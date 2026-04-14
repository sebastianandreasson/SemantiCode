import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Plugin } from 'vite'

import {
  acceptLayoutDraft,
  listLayoutDrafts,
  listSavedLayouts,
  rejectLayoutDraft,
} from './planner'
import type { DraftMutationResponse, LayoutStateResponse } from './types'
import type { ReadProjectSnapshotOptions } from './types'
import { readProjectSnapshot } from './node/readProjectSnapshot'
import {
  CODEBASE_VISUALIZER_DRAFTS_ROUTE,
  CODEBASE_VISUALIZER_LAYOUTS_ROUTE,
  CODEBASE_VISUALIZER_ROUTE,
} from './shared/constants'

export interface CodebaseVisualizerViteOptions
  extends ReadProjectSnapshotOptions {
  route?: string
}

export function codebaseVisualizerPlugin(
  options: CodebaseVisualizerViteOptions = {},
): Plugin {
  const route = options.route ?? CODEBASE_VISUALIZER_ROUTE

  return {
    name: 'codebase-visualizer',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleCodebaseVisualizerRequest(
          request,
          response,
          next,
          options.rootDir ?? server.config.root,
          route,
          options,
        )
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleCodebaseVisualizerRequest(
          request,
          response,
          next,
          options.rootDir ?? server.config.root,
          route,
          options,
        )
      })
    },
  }
}

async function handleCodebaseVisualizerRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  next: () => void,
  rootDir: string,
  route: string,
  options: CodebaseVisualizerViteOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (!pathname?.startsWith('/__codebase-visualizer/')) {
    next()
    return
  }

  try {
    if (pathname === route && method === 'GET') {
      const snapshot = await readProjectSnapshot({
        ...options,
        rootDir,
      })

      sendJson(response, 200, snapshot)
      return
    }

    if (pathname === CODEBASE_VISUALIZER_LAYOUTS_ROUTE && method === 'GET') {
      const state: LayoutStateResponse = {
        layouts: await listSavedLayouts(rootDir),
        draftLayouts: await listLayoutDrafts(rootDir),
        activeLayoutId: null,
        activeDraftId: null,
      }

      sendJson(response, 200, state)
      return
    }

    const draftMatch = pathname.match(
      new RegExp(`^${CODEBASE_VISUALIZER_DRAFTS_ROUTE}/([^/]+)/(accept|reject)$`),
    )

    if (draftMatch && method === 'POST') {
      const [, encodedDraftId, action] = draftMatch
      const draftId = decodeURIComponent(encodedDraftId)

      if (action === 'accept') {
        const layout = await acceptLayoutDraft(rootDir, draftId)
        const result: DraftMutationResponse = {
          ok: true,
          draftId,
          layout,
        }

        sendJson(response, 200, result)
        return
      }

      await rejectLayoutDraft(rootDir, draftId)
      const result: DraftMutationResponse = {
        ok: true,
        draftId,
      }

      sendJson(response, 200, result)
      return
    }

    next()
  } catch (error) {
    sendJson(response, 500, {
      message:
        error instanceof Error
          ? error.message
          : 'Failed to process codebase visualizer request.',
    })
  }
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

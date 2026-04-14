import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  acceptLayoutDraft,
  listLayoutDrafts,
  listSavedLayouts,
  rejectLayoutDraft,
} from '../planner'
import type {
  AgentPromptRequest,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  DraftMutationResponse,
  LayoutStateResponse,
  ReadProjectSnapshotOptions,
} from '../types'
import { readProjectSnapshot } from './readProjectSnapshot'
import {
  CODEBASE_VISUALIZER_AGENT_CANCEL_ROUTE,
  CODEBASE_VISUALIZER_AGENT_MESSAGE_ROUTE,
  CODEBASE_VISUALIZER_AGENT_SETTINGS_ROUTE,
  CODEBASE_VISUALIZER_AGENT_SESSION_ROUTE,
  CODEBASE_VISUALIZER_DRAFTS_ROUTE,
  CODEBASE_VISUALIZER_LAYOUTS_ROUTE,
  CODEBASE_VISUALIZER_ROUTE,
} from '../shared/constants'

export interface AgentRuntimeRequestBridge {
  cancelWorkspaceSession: (workspaceRootDir: string) => Promise<boolean>
  ensureWorkspaceSession: (workspaceRootDir: string) => Promise<AgentStateResponse['session']>
  getSettings: () => Promise<AgentSettingsResponse['settings']>
  getWorkspaceMessages: (workspaceRootDir: string) => AgentStateResponse['messages']
  getWorkspaceSessionSummary: (workspaceRootDir: string) => AgentStateResponse['session']
  promptWorkspaceSession: (workspaceRootDir: string, message: string) => Promise<void>
  saveSettings: (settings: AgentSettingsUpdateRequest) => Promise<AgentSettingsResponse['settings']>
}

export interface CodebaseVisualizerRequestHandlerOptions
  extends ReadProjectSnapshotOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  rootDir: string
  route?: string
}

export async function handleCodebaseVisualizerRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: CodebaseVisualizerRequestHandlerOptions,
) {
  const route = options.route ?? CODEBASE_VISUALIZER_ROUTE
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (!pathname?.startsWith('/__codebase-visualizer/')) {
    return false
  }

  try {
    if (pathname === route && method === 'GET') {
      const snapshot = await readProjectSnapshot({
        ...options,
        rootDir: options.rootDir,
      })

      sendJson(response, 200, snapshot)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_LAYOUTS_ROUTE && method === 'GET') {
      const state: LayoutStateResponse = {
        layouts: await listSavedLayouts(options.rootDir),
        draftLayouts: await listLayoutDrafts(options.rootDir),
        activeLayoutId: null,
        activeDraftId: null,
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_SESSION_ROUTE) {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      if (method === 'GET') {
        const state: AgentStateResponse = {
          session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
          messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        }

        sendJson(response, 200, state)
        return true
      }

      if (method === 'POST') {
        const session = await options.agentRuntime.ensureWorkspaceSession(options.rootDir)
        const state: AgentStateResponse = {
          session,
          messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        }

        sendJson(response, 200, state)
        return true
      }
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_MESSAGE_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const payload = await readJsonBody<AgentPromptRequest>(request)

      if (!payload?.message?.trim()) {
        sendJson(response, 400, {
          message: 'A non-empty message is required.',
        })
        return true
      }

      await options.agentRuntime.promptWorkspaceSession(options.rootDir, payload.message)
      const state: AgentStateResponse = {
        session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_CANCEL_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      await options.agentRuntime.cancelWorkspaceSession(options.rootDir)
      const state: AgentStateResponse = {
        session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_SETTINGS_ROUTE) {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      if (method === 'GET') {
        const result: AgentSettingsResponse = {
          settings: await options.agentRuntime.getSettings(),
        }

        sendJson(response, 200, result)
        return true
      }

      if (method === 'POST') {
        const payload = await readJsonBody<AgentSettingsUpdateRequest>(request)

        if (!payload?.provider || !payload?.modelId) {
          sendJson(response, 400, {
            message: 'Provider and model are required.',
          })
          return true
        }

        const result: AgentSettingsResponse = {
          settings: await options.agentRuntime.saveSettings(payload),
        }

        sendJson(response, 200, result)
        return true
      }
    }

    const draftMatch = pathname.match(
      new RegExp(`^${CODEBASE_VISUALIZER_DRAFTS_ROUTE}/([^/]+)/(accept|reject)$`),
    )

    if (draftMatch && method === 'POST') {
      const [, encodedDraftId, action] = draftMatch
      const draftId = decodeURIComponent(encodedDraftId)

      if (action === 'accept') {
        const layout = await acceptLayoutDraft(options.rootDir, draftId)
        const result: DraftMutationResponse = {
          ok: true,
          draftId,
          layout,
        }

        sendJson(response, 200, result)
        return true
      }

      await rejectLayoutDraft(options.rootDir, draftId)
      const result: DraftMutationResponse = {
        ok: true,
        draftId,
      }

      sendJson(response, 200, result)
      return true
    }

    return false
  } catch (error) {
    sendJson(response, 500, {
      message:
        error instanceof Error
          ? error.message
          : 'Failed to process codebase visualizer request.',
    })
    return true
  }
}

async function readJsonBody<T>(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
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

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readProjectSnapshot } from '../readProjectSnapshot'
import {
  SEMANTICODE_LAYOUTS_ROUTE,
  SEMANTICODE_ROUTE,
  SEMANTICODE_SEMANTIC_LAYOUT_ROUTE,
} from '../../shared/constants'
import type { LayoutStateResponse, SemanticLayoutResponse } from '../../types'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
import { readPersistedPreprocessedWorkspaceContext } from '../preprocessingPersistence'
import { readOrBuildSemanticLayout } from '../semanticLayoutPersistence'
import type { SemanticodeRequestHandlerOptions } from './types'
import { sendJson } from './utils'

export async function handleSnapshotRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const route = options.route ?? SEMANTICODE_ROUTE
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (pathname === route && method === 'GET') {
    const snapshot = await readProjectSnapshot({
      ...options,
      rootDir: options.rootDir,
    })

    sendJson(response, 200, snapshot)
    return true
  }

  if (pathname === SEMANTICODE_SEMANTIC_LAYOUT_ROUTE && method === 'GET') {
    const snapshot = await readProjectSnapshot({
      ...options,
      rootDir: options.rootDir,
    })
    const context = await readPersistedPreprocessedWorkspaceContext(options.rootDir)
    const result = await readOrBuildSemanticLayout({
      preprocessedWorkspaceContext: context,
      rootDir: options.rootDir,
      snapshot,
    })
    const responsePayload: SemanticLayoutResponse = {
      cached: result.cached,
      layout: result.layout,
    }

    sendJson(response, 200, responsePayload)
    return true
  }

  if (pathname === SEMANTICODE_LAYOUTS_ROUTE && method === 'GET') {
    const state: LayoutStateResponse = {
      layouts: await listSavedLayouts(options.rootDir),
      draftLayouts: await listLayoutDrafts(options.rootDir),
      activeLayoutId: null,
      activeDraftId: null,
    }

    sendJson(response, 200, state)
    return true
  }

  return false
}

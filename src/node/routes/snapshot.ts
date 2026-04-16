import type { IncomingMessage, ServerResponse } from 'node:http'

import { readProjectSnapshot } from '../readProjectSnapshot'
import { SEMANTICODE_LAYOUTS_ROUTE, SEMANTICODE_ROUTE } from '../../shared/constants'
import type { LayoutStateResponse } from '../../types'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
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

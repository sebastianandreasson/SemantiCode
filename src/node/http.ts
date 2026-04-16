import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleAgentRoute } from './routes/agent'
import { handleLayoutMutationRoute } from './routes/layouts'
import { handlePreprocessingRoute } from './routes/preprocessing'
import { handleSnapshotRoute } from './routes/snapshot'
import type {
  AgentRuntimeRequestBridge,
  SemanticodeRequestHandlerOptions,
} from './routes/types'
import { sendJson } from './routes/utils'

export type { AgentRuntimeRequestBridge, SemanticodeRequestHandlerOptions }

export async function handleSemanticodeRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]

  if (!pathname?.startsWith('/__semanticode/')) {
    return false
  }

  try {
    if (await handleSnapshotRoute(request, response, options)) {
      return true
    }

    if (await handlePreprocessingRoute(request, response, options)) {
      return true
    }

    if (await handleAgentRoute(request, response, options)) {
      return true
    }

    if (await handleLayoutMutationRoute(request, response, options)) {
      return true
    }

    return false
  } catch (error) {
    sendJson(response, 500, {
      message:
        error instanceof Error
          ? error.message
          : 'Failed to process semanticode request.',
    })
    return true
  }
}

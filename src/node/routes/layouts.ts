import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  executeLayoutQuerySessionCommand,
} from '../layoutQueryRegistry'
import { acceptLayoutDraft, rejectLayoutDraft } from '../../planner'
import {
  SEMANTICODE_DRAFTS_ROUTE,
  SEMANTICODE_LAYOUT_QUERY_ROUTE,
  SEMANTICODE_LAYOUT_SUGGEST_ROUTE,
} from '../../shared/constants'
import type {
  DraftMutationResponse,
  LayoutSuggestionPayload,
} from '../../types'
import type { SemanticodeRequestHandlerOptions } from './types'
import { buildRequestUrl, readJsonBody, sendJson } from './utils'

export async function handleLayoutMutationRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'
  const layoutQueryMatch = pathname?.match(
    new RegExp(`^${SEMANTICODE_LAYOUT_QUERY_ROUTE}/([^/]+)$`),
  )

  if (layoutQueryMatch && method === 'POST') {
    const [, encodedSessionId] = layoutQueryMatch
    const sessionId = decodeURIComponent(encodedSessionId)
    const payload = await readJsonBody<{
      args?: Record<string, unknown>
      operation?: string
    }>(request)

    if (!payload?.operation) {
      sendJson(response, 400, {
        message: 'A layout query operation is required.',
      })
      return true
    }

    const result = await executeLayoutQuerySessionCommand(sessionId, {
      args: payload.args,
      operation: payload.operation as never,
    })

    sendJson(response, result.ok ? 200 : 400, result)
    return true
  }

  if (pathname === SEMANTICODE_LAYOUT_SUGGEST_ROUTE && method === 'POST') {
    if (!options.agentRuntime) {
      sendJson(response, 503, {
        message: 'The embedded agent runtime is not available for layout suggestions.',
      })
      return true
    }

    const payload = await readJsonBody<LayoutSuggestionPayload>(request)
    const prompt = payload?.prompt?.trim()

    if (!prompt) {
      sendJson(response, 400, {
        message: 'A non-empty layout prompt is required.',
      })
      return true
    }

    const requestUrl = new URL(buildRequestUrl(request))
    const result = await options.agentRuntime.suggestLayout(
      options.rootDir,
      {
        ...payload,
        prompt,
      },
      {
        helperBaseUrl: `${requestUrl.origin}${SEMANTICODE_LAYOUT_QUERY_ROUTE}`,
      },
    )

    sendJson(response, 200, result)
    return true
  }

  const draftMatch = pathname?.match(
    new RegExp(`^${SEMANTICODE_DRAFTS_ROUTE}/([^/]+)/(accept|reject)$`),
  )

  if (!draftMatch || method !== 'POST') {
    return false
  }

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

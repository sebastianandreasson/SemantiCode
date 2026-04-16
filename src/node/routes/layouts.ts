import type { IncomingMessage, ServerResponse } from 'node:http'

import { acceptLayoutDraft, rejectLayoutDraft } from '../../planner'
import { SEMANTICODE_DRAFTS_ROUTE } from '../../shared/constants'
import type { DraftMutationResponse } from '../../types'
import type { SemanticodeRequestHandlerOptions } from './types'
import { sendJson } from './utils'

export async function handleLayoutMutationRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'
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

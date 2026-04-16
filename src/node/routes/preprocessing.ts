import type { IncomingMessage, ServerResponse } from 'node:http'

import { SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE, SEMANTICODE_PREPROCESSING_ROUTE, SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE } from '../../shared/constants'
import type {
  PreprocessingContextResponse,
  PreprocessingContextUpdateRequest,
  PreprocessingEmbeddingRequest,
  PreprocessingEmbeddingResponse,
  PreprocessingSummaryRequest,
  PreprocessingSummaryResponse,
  WorkspaceSyncStatusResponse,
} from '../../types'
import { readPersistedPreprocessedWorkspaceContext, writePersistedPreprocessedWorkspaceContext } from '../preprocessingPersistence'
import { embedSemanticTexts } from '../semanticEmbeddingService'
import { analyzeWorkspaceArtifactSync } from '../../preprocessing/workspaceSync'
import { getGitWorkspaceStatus } from '../gitWorkspaceSync'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
import { readProjectSnapshot } from '../readProjectSnapshot'
import { SEMANTICODE_SYNC_ROUTE } from '../../shared/constants'
import type { SemanticodeRequestHandlerOptions } from './types'
import { readJsonBody, sendJson } from './utils'

export async function handlePreprocessingRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (pathname === SEMANTICODE_PREPROCESSING_ROUTE) {
    if (method === 'GET') {
      const result: PreprocessingContextResponse = {
        context: await readPersistedPreprocessedWorkspaceContext(options.rootDir),
      }

      sendJson(response, 200, result)
      return true
    }

    if (method === 'POST') {
      const payload = await readJsonBody<PreprocessingContextUpdateRequest>(request)

      if (!payload?.context?.snapshotId) {
        sendJson(response, 400, {
          message: 'A preprocessing context payload is required.',
        })
        return true
      }

      await writePersistedPreprocessedWorkspaceContext(options.rootDir, payload.context)

      const result: PreprocessingContextResponse = {
        context: payload.context,
      }

      sendJson(response, 200, result)
      return true
    }
  }

  if (pathname === SEMANTICODE_SYNC_ROUTE && method === 'GET') {
    const [snapshot, layouts, draftLayouts, context, git] = await Promise.all([
      readProjectSnapshot({
        ...options,
        rootDir: options.rootDir,
      }),
      listSavedLayouts(options.rootDir),
      listLayoutDrafts(options.rootDir),
      readPersistedPreprocessedWorkspaceContext(options.rootDir),
      getGitWorkspaceStatus(options.rootDir),
    ])

    const result: WorkspaceSyncStatusResponse = {
      sync: analyzeWorkspaceArtifactSync({
        snapshot,
        preprocessedWorkspaceContext: context,
        layouts,
        draftLayouts,
        git,
      }),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE && method === 'POST') {
    if (!options.agentRuntime) {
      sendJson(response, 503, {
        message: 'The embedded PI runtime is not available for this host.',
      })
      return true
    }

    const payload = await readJsonBody<PreprocessingSummaryRequest>(request)

    if (!payload?.message?.trim()) {
      sendJson(response, 400, {
        message: 'A preprocessing prompt is required.',
      })
      return true
    }

    const result: PreprocessingSummaryResponse = {
      text: await options.agentRuntime.runOneOffPrompt(options.rootDir, {
        message: payload.message,
        systemPrompt: payload.systemPrompt,
      }),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE && method === 'POST') {
    const payload = await readJsonBody<PreprocessingEmbeddingRequest>(request)

    if (!payload?.texts?.length) {
      sendJson(response, 400, {
        message: 'A preprocessing embedding payload is required.',
      })
      return true
    }

    const result: PreprocessingEmbeddingResponse = {
      embeddings: await embedSemanticTexts({
        modelId: payload.modelId,
        texts: payload.texts,
      }),
    }

    sendJson(response, 200, result)
    return true
  }

  return false
}

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  SEMANTICODE_GROUP_PROTOTYPES_ROUTE,
  SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE,
  SEMANTICODE_PREPROCESSING_ROUTE,
  SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE,
  SEMANTICODE_SYNC_ROUTE,
  SEMANTICODE_UI_PREFERENCES_ROUTE,
  SEMANTICODE_WORKSPACE_HISTORY_ROUTE,
} from '../../shared/constants'
import type {
  GroupPrototypeCacheResponse,
  GroupPrototypeCacheUpdateRequest,
  PreprocessingContextResponse,
  PreprocessingContextUpdateRequest,
  PreprocessingEmbeddingRequest,
  PreprocessingEmbeddingResponse,
  PreprocessingSummaryRequest,
  PreprocessingSummaryResponse,
  UiPreferencesResponse,
  UiPreferencesUpdateRequest,
  WorkspaceHistoryResponse,
  WorkspaceSyncStatusResponse,
} from '../../types'
import { readPersistedGroupPrototypeCache, writePersistedGroupPrototypeCache } from '../groupPrototypePersistence'
import { readPersistedPreprocessedWorkspaceContext, writePersistedPreprocessedWorkspaceContext } from '../preprocessingPersistence'
import { embedSemanticTexts } from '../semanticEmbeddingService'
import { analyzeWorkspaceArtifactSync } from '../../preprocessing/workspaceSync'
import { getGitWorkspaceStatus } from '../gitWorkspaceSync'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
import { readProjectSnapshot } from '../readProjectSnapshot'
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

  if (pathname === SEMANTICODE_GROUP_PROTOTYPES_ROUTE) {
    if (method === 'GET') {
      const result: GroupPrototypeCacheResponse = {
        cache: await readPersistedGroupPrototypeCache(options.rootDir),
      }

      sendJson(response, 200, result)
      return true
    }

    if (method === 'POST') {
      const payload = await readJsonBody<GroupPrototypeCacheUpdateRequest>(request)

      if (!payload?.cache || !Array.isArray(payload.cache.records)) {
        sendJson(response, 400, {
          message: 'A group prototype cache payload is required.',
        })
        return true
      }

      await writePersistedGroupPrototypeCache(options.rootDir, payload.cache)

      const result: GroupPrototypeCacheResponse = {
        cache: payload.cache,
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

  if (pathname === SEMANTICODE_WORKSPACE_HISTORY_ROUTE && method === 'GET') {
    const result: WorkspaceHistoryResponse = options.getWorkspaceHistory
      ? await options.getWorkspaceHistory()
      : {
          activeWorkspaceRootDir: options.rootDir,
          recentWorkspaces: [],
        }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_UI_PREFERENCES_ROUTE) {
    if (method === 'GET') {
      const result: UiPreferencesResponse = options.getUiPreferences
        ? await options.getUiPreferences()
        : {
            preferences: {},
          }

      sendJson(response, 200, result)
      return true
    }

    if (method === 'POST') {
      const payload = await readJsonBody<UiPreferencesUpdateRequest>(request)

      if (!payload?.preferences) {
        sendJson(response, 400, {
          message: 'A UI preferences payload is required.',
        })
        return true
      }

      const result: UiPreferencesResponse = options.setUiPreferences
        ? await options.setUiPreferences(payload.preferences)
        : {
            preferences: payload.preferences,
          }

      sendJson(response, 200, result)
      return true
    }
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

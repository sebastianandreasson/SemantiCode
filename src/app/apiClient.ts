import type {
  AgentStateResponse,
  AgentPromptRequest,
  AutonomousRunDetailResponse,
  AutonomousRunStartPayload,
  AutonomousRunStartResponse,
  AutonomousRunStopResponse,
  AutonomousRunTimelineResponse,
  AutonomousRunsResponse,
  CodebaseSnapshot,
  DraftMutationResponse,
  GitFileDiffResponse,
  GroupPrototypeCacheResponse,
  GroupPrototypeCacheUpdateRequest,
  LayoutStateResponse,
  PreprocessedWorkspaceContext,
  PreprocessingEmbeddingResponse,
  PreprocessingContextResponse,
  PreprocessingSummaryResponse,
  SemanticLayoutResponse,
  UiPreferences,
  UiPreferencesResponse,
  TelemetryActivityResponse,
  TelemetryHeatmapRequest,
  TelemetryHeatmapResponse,
  TelemetryOverviewResponse,
  WorkspaceHistoryResponse,
  WorkspaceArtifactSyncStatus,
  WorkspaceSyncStatusResponse,
} from '../types'
import {
  SEMANTICODE_AGENT_MESSAGE_ROUTE,
  SEMANTICODE_AGENT_SESSION_ROUTE,
  buildSemanticodeDraftActionRoute,
  buildSemanticodeRunRoute,
  buildSemanticodeRunStopRoute,
  buildSemanticodeRunTimelineRoute,
  SEMANTICODE_FILE_DIFF_ROUTE,
  SEMANTICODE_LAYOUTS_ROUTE,
  SEMANTICODE_GROUP_PROTOTYPES_ROUTE,
  SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE,
  SEMANTICODE_PREPROCESSING_ROUTE,
  SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE,
  SEMANTICODE_RUNS_ROUTE,
  SEMANTICODE_SEMANTIC_LAYOUT_ROUTE,
  SEMANTICODE_ROUTE,
  SEMANTICODE_SYNC_ROUTE,
  SEMANTICODE_TELEMETRY_ACTIVITY_ROUTE,
  SEMANTICODE_TELEMETRY_HEATMAP_ROUTE,
  SEMANTICODE_TELEMETRY_OVERVIEW_ROUTE,
  SEMANTICODE_UI_PREFERENCES_ROUTE,
  SEMANTICODE_WORKSPACE_HISTORY_ROUTE,
} from '../shared/constants'

export const SEMANTIC_EMBEDDING_MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5'

export async function fetchWorkspaceState() {
  const [snapshotResponse, layoutStateResponse] = await Promise.all([
    fetch(SEMANTICODE_ROUTE),
    fetch(SEMANTICODE_LAYOUTS_ROUTE),
  ])

  if (!snapshotResponse.ok) {
    throw new Error(await getResponseErrorMessage(
      snapshotResponse,
      `Snapshot request failed with status ${snapshotResponse.status}.`,
    ))
  }

  if (!layoutStateResponse.ok) {
    throw new Error(await getResponseErrorMessage(
      layoutStateResponse,
      `Layout state request failed with status ${layoutStateResponse.status}.`,
    ))
  }

  const [snapshot, layoutState] = (await Promise.all([
    snapshotResponse.json(),
    layoutStateResponse.json(),
  ])) as [CodebaseSnapshot, LayoutStateResponse]

  return {
    layoutState,
    snapshot,
  }
}

export async function fetchLayoutState() {
  const response = await fetch(SEMANTICODE_LAYOUTS_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Layout state request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as LayoutStateResponse
}

export async function fetchSemanticLayout() {
  const response = await fetch(SEMANTICODE_SEMANTIC_LAYOUT_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Semantic layout request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as SemanticLayoutResponse
}

export async function postAgentMessage(
  message: string,
  metadata?: AgentPromptRequest['metadata'],
) {
  const response = await fetch(SEMANTICODE_AGENT_MESSAGE_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, metadata } satisfies AgentPromptRequest),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Agent message request failed with status ${response.status}.`,
    ))
  }
}

export async function fetchAgentState() {
  const response = await fetch(SEMANTICODE_AGENT_SESSION_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Agent session request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AgentStateResponse
}

export async function mutateDraft(
  draftId: string,
  action: 'accept' | 'reject',
) {
  const response = await fetch(buildSemanticodeDraftActionRoute(draftId, action), {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `${action === 'accept' ? 'Accept' : 'Reject'} draft failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as DraftMutationResponse
}

export async function fetchPersistedPreprocessedWorkspaceContext() {
  const response = await fetch(SEMANTICODE_PREPROCESSING_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Preprocessing context request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as PreprocessingContextResponse
  return payload.context
}

export async function fetchWorkspaceSyncStatus(): Promise<WorkspaceArtifactSyncStatus> {
  const response = await fetch(SEMANTICODE_SYNC_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Workspace sync request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as WorkspaceSyncStatusResponse
  return payload.sync
}

export async function fetchGitFileDiff(path: string) {
  const url = new URL(SEMANTICODE_FILE_DIFF_ROUTE, window.location.origin)
  url.searchParams.set('path', path)
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `File diff request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as GitFileDiffResponse
  return payload.diff
}

export async function fetchWorkspaceHistory() {
  const response = await fetch(SEMANTICODE_WORKSPACE_HISTORY_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Workspace history request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as WorkspaceHistoryResponse
}

export async function fetchUiPreferences() {
  const response = await fetch(SEMANTICODE_UI_PREFERENCES_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `UI preferences request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as UiPreferencesResponse
  return payload.preferences
}

export async function persistUiPreferences(
  preferences: UiPreferences,
) {
  const response = await fetch(SEMANTICODE_UI_PREFERENCES_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ preferences }),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `UI preferences persistence failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as UiPreferencesResponse
  return payload.preferences
}

export async function persistPreprocessedWorkspaceContext(
  context: PreprocessedWorkspaceContext,
) {
  const response = await fetch(SEMANTICODE_PREPROCESSING_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ context }),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Preprocessing persistence failed with status ${response.status}.`,
    ))
  }
}

export async function fetchGroupPrototypeCache() {
  const response = await fetch(SEMANTICODE_GROUP_PROTOTYPES_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Group prototype cache request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as GroupPrototypeCacheResponse
  return payload.cache
}

export async function persistGroupPrototypeCache(
  cache: GroupPrototypeCacheUpdateRequest['cache'],
) {
  const response = await fetch(SEMANTICODE_GROUP_PROTOTYPES_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cache }),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Group prototype cache persistence failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as GroupPrototypeCacheResponse
  return payload.cache
}

export async function requestLLMSemanticSummary(
  message: string,
  metadata?: AgentPromptRequest['metadata'],
) {
  const response = await fetch(SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, metadata }),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `LLM preprocessing request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as PreprocessingSummaryResponse
  return payload.text
}

export async function fetchAutonomousRuns() {
  const response = await fetch(SEMANTICODE_RUNS_ROUTE)

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Autonomous runs request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AutonomousRunsResponse
}

export async function startAutonomousRun(payload: AutonomousRunStartPayload = {}) {
  const response = await fetch(`${SEMANTICODE_RUNS_ROUTE}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Starting autonomous run failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AutonomousRunStartResponse
}

export async function fetchAutonomousRunDetail(runId: string) {
  const response = await fetch(buildSemanticodeRunRoute(runId))

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Autonomous run detail request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AutonomousRunDetailResponse
}

export async function fetchAutonomousRunTimeline(runId: string) {
  const response = await fetch(buildSemanticodeRunTimelineRoute(runId))

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Autonomous run timeline request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AutonomousRunTimelineResponse
}

export async function stopAutonomousRun(runId: string) {
  const response = await fetch(buildSemanticodeRunStopRoute(runId), {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Stopping autonomous run failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as AutonomousRunStopResponse
}

export async function fetchTelemetryOverview(query: TelemetryHeatmapRequest = {}) {
  const response = await fetch(buildTelemetryUrl(SEMANTICODE_TELEMETRY_OVERVIEW_ROUTE, query))

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Telemetry overview request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as TelemetryOverviewResponse
}

export async function fetchTelemetryHeatmap(query: TelemetryHeatmapRequest = {}) {
  const response = await fetch(buildTelemetryUrl(SEMANTICODE_TELEMETRY_HEATMAP_ROUTE, query))

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Telemetry heatmap request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as TelemetryHeatmapResponse
}

export async function fetchTelemetryActivity(query: TelemetryHeatmapRequest = {}) {
  const response = await fetch(buildTelemetryUrl(SEMANTICODE_TELEMETRY_ACTIVITY_ROUTE, query))

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Telemetry activity request failed with status ${response.status}.`,
    ))
  }

  return (await response.json()) as TelemetryActivityResponse
}

export async function requestSemanticEmbeddings(
  texts: {
    id: string
    text: string
    textHash: string
  }[],
) {
  const response = await fetch(SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      modelId: SEMANTIC_EMBEDDING_MODEL_ID,
      texts,
    }),
  })

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(
      response,
      `Semantic embedding request failed with status ${response.status}.`,
    ))
  }

  const payload = (await response.json()) as PreprocessingEmbeddingResponse
  return payload.embeddings
}

async function getResponseErrorMessage(
  response: Response,
  fallbackMessage: string,
) {
  try {
    const payload = (await response.json()) as { message?: string }

    if (payload?.message) {
      return payload.message
    }
  } catch {
    // Ignore non-JSON error bodies and fall back to the caller-provided message.
  }

  return fallbackMessage
}

function buildTelemetryUrl(
  baseRoute: string,
  query: TelemetryHeatmapRequest,
) {
  const url = new URL(baseRoute, globalThis.location?.origin ?? 'http://127.0.0.1')

  if (query.mode) {
    url.searchParams.set('mode', query.mode)
  }

  if (query.runId) {
    url.searchParams.set('runId', query.runId)
  }

  if (query.source) {
    url.searchParams.set('source', String(query.source))
  }

  if (query.window) {
    url.searchParams.set('window', String(query.window))
  }

  return `${url.pathname}${url.search}`
}

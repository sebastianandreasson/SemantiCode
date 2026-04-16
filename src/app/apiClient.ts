import type {
  AgentStateResponse,
  CodebaseSnapshot,
  DraftMutationResponse,
  LayoutStateResponse,
  PreprocessedWorkspaceContext,
  PreprocessingEmbeddingResponse,
  PreprocessingContextResponse,
  PreprocessingSummaryResponse,
  WorkspaceArtifactSyncStatus,
  WorkspaceSyncStatusResponse,
} from '../types'
import {
  SEMANTICODE_AGENT_MESSAGE_ROUTE,
  SEMANTICODE_AGENT_SESSION_ROUTE,
  buildSemanticodeDraftActionRoute,
  SEMANTICODE_LAYOUTS_ROUTE,
  SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE,
  SEMANTICODE_PREPROCESSING_ROUTE,
  SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE,
  SEMANTICODE_ROUTE,
  SEMANTICODE_SYNC_ROUTE,
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

export async function postAgentMessage(message: string) {
  const response = await fetch(SEMANTICODE_AGENT_MESSAGE_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
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

export async function requestLLMSemanticSummary(message: string) {
  const response = await fetch(SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
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

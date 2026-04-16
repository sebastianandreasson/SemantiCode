import { startTransition, useEffect, useRef, useState } from 'react'

import { Semanticode } from './index'
import {
  countPreprocessableSymbols,
  getPreprocessableSymbols,
  getPreprocessedSnapshotId,
  hydratePreprocessedWorkspaceContext,
  preprocessWorkspaceSnapshotIncrementally,
} from './preprocessing/preprocessingService'
import { buildWorkspaceProfile } from './preprocessing/workspaceProfile'
import {
  buildSemanticPurposeSummaryPrompt,
  buildSemanticPurposeSummaryRecordFromModelOutput,
  parseSemanticPurposeSummaryResponse,
} from './semantic/purposeSummaries'
import { buildSemanticSymbolTextRecord } from './semantic/symbolText'
import { hashSemanticText } from './semantic/symbolText'
import type {
  AgentStateResponse,
  CodebaseSnapshot,
  DraftMutationResponse,
  LayoutStateResponse,
  PreprocessedWorkspaceContext,
  PreprocessingEmbeddingResponse,
  PreprocessingContextResponse,
  PreprocessingSummaryResponse,
  PreprocessingStatus,
  WorkspaceArtifactSyncStatus,
  WorkspaceSyncStatusResponse,
} from './types'
import { useVisualizerStore, visualizerStore } from './store/visualizerStore'
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
} from './shared/constants'

const SEMANTIC_EMBEDDING_MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5'

export default function App() {
  const [layoutActionPending, setLayoutActionPending] = useState(false)
  const [layoutSuggestionPending, setLayoutSuggestionPending] = useState(false)
  const [layoutSuggestionError, setLayoutSuggestionError] = useState<string | null>(null)
  const [preprocessedWorkspaceContext, setPreprocessedWorkspaceContext] =
    useState<PreprocessedWorkspaceContext | null>(null)
  const [workspaceSyncStatus, setWorkspaceSyncStatus] =
    useState<WorkspaceArtifactSyncStatus | null>(null)
  const [preprocessingStatus, setPreprocessingStatus] = useState<PreprocessingStatus>({
    activity: null,
    runState: 'idle',
    updatedAt: null,
    purposeSummaryCount: 0,
    semanticEmbeddingCount: 0,
    lastError: null,
    processedSymbols: 0,
    snapshotId: null,
    totalSymbols: 0,
  })
  const preprocessingRunIdRef = useRef(0)
  const preprocessedWorkspaceContextRef = useRef<PreprocessedWorkspaceContext | null>(null)
  const status = useVisualizerStore((state) => state.status)
  const errorMessage = useVisualizerStore((state) => state.errorMessage)
  const activeDraftId = useVisualizerStore((state) => state.activeDraftId)
  const snapshot = useVisualizerStore((state) => state.snapshot)
  const draftLayouts = useVisualizerStore((state) => state.draftLayouts)
  const setErrorMessage = useVisualizerStore((state) => state.setErrorMessage)
  const setActiveDraftId = useVisualizerStore((state) => state.setActiveDraftId)
  const setActiveLayoutId = useVisualizerStore((state) => state.setActiveLayoutId)
  const setDraftLayouts = useVisualizerStore((state) => state.setDraftLayouts)
  const setLayouts = useVisualizerStore((state) => state.setLayouts)
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setStatus = useVisualizerStore((state) => state.setStatus)

  useEffect(() => {
    preprocessedWorkspaceContextRef.current = preprocessedWorkspaceContext
  }, [preprocessedWorkspaceContext])

  useEffect(() => {
    const desktopBridge = (
      globalThis as typeof globalThis & {
        semanticodeDesktop?: { isDesktop?: boolean }
      }
    ).semanticodeDesktop

    if (!desktopBridge?.isDesktop) {
      return
    }

    document.body.classList.add('is-desktop-host')

    return () => {
      document.body.classList.remove('is-desktop-host')
    }
  }, [])

  useEffect(() => {
    let isCancelled = false

    async function loadWorkspaceState() {
      setStatus('loading')

      try {
        const [{ layoutState, snapshot }, persistedContext, workspaceSyncStatus] = await Promise.all([
          fetchWorkspaceState(),
          fetchPersistedPreprocessedWorkspaceContext(),
          fetchWorkspaceSyncStatus(),
        ])

        if (isCancelled) {
          return
        }

        if (persistedContext) {
          hydratePreprocessedWorkspaceContext(persistedContext)
        }

        startTransition(() => {
          const totalSymbols = countPreprocessableSymbols(snapshot)
          const isPersistedContextFresh =
            persistedContext?.snapshotId === getPreprocessedSnapshotId(snapshot)
          const isPersistedContextReady =
            Boolean(
              persistedContext &&
                persistedContext.isComplete &&
                isPersistedContextFresh,
            )

          setSnapshot(snapshot)
          setLayouts(layoutState.layouts)
          setDraftLayouts(layoutState.draftLayouts)
          setActiveLayoutId(layoutState.activeLayoutId)
          setActiveDraftId(layoutState.activeDraftId)
          setPreprocessedWorkspaceContext(persistedContext)
          setWorkspaceSyncStatus(workspaceSyncStatus)
          setPreprocessingStatus(
            persistedContext
              ? {
                  runState: isPersistedContextReady ? 'ready' : 'stale',
                  activity: null,
                  updatedAt: persistedContext.workspaceProfile.generatedAt,
                  purposeSummaryCount: persistedContext.purposeSummaries.length,
                  semanticEmbeddingCount: persistedContext.semanticEmbeddings.length,
                  lastError: null,
                  processedSymbols: persistedContext.purposeSummaries.length,
                  snapshotId: persistedContext.snapshotId,
                  totalSymbols,
                }
              : {
                  runState: 'idle',
                  activity: null,
                  updatedAt: null,
                  purposeSummaryCount: 0,
                  semanticEmbeddingCount: 0,
                  lastError: null,
                  processedSymbols: 0,
                  snapshotId: null,
                  totalSymbols: countPreprocessableSymbols(snapshot),
                },
          )
          setErrorMessage(null)
          setStatus('ready')
        })

        if (persistedContext?.isComplete) {
          startBackgroundPreprocessing(
            snapshot,
            persistedContext ?? preprocessedWorkspaceContextRef.current,
            true,
          )
        }
      } catch (error) {
        if (isCancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to load the codebase.',
        )
        setStatus('error')
      }
    }

    void loadWorkspaceState()

    return () => {
      isCancelled = true
    }
  }, [
    setActiveDraftId,
    setActiveLayoutId,
    setDraftLayouts,
    setErrorMessage,
    setLayouts,
    setSnapshot,
    setStatus,
  ])

  async function refreshWorkspaceState() {
    const [{ layoutState, snapshot }, workspaceSyncStatus] = await Promise.all([
      fetchWorkspaceState(),
      fetchWorkspaceSyncStatus(),
    ])

    startTransition(() => {
      setSnapshot(snapshot)
      setLayouts(layoutState.layouts)
      setDraftLayouts(layoutState.draftLayouts)
      setWorkspaceSyncStatus(workspaceSyncStatus)
      setErrorMessage(null)
    })

    if (preprocessedWorkspaceContextRef.current) {
      startBackgroundPreprocessing(
        snapshot,
        preprocessedWorkspaceContextRef.current,
        true,
      )
    } else {
      startTransition(() => {
        setPreprocessingStatus({
          runState: 'idle',
          activity: null,
          updatedAt: null,
          purposeSummaryCount: 0,
          semanticEmbeddingCount: 0,
          lastError: null,
          processedSymbols: 0,
          snapshotId: null,
          totalSymbols: countPreprocessableSymbols(snapshot),
        })
      })
    }
  }

  function startBackgroundPreprocessing(
    nextSnapshot: CodebaseSnapshot,
    existingContext: PreprocessedWorkspaceContext | null,
    automatic: boolean,
  ) {
    if (!automatic && !existingContext) {
      setPreprocessingStatus({
        runState: 'building',
        activity: 'summaries',
        updatedAt: null,
        purposeSummaryCount: 0,
        semanticEmbeddingCount: 0,
        lastError: null,
        processedSymbols: 0,
        snapshotId: null,
        totalSymbols: countPreprocessableSymbols(nextSnapshot),
      })
    }

    const runId = preprocessingRunIdRef.current + 1
    preprocessingRunIdRef.current = runId

    startTransition(() => {
      setPreprocessingStatus((current) => ({
        runState: existingContext ? 'stale' : 'building',
        activity: 'summaries',
        updatedAt: current.updatedAt,
        purposeSummaryCount: current.purposeSummaryCount,
        semanticEmbeddingCount: current.semanticEmbeddingCount,
        lastError: null,
        processedSymbols: 0,
        snapshotId: current.snapshotId,
        totalSymbols: countPreprocessableSymbols(nextSnapshot),
      }))
    })

    window.setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          preprocessWorkspaceSnapshotIncrementally(nextSnapshot, {
            onProgress: (progress) => {
              if (preprocessingRunIdRef.current !== runId) {
                return
              }

              setPreprocessingStatus((current) => ({
                ...current,
                activity: 'summaries',
                processedSymbols: progress.processedSymbols,
                purposeSummaryCount: progress.processedSymbols,
                totalSymbols: progress.totalSymbols,
              }))
            },
            previousContext: existingContext,
          }),
        )
        .then((context) => {
          if (preprocessingRunIdRef.current !== runId) {
            return
          }

          startTransition(() => {
            setPreprocessedWorkspaceContext(context)
            setPreprocessingStatus({
              runState: 'ready',
              activity: null,
              updatedAt: new Date().toISOString(),
              purposeSummaryCount: context.purposeSummaries.length,
              semanticEmbeddingCount: context.semanticEmbeddings.length,
              lastError: null,
              processedSymbols: context.purposeSummaries.length,
              snapshotId: context.snapshotId,
              totalSymbols: countPreprocessableSymbols(nextSnapshot),
            })
          })

          void persistPreprocessedWorkspaceContext(context).catch((error) => {
            if (preprocessingRunIdRef.current !== runId) {
              return
            }

            setPreprocessingStatus((current) => ({
              ...current,
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to persist preprocessing cache.',
            }))
          })
        })
        .catch((error) => {
          if (preprocessingRunIdRef.current !== runId) {
            return
          }

          startTransition(() => {
            setPreprocessingStatus((current) => ({
              runState: 'error',
              activity: current.activity,
              updatedAt: current.updatedAt,
              purposeSummaryCount: current.purposeSummaryCount,
              semanticEmbeddingCount: current.semanticEmbeddingCount,
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to preprocess workspace context.',
              processedSymbols: current.processedSymbols,
              snapshotId: current.snapshotId,
              totalSymbols: current.totalSymbols,
            }))
          })
        })
    }, 0)
  }

  function handleStartPreprocessing() {
    const nextSnapshot = snapshot ?? visualizerStore.getState().snapshot

    if (!nextSnapshot) {
      startTransition(() => {
        setPreprocessingStatus((current) => ({
          ...current,
          runState: 'error',
          activity: current.activity,
          lastError: 'The workspace snapshot is not ready yet.',
        }))
      })
      return
    }

    setPreprocessingStatus({
      runState: 'building',
      activity: 'summaries',
      updatedAt: preprocessedWorkspaceContextRef.current?.workspaceProfile.generatedAt ?? null,
      purposeSummaryCount: preprocessedWorkspaceContextRef.current?.purposeSummaries.length ?? 0,
      semanticEmbeddingCount:
        preprocessedWorkspaceContextRef.current?.semanticEmbeddings.length ?? 0,
      lastError: null,
      processedSymbols: 0,
      snapshotId: preprocessedWorkspaceContextRef.current?.snapshotId ?? null,
      totalSymbols: countPreprocessableSymbols(nextSnapshot),
    })

    void runLLMPreprocessing(nextSnapshot, preprocessedWorkspaceContextRef.current)
  }

  async function runLLMPreprocessing(
    nextSnapshot: CodebaseSnapshot,
    existingContext: PreprocessedWorkspaceContext | null,
  ) {
    const runId = preprocessingRunIdRef.current + 1
    preprocessingRunIdRef.current = runId
    const generatedAt = new Date().toISOString()
    const workspaceProfile = buildWorkspaceProfile(nextSnapshot)
    const symbols = getPreprocessableSymbols(nextSnapshot)
    const previousSummaryBySymbolId = new Map(
      existingContext?.purposeSummaries.map((summary) => [summary.symbolId, summary]) ?? [],
    )
    const nextPurposeSummaries = []
    let activeSymbolPath: string | null = null

    startTransition(() => {
      setPreprocessingStatus({
        runState: 'building',
        activity: 'summaries',
        updatedAt: existingContext?.workspaceProfile.generatedAt ?? null,
        purposeSummaryCount: 0,
        semanticEmbeddingCount: existingContext?.semanticEmbeddings.length ?? 0,
        lastError: null,
        processedSymbols: 0,
        snapshotId: existingContext?.snapshotId ?? null,
        totalSymbols: countPreprocessableSymbols(nextSnapshot),
      })
    })

    try {
      for (const [index, symbol] of symbols.entries()) {
        if (preprocessingRunIdRef.current !== runId) {
          return
        }

        activeSymbolPath = symbol.path
        const previousSummary = previousSummaryBySymbolId.get(symbol.id)
        const sourceTextRecord = buildSemanticSymbolTextRecord(
          nextSnapshot,
          symbol,
          generatedAt,
        )
        const record =
          previousSummary &&
          previousSummary.generator === 'llm' &&
          previousSummary.sourceHash === sourceTextRecord.textHash
            ? previousSummary
            : buildSemanticPurposeSummaryRecordFromModelOutput(
                nextSnapshot,
                symbol,
                parseSemanticPurposeSummaryResponse(
                  await requestLLMSemanticSummary(
                    buildSemanticPurposeSummaryPrompt(nextSnapshot, symbol),
                  ),
                ),
                generatedAt,
              )
        nextPurposeSummaries.push(record)
        const partialContext: PreprocessedWorkspaceContext = {
          snapshotId: getPreprocessedSnapshotId(nextSnapshot),
          isComplete: false,
          semanticEmbeddingModelId: existingContext?.semanticEmbeddingModelId ?? null,
          semanticEmbeddings: filterEmbeddingsForSummaries(existingContext, nextPurposeSummaries),
          workspaceProfile,
          purposeSummaries: nextPurposeSummaries.slice(),
        }

        hydratePreprocessedWorkspaceContext(partialContext)
        setPreprocessedWorkspaceContext(partialContext)
        await persistPreprocessedWorkspaceContext(partialContext)

        startTransition(() => {
          setPreprocessingStatus((current) => ({
            ...current,
            activity: 'summaries',
            processedSymbols: index + 1,
            purposeSummaryCount: index + 1,
          }))
        })
      }

      const context: PreprocessedWorkspaceContext = {
        snapshotId: getPreprocessedSnapshotId(nextSnapshot),
        isComplete: true,
        semanticEmbeddingModelId: existingContext?.semanticEmbeddingModelId ?? null,
        semanticEmbeddings: filterEmbeddingsForSummaries(existingContext, nextPurposeSummaries),
        workspaceProfile,
        purposeSummaries: nextPurposeSummaries,
      }

      hydratePreprocessedWorkspaceContext(context)
      startTransition(() => {
        setPreprocessedWorkspaceContext(context)
        setPreprocessingStatus({
          runState: 'ready',
          activity: null,
          updatedAt: generatedAt,
          purposeSummaryCount: context.purposeSummaries.length,
          semanticEmbeddingCount: context.semanticEmbeddings.length,
          lastError: null,
          processedSymbols: context.purposeSummaries.length,
          snapshotId: context.snapshotId,
          totalSymbols: context.purposeSummaries.length,
        })
      })

      await persistPreprocessedWorkspaceContext(context)
      setWorkspaceSyncStatus(await fetchWorkspaceSyncStatus())
    } catch (error) {
      if (preprocessingRunIdRef.current !== runId) {
        return
      }

      startTransition(() => {
        setPreprocessingStatus((current) => ({
          ...current,
          runState: 'error',
          activity: 'summaries',
          lastError:
            activeSymbolPath
              ? `Failed on ${activeSymbolPath}: ${error instanceof Error ? error.message : 'Unknown preprocessing error.'}`
              : error instanceof Error
                ? error.message
                : 'Failed to build LLM preprocessing context.',
        }))
      })
    }
  }

  async function handleBuildSemanticEmbeddings() {
    const nextSnapshot = snapshot ?? visualizerStore.getState().snapshot
    const existingContext = preprocessedWorkspaceContextRef.current

    if (!nextSnapshot || !existingContext?.purposeSummaries.length) {
      setPreprocessingStatus((current) => ({
        ...current,
        runState: 'error',
        activity: 'embeddings',
        lastError: 'Build summaries with the agent before generating embeddings.',
      }))
      return
    }

    const totalSymbols = existingContext.purposeSummaries.length
    setPreprocessingStatus((current) => ({
      ...current,
      runState: 'building',
      activity: 'embeddings',
      updatedAt: existingContext.workspaceProfile.generatedAt,
      purposeSummaryCount: existingContext.purposeSummaries.length,
      semanticEmbeddingCount: existingContext.semanticEmbeddings.length,
      lastError: null,
      processedSymbols: 0,
      snapshotId: existingContext.snapshotId,
      totalSymbols,
    }))

    const previousEmbeddingBySymbolId = new Map(
      existingContext.semanticEmbeddings.map((embedding) => [embedding.symbolId, embedding]),
    )
    const nextEmbeddings = []
    let activeSymbolPath: string | null = null

    try {
      for (const [index, summary] of existingContext.purposeSummaries.entries()) {
        activeSymbolPath = summary.path
        const embeddingTextHash = hashSemanticText(summary.embeddingText)
        const previousEmbedding = previousEmbeddingBySymbolId.get(summary.symbolId)
        const embedding =
          previousEmbedding &&
          existingContext.semanticEmbeddingModelId === SEMANTIC_EMBEDDING_MODEL_ID &&
          previousEmbedding.textHash === embeddingTextHash
            ? previousEmbedding
            : (
                await requestSemanticEmbeddings([
                  {
                    id: summary.symbolId,
                    text: summary.embeddingText,
                    textHash: embeddingTextHash,
                  },
                ])
              )[0]

        nextEmbeddings.push(embedding)

        const partialContext: PreprocessedWorkspaceContext = {
          ...existingContext,
          semanticEmbeddingModelId: SEMANTIC_EMBEDDING_MODEL_ID,
          semanticEmbeddings: nextEmbeddings.slice(),
        }

        hydratePreprocessedWorkspaceContext(partialContext)
        setPreprocessedWorkspaceContext(partialContext)
        await persistPreprocessedWorkspaceContext(partialContext)

        setPreprocessingStatus((current) => ({
          ...current,
          activity: 'embeddings',
          processedSymbols: index + 1,
          semanticEmbeddingCount: index + 1,
        }))
      }

      const context: PreprocessedWorkspaceContext = {
        ...existingContext,
        semanticEmbeddingModelId: SEMANTIC_EMBEDDING_MODEL_ID,
        semanticEmbeddings: nextEmbeddings,
      }

      hydratePreprocessedWorkspaceContext(context)
      setPreprocessedWorkspaceContext(context)
      setPreprocessingStatus((current) => ({
        ...current,
        runState: 'ready',
        activity: null,
        updatedAt: new Date().toISOString(),
        semanticEmbeddingCount: nextEmbeddings.length,
        processedSymbols: nextEmbeddings.length,
      }))
      await persistPreprocessedWorkspaceContext(context)
      setWorkspaceSyncStatus(await fetchWorkspaceSyncStatus())
    } catch (error) {
      setPreprocessingStatus((current) => ({
        ...current,
        runState: 'error',
        activity: 'embeddings',
        lastError:
          activeSymbolPath
            ? `Embedding failed on ${activeSymbolPath}: ${error instanceof Error ? error.message : 'Unknown embedding error.'}`
            : error instanceof Error
              ? error.message
              : 'Failed to build semantic embeddings.',
      }))
    }
  }

  async function refreshLayoutState() {
    const [response, workspaceSyncStatus] = await Promise.all([
      fetch(SEMANTICODE_LAYOUTS_ROUTE),
      fetchWorkspaceSyncStatus(),
    ])

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Layout state request failed with status ${response.status}.`,
      ))
    }

    const layoutState = (await response.json()) as LayoutStateResponse

    startTransition(() => {
      setLayouts(layoutState.layouts)
      setDraftLayouts(layoutState.draftLayouts)
      setWorkspaceSyncStatus(workspaceSyncStatus)
    })

    return layoutState
  }

  async function handleSuggestLayout(layoutBrief: string) {
    if (!snapshot?.rootDir) {
      setLayoutSuggestionError('The repository snapshot is not available yet.')
      return
    }

    const trimmedBrief = layoutBrief.trim()

    if (!trimmedBrief) {
      setLayoutSuggestionError('Enter a layout brief first.')
      return
    }

    setLayoutSuggestionPending(true)
    setLayoutSuggestionError(null)

    const existingDraftIds = new Set(draftLayouts.map((draft) => draft.id))

    try {
      const response = await fetch(SEMANTICODE_AGENT_MESSAGE_ROUTE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: buildLayoutSuggestionPrompt(snapshot.rootDir, trimmedBrief),
        }),
      })

      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(
          response,
          `Layout suggestion request failed with status ${response.status}.`,
        ))
      }

      const nextDraft = await waitForSuggestedLayoutDraft({
        existingDraftIds,
      })

      startTransition(() => {
        setActiveLayoutId(null)
        setActiveDraftId(nextDraft.id)
        setErrorMessage(null)
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to generate a layout draft.'
      setLayoutSuggestionError(message)
    } finally {
      setLayoutSuggestionPending(false)
    }
  }

  async function waitForSuggestedLayoutDraft(input: {
    existingDraftIds: Set<string>
  }) {
    const timeoutAt = Date.now() + 180_000

    while (Date.now() < timeoutAt) {
      const [layoutResponse, agentResponse] = await Promise.all([
        fetch(SEMANTICODE_LAYOUTS_ROUTE),
        fetch(SEMANTICODE_AGENT_SESSION_ROUTE),
      ])

      if (!layoutResponse.ok) {
        throw new Error(await getResponseErrorMessage(
          layoutResponse,
          `Layout state request failed with status ${layoutResponse.status}.`,
        ))
      }

      if (!agentResponse.ok) {
        throw new Error(await getResponseErrorMessage(
          agentResponse,
          `Agent session request failed with status ${agentResponse.status}.`,
        ))
      }

      const [layoutState, agentState] = (await Promise.all([
        layoutResponse.json(),
        agentResponse.json(),
      ])) as [LayoutStateResponse, AgentStateResponse]

      startTransition(() => {
        setLayouts(layoutState.layouts)
        setDraftLayouts(layoutState.draftLayouts)
      })

      const nextDraft = layoutState.draftLayouts.find(
        (draft) =>
          draft.status === 'draft' &&
          Boolean(draft.layout) &&
          !input.existingDraftIds.has(draft.id),
      )

      if (nextDraft) {
        return nextDraft
      }

      if (agentState.session?.runState === 'error') {
        throw new Error(
          agentState.session.lastError ?? 'The agent failed before saving a layout draft.',
        )
      }

      await delay(1500)
    }

    throw new Error('Timed out waiting for a new layout draft.')
  }

  async function handleAcceptDraft(draftId: string) {
    setLayoutActionPending(true)

    try {
      const response = await fetch(
        buildSemanticodeDraftActionRoute(draftId, 'accept'),
        {
          method: 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(
          response,
          `Accept draft failed with status ${response.status}.`,
        ))
      }

      const result = (await response.json()) as DraftMutationResponse

      await refreshLayoutState()

      startTransition(() => {
        setActiveDraftId(null)
        setActiveLayoutId(result.layout?.id ?? null)
        setErrorMessage(null)
      })
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to accept layout draft.',
      )
    } finally {
      setLayoutActionPending(false)
    }
  }

  async function handleRejectDraft(draftId: string) {
    setLayoutActionPending(true)

    try {
      const response = await fetch(
        buildSemanticodeDraftActionRoute(draftId, 'reject'),
        {
          method: 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(await getResponseErrorMessage(
          response,
          `Reject draft failed with status ${response.status}.`,
        ))
      }

      await refreshLayoutState()

      if (activeDraftId === draftId) {
        startTransition(() => {
          setActiveDraftId(null)
        })
      }

      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to reject layout draft.',
      )
    } finally {
      setLayoutActionPending(false)
    }
  }

  return (
    <main className="demo-page">
      {status === 'loading' || status === 'idle' ? (
        <section className="demo-status">Indexing files from the current workspace...</section>
      ) : errorMessage ? (
        <section className="demo-status is-error">{errorMessage}</section>
      ) : (
        <Semanticode
          layoutActionsPending={layoutActionPending}
          onAgentRunSettled={refreshWorkspaceState}
          onBuildSemanticEmbeddings={handleBuildSemanticEmbeddings}
          layoutSuggestionError={layoutSuggestionError}
          layoutSuggestionPending={layoutSuggestionPending}
          onAcceptDraft={handleAcceptDraft}
          onRejectDraft={handleRejectDraft}
          onSuggestLayout={handleSuggestLayout}
          onStartPreprocessing={handleStartPreprocessing}
          preprocessedWorkspaceContext={preprocessedWorkspaceContext}
          preprocessingStatus={preprocessingStatus}
          workspaceSyncStatus={workspaceSyncStatus}
          workspaceProfile={preprocessedWorkspaceContext?.workspaceProfile ?? null}
        />
      )}
    </main>
  )
}

async function fetchWorkspaceState() {
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

function buildLayoutSuggestionPrompt(rootDir: string, layoutBrief: string) {
  const instructionsPath = `${rootDir}/.semanticode/INSTRUCTIONS.md`

  return [
    `Look up "${instructionsPath}" and follow it to construct a new Semanticode layout draft for this repository.`,
    'Use the following layout brief:',
    layoutBrief,
    'Save the result as a draft layout so it appears in Semanticode.',
    'Do not answer with prose in chat. Do the work and stop after the draft has been saved.',
  ].join('\n\n')
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
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

async function fetchPersistedPreprocessedWorkspaceContext() {
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

async function fetchWorkspaceSyncStatus() {
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

async function persistPreprocessedWorkspaceContext(
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

async function requestLLMSemanticSummary(message: string) {
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

async function requestSemanticEmbeddings(
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

function filterEmbeddingsForSummaries(
  context: PreprocessedWorkspaceContext | null,
  summaries: PreprocessedWorkspaceContext['purposeSummaries'],
) {
  if (!context?.semanticEmbeddings.length || !context.semanticEmbeddingModelId) {
    return []
  }

  const embeddingsBySymbolId = new Map(
    context.semanticEmbeddings.map((embedding) => [embedding.symbolId, embedding]),
  )

  return summaries.flatMap((summary) => {
    const embedding = embeddingsBySymbolId.get(summary.symbolId)
    const embeddingTextHash = hashSemanticText(summary.embeddingText)

    return embedding && embedding.textHash === embeddingTextHash ? [embedding] : []
  })
}

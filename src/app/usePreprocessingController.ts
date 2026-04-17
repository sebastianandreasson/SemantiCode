import { startTransition, useEffect, useRef, useState } from 'react'

import {
  SEMANTIC_EMBEDDING_MODEL_ID,
  fetchWorkspaceSyncStatus,
  persistPreprocessedWorkspaceContext,
  requestLLMSemanticSummary,
  requestSemanticEmbeddings,
} from './apiClient'
import {
  countPreprocessableSymbols,
  getPreprocessableSymbols,
  getPreprocessedSnapshotId,
  hydratePreprocessedWorkspaceContext,
  preprocessWorkspaceSnapshotIncrementally,
} from '../preprocessing/preprocessingService'
import { buildWorkspaceProfile } from '../preprocessing/workspaceProfile'
import {
  buildSemanticPurposeSummaryPrompt,
  buildSemanticPurposeSummaryRecordFromModelOutput,
  parseSemanticPurposeSummaryResponse,
} from '../semantic/purposeSummaries'
import { buildSemanticSymbolTextRecord, hashSemanticText } from '../semantic/symbolText'
import type {
  CodebaseSnapshot,
  PreprocessedWorkspaceContext,
  PreprocessingStatus,
  WorkspaceArtifactSyncStatus,
} from '../types'

interface UsePreprocessingControllerInput {
  snapshot: CodebaseSnapshot | null
  getFallbackSnapshot: () => CodebaseSnapshot | null
  onWorkspaceSyncStatusChange: (status: WorkspaceArtifactSyncStatus) => void
}

export function usePreprocessingController(
  input: UsePreprocessingControllerInput,
) {
  const [preprocessedWorkspaceContext, setPreprocessedWorkspaceContext] =
    useState<PreprocessedWorkspaceContext | null>(null)
  const [preprocessingStatus, setPreprocessingStatus] = useState<PreprocessingStatus>({
    activity: null,
    runState: 'idle',
    updatedAt: null,
    purposeSummaryCount: 0,
    semanticEmbeddingCount: 0,
    lastError: null,
    currentItemPath: null,
    processedSymbols: 0,
    snapshotId: null,
    totalSymbols: 0,
  })
  const preprocessingRunIdRef = useRef(0)
  const preprocessedWorkspaceContextRef = useRef<PreprocessedWorkspaceContext | null>(null)

  useEffect(() => {
    preprocessedWorkspaceContextRef.current = preprocessedWorkspaceContext
  }, [preprocessedWorkspaceContext])

  function applyLoadedWorkspaceState(
    snapshot: CodebaseSnapshot,
    persistedContext: PreprocessedWorkspaceContext | null,
  ) {
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

      setPreprocessedWorkspaceContext(persistedContext)
      setPreprocessingStatus(
        persistedContext
          ? {
              runState: isPersistedContextReady ? 'ready' : 'stale',
              activity: null,
              updatedAt: persistedContext.workspaceProfile.generatedAt,
              purposeSummaryCount: persistedContext.purposeSummaries.length,
              semanticEmbeddingCount: persistedContext.semanticEmbeddings.length,
              lastError: null,
              currentItemPath: null,
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
              currentItemPath: null,
              processedSymbols: 0,
              snapshotId: null,
              totalSymbols,
            },
      )
    })
  }

  function resetForSnapshot(snapshot: CodebaseSnapshot) {
    startTransition(() => {
      setPreprocessingStatus({
        runState: 'idle',
        activity: null,
        updatedAt: null,
        purposeSummaryCount: 0,
        semanticEmbeddingCount: 0,
        lastError: null,
        currentItemPath: null,
        processedSymbols: 0,
        snapshotId: null,
        totalSymbols: countPreprocessableSymbols(snapshot),
      })
    })
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
        currentItemPath: null,
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
        currentItemPath: null,
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
                currentItemPath: null,
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
              currentItemPath: null,
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
              currentItemPath: current.currentItemPath,
              processedSymbols: current.processedSymbols,
              snapshotId: current.snapshotId,
              totalSymbols: current.totalSymbols,
            }))
          })
        })
    }, 0)
  }

  function handleStartPreprocessing() {
    const nextSnapshot = input.snapshot ?? input.getFallbackSnapshot()

    if (!nextSnapshot) {
      startTransition(() => {
        setPreprocessingStatus((current) => ({
          ...current,
          runState: 'error',
          activity: current.activity,
          lastError: 'The workspace snapshot is not ready yet.',
          currentItemPath: null,
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
      currentItemPath: null,
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
        currentItemPath: null,
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
        setPreprocessingStatus((current) => ({
          ...current,
          activity: 'summaries',
          currentItemPath: symbol.path,
        }))
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

        setPreprocessingStatus((current) => ({
          ...current,
          activity: 'summaries',
          currentItemPath: symbol.path,
          processedSymbols: index + 1,
          purposeSummaryCount: index + 1,
        }))
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
          currentItemPath: null,
          processedSymbols: context.purposeSummaries.length,
          snapshotId: context.snapshotId,
          totalSymbols: context.purposeSummaries.length,
        })
      })

      await persistPreprocessedWorkspaceContext(context)
      input.onWorkspaceSyncStatusChange(await fetchWorkspaceSyncStatus())
    } catch (error) {
      if (preprocessingRunIdRef.current !== runId) {
        return
      }

      startTransition(() => {
        setPreprocessingStatus((current) => ({
          ...current,
          runState: 'error',
          activity: 'summaries',
          currentItemPath: activeSymbolPath,
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
    const nextSnapshot = input.snapshot ?? input.getFallbackSnapshot()
    const existingContext = preprocessedWorkspaceContextRef.current

    if (!nextSnapshot || !existingContext?.purposeSummaries.length) {
      setPreprocessingStatus((current) => ({
        ...current,
        runState: 'error',
        activity: 'embeddings',
        lastError: 'Build summaries with the agent before generating embeddings.',
        currentItemPath: null,
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
      currentItemPath: null,
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
        setPreprocessingStatus((current) => ({
          ...current,
          activity: 'embeddings',
          currentItemPath: summary.path,
        }))
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
          currentItemPath: summary.path,
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
        currentItemPath: null,
        semanticEmbeddingCount: nextEmbeddings.length,
        processedSymbols: nextEmbeddings.length,
      }))
      await persistPreprocessedWorkspaceContext(context)
      input.onWorkspaceSyncStatusChange(await fetchWorkspaceSyncStatus())
    } catch (error) {
      setPreprocessingStatus((current) => ({
        ...current,
        runState: 'error',
        activity: 'embeddings',
        currentItemPath: activeSymbolPath,
        lastError:
          activeSymbolPath
            ? `Embedding failed on ${activeSymbolPath}: ${error instanceof Error ? error.message : 'Unknown embedding error.'}`
            : error instanceof Error
              ? error.message
              : 'Failed to build semantic embeddings.',
      }))
    }
  }

  return {
    preprocessedWorkspaceContext,
    preprocessedWorkspaceContextRef,
    preprocessingStatus,
    applyLoadedWorkspaceState,
    resetForSnapshot,
    startBackgroundPreprocessing,
    handleStartPreprocessing,
    handleBuildSemanticEmbeddings,
  }
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

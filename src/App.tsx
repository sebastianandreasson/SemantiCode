import { startTransition, useState } from 'react'

import { Semanticode } from './index'
import {
  fetchLayoutState,
  fetchWorkspaceState,
  fetchWorkspaceSyncStatus,
} from './app/apiClient'
import { useLayoutDraftController } from './app/useLayoutDraftController'
import { usePreprocessingController } from './app/usePreprocessingController'
import { useWorkspaceBootstrap } from './app/useWorkspaceBootstrap'
import { hydratePreprocessedWorkspaceContext } from './preprocessing/preprocessingService'
import type { WorkspaceArtifactSyncStatus } from './types'
import { useVisualizerStore, visualizerStore } from './store/visualizerStore'

export default function App() {
  const [workspaceSyncStatus, setWorkspaceSyncStatus] =
    useState<WorkspaceArtifactSyncStatus | null>(null)
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
  const {
    preprocessedWorkspaceContext,
    preprocessedWorkspaceContextRef,
    preprocessingStatus,
    applyLoadedWorkspaceState,
    resetForSnapshot,
    startBackgroundPreprocessing,
    handleStartPreprocessing,
    handleBuildSemanticEmbeddings,
  } = usePreprocessingController({
    snapshot,
    getFallbackSnapshot: () => visualizerStore.getState().snapshot,
    onWorkspaceSyncStatusChange: setWorkspaceSyncStatus,
  })
  const {
    layoutActionPending,
    layoutSuggestionPending,
    layoutSuggestionError,
    handleAcceptDraft,
    handleRejectDraft,
    handleSuggestLayout,
  } = useLayoutDraftController({
    activeDraftId,
    draftLayouts,
    rootDir: snapshot?.rootDir ?? null,
    onLayoutStateLoaded: ({ layouts, draftLayouts }) => {
      startTransition(() => {
        setLayouts(layouts)
        setDraftLayouts(draftLayouts)
      })
    },
    onAcceptApplied: (layoutId) => {
      startTransition(() => {
        setActiveDraftId(null)
        setActiveLayoutId(layoutId)
      })
    },
    onRejectApplied: () => {
      startTransition(() => {
        setActiveDraftId(null)
      })
    },
    onSuggestionApplied: (draftId) => {
      startTransition(() => {
        setActiveLayoutId(null)
        setActiveDraftId(draftId)
      })
    },
    onError: setErrorMessage,
    refreshLayoutState,
  })

  useWorkspaceBootstrap({
    onHydratePersistedContext: hydratePreprocessedWorkspaceContext,
    onLoadStart: () => {
      setStatus('loading')
    },
    onLoadSuccess: ({ snapshot, layoutState, persistedContext, workspaceSyncStatus }) => {
      startTransition(() => {
        setSnapshot(snapshot)
        setLayouts(layoutState.layouts)
        setDraftLayouts(layoutState.draftLayouts)
        setActiveLayoutId(layoutState.activeLayoutId)
        setActiveDraftId(layoutState.activeDraftId)
        setWorkspaceSyncStatus(workspaceSyncStatus)
        setErrorMessage(null)
        setStatus('ready')
      })
      applyLoadedWorkspaceState(snapshot, persistedContext)
    },
    onLoadError: (message) => {
      setErrorMessage(message)
      setStatus('error')
    },
    onReadyPersistedContext: (snapshot, persistedContext) => {
      startBackgroundPreprocessing(snapshot, persistedContext, true)
    },
    onWorkspaceSyncStatusReady: (workspaceSyncStatus) => {
      startTransition(() => {
        setWorkspaceSyncStatus(workspaceSyncStatus)
      })
    },
  })

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
      resetForSnapshot(snapshot)
    }
  }

  async function refreshWorkspaceSnapshotPreservingScene() {
    const [{ snapshot }, workspaceSyncStatus] = await Promise.all([
      fetchWorkspaceState(),
      fetchWorkspaceSyncStatus(),
    ])

    startTransition(() => {
      setSnapshot(snapshot)
      setWorkspaceSyncStatus(workspaceSyncStatus)
      setErrorMessage(null)
    })
  }

  async function refreshLayoutState() {
    const [layoutState, workspaceSyncStatus] = await Promise.all([
      fetchLayoutState(),
      fetchWorkspaceSyncStatus(),
    ])

    startTransition(() => {
      setLayouts(layoutState.layouts)
      setDraftLayouts(layoutState.draftLayouts)
      setWorkspaceSyncStatus(workspaceSyncStatus)
    })

    return layoutState
  }

  return (
    <main className="demo-page">
      {status === 'loading' || status === 'idle' ? (
        <section className="demo-status">Loading workspace snapshot...</section>
      ) : errorMessage ? (
        <section className="demo-status is-error">{errorMessage}</section>
      ) : (
        <Semanticode
          layoutActionsPending={layoutActionPending}
          onAgentRunSettled={refreshWorkspaceState}
          onLiveWorkspaceRefresh={refreshWorkspaceSnapshotPreservingScene}
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

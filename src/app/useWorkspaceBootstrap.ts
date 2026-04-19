import { useEffect, useRef } from 'react'

import {
  fetchPersistedPreprocessedWorkspaceContext,
  fetchWorkspaceState,
  fetchWorkspaceSyncStatus,
} from './apiClient'
import type {
  CodebaseSnapshot,
  LayoutStateResponse,
  PreprocessedWorkspaceContext,
  WorkspaceArtifactSyncStatus,
} from '../types'

interface UseWorkspaceBootstrapInput {
  onHydratePersistedContext: (context: PreprocessedWorkspaceContext) => void
  onLoadStart: () => void
  onLoadSuccess: (input: {
    snapshot: CodebaseSnapshot
    layoutState: LayoutStateResponse
    persistedContext: PreprocessedWorkspaceContext | null
    workspaceSyncStatus: WorkspaceArtifactSyncStatus | null
  }) => void
  onLoadError: (message: string) => void
  onWorkspaceSyncStatusReady?: (workspaceSyncStatus: WorkspaceArtifactSyncStatus) => void
  onReadyPersistedContext: (
    snapshot: CodebaseSnapshot,
    persistedContext: PreprocessedWorkspaceContext,
  ) => void
}

export function useWorkspaceBootstrap(input: UseWorkspaceBootstrapInput) {
  const callbacksRef = useRef(input)

  useEffect(() => {
    callbacksRef.current = input
  }, [input])

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
      callbacksRef.current.onLoadStart()

      try {
        const [{ layoutState, snapshot }, persistedContext] = await Promise.all([
          fetchWorkspaceState(),
          fetchPersistedPreprocessedWorkspaceContext(),
        ])

        if (isCancelled) {
          return
        }

        if (persistedContext) {
          callbacksRef.current.onHydratePersistedContext(persistedContext)
        }

        callbacksRef.current.onLoadSuccess({
          snapshot,
          layoutState,
          persistedContext,
          workspaceSyncStatus: null,
        })

        if (persistedContext?.isComplete) {
          callbacksRef.current.onReadyPersistedContext(snapshot, persistedContext)
        }

        void fetchWorkspaceSyncStatus()
          .then((workspaceSyncStatus) => {
            if (!isCancelled) {
              callbacksRef.current.onWorkspaceSyncStatusReady?.(workspaceSyncStatus)
            }
          })
          .catch(() => {
            // Sync status is advisory chrome; the workspace should remain usable if it fails.
          })
      } catch (error) {
        if (isCancelled) {
          return
        }

        callbacksRef.current.onLoadError(
          error instanceof Error ? error.message : 'Failed to load the codebase.',
        )
      }
    }

    void loadWorkspaceState()

    return () => {
      isCancelled = true
    }
  }, [])
}

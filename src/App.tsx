import { startTransition, useEffect, useState } from 'react'

import { CodebaseVisualizer } from './index'
import type {
  CodebaseSnapshot,
  DraftMutationResponse,
  LayoutStateResponse,
} from './types'
import { useVisualizerStore } from './store/visualizerStore'
import {
  buildCodebaseVisualizerDraftActionRoute,
  CODEBASE_VISUALIZER_LAYOUTS_ROUTE,
  CODEBASE_VISUALIZER_ROUTE,
} from './shared/constants'

export default function App() {
  const [layoutActionPending, setLayoutActionPending] = useState(false)
  const status = useVisualizerStore((state) => state.status)
  const errorMessage = useVisualizerStore((state) => state.errorMessage)
  const activeDraftId = useVisualizerStore((state) => state.activeDraftId)
  const setErrorMessage = useVisualizerStore((state) => state.setErrorMessage)
  const setActiveDraftId = useVisualizerStore((state) => state.setActiveDraftId)
  const setActiveLayoutId = useVisualizerStore((state) => state.setActiveLayoutId)
  const setDraftLayouts = useVisualizerStore((state) => state.setDraftLayouts)
  const setLayouts = useVisualizerStore((state) => state.setLayouts)
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setStatus = useVisualizerStore((state) => state.setStatus)

  useEffect(() => {
    let isCancelled = false

    async function loadWorkspaceState() {
      setStatus('loading')

      try {
        const [snapshotResponse, layoutStateResponse] = await Promise.all([
          fetch(CODEBASE_VISUALIZER_ROUTE),
          fetch(CODEBASE_VISUALIZER_LAYOUTS_ROUTE),
        ])

        if (!snapshotResponse.ok) {
          throw new Error(
            `Snapshot request failed with status ${snapshotResponse.status}.`,
          )
        }

        if (!layoutStateResponse.ok) {
          throw new Error(
            `Layout state request failed with status ${layoutStateResponse.status}.`,
          )
        }

        const [snapshot, layoutState] = (await Promise.all([
          snapshotResponse.json(),
          layoutStateResponse.json(),
        ])) as [CodebaseSnapshot, LayoutStateResponse]

        if (isCancelled) {
          return
        }

        startTransition(() => {
          setSnapshot(snapshot)
          setLayouts(layoutState.layouts)
          setDraftLayouts(layoutState.draftLayouts)
          setActiveLayoutId(layoutState.activeLayoutId)
          setActiveDraftId(layoutState.activeDraftId)
          setErrorMessage(null)
          setStatus('ready')
        })
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

  async function refreshLayoutState() {
    const response = await fetch(CODEBASE_VISUALIZER_LAYOUTS_ROUTE)

    if (!response.ok) {
      throw new Error(`Layout state request failed with status ${response.status}.`)
    }

    const layoutState = (await response.json()) as LayoutStateResponse

    startTransition(() => {
      setLayouts(layoutState.layouts)
      setDraftLayouts(layoutState.draftLayouts)
    })
  }

  async function handleAcceptDraft(draftId: string) {
    setLayoutActionPending(true)

    try {
      const response = await fetch(
        buildCodebaseVisualizerDraftActionRoute(draftId, 'accept'),
        {
          method: 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(`Accept draft failed with status ${response.status}.`)
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
        buildCodebaseVisualizerDraftActionRoute(draftId, 'reject'),
        {
          method: 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(`Reject draft failed with status ${response.status}.`)
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
        <CodebaseVisualizer
          layoutActionsPending={layoutActionPending}
          onAcceptDraft={handleAcceptDraft}
          onRejectDraft={handleRejectDraft}
        />
      )}
    </main>
  )
}

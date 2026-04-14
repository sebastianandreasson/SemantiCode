import { startTransition, useEffect } from 'react'

import { CodebaseVisualizer } from './index'
import type { CodebaseSnapshot } from './types'
import { useVisualizerStore } from './store/visualizerStore'
import { CODEBASE_VISUALIZER_ROUTE } from './vite'

export default function App() {
  const status = useVisualizerStore((state) => state.status)
  const errorMessage = useVisualizerStore((state) => state.errorMessage)
  const setErrorMessage = useVisualizerStore((state) => state.setErrorMessage)
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setStatus = useVisualizerStore((state) => state.setStatus)

  useEffect(() => {
    let isCancelled = false

    async function loadSnapshot() {
      setStatus('loading')

      try {
        const response = await fetch(CODEBASE_VISUALIZER_ROUTE)

        if (!response.ok) {
          throw new Error(`Snapshot request failed with status ${response.status}.`)
        }

        const data = (await response.json()) as CodebaseSnapshot

        if (isCancelled) {
          return
        }

        startTransition(() => {
          setSnapshot(data)
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

    void loadSnapshot()

    return () => {
      isCancelled = true
    }
  }, [setErrorMessage, setSnapshot, setStatus])

  return (
    <main className="demo-page">
      <header className="demo-header">
        <p className="demo-kicker">codebase-visualizer</p>
        <h1>Filesystem canvas with live graph overlays</h1>
        <p className="demo-copy">
          This demo reads the current project directory through the package Vite
          plugin, lays the repo out in its stored folder structure, and lets
          you turn import and call graph overlays on inside the same canvas.
        </p>
      </header>

      {status === 'loading' || status === 'idle' ? (
        <section className="demo-status">Indexing files from the current workspace...</section>
      ) : errorMessage ? (
        <section className="demo-status is-error">{errorMessage}</section>
      ) : (
        <CodebaseVisualizer />
      )}
    </main>
  )
}

import { useCallback, useEffect, useState } from 'react'

import {
  fetchGitFileDiff,
  fetchTelemetryActivity,
  fetchTelemetryHeatmap,
  fetchTelemetryOverview,
  fetchWorkspaceSyncStatus,
} from './apiClient'
import type {
  AgentHeatSample,
  DirtyFileEditSignal,
  TelemetryActivityEvent,
  TelemetryMode,
  TelemetryOverview,
  TelemetrySource,
  TelemetryWindow,
  WorkspaceArtifactSyncStatus,
} from '../types'

const FOLLOW_DIRTY_SIGNAL_MAX_FILES = 16

interface UseTelemetryControllerOptions {
  activeChatSessionId?: string | null
  activeChatWindowStartMs?: number | null
  followActiveAgent: boolean
  hasRunningAutonomousRun: boolean
  rootDir: string | null | undefined
  runsSurfaceOpen: boolean
  selectedRunId: string | null
  workspaceSyncStatus: WorkspaceArtifactSyncStatus | null
}

interface TelemetryData {
  activityEvents: TelemetryActivityEvent[]
  heatSamples: AgentHeatSample[]
  observedAt: number
  overview: TelemetryOverview | null
}

export function useTelemetryController({
  activeChatSessionId = null,
  activeChatWindowStartMs = null,
  followActiveAgent,
  hasRunningAutonomousRun,
  rootDir,
  runsSurfaceOpen,
  selectedRunId,
  workspaceSyncStatus,
}: UseTelemetryControllerOptions) {
  const [telemetrySource, setTelemetrySource] = useState<TelemetrySource>('all')
  const [telemetryWindow, setTelemetryWindow] = useState<TelemetryWindow>(60)
  const [telemetryMode, setTelemetryMode] = useState<TelemetryMode>('symbols')
  const [telemetryEnabled, setTelemetryEnabled] = useState(false)
  const [telemetryData, setTelemetryData] = useState<TelemetryData>({
    activityEvents: [],
    heatSamples: [],
    observedAt: 0,
    overview: null,
  })
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const [liveChangedFiles, setLiveChangedFiles] = useState<string[]>([])
  const [followDirtyFileSignals, setFollowDirtyFileSignals] = useState<DirtyFileEditSignal[]>([])

  useEffect(() => {
    let cancelled = false

    if (!rootDir || !telemetryEnabled) {
      return
    }

    if (telemetryWindow === 'session' && !activeChatSessionId) {
      setTelemetryData({
        activityEvents: [],
        heatSamples: [],
        observedAt: Date.now(),
        overview: buildEmptyTelemetryOverview(telemetrySource, telemetryWindow),
      })
      setTelemetryError(null)
      return
    }

    const refreshTelemetry = async () => {
      try {
        const telemetryQuery = {
          mode: telemetryMode,
          runId: telemetryWindow === 'run' ? selectedRunId ?? undefined : undefined,
          sessionId: telemetryWindow === 'session' ? activeChatSessionId ?? undefined : undefined,
          sinceMs: telemetryWindow === 'session' ? activeChatWindowStartMs ?? undefined : undefined,
          source: telemetrySource,
          window: telemetryWindow,
        } as const
        const [overviewResponse, heatmapResponse, activityResponse] = await Promise.all([
          fetchTelemetryOverview(telemetryQuery),
          fetchTelemetryHeatmap(telemetryQuery),
          fetchTelemetryActivity(telemetryQuery),
        ])

        if (cancelled) {
          return
        }

        setTelemetryData({
          activityEvents: activityResponse.events,
          heatSamples: heatmapResponse.samples,
          observedAt: Date.now(),
          overview: overviewResponse.overview,
        })
        setTelemetryError(null)
      } catch (error) {
        if (!cancelled) {
          setTelemetryError(
            error instanceof Error ? error.message : 'Failed to load autonomous run telemetry.',
          )
        }
      }
    }

    void refreshTelemetry()
    const intervalId = window.setInterval(() => {
      void refreshTelemetry()
    }, (
      runsSurfaceOpen ||
      telemetryWindow === 'run' ||
      telemetryWindow === 'session' ||
      hasRunningAutonomousRun
    ) ? 2500 : 5000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [
    activeChatSessionId,
    activeChatWindowStartMs,
    hasRunningAutonomousRun,
    rootDir,
    runsSurfaceOpen,
    selectedRunId,
    telemetryEnabled,
    telemetryMode,
    telemetrySource,
    telemetryWindow,
  ])

  useEffect(() => {
    let cancelled = false

    if (!rootDir) {
      return
    }

    const applyChangedFiles = (changedFiles: string[]) => {
      if (!cancelled) {
        setLiveChangedFiles(changedFiles)
      }
    }

    applyChangedFiles(workspaceSyncStatus?.git.changedFiles ?? [])

    if (!followActiveAgent) {
      return () => {
        cancelled = true
      }
    }

    const refreshChangedFiles = async () => {
      try {
        const syncStatus = await fetchWorkspaceSyncStatus()

        if (cancelled) {
          return
        }

        applyChangedFiles(syncStatus.git.changedFiles)
      } catch {
        if (!cancelled) {
          applyChangedFiles(workspaceSyncStatus?.git.changedFiles ?? [])
        }
      }
    }

    void refreshChangedFiles()
    const intervalId = window.setInterval(() => {
      void refreshChangedFiles()
    }, hasRunningAutonomousRun ? 1200 : 2500)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [
    followActiveAgent,
    hasRunningAutonomousRun,
    rootDir,
    workspaceSyncStatus,
  ])

  useEffect(() => {
    let cancelled = false

    if (!rootDir || !followActiveAgent || liveChangedFiles.length === 0) {
      window.setTimeout(() => {
        if (!cancelled) {
          setFollowDirtyFileSignals([])
        }
      }, 0)

      return () => {
        cancelled = true
      }
    }

    const trackedPaths = liveChangedFiles.slice(0, FOLLOW_DIRTY_SIGNAL_MAX_FILES)

    const refreshDirtyFileSignals = async () => {
      try {
        const diffEntries = await Promise.all(
          trackedPaths.map(async (path) => {
            const diff = await fetchGitFileDiff(path).catch(() => null)
            return {
              fingerprint: buildFollowDirtySignalFingerprint(diff),
              path,
            }
          }),
        )

        if (cancelled) {
          return
        }

        const nowMs = Date.now()
        const nextChangedPathSet = new Set(trackedPaths)

        setFollowDirtyFileSignals((currentSignals) => {
          const currentByPath = new Map(
            currentSignals.map((signal) => [signal.path, signal]),
          )
          const nextSignals: DirtyFileEditSignal[] = []

          for (const entry of diffEntries) {
            if (!entry.fingerprint || !nextChangedPathSet.has(entry.path)) {
              continue
            }

            const currentSignal = currentByPath.get(entry.path)

            if (currentSignal && currentSignal.fingerprint === entry.fingerprint) {
              nextSignals.push(currentSignal)
              continue
            }

            nextSignals.push({
              changedAt: new Date(nowMs).toISOString(),
              changedAtMs: nowMs,
              fingerprint: entry.fingerprint,
              path: entry.path,
            })
          }

          return nextSignals.sort((left, right) => right.changedAtMs - left.changedAtMs)
        })
      } catch {
        if (!cancelled) {
          setFollowDirtyFileSignals((currentSignals) =>
            currentSignals.filter((signal) => trackedPaths.includes(signal.path)),
          )
        }
      }
    }

    void refreshDirtyFileSignals()
    const intervalId = window.setInterval(() => {
      void refreshDirtyFileSignals()
    }, hasRunningAutonomousRun ? 1200 : 2500)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [
    followActiveAgent,
    hasRunningAutonomousRun,
    liveChangedFiles,
    rootDir,
  ])

  const handleTelemetrySourceChange = useCallback((source: TelemetrySource) => {
    setTelemetryEnabled(true)
    setTelemetrySource(source)
  }, [])

  const handleTelemetryWindowChange = useCallback((windowValue: TelemetryWindow) => {
    setTelemetryEnabled(true)
    setTelemetryWindow(windowValue)
  }, [])

  const handleTelemetryModeChange = useCallback((mode: TelemetryMode) => {
    setTelemetryEnabled(true)
    setTelemetryMode(mode)
  }, [])

  const activateRunTelemetry = useCallback(() => {
    setTelemetryEnabled(true)
    setTelemetryWindow('run')
    setTelemetrySource('all')
  }, [])

  const enableTelemetry = useCallback(() => {
    setTelemetryEnabled(true)
  }, [])

  return {
    activateRunTelemetry,
    enableTelemetry,
    followDirtyFileSignals,
    handleTelemetryModeChange,
    handleTelemetrySourceChange,
    handleTelemetryWindowChange,
    liveChangedFiles,
    telemetryActivityEvents: telemetryData.activityEvents,
    telemetryEnabled,
    telemetryError,
    telemetryHeatSamples: telemetryData.heatSamples,
    telemetryMode,
    telemetryObservedAt: telemetryData.observedAt,
    telemetryOverview: telemetryData.overview,
    telemetrySource,
    telemetryWindow,
  }
}

function buildFollowDirtySignalFingerprint(
  diff: {
    fingerprint: string
    hasDiff: boolean
  } | null,
) {
  if (!diff?.hasDiff) {
    return null
  }

  return diff.fingerprint
}

function buildEmptyTelemetryOverview(
  source: TelemetrySource,
  window: TelemetryWindow,
): TelemetryOverview {
  return {
    activeRuns: [],
    requestCount: 0,
    source,
    topDirectories: [],
    topFiles: [],
    topTools: [],
    totalTokens: 0,
    window,
  }
}

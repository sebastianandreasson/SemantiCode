import type { Node } from '@xyflow/react'
import { useCallback, useEffect, useReducer } from 'react'

import {
  createInitialFollowControllerState,
  followControllerReducer,
} from './model'
import type {
  DirtyFileEditSignal,
  FollowCameraCommand,
  FollowDebugState,
  FollowInspectorCommand,
  FollowIntent,
  FollowRefreshCommand,
} from './types'
import type {
  AgentFileOperation,
  ProjectSnapshot,
  TelemetryActivityEvent,
  TelemetryMode,
  VisualizerViewMode,
} from '../../types'

interface UseAgentFollowControllerInput {
  dirtyFileEditSignals: DirtyFileEditSignal[]
  enabled: boolean
  fileOperations: AgentFileOperation[]
  liveChangedFiles: string[]
  snapshot: ProjectSnapshot | null
  telemetryActivityEvents: TelemetryActivityEvent[]
  telemetryEnabled: boolean
  telemetryMode: TelemetryMode
  viewMode: VisualizerViewMode
  visibleNodes: Node[]
}

export function useAgentFollowController(
  input: UseAgentFollowControllerInput,
) {
  const [state, dispatch] = useReducer(
    followControllerReducer,
    undefined,
    createInitialFollowControllerState,
  )

  useEffect(() => {
    dispatch({
      type: 'FOLLOW_TOGGLED',
      enabled: input.enabled,
      nowMs: Date.now(),
    })
  }, [input.enabled])

  useEffect(() => {
    dispatch({
      type: 'TELEMETRY_BATCH_UPDATED',
      nowMs: Date.now(),
      telemetryActivityEvents: input.telemetryActivityEvents,
      telemetryEnabled: input.telemetryEnabled,
    })
  }, [input.telemetryActivityEvents, input.telemetryEnabled])

  useEffect(() => {
    dispatch({
      type: 'FILE_OPERATIONS_UPDATED',
      fileOperations: input.fileOperations,
      nowMs: Date.now(),
    })
  }, [input.fileOperations])

  useEffect(() => {
    dispatch({
      type: 'DIRTY_FILES_UPDATED',
      liveChangedFiles: input.liveChangedFiles,
      nowMs: Date.now(),
    })
  }, [input.liveChangedFiles])

  useEffect(() => {
    dispatch({
      type: 'DIRTY_FILE_SIGNALS_UPDATED',
      nowMs: Date.now(),
      signals: input.dirtyFileEditSignals,
    })
  }, [input.dirtyFileEditSignals])

  useEffect(() => {
    dispatch({
      type: 'SNAPSHOT_CONTEXT_UPDATED',
      nowMs: Date.now(),
      snapshot: input.snapshot,
      visibleNodeIds: input.visibleNodes.map((node) => node.id),
    })
  }, [input.snapshot, input.visibleNodes])

  useEffect(() => {
    dispatch({
      type: 'VIEW_MODE_CHANGED',
      mode: input.telemetryMode,
      nowMs: Date.now(),
      viewMode: input.viewMode,
    })
  }, [input.telemetryMode, input.viewMode])

  useEffect(() => {
    if (!state.enabled || state.cameraLockUntilMs <= state.nowMs) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      dispatch({
        type: 'CLOCK_TICKED',
        nowMs: Date.now(),
      })
    }, Math.max(0, state.cameraLockUntilMs - state.nowMs))

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [state.cameraLockUntilMs, state.enabled, state.nowMs])

  const acknowledgeCameraCommand = useCallback((input: {
    commandId: string
    intent: FollowIntent
  }) => {
    dispatch({
      type: 'COMMAND_ACKNOWLEDGED',
      commandId: input.commandId,
      commandType: 'camera',
      intent: input.intent,
      nowMs: Date.now(),
    })
  }, [])

  const acknowledgeInspectorCommand = useCallback((input: {
    commandId: string
    pendingPath?: string | null
  }) => {
    dispatch({
      type: 'COMMAND_ACKNOWLEDGED',
      commandId: input.commandId,
      commandType: 'inspector',
      nowMs: Date.now(),
      pendingPath: input.pendingPath ?? null,
    })
  }, [])

  const acknowledgeRefreshCommand = useCallback((commandId: string) => {
    dispatch({
      type: 'COMMAND_ACKNOWLEDGED',
      commandId,
      commandType: 'refresh',
      nowMs: Date.now(),
    })
  }, [])

  const setRefreshStatus = useCallback((status: 'idle' | 'in_flight') => {
    dispatch({
      type: 'REFRESH_STATUS_CHANGED',
      nowMs: Date.now(),
      status,
    })
  }, [])

  return {
    cameraCommand: state.currentCameraCommand as FollowCameraCommand | null,
    debugState: state.debug as FollowDebugState,
    inspectorCommand: state.currentInspectorCommand as FollowInspectorCommand | null,
    refreshCommand: state.currentRefreshCommand as FollowRefreshCommand | null,
    acknowledgeCameraCommand,
    acknowledgeInspectorCommand,
    acknowledgeRefreshCommand,
    setRefreshStatus,
  }
}

import type { VisualizerViewMode } from '../../schema/layout'
import type { ProjectSnapshot } from '../../schema/snapshot'
import type { TelemetryActivityEvent, TelemetryMode } from '../../schema/telemetry'
import {
  appendAcknowledgedCommandId,
  buildCameraCommand,
  buildFollowDebugState,
  buildInspectorCommand,
  buildRefreshCommand,
  countQueuedCameraTargets,
  createCameraCommandId,
  FOLLOW_AGENT_EDIT_CAMERA_LOCK_MS,
  pruneAcknowledgedCameraCommandIds,
  pruneAcknowledgedInspectorCommandIds,
} from './commands'
import {
  compareFollowEventsDescending,
  compareFollowEventsForPlayback,
  createDirtyFileFollowEvent,
  createDirtySignalFollowEvent,
  createFileOperationFollowEvent,
  createTelemetryFollowEvent,
  getChangedDirtySignalPaths,
  getChangedFileOperationPaths,
  shouldUseTelemetryEventForFollow,
} from './events'
import {
  buildFollowIndexes,
  buildSnapshotSignature,
  countSnapshotSymbols,
  getPreferredFollowSymbolIdsForFile,
} from './snapshot'
import type {
  FollowControllerAction,
  FollowControllerState,
  FollowDomainEvent,
  FollowFileEvent,
  FollowIndexes,
  FollowIntent,
  FollowTargetConfidence,
  ResolvedFollowTarget,
} from './types'

export function createInitialFollowControllerState(): FollowControllerState {
  const nowMs = Date.now()

  return {
    cameraLockUntilMs: 0,
    currentCameraCommand: null,
    currentInspectorCommand: null,
    currentRefreshCommand: null,
    debug: {
      cameraLockActive: false,
      cameraLockUntilMs: 0,
      currentMode: 'idle',
      currentTarget: null,
      latestEvent: null,
      queueLength: 0,
      refreshInFlight: false,
      refreshPending: false,
    },
    enabled: false,
    fileOperations: [],
    knownChangedPaths: [],
    acknowledgedCameraCommandIds: [],
    acknowledgedInspectorCommandIds: [],
    lastAcknowledgedCameraCommandId: null,
    lastAcknowledgedInspectorCommandId: null,
    lastAcknowledgedRefreshCommandId: null,
    latestNormalizedEvent: null,
    latestResolvedActivityTarget: null,
    latestResolvedEditTarget: null,
    liveChangedFiles: [],
    dirtyFileEditSignals: [],
    nowMs,
    pendingDirtyPaths: [],
    refreshInFlight: false,
    refreshPending: false,
    refreshRequestedAtMs: null,
    snapshot: null,
    snapshotSignature: null,
    symbolCount: 0,
    telemetryActivityEvents: [],
    telemetryEnabled: false,
    telemetryMode: 'files',
    viewMode: 'filesystem',
    visibleNodeIds: [],
  }
}

export function followControllerReducer(
  state: FollowControllerState,
  action: FollowControllerAction,
): FollowControllerState {
  switch (action.type) {
    case 'FOLLOW_TOGGLED': {
      if (!action.enabled) {
        return deriveFollowControllerState({
          ...state,
          cameraLockUntilMs: 0,
          currentCameraCommand: null,
          currentInspectorCommand: null,
          currentRefreshCommand: null,
          enabled: false,
          fileOperations: [],
          knownChangedPaths: [],
          acknowledgedCameraCommandIds: [],
          acknowledgedInspectorCommandIds: [],
          lastAcknowledgedCameraCommandId: null,
          lastAcknowledgedInspectorCommandId: null,
          lastAcknowledgedRefreshCommandId: null,
          liveChangedFiles: [],
          nowMs: action.nowMs,
          pendingDirtyPaths: [],
          refreshInFlight: false,
          refreshPending: false,
          refreshRequestedAtMs: null,
          latestNormalizedEvent: createLifecycleEvent('follow_disabled', action.nowMs),
        })
      }

      return deriveFollowControllerState({
        ...state,
        acknowledgedCameraCommandIds: state.enabled
          ? state.acknowledgedCameraCommandIds
          : [],
        acknowledgedInspectorCommandIds: state.enabled
          ? state.acknowledgedInspectorCommandIds
          : [],
        enabled: true,
        nowMs: action.nowMs,
        latestNormalizedEvent: createLifecycleEvent('follow_enabled', action.nowMs),
      })
    }
    case 'TELEMETRY_BATCH_UPDATED':
      return deriveFollowControllerState({
        ...state,
        nowMs: action.nowMs,
        telemetryActivityEvents: action.telemetryActivityEvents,
        telemetryEnabled: action.telemetryEnabled,
      })
    case 'FILE_OPERATIONS_UPDATED': {
      const reprioritizedPaths = getChangedFileOperationPaths({
        nextOperations: action.fileOperations,
        previousOperations: state.fileOperations,
      })

      return deriveFollowControllerState({
        ...state,
        fileOperations: action.fileOperations,
        nowMs: action.nowMs,
        pendingDirtyPaths: state.enabled
          ? computePendingEditedPaths({
              currentPendingPaths: state.pendingDirtyPaths,
              liveChangedFiles: state.liveChangedFiles,
              previousChangedPaths: new Set(state.knownChangedPaths),
              reprioritizedPaths,
              telemetryActivityEvents: state.telemetryActivityEvents,
            })
          : [],
      })
    }
    case 'DIRTY_FILES_UPDATED': {
      const previousChangedPaths = new Set(state.knownChangedPaths)

      return deriveFollowControllerState({
        ...state,
        knownChangedPaths: [...new Set(action.liveChangedFiles)],
        liveChangedFiles: action.liveChangedFiles,
        nowMs: action.nowMs,
        pendingDirtyPaths: state.enabled
          ? computePendingEditedPaths({
              currentPendingPaths: state.pendingDirtyPaths,
              liveChangedFiles: action.liveChangedFiles,
              previousChangedPaths,
              reprioritizedPaths: [],
              telemetryActivityEvents: state.telemetryActivityEvents,
            })
          : [],
      })
    }
    case 'DIRTY_FILE_SIGNALS_UPDATED': {
      const reprioritizedPaths = getChangedDirtySignalPaths({
        nextSignals: action.signals,
        previousSignals: state.dirtyFileEditSignals,
      })

      return deriveFollowControllerState({
        ...state,
        dirtyFileEditSignals: action.signals,
        nowMs: action.nowMs,
        pendingDirtyPaths: state.enabled
          ? computePendingEditedPaths({
              currentPendingPaths: state.pendingDirtyPaths,
              liveChangedFiles: state.liveChangedFiles,
              previousChangedPaths: new Set(state.knownChangedPaths),
              reprioritizedPaths,
              telemetryActivityEvents: state.telemetryActivityEvents,
            })
          : [],
      })
    }
    case 'SNAPSHOT_CONTEXT_UPDATED': {
      const nextSnapshotSignature = buildSnapshotSignature(action.snapshot)
      const nextSymbolCount = countSnapshotSymbols(action.snapshot)
      let latestNormalizedEvent = state.latestNormalizedEvent

      if (nextSnapshotSignature !== state.snapshotSignature) {
        latestNormalizedEvent =
          nextSymbolCount > state.symbolCount
            ? createLifecycleEvent('symbols_available', action.nowMs)
            : createLifecycleEvent('snapshot_refreshed', action.nowMs)
      }

      return deriveFollowControllerState({
        ...state,
        latestNormalizedEvent,
        nowMs: action.nowMs,
        snapshot: action.snapshot,
        snapshotSignature: nextSnapshotSignature,
        symbolCount: nextSymbolCount,
        visibleNodeIds: action.visibleNodeIds,
      })
    }
    case 'VIEW_MODE_CHANGED': {
      const latestNormalizedEvent =
        action.mode !== state.telemetryMode
          ? createViewChangedEvent(action.mode, action.nowMs)
          : state.latestNormalizedEvent

      return deriveFollowControllerState({
        ...state,
        latestNormalizedEvent,
        nowMs: action.nowMs,
        telemetryMode: action.mode,
        viewMode: action.viewMode,
      })
    }
    case 'COMMAND_ACKNOWLEDGED': {
      const nextState: FollowControllerState = {
        ...state,
        nowMs: action.nowMs,
      }

      if (action.commandType === 'camera') {
        nextState.acknowledgedCameraCommandIds = appendAcknowledgedCommandId(
          nextState.acknowledgedCameraCommandIds,
          action.commandId,
        )
        nextState.lastAcknowledgedCameraCommandId = action.commandId

        if (action.intent === 'edit') {
          nextState.cameraLockUntilMs = action.nowMs + FOLLOW_AGENT_EDIT_CAMERA_LOCK_MS
        }
      }

      if (action.commandType === 'inspector') {
        nextState.acknowledgedInspectorCommandIds = appendAcknowledgedCommandId(
          nextState.acknowledgedInspectorCommandIds,
          action.commandId,
        )
        nextState.lastAcknowledgedInspectorCommandId = action.commandId

        if (action.pendingPath) {
          nextState.pendingDirtyPaths = nextState.pendingDirtyPaths.filter(
            (path) => path !== action.pendingPath,
          )
        }
      }

      if (action.commandType === 'refresh') {
        nextState.lastAcknowledgedRefreshCommandId = action.commandId
        nextState.refreshPending = true
        nextState.refreshRequestedAtMs = action.nowMs
      }

      return deriveFollowControllerState(nextState)
    }
    case 'REFRESH_STATUS_CHANGED':
      return deriveFollowControllerState({
        ...state,
        nowMs: action.nowMs,
        refreshInFlight: action.status === 'in_flight',
        refreshPending: action.status !== 'idle',
        refreshRequestedAtMs:
          action.status === 'idle' ? null : state.refreshRequestedAtMs ?? action.nowMs,
      })
    case 'CLOCK_TICKED':
      return deriveFollowControllerState({
        ...state,
        nowMs: action.nowMs,
      })
  }
}

export function computePendingEditedPaths(input: {
  currentPendingPaths: string[]
  previousChangedPaths: ReadonlySet<string>
  liveChangedFiles: string[]
  reprioritizedPaths: string[]
  telemetryActivityEvents: TelemetryActivityEvent[]
}) {
  const nextChangedPaths = new Set(input.liveChangedFiles)
  const newChangedPaths = input.liveChangedFiles.filter(
    (path) => !input.previousChangedPaths.has(path),
  )
  const prioritizedPaths = [...new Set(
    input.reprioritizedPaths.filter((path) => nextChangedPaths.has(path)),
  )]

  if (newChangedPaths.length === 0 && prioritizedPaths.length === 0) {
    return input.currentPendingPaths.filter((path) => nextChangedPaths.has(path))
  }

  const telemetryIndexByPath = new Map<string, number>()

  input.telemetryActivityEvents
    .filter(shouldUseTelemetryEventForFollow)
    .forEach((event, index) => {
      if (!telemetryIndexByPath.has(event.path)) {
        telemetryIndexByPath.set(event.path, index)
      }
    })

  newChangedPaths.sort((leftPath, rightPath) => {
    const leftIndex = telemetryIndexByPath.get(leftPath) ?? Number.MAX_SAFE_INTEGER
    const rightIndex = telemetryIndexByPath.get(rightPath) ?? Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex
  })

  const candidatePaths = [...prioritizedPaths]

  for (const path of newChangedPaths) {
    if (!candidatePaths.includes(path)) {
      candidatePaths.push(path)
    }
  }

  const existingPending = input.currentPendingPaths.filter(
    (path) => nextChangedPaths.has(path) && !candidatePaths.includes(path),
  )
  const nextPending = [...candidatePaths]

  for (const path of existingPending) {
    if (!nextPending.includes(path)) {
      nextPending.push(path)
    }
  }

  return nextPending
}

function deriveFollowControllerState(
  state: FollowControllerState,
): FollowControllerState {
  if (!state.enabled) {
    return {
      ...state,
      currentCameraCommand: null,
      currentInspectorCommand: null,
      currentRefreshCommand: null,
      debug: buildFollowDebugState({
        cameraLockUntilMs: 0,
        currentMode: 'idle',
        currentTarget: null,
        latestEvent: state.latestNormalizedEvent,
        queueLength: 0,
        refreshInFlight: false,
        refreshPending: false,
        nowMs: state.nowMs,
      }),
      latestResolvedActivityTarget: null,
      latestResolvedEditTarget: null,
    }
  }

  const indexes = buildFollowIndexes(state.snapshot)
  const normalizedTelemetryEvents = state.telemetryEnabled
    ? state.telemetryActivityEvents
        .filter(shouldUseTelemetryEventForFollow)
        .map((event) => createTelemetryFollowEvent(event, state.nowMs))
        .sort(compareFollowEventsDescending)
    : []
  const normalizedFileOperationEvents = state.fileOperations
    .map((operation) => createFileOperationFollowEvent(operation, state.nowMs))
    .filter((event): event is FollowFileEvent => Boolean(event))
    .sort(compareFollowEventsDescending)
  const normalizedDirtyEditEvents = state.dirtyFileEditSignals
    .map(createDirtySignalFollowEvent)
    .sort(compareFollowEventsDescending)
  const normalizedActivityEvents = [
    ...normalizedFileOperationEvents,
    ...normalizedTelemetryEvents,
  ].filter((event) => event.type === 'file_touched')
    .sort(compareFollowEventsDescending)
  const normalizedEditEvents = [
    ...normalizedDirtyEditEvents,
    ...normalizedFileOperationEvents,
    ...normalizedTelemetryEvents,
  ]
    .filter((event) => event.type === 'file_edited')
    .sort(compareFollowEventsDescending)
  const latestResolvedEdit = resolveLatestEditTarget({
    indexes,
    liveChangedFiles: state.liveChangedFiles,
    mode: getFollowTargetMode(state.viewMode),
    normalizedEditEvents,
    pendingDirtyPaths: state.pendingDirtyPaths,
    snapshot: state.snapshot,
    viewMode: state.viewMode,
    visibleNodeIds: state.visibleNodeIds,
  })
  const resolvedActivityQueue = resolveActivityTargets({
    indexes,
    mode: getFollowTargetMode(state.viewMode),
    normalizedActivityEvents: [...normalizedActivityEvents].sort(compareFollowEventsForPlayback),
    snapshot: state.snapshot,
    viewMode: state.viewMode,
    visibleNodeIds: state.visibleNodeIds,
  })
  const latestResolvedActivity = resolvedActivityQueue[0] ?? null
  const candidateTargets = [
    ...(latestResolvedEdit ? [latestResolvedEdit.target] : []),
    ...resolvedActivityQueue.map((resolvedTarget) => resolvedTarget.target),
  ]
  const acknowledgedCameraCommandIds = pruneAcknowledgedCameraCommandIds({
    acknowledgedCommandIds: state.acknowledgedCameraCommandIds,
    candidateTargets,
    currentCommand: state.currentCameraCommand,
  })
  const acknowledgedInspectorCommandIds = pruneAcknowledgedInspectorCommandIds({
    acknowledgedCommandIds: state.acknowledgedInspectorCommandIds,
    candidateTargets,
    currentCommand: state.currentInspectorCommand,
  })
  const latestNormalizedEvent =
    latestResolvedEdit?.sourceEvent ??
    latestResolvedActivity?.sourceEvent ??
    state.latestNormalizedEvent
  const currentCameraCommand = buildCameraCommand({
    acknowledgedCommandIds: acknowledgedCameraCommandIds,
    cameraLockUntilMs: state.cameraLockUntilMs,
    currentCommand: state.currentCameraCommand,
    editTargets: latestResolvedEdit ? [latestResolvedEdit.target] : [],
    lastAcknowledgedCommandId: state.lastAcknowledgedCameraCommandId,
    nowMs: state.nowMs,
    activityTargets: resolvedActivityQueue.map((resolvedTarget) => resolvedTarget.target),
  })
  const currentTarget = currentCameraCommand?.target ??
    latestResolvedEdit?.target ??
    latestResolvedActivity?.target ??
    null
  const currentMode: FollowIntent | 'idle' = currentTarget?.intent ?? 'idle'
  const currentInspectorCommand = buildInspectorCommand({
    acknowledgedCommandIds: acknowledgedInspectorCommandIds,
    pendingPath:
      currentTarget?.intent === 'edit' &&
      currentTarget.eventKey === latestResolvedEdit?.target.eventKey
        ? latestResolvedEdit.pendingPath
        : null,
    target: currentTarget,
    lastAcknowledgedCommandId: state.lastAcknowledgedInspectorCommandId,
  })
  const currentRefreshCommand = buildRefreshCommand({
    editTarget: latestResolvedEdit?.target ?? null,
    lastAcknowledgedCommandId: state.lastAcknowledgedRefreshCommandId,
    refreshInFlight: state.refreshInFlight,
    refreshPending: state.refreshPending,
    viewMode: state.viewMode,
  })

  return {
    ...state,
    acknowledgedCameraCommandIds,
    acknowledgedInspectorCommandIds,
    currentCameraCommand,
    currentInspectorCommand,
    currentRefreshCommand,
    debug: buildFollowDebugState({
      cameraLockUntilMs: state.cameraLockUntilMs,
      currentMode,
      currentTarget,
      latestEvent: latestNormalizedEvent,
      queueLength: state.pendingDirtyPaths.length +
        countQueuedCameraTargets({
          acknowledgedCommandIds: acknowledgedCameraCommandIds,
          currentCommand: currentCameraCommand,
          targets: candidateTargets,
        }),
      refreshInFlight: state.refreshInFlight,
      refreshPending: state.refreshPending,
      nowMs: state.nowMs,
    }),
    latestNormalizedEvent,
    latestResolvedActivityTarget: latestResolvedActivity?.target ?? null,
    latestResolvedEditTarget: latestResolvedEdit?.target ?? null,
  }
}

function resolveActivityTargets(input: {
  indexes: FollowIndexes | null
  mode: TelemetryMode
  normalizedActivityEvents: FollowFileEvent[]
  snapshot: ProjectSnapshot | null
  viewMode: VisualizerViewMode
  visibleNodeIds: string[]
}) {
  const result: ResolvedFollowTarget[] = []
  const seenCommandIds = new Set<string>()

  for (const event of input.normalizedActivityEvents) {
    const resolvedTarget = resolveFollowTargetFromEvent({
      allowInvisibleFileFallback: input.viewMode === 'filesystem',
      indexes: input.indexes,
      intent: 'activity',
      mode: input.mode,
      snapshot: input.snapshot,
      sourceEvent: event,
      viewMode: input.viewMode,
      visibleNodeIds: input.visibleNodeIds,
    })

    if (resolvedTarget) {
      const commandId = createCameraCommandId(resolvedTarget.target)

      if (!seenCommandIds.has(commandId)) {
        seenCommandIds.add(commandId)
        result.push(resolvedTarget)
      }
    }
  }

  return result
}

function resolveLatestEditTarget(input: {
  indexes: FollowIndexes | null
  liveChangedFiles: string[]
  mode: TelemetryMode
  normalizedEditEvents: FollowFileEvent[]
  pendingDirtyPaths: string[]
  snapshot: ProjectSnapshot | null
  viewMode: VisualizerViewMode
  visibleNodeIds: string[]
}) {
  const latestEditTelemetryEvents = input.normalizedEditEvents
  const dirtyPathSet = new Set(input.liveChangedFiles)
  const nextPendingPath = input.pendingDirtyPaths[0] ?? null

  if (nextPendingPath) {
    const pendingTelemetryEvent =
      latestEditTelemetryEvents.find((event) => event.path === nextPendingPath) ??
      createDirtyFileFollowEvent(nextPendingPath)
    const pendingTarget = resolveFollowTargetFromEvent({
      allowInvisibleFileFallback: true,
      indexes: input.indexes,
      intent: 'edit',
      mode: input.mode,
      snapshot: input.snapshot,
      sourceEvent: pendingTelemetryEvent,
      viewMode: input.viewMode,
      visibleNodeIds: input.visibleNodeIds,
    })

    if (pendingTarget) {
      return {
        ...pendingTarget,
        pendingPath: nextPendingPath,
      }
    }
  }

  for (const event of latestEditTelemetryEvents) {
    if (dirtyPathSet.size > 0 && !dirtyPathSet.has(event.path)) {
      continue
    }

    const resolvedTarget = resolveFollowTargetFromEvent({
      allowInvisibleFileFallback: true,
      indexes: input.indexes,
      intent: 'edit',
      mode: input.mode,
      snapshot: input.snapshot,
      sourceEvent: event,
      viewMode: input.viewMode,
      visibleNodeIds: input.visibleNodeIds,
    })

    if (resolvedTarget) {
      return resolvedTarget
    }
  }

  if (dirtyPathSet.size === 0) {
    return null
  }

  for (const pathValue of dirtyPathSet) {
    const dirtyFallbackTarget = resolveFollowTargetFromEvent({
      allowInvisibleFileFallback: true,
      indexes: input.indexes,
      intent: 'edit',
      mode: input.mode,
      snapshot: input.snapshot,
      sourceEvent: createDirtyFileFollowEvent(pathValue),
      viewMode: input.viewMode,
      visibleNodeIds: input.visibleNodeIds,
    })

    if (dirtyFallbackTarget) {
      return dirtyFallbackTarget
    }
  }

  return null
}

function resolveFollowTargetFromEvent(input: {
  allowInvisibleFileFallback: boolean
  indexes: FollowIndexes | null
  intent: FollowIntent
  mode: TelemetryMode
  snapshot: ProjectSnapshot | null
  sourceEvent: FollowFileEvent
  viewMode: VisualizerViewMode
  visibleNodeIds: string[]
}): ResolvedFollowTarget | null {
  if (!input.snapshot || !input.indexes) {
    return null
  }

  const visibleNodeIdSet = new Set(input.visibleNodeIds)
  const fileNodeId = input.indexes.fileIdsByPath.get(input.sourceEvent.path)

  if (!fileNodeId) {
    return null
  }

  const visibleSymbolIds =
    input.mode === 'symbols'
      ? getPreferredFollowSymbolIdsForFile({
          fileId: fileNodeId,
          snapshot: input.snapshot,
          symbolIdsByFileId: input.indexes.symbolIdsByFileId,
        }).filter((nodeId) => visibleNodeIdSet.has(nodeId))
      : []

  if (visibleSymbolIds.length > 0 && input.mode === 'symbols') {
    const confidence: FollowTargetConfidence =
      visibleSymbolIds.length === 1 ? 'exact_symbol' : 'best_named_symbol'

    return {
      pendingPath: null,
      sourceEvent: input.sourceEvent,
      target: {
        confidence,
        eventKey: input.sourceEvent.eventKey,
        fileNodeId,
        intent: input.intent,
        kind: 'symbol',
        path: input.sourceEvent.path,
        primaryNodeId: visibleSymbolIds[0],
        requiresSnapshotRefresh: input.intent === 'edit' && input.viewMode === 'symbols',
        shouldOpenInspector: true,
        symbolNodeIds: visibleSymbolIds,
        timestamp: input.sourceEvent.timestamp,
        toolNames: input.sourceEvent.toolNames,
      },
    }
  }

  const fileIsVisible = visibleNodeIdSet.has(fileNodeId)

  if (!fileIsVisible && !input.allowInvisibleFileFallback) {
    return null
  }

  return {
    pendingPath: null,
    sourceEvent: input.sourceEvent,
    target: {
      confidence:
        input.sourceEvent.key.startsWith('dirty:')
          ? 'dirty_file_fallback'
          : 'file_fallback',
      eventKey: input.sourceEvent.eventKey,
      fileNodeId,
      intent: input.intent,
      kind: 'file',
      path: input.sourceEvent.path,
      primaryNodeId: fileNodeId,
      requiresSnapshotRefresh: input.intent === 'edit' && input.viewMode === 'symbols',
      shouldOpenInspector: true,
      symbolNodeIds: [],
      timestamp: input.sourceEvent.timestamp,
      toolNames: input.sourceEvent.toolNames,
    },
  }
}

function getFollowTargetMode(viewMode: VisualizerViewMode): TelemetryMode {
  return viewMode === 'symbols' ? 'symbols' : 'files'
}

function createLifecycleEvent(
  type: Extract<
    FollowDomainEvent['type'],
    'follow_enabled' | 'follow_disabled' | 'snapshot_refreshed' | 'symbols_available'
  >,
  nowMs: number,
): FollowDomainEvent {
  return {
    key: `${type}:${nowMs}`,
    timestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs,
    type,
  }
}

function createViewChangedEvent(mode: TelemetryMode, nowMs: number): FollowDomainEvent {
  return {
    key: `view:${mode}:${nowMs}`,
    mode,
    timestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs,
    type: 'view_changed',
  }
}

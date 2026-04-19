import {
  isFileNode,
  isSymbolNode,
  type AgentFileOperation,
  type ProjectSnapshot,
  type SymbolNode,
  type TelemetryActivityEvent,
  type TelemetryMode,
  type VisualizerViewMode,
} from '../types'

export const FOLLOW_AGENT_EDIT_CAMERA_LOCK_MS = 1400
const FOLLOW_AGENT_EVENT_PRIORITY_WINDOW_MS = 30_000

export type FollowTargetKind = 'symbol' | 'file'
export type FollowTargetConfidence =
  | 'exact_symbol'
  | 'best_named_symbol'
  | 'file_fallback'
  | 'dirty_file_fallback'
export type FollowIntent = 'activity' | 'edit'

export interface DirtyFileEditSignal {
  changedAt: string
  changedAtMs: number
  fingerprint: string
  path: string
}

export type FollowDomainEvent =
  | {
      type: 'file_touched' | 'file_edited'
      key: string
      eventKey: string
      path: string
      timestamp: string
      timestampMs: number
      toolNames: string[]
      sourcePriority: number
      sourceSequence: number
    }
  | {
      type: 'snapshot_refreshed' | 'symbols_available'
      key: string
      timestamp: string
      timestampMs: number
    }
  | {
      type: 'follow_enabled' | 'follow_disabled'
      key: string
      timestamp: string
      timestampMs: number
    }
  | {
      type: 'view_changed'
      key: string
      mode: TelemetryMode
      timestamp: string
      timestampMs: number
    }

export interface FollowTarget {
  kind: FollowTargetKind
  path: string
  fileNodeId: string
  symbolNodeIds: string[]
  primaryNodeId: string
  intent: FollowIntent
  confidence: FollowTargetConfidence
  eventKey: string
  toolNames: string[]
  timestamp: string
  requiresSnapshotRefresh: boolean
  shouldOpenInspector: boolean
}

export interface FollowCameraCommand {
  id: string
  target: FollowTarget
}

export interface FollowInspectorCommand {
  id: string
  pendingPath: string | null
  scrollToDiffRequestKey: string
  target: FollowTarget
}

export interface FollowRefreshCommand {
  id: string
  target: FollowTarget
}

export interface FollowDebugState {
  cameraLockActive: boolean
  cameraLockUntilMs: number
  currentMode: FollowIntent | 'idle'
  currentTarget: FollowTarget | null
  latestEvent: FollowDomainEvent | null
  queueLength: number
  refreshInFlight: boolean
  refreshPending: boolean
}

export interface FollowControllerState {
  enabled: boolean
  telemetryEnabled: boolean
  telemetryMode: TelemetryMode
  viewMode: VisualizerViewMode
  snapshot: ProjectSnapshot | null
  snapshotSignature: string | null
  symbolCount: number
  visibleNodeIds: string[]
  fileOperations: AgentFileOperation[]
  telemetryActivityEvents: TelemetryActivityEvent[]
  liveChangedFiles: string[]
  dirtyFileEditSignals: DirtyFileEditSignal[]
  pendingDirtyPaths: string[]
  knownChangedPaths: string[]
  latestNormalizedEvent: FollowDomainEvent | null
  latestResolvedActivityTarget: FollowTarget | null
  latestResolvedEditTarget: FollowTarget | null
  cameraLockUntilMs: number
  refreshPending: boolean
  refreshInFlight: boolean
  refreshRequestedAtMs: number | null
  lastAcknowledgedCameraCommandId: string | null
  lastAcknowledgedInspectorCommandId: string | null
  lastAcknowledgedRefreshCommandId: string | null
  currentCameraCommand: FollowCameraCommand | null
  currentInspectorCommand: FollowInspectorCommand | null
  currentRefreshCommand: FollowRefreshCommand | null
  debug: FollowDebugState
  nowMs: number
}

export type FollowControllerAction =
  | {
      type: 'FOLLOW_TOGGLED'
      enabled: boolean
      nowMs: number
    }
  | {
      type: 'TELEMETRY_BATCH_UPDATED'
      nowMs: number
      telemetryActivityEvents: TelemetryActivityEvent[]
      telemetryEnabled: boolean
    }
  | {
      type: 'FILE_OPERATIONS_UPDATED'
      fileOperations: AgentFileOperation[]
      nowMs: number
    }
  | {
      type: 'DIRTY_FILES_UPDATED'
      liveChangedFiles: string[]
      nowMs: number
    }
  | {
      type: 'DIRTY_FILE_SIGNALS_UPDATED'
      signals: DirtyFileEditSignal[]
      nowMs: number
    }
  | {
      type: 'SNAPSHOT_CONTEXT_UPDATED'
      nowMs: number
      snapshot: ProjectSnapshot | null
      visibleNodeIds: string[]
    }
  | {
      type: 'VIEW_MODE_CHANGED'
      mode: TelemetryMode
      nowMs: number
      viewMode: VisualizerViewMode
    }
  | {
      type: 'COMMAND_ACKNOWLEDGED'
      commandId: string
      commandType: 'camera' | 'inspector' | 'refresh'
      intent?: FollowIntent
      nowMs: number
      pendingPath?: string | null
    }
  | {
      type: 'REFRESH_STATUS_CHANGED'
      nowMs: number
      status: 'idle' | 'in_flight'
    }
  | {
      type: 'CLOCK_TICKED'
      nowMs: number
    }

type FollowFileEvent = Extract<
  FollowDomainEvent,
  { type: 'file_touched' | 'file_edited' }
>

interface FollowIndexes {
  fileIdsByPath: Map<string, string>
  symbolIdsByFileId: Map<string, string[]>
}

interface ResolvedFollowTarget {
  pendingPath: string | null
  sourceEvent: FollowFileEvent
  target: FollowTarget
}

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
        nextState.lastAcknowledgedCameraCommandId = action.commandId

        if (action.intent === 'edit') {
          nextState.cameraLockUntilMs = action.nowMs + FOLLOW_AGENT_EDIT_CAMERA_LOCK_MS
        }
      }

      if (action.commandType === 'inspector') {
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

  input.telemetryActivityEvents.forEach((event, index) => {
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

export function getPreferredFollowSymbolIdsForFile(input: {
  fileId: string
  snapshot: ProjectSnapshot
  symbolIdsByFileId: Map<string, string[]>
}) {
  const symbolIds = input.symbolIdsByFileId.get(input.fileId) ?? []
  const symbols = symbolIds
    .map((symbolId) => input.snapshot.nodes[symbolId])
    .filter(isSymbolNode)

  if (symbols.length === 0) {
    return []
  }

  const preferredSymbols = symbols.filter(isPreferredFollowSymbolNode)
  const candidates = preferredSymbols.length > 0 ? preferredSymbols : symbols

  return [...candidates]
    .sort(compareSymbolsForFollow)
    .map((symbol) => symbol.id)
}

export function isEditTelemetryEvent(toolNames: string[]) {
  return toolNames.some((toolName) => {
    const normalizedToolName = toolName.trim().toLowerCase()

    return (
      normalizedToolName.includes('apply') ||
      normalizedToolName.includes('write') ||
      normalizedToolName.includes('edit') ||
      normalizedToolName.includes('patch') ||
      normalizedToolName.includes('replace')
    )
  })
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
    ? state.telemetryActivityEvents.map((event) =>
        createTelemetryFollowEvent(event, state.nowMs),
      ).sort(compareFollowEventsDescending)
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
    mode: state.telemetryMode,
    normalizedEditEvents,
    pendingDirtyPaths: state.pendingDirtyPaths,
    snapshot: state.snapshot,
    viewMode: state.viewMode,
    visibleNodeIds: state.visibleNodeIds,
  })
  const latestResolvedActivity = resolveLatestActivityTarget({
    indexes,
    mode: state.telemetryMode,
    normalizedTelemetryEvents: normalizedActivityEvents,
    snapshot: state.snapshot,
    viewMode: state.viewMode,
    visibleNodeIds: state.visibleNodeIds,
  })
  const latestNormalizedEvent =
    latestResolvedEdit?.sourceEvent ??
    latestResolvedActivity?.sourceEvent ??
    state.latestNormalizedEvent
  const currentTarget = latestResolvedEdit?.target ?? latestResolvedActivity?.target ?? null
  const currentMode: FollowIntent | 'idle' = latestResolvedEdit
    ? 'edit'
    : latestResolvedActivity
      ? 'activity'
      : 'idle'
  const currentCameraCommand = buildCameraCommand({
    cameraLockUntilMs: state.cameraLockUntilMs,
    editTarget: latestResolvedEdit?.target ?? null,
    lastAcknowledgedCommandId: state.lastAcknowledgedCameraCommandId,
    nowMs: state.nowMs,
    activityTarget: latestResolvedActivity?.target ?? null,
  })
  const currentInspectorCommand = buildInspectorCommand({
    editTarget: latestResolvedEdit ?? null,
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
    currentCameraCommand,
    currentInspectorCommand,
    currentRefreshCommand,
    debug: buildFollowDebugState({
      cameraLockUntilMs: state.cameraLockUntilMs,
      currentMode,
      currentTarget,
      latestEvent: latestNormalizedEvent,
      queueLength: state.pendingDirtyPaths.length,
      refreshInFlight: state.refreshInFlight,
      refreshPending: state.refreshPending,
      nowMs: state.nowMs,
    }),
    latestNormalizedEvent,
    latestResolvedActivityTarget: latestResolvedActivity?.target ?? null,
    latestResolvedEditTarget: latestResolvedEdit?.target ?? null,
  }
}

function resolveLatestActivityTarget(input: {
  indexes: FollowIndexes | null
  mode: TelemetryMode
  normalizedTelemetryEvents: FollowFileEvent[]
  snapshot: ProjectSnapshot | null
  viewMode: VisualizerViewMode
  visibleNodeIds: string[]
}) {
  for (const event of input.normalizedTelemetryEvents) {
    const resolvedTarget = resolveFollowTargetFromEvent({
      allowInvisibleFileFallback: false,
      indexes: input.indexes,
      intent: 'activity',
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

  return null
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
        shouldOpenInspector: input.intent === 'edit',
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
      shouldOpenInspector: input.intent === 'edit',
      symbolNodeIds: [],
      timestamp: input.sourceEvent.timestamp,
      toolNames: input.sourceEvent.toolNames,
    },
  }
}

function buildCameraCommand(input: {
  activityTarget: FollowTarget | null
  cameraLockUntilMs: number
  editTarget: FollowTarget | null
  lastAcknowledgedCommandId: string | null
  nowMs: number
}) {
  const target = input.editTarget
    ? input.editTarget
    : input.cameraLockUntilMs <= input.nowMs
      ? input.activityTarget
      : null

  if (!target) {
    return null
  }

  const commandId = `camera:${target.intent}:${target.eventKey}:${target.primaryNodeId}:${target.confidence}`

  if (commandId === input.lastAcknowledgedCommandId) {
    return null
  }

  return {
    id: commandId,
    target,
  } satisfies FollowCameraCommand
}

function buildInspectorCommand(input: {
  editTarget: ResolvedFollowTarget | null
  lastAcknowledgedCommandId: string | null
}) {
  if (!input.editTarget?.target.shouldOpenInspector) {
    return null
  }

  const commandId = `inspector:${input.editTarget.target.path}:${input.editTarget.target.eventKey}`

  if (commandId === input.lastAcknowledgedCommandId) {
    return null
  }

  return {
    id: commandId,
    pendingPath: input.editTarget.pendingPath,
    scrollToDiffRequestKey: `edit:${input.editTarget.target.eventKey}`,
    target: input.editTarget.target,
  } satisfies FollowInspectorCommand
}

function buildRefreshCommand(input: {
  editTarget: FollowTarget | null
  lastAcknowledgedCommandId: string | null
  refreshInFlight: boolean
  refreshPending: boolean
  viewMode: VisualizerViewMode
}) {
  if (
    !input.editTarget?.requiresSnapshotRefresh ||
    input.viewMode !== 'symbols' ||
    input.refreshPending ||
    input.refreshInFlight
  ) {
    return null
  }

  const commandId = `refresh:${input.editTarget.path}:${input.editTarget.eventKey}`

  if (commandId === input.lastAcknowledgedCommandId) {
    return null
  }

  return {
    id: commandId,
    target: input.editTarget,
  } satisfies FollowRefreshCommand
}

function buildFollowDebugState(input: {
  cameraLockUntilMs: number
  currentMode: FollowIntent | 'idle'
  currentTarget: FollowTarget | null
  latestEvent: FollowDomainEvent | null
  queueLength: number
  refreshInFlight: boolean
  refreshPending: boolean
  nowMs: number
}) {
  return {
    cameraLockActive: input.cameraLockUntilMs > input.nowMs,
    cameraLockUntilMs: input.cameraLockUntilMs,
    currentMode: input.currentMode,
    currentTarget: input.currentTarget,
    latestEvent: input.latestEvent,
    queueLength: input.queueLength,
    refreshInFlight: input.refreshInFlight,
    refreshPending: input.refreshPending,
  } satisfies FollowDebugState
}

function buildFollowIndexes(snapshot: ProjectSnapshot | null): FollowIndexes | null {
  if (!snapshot) {
    return null
  }

  const fileIdsByPath = new Map<string, string>()
  const symbolIdsByFileId = new Map<string, string[]>()

  for (const node of Object.values(snapshot.nodes)) {
    if (isFileNode(node)) {
      fileIdsByPath.set(node.path, node.id)
      continue
    }

    if (isSymbolNode(node)) {
      const currentSymbolIds = symbolIdsByFileId.get(node.fileId) ?? []
      currentSymbolIds.push(node.id)
      symbolIdsByFileId.set(node.fileId, currentSymbolIds)
    }
  }

  return {
    fileIdsByPath,
    symbolIdsByFileId,
  }
}

function countSnapshotSymbols(snapshot: ProjectSnapshot | null) {
  if (!snapshot) {
    return 0
  }

  return Object.values(snapshot.nodes).filter(isSymbolNode).length
}

function buildSnapshotSignature(snapshot: ProjectSnapshot | null) {
  if (!snapshot) {
    return null
  }

  return [
    snapshot.rootDir,
    snapshot.generatedAt,
    Object.keys(snapshot.nodes).length,
    snapshot.edges.length,
  ].join('::')
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

function createTelemetryFollowEvent(
  event: TelemetryActivityEvent,
  fallbackNowMs: number,
): FollowFileEvent {
  const timestampMs = parseTimestampMs(event.timestamp, fallbackNowMs)
  const type = isEditTelemetryEvent(event.toolNames) ? 'file_edited' : 'file_touched'

  return {
    eventKey: event.key,
    key: `${type}:${event.key}`,
    path: event.path,
    sourcePriority: 1,
    sourceSequence: 0,
    timestamp: event.timestamp,
    timestampMs,
    toolNames: event.toolNames,
    type,
  }
}

function createFileOperationFollowEvent(
  operation: AgentFileOperation,
  fallbackNowMs: number,
): FollowFileEvent | null {
  if (!operation.path || operation.status === 'error') {
    return null
  }

  const timestampMs = parseTimestampMs(operation.timestamp, fallbackNowMs)
  const type = operation.kind === 'file_read'
    ? 'file_touched'
    : isFileChangingOperationKind(operation.kind)
      ? 'file_edited'
      : null

  if (!type) {
    return null
  }

  return {
    eventKey: operation.id,
    key: `operation:${type}:${operation.id}`,
    path: operation.path,
    sourcePriority: getFileOperationSourcePriority(operation),
    sourceSequence: getOperationPathSequence(operation),
    timestamp: operation.timestamp,
    timestampMs,
    toolNames: [operation.toolName],
    type,
  }
}

function createDirtyFileFollowEvent(pathValue: string): FollowFileEvent {
  const timestamp = new Date(0).toISOString()

  return {
    eventKey: `dirty:${pathValue}`,
    key: `dirty:${pathValue}`,
    path: pathValue,
    sourcePriority: 2,
    sourceSequence: 0,
    timestamp,
    timestampMs: 0,
    toolNames: ['git-diff'],
    type: 'file_edited',
  }
}

function createDirtySignalFollowEvent(signal: DirtyFileEditSignal): FollowFileEvent {
  return {
    eventKey: `dirty:${signal.path}:${signal.fingerprint}`,
    key: `dirty:${signal.path}:${signal.fingerprint}`,
    path: signal.path,
    sourcePriority: 4,
    sourceSequence: 0,
    timestamp: signal.changedAt,
    timestampMs: signal.changedAtMs,
    toolNames: ['git-diff'],
    type: 'file_edited',
  }
}

function getChangedDirtySignalPaths(input: {
  nextSignals: DirtyFileEditSignal[]
  previousSignals: DirtyFileEditSignal[]
}) {
  const previousByPath = new Map(
    input.previousSignals.map((signal) => [signal.path, signal.fingerprint]),
  )

  return input.nextSignals
    .filter((signal) => previousByPath.get(signal.path) !== signal.fingerprint)
    .sort((left, right) => right.changedAtMs - left.changedAtMs)
    .map((signal) => signal.path)
}

function getChangedFileOperationPaths(input: {
  nextOperations: AgentFileOperation[]
  previousOperations: AgentFileOperation[]
}) {
  const previousOperationIds = new Set(
    input.previousOperations.map((operation) => operation.id),
  )

  return input.nextOperations
    .filter((operation) =>
      operation.path &&
      operation.status !== 'error' &&
      isFileChangingOperationKind(operation.kind) &&
      !previousOperationIds.has(operation.id),
    )
    .sort((left, right) =>
      parseTimestampMs(right.timestamp, 0) - parseTimestampMs(left.timestamp, 0),
    )
    .map((operation) => operation.path!)
}

function isFileChangingOperationKind(kind: AgentFileOperation['kind']) {
  return (
    kind === 'file_changed' ||
    kind === 'file_delete' ||
    kind === 'file_rename' ||
    kind === 'file_write'
  )
}

function compareFollowEventsDescending(left: FollowFileEvent, right: FollowFileEvent) {
  if (left.timestampMs !== right.timestampMs) {
    const timestampDeltaMs = Math.abs(right.timestampMs - left.timestampMs)
    if (
      timestampDeltaMs <= FOLLOW_AGENT_EVENT_PRIORITY_WINDOW_MS &&
      left.sourcePriority !== right.sourcePriority
    ) {
      return right.sourcePriority - left.sourcePriority
    }

    return right.timestampMs - left.timestampMs
  }

  if (left.sourcePriority !== right.sourcePriority) {
    return right.sourcePriority - left.sourcePriority
  }

  if (left.sourceSequence !== right.sourceSequence) {
    return left.sourceSequence - right.sourceSequence
  }

  return right.eventKey.localeCompare(left.eventKey)
}

function parseTimestampMs(timestamp: string, fallbackNowMs: number) {
  const nextTimestampMs = new Date(timestamp).getTime()
  return Number.isFinite(nextTimestampMs) ? nextTimestampMs : fallbackNowMs
}

function getOperationPathSequence(operation: AgentFileOperation) {
  if (!operation.path) {
    return 0
  }

  const pathIndex = operation.paths.indexOf(operation.path)
  return pathIndex >= 0 ? pathIndex : 0
}

function getFileOperationSourcePriority(operation: AgentFileOperation) {
  switch (operation.source) {
    case 'request-telemetry':
      return 1
    case 'assistant-message':
    case 'git-dirty':
      return 2
    case 'agent-tool':
    case 'codex-cli':
    case 'pi-sdk':
      return 3
  }
}

function isPreferredFollowSymbolNode(symbol: SymbolNode) {
  const normalizedName = symbol.name.trim().toLowerCase()

  if (
    normalizedName.length === 0 ||
    normalizedName === 'anon' ||
    normalizedName === 'anonymous' ||
    normalizedName === 'global'
  ) {
    return false
  }

  return symbol.symbolKind !== 'unknown' && symbol.symbolKind !== 'module'
}

function compareSymbolsForFollow(left: SymbolNode, right: SymbolNode) {
  const leftPreferred = isPreferredFollowSymbolNode(left) ? 0 : 1
  const rightPreferred = isPreferredFollowSymbolNode(right) ? 0 : 1

  if (leftPreferred !== rightPreferred) {
    return leftPreferred - rightPreferred
  }

  const leftKindRank = getFollowSymbolKindRank(left)
  const rightKindRank = getFollowSymbolKindRank(right)

  if (leftKindRank !== rightKindRank) {
    return leftKindRank - rightKindRank
  }

  const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
  const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }

  return left.id.localeCompare(right.id)
}

function getFollowSymbolKindRank(symbol: SymbolNode) {
  switch (symbol.symbolKind) {
    case 'class':
      return 0
    case 'function':
      return 1
    case 'method':
      return 2
    case 'constant':
      return 3
    case 'variable':
      return 4
    default:
      return 99
  }
}

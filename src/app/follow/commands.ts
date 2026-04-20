import type { VisualizerViewMode } from '../../schema/layout'
import type {
  FollowCameraCommand,
  FollowDebugState,
  FollowDomainEvent,
  FollowInspectorCommand,
  FollowIntent,
  FollowRefreshCommand,
  FollowTarget,
} from './types'

export const FOLLOW_AGENT_EDIT_CAMERA_LOCK_MS = 1400
const MAX_ACKNOWLEDGED_COMMAND_IDS = 300

export function buildCameraCommand(input: {
  acknowledgedCommandIds: string[]
  activityTargets: FollowTarget[]
  cameraLockUntilMs: number
  currentCommand: FollowCameraCommand | null
  editTargets: FollowTarget[]
  lastAcknowledgedCommandId: string | null
  nowMs: number
}) {
  const acknowledgedCommandIds = new Set(input.acknowledgedCommandIds)

  const candidateTargets = input.editTargets.length > 0
    ? input.editTargets
    : input.currentCommand?.target.intent === 'activity' &&
        !acknowledgedCommandIds.has(input.currentCommand.id) &&
        input.currentCommand.id !== input.lastAcknowledgedCommandId
      ? [input.currentCommand.target]
      : input.cameraLockUntilMs <= input.nowMs
        ? input.activityTargets
        : []

  const target = candidateTargets.find((candidateTarget) => {
    const commandId = createCameraCommandId(candidateTarget)
    return commandId !== input.lastAcknowledgedCommandId && !acknowledgedCommandIds.has(commandId)
  }) ?? null

  if (!target) {
    return null
  }

  return {
    id: createCameraCommandId(target),
    target,
  } satisfies FollowCameraCommand
}

export function buildInspectorCommand(input: {
  acknowledgedCommandIds: string[]
  pendingPath: string | null
  target: FollowTarget | null
  lastAcknowledgedCommandId: string | null
}) {
  if (!input.target?.shouldOpenInspector) {
    return null
  }

  const commandId = createInspectorCommandId(input.target)

  if (
    commandId === input.lastAcknowledgedCommandId ||
    input.acknowledgedCommandIds.includes(commandId)
  ) {
    return null
  }

  return {
    id: commandId,
    pendingPath: input.target.intent === 'edit' ? input.pendingPath : null,
    scrollToDiffRequestKey:
      input.target.intent === 'edit' ? `edit:${input.target.eventKey}` : null,
    target: input.target,
  } satisfies FollowInspectorCommand
}

export function buildRefreshCommand(input: {
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

export function buildFollowDebugState(input: {
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

export function createCameraCommandId(target: FollowTarget) {
  return `camera:${target.intent}:${target.eventKey}:${target.primaryNodeId}:${target.confidence}`
}

export function appendAcknowledgedCommandId(
  acknowledgedCommandIds: string[],
  commandId: string,
) {
  return [
    ...acknowledgedCommandIds.filter((acknowledgedCommandId) => acknowledgedCommandId !== commandId),
    commandId,
  ].slice(-MAX_ACKNOWLEDGED_COMMAND_IDS)
}

export function pruneAcknowledgedInspectorCommandIds(input: {
  acknowledgedCommandIds: string[]
  candidateTargets: FollowTarget[]
  currentCommand: FollowInspectorCommand | null
}) {
  return pruneAcknowledgedCommandIds({
    ...input,
    createCommandId: createInspectorCommandId,
  })
}

export function pruneAcknowledgedCameraCommandIds(input: {
  acknowledgedCommandIds: string[]
  candidateTargets: FollowTarget[]
  currentCommand: FollowCameraCommand | null
}) {
  return pruneAcknowledgedCommandIds({
    ...input,
    createCommandId: createCameraCommandId,
  })
}

export function countQueuedCameraTargets(input: {
  acknowledgedCommandIds: string[]
  currentCommand: FollowCameraCommand | null
  targets: FollowTarget[]
}) {
  const acknowledgedCommandIds = new Set(input.acknowledgedCommandIds)
  const currentCommandId = input.currentCommand?.id ?? null

  return input.targets.filter((target) => {
    const commandId = createCameraCommandId(target)
    return commandId !== currentCommandId && !acknowledgedCommandIds.has(commandId)
  }).length
}

function createInspectorCommandId(target: FollowTarget) {
  return `inspector:${target.intent}:${target.path}:${target.eventKey}`
}

function pruneAcknowledgedCommandIds(input: {
  acknowledgedCommandIds: string[]
  candidateTargets: FollowTarget[]
  createCommandId: (target: FollowTarget) => string
  currentCommand: { id: string } | null
}) {
  const candidateCommandIds = new Set(
    input.candidateTargets.map(input.createCommandId),
  )

  if (input.currentCommand) {
    candidateCommandIds.add(input.currentCommand.id)
  }

  return input.acknowledgedCommandIds
    .filter((commandId) => candidateCommandIds.has(commandId))
    .slice(-MAX_ACKNOWLEDGED_COMMAND_IDS)
}

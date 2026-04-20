import type { AgentFileOperation } from '../../schema/agent'
import type { TelemetryActivityEvent } from '../../schema/telemetry'
import type { DirtyFileEditSignal, FollowFileEvent } from './types'

const FOLLOW_AGENT_EVENT_PRIORITY_WINDOW_MS = 30_000

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

export function createTelemetryFollowEvent(
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

export function shouldUseTelemetryEventForFollow(event: TelemetryActivityEvent) {
  return event.confidence !== 'fallback'
}

export function createFileOperationFollowEvent(
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

export function createDirtyFileFollowEvent(pathValue: string): FollowFileEvent {
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

export function createDirtySignalFollowEvent(signal: DirtyFileEditSignal): FollowFileEvent {
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

export function getChangedDirtySignalPaths(input: {
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

export function getChangedFileOperationPaths(input: {
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

export function compareFollowEventsDescending(left: FollowFileEvent, right: FollowFileEvent) {
  return compareFollowEventOrder(left, right, -1)
}

export function compareFollowEventsForPlayback(left: FollowFileEvent, right: FollowFileEvent) {
  return compareFollowEventOrder(left, right, 1)
}

export function parseTimestampMs(timestamp: string, fallbackNowMs: number) {
  const nextTimestampMs = new Date(timestamp).getTime()
  return Number.isFinite(nextTimestampMs) ? nextTimestampMs : fallbackNowMs
}

function isFileChangingOperationKind(kind: AgentFileOperation['kind']) {
  return (
    kind === 'file_changed' ||
    kind === 'file_delete' ||
    kind === 'file_rename' ||
    kind === 'file_write'
  )
}

function compareFollowEventOrder(
  left: FollowFileEvent,
  right: FollowFileEvent,
  timestampDirection: 1 | -1,
) {
  if (left.timestampMs !== right.timestampMs) {
    const timestampDeltaMs = Math.abs(right.timestampMs - left.timestampMs)
    if (
      timestampDeltaMs <= FOLLOW_AGENT_EVENT_PRIORITY_WINDOW_MS &&
      left.sourcePriority !== right.sourcePriority
    ) {
      return right.sourcePriority - left.sourcePriority
    }

    return timestampDirection * (left.timestampMs - right.timestampMs)
  }

  if (left.sourcePriority !== right.sourcePriority) {
    return right.sourcePriority - left.sourcePriority
  }

  if (left.sourceSequence !== right.sourceSequence) {
    return left.sourceSequence - right.sourceSequence
  }

  return timestampDirection * left.eventKey.localeCompare(right.eventKey)
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
    case 'pi-sdk':
      return 3
  }
}

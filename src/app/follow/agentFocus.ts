import type { AgentFileOperation, AgentFileOperationRange } from '../../schema/agent'
import type { LayoutSpec } from '../../schema/layout'
import {
  isSymbolNode,
  type ProjectSnapshot,
  type SourceRange,
  type SymbolNode,
} from '../../schema/snapshot'
import type {
  TelemetryActivityEvent,
  TelemetrySource,
  TelemetryWindow,
} from '../../schema/telemetry'
import {
  createFileOperationFollowEvent,
  createTelemetryFollowEvent,
  parseTimestampMs,
} from './events'
import {
  buildFollowIndexes,
  getPreferredFollowSymbolIdsForFile,
} from './snapshot'
import type { DirtyFileEditSignal } from './types'

export type AgentFocusIntent = 'read' | 'edit' | 'mixed'
export type AgentFocusConfidence =
  | 'exact_symbol'
  | 'range_overlap'
  | 'file_wide'
  | 'dirty_file'

export interface AgentTouchedSymbolRecord {
  symbolId: string
  fileNodeId: string
  path: string
  intent: AgentFocusIntent
  confidence: AgentFocusConfidence
  firstSeenAt: string
  lastSeenAt: string
  eventCount: number
  editCount: number
  readCount: number
  source: TelemetrySource
  toolNames: string[]
  operationRanges?: AgentFileOperationRange[]
}

export interface AgentUnresolvedTouch {
  key: string
  path: string
  reason: 'missing_file' | 'missing_placement' | 'no_symbols'
  intent: Exclude<AgentFocusIntent, 'mixed'>
  timestamp: string
  toolNames: string[]
}

export interface AgentFocusSemanticLayoutResult {
  layout: LayoutSpec
  touchedSymbols: AgentTouchedSymbolRecord[]
  unresolvedFileTouches: AgentUnresolvedTouch[]
  summary: {
    editCount: number
    fileCount: number
    readCount: number
    symbolCount: number
    unresolvedCount: number
  }
}

interface BuildAgentFocusSemanticLayoutInput {
  dirtyFileEditSignals: DirtyFileEditSignal[]
  fileOperations: AgentFileOperation[]
  liveChangedFiles?: string[]
  nowMs?: number
  observedAtMs?: number
  semanticLayout: LayoutSpec | null
  snapshot: ProjectSnapshot | null
  telemetryActivityEvents: TelemetryActivityEvent[]
  telemetryWindow: TelemetryWindow
}

interface BuildAgentTouchedSymbolRecordsInput {
  dirtyFileEditSignals: DirtyFileEditSignal[]
  fileOperations: AgentFileOperation[]
  liveChangedFiles?: string[]
  maxFileWideSymbolsPerFile?: number
  nowMs?: number
  observedAtMs?: number
  snapshot: ProjectSnapshot | null
  telemetryActivityEvents: TelemetryActivityEvent[]
  telemetryWindow: TelemetryWindow
}

interface AgentFocusSourceEvent {
  key: string
  path: string
  intent: Exclude<AgentFocusIntent, 'mixed'>
  operationRanges?: AgentFileOperationRange[]
  source: TelemetrySource
  symbolNodeIds?: string[]
  timestamp: string
  timestampMs: number
  toolNames: string[]
}

const DEFAULT_FILE_WIDE_SYMBOL_LIMIT = 6
const SUPPORTED_AGENT_FOCUS_SYMBOL_KINDS = new Set([
  'class',
  'function',
  'method',
  'constant',
  'variable',
])

export function buildAgentFocusSemanticLayout({
  dirtyFileEditSignals,
  fileOperations,
  liveChangedFiles = [],
  nowMs = Date.now(),
  observedAtMs,
  semanticLayout,
  snapshot,
  telemetryActivityEvents,
  telemetryWindow,
}: BuildAgentFocusSemanticLayoutInput): AgentFocusSemanticLayoutResult | null {
  if (!snapshot || !semanticLayout) {
    return null
  }

  const { touchedSymbols, unresolvedFileTouches } = buildAgentTouchedSymbolRecords({
    dirtyFileEditSignals,
    fileOperations,
    liveChangedFiles,
    nowMs,
    observedAtMs,
    snapshot,
    telemetryActivityEvents,
    telemetryWindow,
  })
  const visibleSymbolIds = new Set(
    touchedSymbols
      .filter((record) => Boolean(semanticLayout.placements[record.symbolId]))
      .map((record) => record.symbolId),
  )
  const unresolvedMissingPlacements = touchedSymbols
    .filter((record) => !semanticLayout.placements[record.symbolId])
    .map((record) => ({
      intent: record.editCount > 0 ? 'edit' as const : 'read' as const,
      key: `missing-placement:${record.symbolId}:${record.lastSeenAt}`,
      path: record.path,
      reason: 'missing_placement' as const,
      timestamp: record.lastSeenAt,
      toolNames: record.toolNames,
    }))
  const hiddenNodeIds = Object.values(snapshot.nodes)
    .filter((node) => !visibleSymbolIds.has(node.id))
    .map((node) => node.id)
  const visibleRecords = touchedSymbols.filter((record) => visibleSymbolIds.has(record.symbolId))
  const visiblePaths = new Set(visibleRecords.map((record) => record.path))

  return {
    layout: {
      ...semanticLayout,
      annotations: [],
      description: [
        'Runtime agent-focus view derived from semantic symbols.',
        `Window: ${telemetryWindow}.`,
        `Touched symbols: ${visibleSymbolIds.size}.`,
      ].join(' '),
      groups: [],
      hiddenNodeIds,
      id: `layout:agent-focus-semantic:${snapshot.rootDir}`,
      lanes: [],
      nodeScope: 'symbols',
      title: 'Agent focus',
      updatedAt: semanticLayout.updatedAt ?? snapshot.generatedAt,
    },
    summary: {
      editCount: visibleRecords.filter((record) => record.editCount > 0).length,
      fileCount: visiblePaths.size,
      readCount: visibleRecords.filter((record) => record.readCount > 0).length,
      symbolCount: visibleSymbolIds.size,
      unresolvedCount: unresolvedFileTouches.length + unresolvedMissingPlacements.length,
    },
    touchedSymbols: visibleRecords,
    unresolvedFileTouches: [
      ...unresolvedFileTouches,
      ...unresolvedMissingPlacements,
    ],
  }
}

export function buildAgentTouchedSymbolRecords({
  dirtyFileEditSignals,
  fileOperations,
  liveChangedFiles = [],
  maxFileWideSymbolsPerFile = DEFAULT_FILE_WIDE_SYMBOL_LIMIT,
  nowMs = Date.now(),
  observedAtMs = nowMs,
  snapshot,
  telemetryActivityEvents,
  telemetryWindow,
}: BuildAgentTouchedSymbolRecordsInput): {
  touchedSymbols: AgentTouchedSymbolRecord[]
  unresolvedFileTouches: AgentUnresolvedTouch[]
} {
  if (!snapshot) {
    return {
      touchedSymbols: [],
      unresolvedFileTouches: [],
    }
  }

  const indexes = buildFollowIndexes(snapshot)

  if (!indexes) {
    return {
      touchedSymbols: [],
      unresolvedFileTouches: [],
    }
  }

  const sourceEvents = collectAgentFocusSourceEvents({
    dirtyFileEditSignals,
    fileOperations,
    liveChangedFiles,
    nowMs,
    observedAtMs,
    telemetryActivityEvents,
    telemetryWindow,
  })
  const recordsBySymbolId = new Map<string, AgentTouchedSymbolRecord>()
  const unresolvedFileTouches: AgentUnresolvedTouch[] = []

  for (const event of sourceEvents) {
    const fileNodeId = indexes.fileIdsByPath.get(event.path)

    if (!fileNodeId) {
      unresolvedFileTouches.push(createUnresolvedTouch(event, 'missing_file'))
      continue
    }

    const symbolMatches = resolveTouchedSymbolMatches({
      event,
      fileNodeId,
      maxFileWideSymbolsPerFile,
      snapshot,
      symbolIdsByFileId: indexes.symbolIdsByFileId,
    })

    if (symbolMatches.length === 0) {
      unresolvedFileTouches.push(createUnresolvedTouch(event, 'no_symbols'))
      continue
    }

    for (const match of symbolMatches) {
      const existing = recordsBySymbolId.get(match.symbolId)

      recordsBySymbolId.set(
        match.symbolId,
        mergeTouchedSymbolRecord(existing, {
          confidence: match.confidence,
          event,
          fileNodeId,
          symbolId: match.symbolId,
        }),
      )
    }
  }

  return {
    touchedSymbols: [...recordsBySymbolId.values()].sort(compareTouchedSymbolRecords),
    unresolvedFileTouches: dedupeUnresolvedTouches(unresolvedFileTouches),
  }
}

function collectAgentFocusSourceEvents(input: {
  dirtyFileEditSignals: DirtyFileEditSignal[]
  fileOperations: AgentFileOperation[]
  liveChangedFiles: string[]
  nowMs: number
  observedAtMs: number
  telemetryActivityEvents: TelemetryActivityEvent[]
  telemetryWindow: TelemetryWindow
}) {
  const events: AgentFocusSourceEvent[] = []

  for (const operation of input.fileOperations) {
    const followEvent = createFileOperationFollowEvent(operation, input.nowMs)

    if (!followEvent) {
      continue
    }

    events.push({
      intent: followEvent.type === 'file_edited' ? 'edit' : 'read',
      key: followEvent.eventKey,
      operationRanges: followEvent.operationRanges,
      path: followEvent.path,
      source: getTelemetrySourceForFileOperation(operation),
      symbolNodeIds: followEvent.symbolNodeIds,
      timestamp: followEvent.timestamp,
      timestampMs: followEvent.timestampMs,
      toolNames: followEvent.toolNames,
    })
  }

  for (const event of input.telemetryActivityEvents) {
    const followEvent = createTelemetryFollowEvent(event, input.nowMs)

    events.push({
      intent: followEvent.type === 'file_edited' ? 'edit' : 'read',
      key: followEvent.eventKey,
      path: followEvent.path,
      source: event.source,
      symbolNodeIds: followEvent.symbolNodeIds,
      timestamp: followEvent.timestamp,
      timestampMs: followEvent.timestampMs,
      toolNames: followEvent.toolNames,
    })
  }

  const dirtySignalPathSet = new Set(input.dirtyFileEditSignals.map((signal) => signal.path))

  for (const signal of input.dirtyFileEditSignals) {
    events.push({
      intent: 'edit',
      key: `dirty:${signal.path}:${signal.fingerprint}`,
      path: signal.path,
      source: 'all',
      timestamp: signal.changedAt,
      timestampMs: signal.changedAtMs,
      toolNames: ['git-diff'],
    })
  }

  for (const path of input.liveChangedFiles) {
    if (dirtySignalPathSet.has(path)) {
      continue
    }

    events.push({
      intent: 'edit',
      key: `dirty-live:${path}`,
      path,
      source: 'all',
      timestamp: new Date(input.nowMs).toISOString(),
      timestampMs: input.nowMs,
      toolNames: ['git-diff'],
    })
  }

  return events
    .filter((event) =>
      isEventInsideTelemetryWindow(
        event.timestampMs,
        input.telemetryWindow,
        input.observedAtMs,
      ),
    )
    .sort((left, right) => right.timestampMs - left.timestampMs)
}

function resolveTouchedSymbolMatches(input: {
  event: AgentFocusSourceEvent
  fileNodeId: string
  maxFileWideSymbolsPerFile: number
  snapshot: ProjectSnapshot
  symbolIdsByFileId: Map<string, string[]>
}): Array<{
  confidence: AgentFocusConfidence
  symbolId: string
}> {
  const explicitSymbolIds = getValidFocusSymbolIds({
    fileNodeId: input.fileNodeId,
    snapshot: input.snapshot,
    symbolNodeIds: input.event.symbolNodeIds ?? [],
  })

  if (explicitSymbolIds.length > 0) {
    return explicitSymbolIds.map((symbolId) => ({
      confidence: 'exact_symbol',
      symbolId,
    }))
  }

  const rangeSymbolIds = getValidFocusSymbolIds({
    fileNodeId: input.fileNodeId,
    snapshot: input.snapshot,
    symbolNodeIds: input.event.operationRanges?.flatMap((range) => range.symbolNodeIds ?? []) ?? [],
  })

  if (rangeSymbolIds.length > 0) {
    return rangeSymbolIds.map((symbolId) => ({
      confidence: 'exact_symbol',
      symbolId,
    }))
  }

  const rangeMatchedSymbolIds = getFocusSymbolIdsForOperationRanges({
    fileId: input.fileNodeId,
    operationRanges: input.event.operationRanges ?? [],
    path: input.event.path,
    snapshot: input.snapshot,
    symbolIdsByFileId: input.symbolIdsByFileId,
  })

  if (rangeMatchedSymbolIds.length > 0) {
    return rangeMatchedSymbolIds.map((symbolId) => ({
      confidence: 'range_overlap',
      symbolId,
    }))
  }

  const fallbackSymbolIds = getPreferredFollowSymbolIdsForFile({
    fileId: input.fileNodeId,
    snapshot: input.snapshot,
    symbolIdsByFileId: input.symbolIdsByFileId,
  })
    .filter((symbolId) => isSupportedFocusSymbol(input.snapshot.nodes[symbolId]))
    .slice(0, input.maxFileWideSymbolsPerFile)

  return fallbackSymbolIds.map((symbolId) => ({
    confidence: input.event.key.startsWith('dirty:') ||
      input.event.key.startsWith('dirty-live:')
      ? 'dirty_file'
      : 'file_wide',
    symbolId,
  }))
}

function getValidFocusSymbolIds(input: {
  fileNodeId: string
  snapshot: ProjectSnapshot
  symbolNodeIds: string[]
}) {
  return [...new Set(input.symbolNodeIds)].filter((symbolId) => {
    const node = input.snapshot.nodes[symbolId]

    return Boolean(
      node &&
        isSupportedFocusSymbol(node) &&
        node.fileId === input.fileNodeId,
    )
  })
}

function getFocusSymbolIdsForOperationRanges(input: {
  fileId: string
  operationRanges: AgentFileOperationRange[]
  path: string
  snapshot: ProjectSnapshot
  symbolIdsByFileId: Map<string, string[]>
}) {
  const candidateRanges = input.operationRanges
    .filter((range) => !range.path || range.path === input.path)
    .map((range) => range.range)

  if (candidateRanges.length === 0) {
    return []
  }

  return (input.symbolIdsByFileId.get(input.fileId) ?? [])
    .map((symbolId) => input.snapshot.nodes[symbolId])
    .filter(isSupportedFocusSymbol)
    .map((symbol) => ({
      overlap: Math.max(
        ...candidateRanges.map((range) => getLineRangeOverlap(symbol.range, range)),
      ),
      symbol,
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort((left, right) => {
      if (left.overlap !== right.overlap) {
        return right.overlap - left.overlap
      }

      const leftLine = left.symbol.range?.start.line ?? Number.MAX_SAFE_INTEGER
      const rightLine = right.symbol.range?.start.line ?? Number.MAX_SAFE_INTEGER

      if (leftLine !== rightLine) {
        return leftLine - rightLine
      }

      return left.symbol.id.localeCompare(right.symbol.id)
    })
    .map(({ symbol }) => symbol.id)
}

function mergeTouchedSymbolRecord(
  existing: AgentTouchedSymbolRecord | undefined,
  input: {
    confidence: AgentFocusConfidence
    event: AgentFocusSourceEvent
    fileNodeId: string
    symbolId: string
  },
): AgentTouchedSymbolRecord {
  const timestamp = input.event.timestamp
  const editCount = input.event.intent === 'edit' ? 1 : 0
  const readCount = input.event.intent === 'read' ? 1 : 0

  if (!existing) {
    return {
      confidence: input.confidence,
      editCount,
      eventCount: 1,
      fileNodeId: input.fileNodeId,
      firstSeenAt: timestamp,
      intent: input.event.intent,
      lastSeenAt: timestamp,
      operationRanges: input.event.operationRanges,
      path: input.event.path,
      readCount,
      source: input.event.source,
      symbolId: input.symbolId,
      toolNames: [...new Set(input.event.toolNames)],
    }
  }

  const nextEditCount = existing.editCount + editCount
  const nextReadCount = existing.readCount + readCount

  return {
    ...existing,
    confidence: getStrongerConfidence(existing.confidence, input.confidence),
    editCount: nextEditCount,
    eventCount: existing.eventCount + 1,
    firstSeenAt: getEarlierTimestamp(existing.firstSeenAt, timestamp),
    intent: nextEditCount > 0 && nextReadCount > 0
      ? 'mixed'
      : nextEditCount > 0
        ? 'edit'
        : 'read',
    lastSeenAt: getLaterTimestamp(existing.lastSeenAt, timestamp),
    operationRanges: mergeOperationRanges(existing.operationRanges, input.event.operationRanges),
    readCount: nextReadCount,
    source: existing.source === input.event.source ? existing.source : 'all',
    toolNames: [...new Set([...existing.toolNames, ...input.event.toolNames])],
  }
}

function createUnresolvedTouch(
  event: AgentFocusSourceEvent,
  reason: AgentUnresolvedTouch['reason'],
): AgentUnresolvedTouch {
  return {
    intent: event.intent,
    key: `${reason}:${event.key}`,
    path: event.path,
    reason,
    timestamp: event.timestamp,
    toolNames: event.toolNames,
  }
}

function dedupeUnresolvedTouches(unresolvedTouches: AgentUnresolvedTouch[]) {
  const byKey = new Map<string, AgentUnresolvedTouch>()

  for (const touch of unresolvedTouches) {
    const key = `${touch.reason}:${touch.path}:${touch.intent}`
    const existing = byKey.get(key)

    if (!existing || existing.timestamp < touch.timestamp) {
      byKey.set(key, touch)
    }
  }

  return [...byKey.values()].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

function isEventInsideTelemetryWindow(
  timestampMs: number,
  telemetryWindow: TelemetryWindow,
  observedAtMs: number,
) {
  if (
    telemetryWindow === 'run' ||
    telemetryWindow === 'session' ||
    telemetryWindow === 'workspace'
  ) {
    return true
  }

  return Number.isFinite(timestampMs) && timestampMs >= observedAtMs - telemetryWindow * 1000
}

function getTelemetrySourceForFileOperation(operation: AgentFileOperation): TelemetrySource {
  switch (operation.source) {
    case 'pi-sdk':
    case 'request-telemetry':
      return 'autonomous'
    case 'agent-tool':
    case 'assistant-message':
    case 'git-dirty':
      return 'interactive'
  }
}

function isSupportedFocusSymbol(
  node: ProjectSnapshot['nodes'][string] | undefined,
): node is SymbolNode {
  return Boolean(
    node &&
      isSymbolNode(node) &&
      SUPPORTED_AGENT_FOCUS_SYMBOL_KINDS.has(node.symbolKind),
  )
}

function getLineRangeOverlap(
  symbolRange: SourceRange | undefined,
  operationRange: SourceRange,
) {
  if (!symbolRange) {
    return 0
  }

  const startLine = Math.max(symbolRange.start.line, operationRange.start.line)
  const endLine = Math.min(symbolRange.end.line, operationRange.end.line)

  return Math.max(0, endLine - startLine + 1)
}

function getStrongerConfidence(
  left: AgentFocusConfidence,
  right: AgentFocusConfidence,
) {
  const rank: Record<AgentFocusConfidence, number> = {
    exact_symbol: 4,
    range_overlap: 3,
    dirty_file: 2,
    file_wide: 1,
  }

  return rank[left] >= rank[right] ? left : right
}

function getEarlierTimestamp(left: string, right: string) {
  return parseTimestampMs(left, 0) <= parseTimestampMs(right, 0) ? left : right
}

function getLaterTimestamp(left: string, right: string) {
  return parseTimestampMs(left, 0) >= parseTimestampMs(right, 0) ? left : right
}

function mergeOperationRanges(
  left: AgentFileOperationRange[] | undefined,
  right: AgentFileOperationRange[] | undefined,
) {
  if (!left?.length) {
    return right
  }

  if (!right?.length) {
    return left
  }

  const seenKeys = new Set<string>()
  const mergedRanges: AgentFileOperationRange[] = []

  for (const range of [...left, ...right]) {
    const key = [
      range.kind,
      range.path ?? '',
      range.range.start.line,
      range.range.start.column,
      range.range.end.line,
      range.range.end.column,
    ].join(':')

    if (seenKeys.has(key)) {
      continue
    }

    seenKeys.add(key)
    mergedRanges.push(range)
  }

  return mergedRanges
}

function compareTouchedSymbolRecords(
  left: AgentTouchedSymbolRecord,
  right: AgentTouchedSymbolRecord,
) {
  const timestampCompare = right.lastSeenAt.localeCompare(left.lastSeenAt)

  if (timestampCompare !== 0) {
    return timestampCompare
  }

  if (left.intent !== right.intent) {
    return getIntentRank(left.intent) - getIntentRank(right.intent)
  }

  return left.symbolId.localeCompare(right.symbolId)
}

function getIntentRank(intent: AgentFocusIntent) {
  switch (intent) {
    case 'edit':
      return 0
    case 'mixed':
      return 1
    case 'read':
      return 2
  }
}

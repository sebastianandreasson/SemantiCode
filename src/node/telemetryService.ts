import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  appendRequestTelemetryArtifacts,
  deriveRequestTelemetryAnalytics,
  deriveRequestTelemetryBreakdown,
  deriveToolPaths,
  getRequestTelemetryPaths,
  readRequestTelemetryRecords,
  readTokenUsageSummary,
  summarizeRequestSpans,
} from '@sebastianandreasson/pi-autonomous-agents'

import { getPiRunScopedPaths, resolvePiHarnessPaths } from './piHarnessPaths'
import {
  type AgentHeatSample,
  type TelemetryActivityEvent,
  type TelemetryConfidence,
  type TelemetryMode,
  type TelemetryOverview,
  type TelemetryOverviewBucket,
  type TelemetrySource,
  type TelemetryWindow,
} from '../types'
import type { AgentToolProfile } from '../schema/agent'

interface InteractiveTelemetryInput {
  kind: string
  message: string
  modelId: string
  provider: string
  promptSequence: number
  rootDir: string
  scope?: {
    paths?: string[]
    scope?: {
      paths: string[]
      symbolPaths?: string[]
      title?: string
    } | null
    task?: string
  }
  sessionId: string
  startedAt: string
  finishedAt: string
  toolProfile?: AgentToolProfile
  toolInvocations: {
    args: unknown
    nodeIds?: string[]
    paths?: string[]
    resultPreview?: string
    symbolNodeIds?: string[]
    toolCallId: string
    toolName: string
  }[]
}

interface InteractiveTelemetryScopeShape {
  paths?: string[]
  scope?: {
    paths: string[]
    symbolPaths?: string[]
    title?: string
  } | null
  task?: string
}

interface RequestRecord {
  [key: string]: unknown
  cacheReadTokens?: number
  cacheWriteTokens?: number
  fileFallbackToolCallCount?: number
  files?: string[]
  inputTokens?: number
  iteration?: number
  kind?: string
  model?: string
  outputTokens?: number
  phase?: string
  requestId?: string
  role?: string
  runId?: string
  sessionId?: string
  source?: string
  spanSource?: string
  symbolNodeIds?: string[]
  task?: string
  timestamp?: string
  toolNames?: string[]
  toolProfile?: AgentToolProfile
  symbolToolCallCount?: number
  totalTokens?: number
  usageSource?: string
}

interface SpanRecord {
  [key: string]: unknown
  byteCount?: number
  paths?: string[]
  primaryPath?: string
  requestId?: string
  spanKind?: string
  symbolNodeIds?: string[]
  timestamp?: string
  toolCallId?: string
  toolName?: string
}

interface RequestTelemetryTarget {
  path: string
  symbolNodeIds: string[]
}

interface TelemetryQueryInput {
  mode: TelemetryMode
  rootDir: string
  runId?: string
  sessionId?: string
  sinceMs?: number
  source: TelemetrySource
  window: TelemetryWindow
}

const require = createRequire(import.meta.url)
const REQUEST_TELEMETRY_EXTENSION_DIRNAME = 'pi-harness-request-telemetry'
const REQUEST_TELEMETRY_SHIM_HEADER = [
  '// Managed by Semanticode.',
  '// This shim lets Pi auto-discover the packaged request telemetry extension.',
].join('\n')

function getManagedRequestTelemetryExtensionPaths(rootDir: string) {
  const repoRoot = resolve(rootDir)
  const extensionRoot = join(repoRoot, '.pi', 'extensions')
  const extensionDir = join(extensionRoot, REQUEST_TELEMETRY_EXTENSION_DIRNAME)
  const packageEntry = require.resolve('@sebastianandreasson/pi-autonomous-agents')
  const sourceFile = join(dirname(dirname(packageEntry)), 'pi-extensions', 'request-telemetry', 'index.mjs')

  return {
    entryFile: join(extensionDir, 'index.mjs'),
    extensionDir,
    manifestFile: join(extensionDir, 'package.json'),
    sourceFile,
  }
}

function renderRequestTelemetryExtensionShim(sourceFile: string) {
  const sourceUrl = pathToFileURL(sourceFile).href

  return [
    REQUEST_TELEMETRY_SHIM_HEADER,
    `export * from ${JSON.stringify(sourceUrl)}`,
    `export { default } from ${JSON.stringify(sourceUrl)}`,
    '',
  ].join('\n')
}

function renderRequestTelemetryExtensionManifest() {
  return `${JSON.stringify(
    {
      name: REQUEST_TELEMETRY_EXTENSION_DIRNAME,
      private: true,
      type: 'module',
      pi: {
        extensions: ['./index.mjs'],
      },
    },
    null,
    2,
  )}\n`
}

export class AgentTelemetryService {
  private readonly telemetryPreparationByRootDir = new Map<string, Promise<void>>()

  async ensureWorkspaceTelemetry(rootDir: string) {
    const normalizedRootDir = resolve(rootDir)
    const existing = this.telemetryPreparationByRootDir.get(normalizedRootDir)

    if (existing) {
      return existing
    }

    const preparation = this.installRequestTelemetryExtension(normalizedRootDir).catch((error) => {
      this.telemetryPreparationByRootDir.delete(normalizedRootDir)
      throw error
    })

    this.telemetryPreparationByRootDir.set(normalizedRootDir, preparation)
    return preparation
  }

  async recordInteractivePrompt(input: InteractiveTelemetryInput) {
    const requestId = `semanticode-request:${randomUUID()}`
    const paths = getRequestTelemetryPaths({
      cwd: input.rootDir,
    })
    const spanRecords = buildInteractiveSpanRecords({
      input,
      requestId,
      sessionId: input.sessionId,
    })
    const persistedSpanRecords = buildPersistedInteractiveSpanRecords(spanRecords)
    const spanSummary = summarizeRequestSpans(spanRecords)
    const toolProfileSummary = summarizeInteractiveToolProfile(input.toolInvocations)

    await appendRequestTelemetryArtifacts(paths, {
      request: {
        api: 'semanticode',
        contextMessageCount: 1,
        durationMs: Math.max(
          0,
          new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
        ),
        files: spanSummary.files,
        finishedAt: input.finishedAt,
        inputTokens: 0,
        iteration: input.promptSequence,
        kind: input.kind,
        model: input.modelId,
        outputTokens: 0,
        phase: 'interactive',
        provider: input.provider,
        requestId,
        role: 'editor',
        runId: input.sessionId,
        sessionId: input.sessionId,
        source: 'semanticode-interactive',
        spanCount: spanSummary.spanCount,
        spanSource: 'tool_hooks',
        startedAt: input.startedAt,
        task: input.scope?.task ?? summarizePrompt(input.message),
        textBytes: spanSummary.textBytes,
        textChars: spanSummary.textChars,
        timestamp: input.finishedAt,
        fileFallbackToolCallCount: toolProfileSummary.fileFallbackToolCallCount,
        symbolToolCallCount: toolProfileSummary.symbolToolCallCount,
        toolProfile: input.toolProfile,
        toolNames: spanSummary.toolNames,
        totalTokens: 0,
        usageSource: 'unavailable',
      },
      spans: persistedSpanRecords,
    }, {
      includeSpanPreview: true,
      includeSpanText: true,
    })
  }

  async getRunAnalytics(rootDir: string, runId: string) {
    const requestTelemetry = await readRequestTelemetryRecords({
      cwd: rootDir,
    })
    const telemetry = await readRunTelemetryEvents(rootDir, runId)

    return deriveRequestTelemetryAnalytics({
      requests: requestTelemetry.requests,
      runId,
      telemetry,
    })
  }

  async getRunTokenSummary(rootDir: string, runId: string) {
    const paths = await resolvePiHarnessPaths(rootDir)
    const runPaths = getPiRunScopedPaths(paths, runId)

    return readTokenUsageSummary({
      tokenUsageEventsFile: runPaths.tokenUsageEventsFile,
      tokenUsageSummaryFile: runPaths.tokenUsageSummaryFile,
    })
  }

  async getTelemetryOverview(input: TelemetryQueryInput): Promise<TelemetryOverview> {
    const telemetry = await this.readFilteredTelemetry(input)
    const breakdown = deriveRequestTelemetryBreakdown({
      requests: telemetry.requests,
      spans: telemetry.spans,
    })

    return {
      activeRuns: [],
      requestCount: breakdown.source.requestCount,
      source: input.source,
      topDirectories: mapBreakdownBuckets(breakdown.breakdowns.byDirectory),
      topFiles: mapBreakdownBuckets(breakdown.breakdowns.byFile),
      topTools: mapBreakdownBuckets(breakdown.breakdowns.byTool),
      totalTokens: breakdown.totals.totalTokens,
      window: input.window,
    }
  }

  async getTelemetryActivity(input: TelemetryQueryInput): Promise<TelemetryActivityEvent[]> {
    const telemetry = await this.readFilteredTelemetry(input)
    const spansByRequestId = indexSpansByRequestId(telemetry.spans)
    const events: TelemetryActivityEvent[] = []

    for (const request of telemetry.requests) {
      const totalTokens = getAttributionBudget(request)
      const confidence = getRequestConfidence(request)
      const source = getTelemetrySourceForRequest(request)

      if (!shouldExposeTelemetryActivity({ confidence, source })) {
        continue
      }

      const requestTargets = collectRequestTargets(
        request,
        spansByRequestId.get(String(request.requestId ?? '')) ?? [],
      )

      if (requestTargets.length === 0) {
        continue
      }

      for (const target of requestTargets) {
        events.push({
          confidence,
          key: `${String(request.requestId ?? '')}:${target.path}`,
          path: target.path,
          requestCount: 1,
          runId: String(request.runId ?? ''),
          sessionId: String(request.sessionId ?? ''),
          source,
          symbolNodeIds: target.symbolNodeIds,
          timestamp: String(request.timestamp ?? ''),
          toolNames: Array.isArray(request.toolNames)
            ? request.toolNames
                .map((toolName: unknown) => String(toolName))
                .filter(Boolean)
            : [],
          totalTokens,
        })
      }
    }

    return events
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 80)
  }

  async getTelemetryHeatmap(input: TelemetryQueryInput): Promise<AgentHeatSample[]> {
    const telemetry = await this.readFilteredTelemetry(input)
    const spansByRequestId = indexSpansByRequestId(telemetry.spans)
    const byPath = new Map<string, {
      confidence: TelemetryConfidence
      lastSeenAt: string
      requestCount: number
      source: TelemetrySource
      symbolNodeIds: Set<string>
      totalTokens: number
    }>()

    for (const request of telemetry.requests) {
      const attributionBudget = getAttributionBudget(request)
      const source = getTelemetrySourceForRequest(request)
      const confidence = getRequestConfidence(request)

      if (!shouldExposeTelemetryActivity({ confidence, source })) {
        continue
      }

      const requestTargets = collectRequestTargets(
        request,
        spansByRequestId.get(String(request.requestId ?? '')) ?? [],
      )
      const perPathBudget = requestTargets.length > 0 ? attributionBudget / requestTargets.length : 0

      for (const target of requestTargets) {
        const current = byPath.get(target.path) ?? {
          confidence,
          lastSeenAt: String(request.timestamp ?? ''),
          requestCount: 0,
          source,
          symbolNodeIds: new Set<string>(),
          totalTokens: 0,
        }

        current.requestCount += 1
        current.totalTokens += perPathBudget
        current.lastSeenAt =
          current.lastSeenAt > String(request.timestamp ?? '')
            ? current.lastSeenAt
            : String(request.timestamp ?? '')
        current.confidence = mergeConfidence(current.confidence, confidence)
        current.source =
          current.source === source ? source : 'all'
        for (const symbolNodeId of target.symbolNodeIds) {
          current.symbolNodeIds.add(symbolNodeId)
        }
        byPath.set(target.path, current)
      }
    }

    const samples = [...byPath.entries()]
      .map(([pathValue, value]) => {
        const symbolNodeIds = [...value.symbolNodeIds]

        return {
          confidence: value.confidence,
          lastSeenAt: value.lastSeenAt,
          nodeIds: input.mode === 'symbols' ? symbolNodeIds : [],
          path: pathValue,
          requestCount: value.requestCount,
          source: value.source,
          symbolNodeIds,
          totalTokens: roundMetric(value.totalTokens),
          weight: 0,
        } satisfies AgentHeatSample
      })

    const maxScore = samples.reduce((maxValue, sample) => {
      return Math.max(maxValue, sample.totalTokens > 0 ? sample.totalTokens : sample.requestCount)
    }, 0)

    return samples
      .map((sample) => ({
        ...sample,
        weight:
          maxScore > 0
            ? roundMetric((sample.totalTokens > 0 ? sample.totalTokens : sample.requestCount) / maxScore)
            : 0,
      }))
      .sort((left, right) => right.weight - left.weight)
  }

  private async readFilteredTelemetry(input: TelemetryQueryInput) {
    if (input.window === 'session' && !input.sessionId) {
      return {
        requests: [],
        spans: [],
      }
    }

    const requestTelemetry = await readRequestTelemetryRecords({
      cwd: input.rootDir,
    })
    const requestIds = new Set<string>()
    const windowStart =
      typeof input.window === 'number'
        ? Date.now() - (input.window * 1000)
        : null
    const sessionWindowStart =
      input.window === 'session' &&
      typeof input.sinceMs === 'number' &&
      Number.isFinite(input.sinceMs)
        ? input.sinceMs
        : null

    const requests = requestTelemetry.requests.filter((request: Record<string, unknown>) => {
      const normalizedSource = getTelemetrySourceForRequest(request)

      if (input.source !== 'all' && normalizedSource !== input.source) {
        return false
      }

      if (input.window === 'run' && input.runId && String(request.runId ?? '') !== input.runId) {
        return false
      }

      if (input.window === 'session' && getTelemetryRequestSessionId(request) !== input.sessionId) {
        return false
      }

      if (windowStart !== null || sessionWindowStart !== null) {
        const timestampMs = new Date(String(request.timestamp ?? '')).getTime()

        if (!Number.isFinite(timestampMs)) {
          return false
        }

        if (windowStart !== null && timestampMs < windowStart) {
          return false
        }

        if (sessionWindowStart !== null && timestampMs < sessionWindowStart) {
          return false
        }
      }

      requestIds.add(String(request.requestId ?? ''))
      return true
    }).map((request: Record<string, unknown>) => normalizeTelemetryRequestPaths(input.rootDir, request))
    const spans = requestTelemetry.spans
      .filter((span: Record<string, unknown>) =>
        requestIds.has(String(span.requestId ?? '')),
      )
      .map((span: Record<string, unknown>) => normalizeTelemetrySpanPaths(input.rootDir, span))

    return {
      requests,
      spans,
    }
  }

  private async installRequestTelemetryExtension(rootDir: string) {
    const paths = getManagedRequestTelemetryExtensionPaths(rootDir)

    await access(paths.sourceFile)
    await mkdir(paths.extensionDir, { recursive: true })

    const entryContent = renderRequestTelemetryExtensionShim(paths.sourceFile)
    const manifestContent = renderRequestTelemetryExtensionManifest()
    let existingEntry = ''
    let existingManifest = ''

    try {
      existingEntry = await readFile(paths.entryFile, 'utf8')
    } catch {
      existingEntry = ''
    }

    try {
      existingManifest = await readFile(paths.manifestFile, 'utf8')
    } catch {
      existingManifest = ''
    }

    if (existingEntry !== entryContent) {
      await writeFile(paths.entryFile, entryContent, 'utf8')
    }

    if (existingManifest !== manifestContent) {
      await writeFile(paths.manifestFile, manifestContent, 'utf8')
    }
  }
}

function getTelemetryRequestSessionId(request: Record<string, unknown>) {
  return String(request.sessionId ?? request.runId ?? '')
}

function buildInteractiveSpanRecords(input: {
  input: InteractiveTelemetryInput
  requestId: string
  sessionId: string
}) {
  const primaryPaths = getTelemetryScopePaths(input.input.scope)
  const promptPath = primaryPaths[0] ?? ''
  const promptText = input.input.message
  const promptByteCount = byteLength(promptText)
  const baseSpan = {
    messageIndex: 0,
    paths: primaryPaths,
    preview: promptText.slice(0, 280),
    primaryPath: promptPath,
    requestId: input.requestId,
    role: 'user',
    sessionId: input.sessionId,
    source: 'context',
    spanIndex: 0,
    spanKind: 'message',
    text: promptText,
    timestamp: input.input.startedAt,
    turnIndex: input.input.promptSequence,
  }
  const spans: SpanRecord[] = [
    {
      ...baseSpan,
      byteCount: promptByteCount,
      charCount: promptText.length,
    },
  ]

  input.input.toolInvocations.forEach((invocation, index) => {
    const toolPaths = [
      ...new Set([
        ...deriveToolPaths(invocation.toolName, invocation.args),
        ...(invocation.paths ?? []),
      ]),
    ]
    const argsText = safeJson(invocation.args)
    const codeReferenceText = safeJson({
      nodeIds: invocation.nodeIds,
      resultPreview: invocation.resultPreview,
      symbolNodeIds: invocation.symbolNodeIds,
    })

    spans.push({
      byteCount: byteLength(argsText),
      charCount: argsText.length,
      paths: toolPaths,
      preview: argsText.slice(0, 280),
      primaryPath: toolPaths[0] ?? '',
      requestId: input.requestId,
      role: 'toolResult',
      sessionId: input.sessionId,
      source: 'tool_hooks',
      spanIndex: (index * 2) + 1,
      spanKind: 'tool_call',
      text: argsText,
      timestamp: input.input.finishedAt,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      turnIndex: input.input.promptSequence,
    })

    if (
      invocation.resultPreview ||
      invocation.nodeIds?.length ||
      invocation.symbolNodeIds?.length
    ) {
      spans.push({
        byteCount: byteLength(codeReferenceText),
        charCount: codeReferenceText.length,
        paths: toolPaths,
        preview: codeReferenceText.slice(0, 280),
        primaryPath: toolPaths[0] ?? '',
        requestId: input.requestId,
        role: 'toolResult',
        sessionId: input.sessionId,
        source: 'tool_hooks',
        spanIndex: (index * 2) + 2,
        spanKind: 'tool_result',
        text: codeReferenceText,
        timestamp: input.input.finishedAt,
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        turnIndex: input.input.promptSequence,
      })
    }
  })

  return spans
}

function buildPersistedInteractiveSpanRecords(spans: SpanRecord[]) {
  return spans.map((span) => {
    const symbolNodeIds = collectSpanSymbolNodeIds(span)
    const nodeIds = collectSymbolNodeIdsFromValue([
      span.nodeIds,
      span.symbolNodeIds,
      span.text,
      span.preview,
    ])
    const hasCodeReferences = symbolNodeIds.length > 0 || nodeIds.length > 0
    const text = hasCodeReferences
      ? safeJson({
          nodeIds,
          symbolNodeIds,
        })
      : ''

    return {
      ...span,
      byteCount: span.byteCount,
      charCount: span.charCount,
      preview: text.slice(0, 280),
      text,
    }
  })
}

const SYMBOL_QUERY_TOOL_NAMES = new Set([
  'findSymbols',
  'getSymbolNeighborhood',
  'getSymbolOutline',
  'getSymbolWorkspaceSummary',
  'readSymbolSlice',
  'replaceSymbolRange',
])

const FILE_FALLBACK_TOOL_NAMES = new Set([
  'bash',
  'find',
  'grep',
  'ls',
  'read',
  'readFileWindow',
  'replaceFileWindow',
])

function summarizeInteractiveToolProfile(
  toolInvocations: InteractiveTelemetryInput['toolInvocations'],
) {
  let fileFallbackToolCallCount = 0
  let symbolToolCallCount = 0

  for (const invocation of toolInvocations) {
    if (SYMBOL_QUERY_TOOL_NAMES.has(invocation.toolName)) {
      symbolToolCallCount += 1
    }

    if (FILE_FALLBACK_TOOL_NAMES.has(invocation.toolName)) {
      fileFallbackToolCallCount += 1
    }
  }

  return {
    fileFallbackToolCallCount,
    symbolToolCallCount,
  }
}

function collectRequestTargets(
  request: RequestRecord,
  spans: SpanRecord[],
): RequestTelemetryTarget[] {
  const symbolsByPath = new Map<string, Set<string>>()
  const requestSymbolNodeIds = new Set(collectSymbolNodeIdsFromValue(request.symbolNodeIds))

  const ensurePath = (pathValue: string) => {
    const normalizedPath = String(pathValue ?? '').trim()

    if (!normalizedPath || isSymbolNodeId(normalizedPath)) {
      return null
    }

    const existing = symbolsByPath.get(normalizedPath) ?? new Set<string>()
    symbolsByPath.set(normalizedPath, existing)
    return existing
  }

  for (const span of spans) {
    const spanSymbolNodeIds = collectSpanSymbolNodeIds(span)
    for (const symbolNodeId of spanSymbolNodeIds) {
      requestSymbolNodeIds.add(symbolNodeId)
    }

    for (const pathValue of Array.isArray(span.paths) ? span.paths : []) {
      const symbolSet = ensurePath(String(pathValue))

      if (!symbolSet) {
        continue
      }

      for (const symbolNodeId of spanSymbolNodeIds) {
        symbolSet.add(symbolNodeId)
      }
    }
  }

  if (symbolsByPath.size === 0) {
    for (const pathValue of Array.isArray(request.files) ? request.files : []) {
      ensurePath(String(pathValue))
    }
  }

  if (symbolsByPath.size === 1) {
    const symbolSet = [...symbolsByPath.values()][0]
    for (const symbolNodeId of requestSymbolNodeIds) {
      symbolSet.add(symbolNodeId)
    }
  }

  return [...symbolsByPath.entries()]
    .map(([path, symbolSet]) => ({
      path,
      symbolNodeIds: [...symbolSet],
    }))
    .filter((target) => Boolean(target.path))
}

function getTelemetrySourceForRequest(request: RequestRecord): TelemetrySource {
  return request.source === 'semanticode-interactive' ? 'interactive' : 'autonomous'
}

function getRequestConfidence(request: RequestRecord): TelemetryConfidence {
  if (request.source === 'semanticode-interactive') {
    return 'fallback'
  }

  if (
    request.usageSource &&
    request.usageSource !== 'unavailable' &&
    getAttributionBudget(request) > 0
  ) {
    return 'exact'
  }

  return 'attributed'
}

function shouldExposeTelemetryActivity(input: {
  confidence: TelemetryConfidence
  source: TelemetrySource
}) {
  return !(input.source === 'interactive' && input.confidence === 'fallback')
}

function mergeConfidence(
  left: TelemetryConfidence,
  right: TelemetryConfidence,
): TelemetryConfidence {
  const rank: Record<TelemetryConfidence, number> = {
    exact: 3,
    attributed: 2,
    fallback: 1,
  }

  return rank[left] >= rank[right] ? left : right
}

function indexSpansByRequestId(spans: SpanRecord[]) {
  const result = new Map<string, SpanRecord[]>()

  for (const span of spans) {
    const requestId = String(span.requestId ?? '')

    if (!requestId) {
      continue
    }

    const existing = result.get(requestId) ?? []
    existing.push(span)
    result.set(requestId, existing)
  }

  return result
}

function mapBreakdownBuckets(
  buckets: Array<{
    key: string
    label: string
    requestCount?: number
    totalTokens?: number
  }>,
): TelemetryOverviewBucket[] {
  return buckets.slice(0, 8).map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    requestCount: Number(bucket.requestCount ?? 0),
    totalTokens: roundMetric(Number(bucket.totalTokens ?? 0)),
  }))
}

function getAttributionBudget(request: RequestRecord) {
  return roundMetric(
    Number(request.totalTokens ?? 0) > 0
      ? Number(request.totalTokens ?? 0)
      : Number(request.inputTokens ?? 0) +
          Number(request.cacheReadTokens ?? 0) +
          Number(request.cacheWriteTokens ?? 0),
  )
}

function getTelemetryScopePaths(
  scope: InteractiveTelemetryScopeShape | { paths: string[]; symbolPaths?: string[] } | undefined,
) {
  const pathSet = new Set<string>()

  for (const pathValue of scope?.paths ?? []) {
    pathSet.add(normalizeRelativePath(pathValue))
  }

  if (scope && 'scope' in scope && scope.scope) {
    for (const pathValue of scope.scope.paths ?? []) {
      pathSet.add(normalizeRelativePath(pathValue))
    }
  }

  if (scope && 'symbolPaths' in scope) {
    for (const pathValue of scope.symbolPaths ?? []) {
      pathSet.add(normalizeRelativePath(pathValue))
    }
  }

  return [...pathSet].filter(Boolean)
}

async function readRunTelemetryEvents(rootDir: string, runId: string) {
  const paths = await resolvePiHarnessPaths(rootDir)
  const runPaths = getPiRunScopedPaths(paths, runId)

  try {
    const raw = await readFile(runPaths.telemetryJsonl, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function summarizePrompt(message: string) {
  return message
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160)
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function normalizeRelativePath(pathValue: string) {
  return pathValue.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function normalizeTelemetryPath(rootDir: string, pathValue: unknown) {
  const normalizedValue = normalizeRelativePath(String(pathValue ?? ''))

  if (!normalizedValue) {
    return ''
  }

  const normalizedRootDir = resolve(rootDir)
  const resolvedPath = resolve(normalizedRootDir, normalizedValue)

  if (resolvedPath === normalizedRootDir || resolvedPath.startsWith(`${normalizedRootDir}/`)) {
    return normalizeRelativePath(relative(normalizedRootDir, resolvedPath))
  }

  return normalizedValue
}

function normalizeTelemetryRequestPaths(
  rootDir: string,
  request: Record<string, unknown>,
): RequestRecord {
  const files = Array.isArray(request.files)
    ? request.files
        .filter((pathValue) => !isSymbolNodeId(String(pathValue ?? '')))
        .map((pathValue) => normalizeTelemetryPath(rootDir, pathValue))
        .filter(Boolean)
    : []
  const symbolNodeIds = collectSymbolNodeIdsFromValue([
    request.symbolNodeIds,
    request.nodeIds,
    request.files,
  ])

  return {
    ...request,
    files,
    symbolNodeIds,
  } as RequestRecord
}

function normalizeTelemetrySpanPaths(
  rootDir: string,
  span: Record<string, unknown>,
): SpanRecord {
  const paths = Array.isArray(span.paths)
    ? span.paths
        .filter((pathValue) => !isSymbolNodeId(String(pathValue ?? '')))
        .map((pathValue) => normalizeTelemetryPath(rootDir, pathValue))
        .filter(Boolean)
    : []
  const primaryPath = isSymbolNodeId(String(span.primaryPath ?? ''))
    ? ''
    : normalizeTelemetryPath(rootDir, span.primaryPath)
  const symbolNodeIds = collectSymbolNodeIdsFromValue([
    span.symbolNodeIds,
    span.nodeIds,
    span.paths,
    span.primaryPath,
    span.text,
    span.preview,
  ])

  return {
    ...span,
    paths,
    primaryPath,
    symbolNodeIds,
  } as SpanRecord
}

function collectSpanSymbolNodeIds(span: SpanRecord) {
  return collectSymbolNodeIdsFromValue([
    span.symbolNodeIds,
    span.paths,
    span.primaryPath,
    span.text,
  ])
}

function collectSymbolNodeIdsFromValue(value: unknown): string[] {
  const symbolNodeIds = new Set<string>()
  collectSymbolNodeIds(value, symbolNodeIds)
  return [...symbolNodeIds]
}

function collectSymbolNodeIds(value: unknown, output: Set<string>) {
  if (!value || output.size >= 32) {
    return
  }

  if (typeof value === 'string') {
    collectSymbolNodeIdsFromString(value, output)
    return
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSymbolNodeIds(entry, output)
    }
    return
  }

  if (typeof value !== 'object') {
    return
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectSymbolNodeIds(entry, output)
  }
}

function collectSymbolNodeIdsFromString(value: string, output: Set<string>) {
  const parsed = parseJsonLikeTelemetryValue(value)

  if (parsed !== value) {
    collectSymbolNodeIds(parsed, output)
  }

  const directValue = cleanTelemetryReferenceToken(value)

  if (isSymbolNodeId(directValue)) {
    output.add(directValue)
  }

  const matches = value.match(/symbol:[^\s'",)\]}]+/g) ?? []
  for (const match of matches) {
    const symbolNodeId = cleanTelemetryReferenceToken(match)

    if (isSymbolNodeId(symbolNodeId)) {
      output.add(symbolNodeId)
    }
  }
}

function parseJsonLikeTelemetryValue(value: string): unknown {
  const text = value.trim()

  if (
    text.length === 0 ||
    !(
      (text.startsWith('{') && text.endsWith('}')) ||
      (text.startsWith('[') && text.endsWith(']')) ||
      (text.startsWith('"') && text.endsWith('"'))
    )
  ) {
    return value
  }

  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' && parsed !== value
      ? parseJsonLikeTelemetryValue(parsed)
      : parsed
  } catch {
    return value
  }
}

function isSymbolNodeId(value: string) {
  const normalized = value.trim()
  return normalized.startsWith('symbol:') && normalized.length > 'symbol:'.length
}

function cleanTelemetryReferenceToken(value: string) {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^[([{<]+/g, '')
    .replace(/[)\]},;>]+$/g, '')
    .trim()
}

function roundMetric(value: number) {
  return Math.round(value * 1000) / 1000
}

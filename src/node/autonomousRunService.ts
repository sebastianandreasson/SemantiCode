import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import type {
  AgentFileOperation,
  AutonomousRunDetail,
  AutonomousRunLiveFeedEntry,
  AutonomousRunScope,
  AutonomousRunStartRequest,
  AutonomousRunStatus,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
} from '../types'
import { AgentTelemetryService } from './telemetryService'
import {
  detectPiTaskFile,
  getPiRunDir,
  getPiRunScopedPaths,
  getScopedInstructionsFile,
  markRunStopped,
  readRunScopeMetadata,
  resolvePiHarnessPaths,
  writeRunScopeMetadata,
} from './piHarnessPaths'
import { createFileOperationsFromToolInvocation } from '../desktop/agent-runtime/agentFileOperations'

interface ActiveRunProcess {
  process: ReturnType<typeof spawn>
  runId: string | null
  scope: AutonomousRunScope | null
}

interface ResolvedActiveRunState {
  runId: string | null
  staleRunId: string | null
}

interface RunStateRecord {
  [key: string]: unknown
  inProgress?: {
    [key: string]: unknown
    iteration?: number
    phase?: string
    task?: string
  } | null
  iteration?: number
  lastPhase?: string
  lastRunAt?: string
  lastStatus?: string
}

interface LastIterationRecord {
  [key: string]: unknown
  iteration?: number
  phase?: string
  task?: string
  terminalReason?: string
}

interface RunTelemetryEventRecord {
  [key: string]: unknown
  iteration?: number
  kind?: string
  notes?: string
  phase?: string
  reason?: string
  role?: string
  status?: string
  task?: string
  timestamp?: string
  totalTokens?: number
}

const require = createRequire(import.meta.url)
const PI_HARNESS_ENTRY = resolve(
  dirname(require.resolve('@sebastianandreasson/pi-autonomous-agents')),
  'cli.mjs',
)

export class AutonomousRunService {
  private readonly activeRunsByRootDir = new Map<string, ActiveRunProcess>()
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>
  private readonly telemetryService: AgentTelemetryService

  constructor(options: {
    logger?: Pick<Console, 'error' | 'info' | 'warn'>
    telemetryService: AgentTelemetryService
  }) {
    this.logger = options.logger ?? console
    this.telemetryService = options.telemetryService
  }

  async getDetectedTaskFile(rootDir: string) {
    return detectPiTaskFile(rootDir)
  }

  async listRuns(rootDir: string) {
    const paths = await resolvePiHarnessPaths(rootDir)
    const activeRun = await this.resolveActiveRunState(rootDir)
    const runsDir = join(paths.piRuntimeDir, 'runs')
    let entries: { name: string }[] = []

    try {
      entries = (await readdir(runsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name }))
    } catch {
      entries = []
    }

    const runs = await Promise.all(
      entries.map(async (entry) =>
        this.buildRunSummary(rootDir, entry.name, activeRun.runId, activeRun.staleRunId),
      ),
    )

    return {
      activeRunId: activeRun.runId,
      runs: runs
        .filter((run): run is AutonomousRunSummary => run !== null)
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))),
    }
  }

  async getRunDetail(rootDir: string, runId: string): Promise<AutonomousRunDetail | null> {
    const activeRun = await this.resolveActiveRunState(rootDir)
    const summary = await this.buildRunSummary(rootDir, runId, activeRun.runId, activeRun.staleRunId)

    if (!summary) {
      return null
    }

    const paths = await resolvePiHarnessPaths(rootDir)
    const runPaths = getPiRunScopedPaths(paths, runId)
    const [scope, logExcerpt, lastOutputExcerpt, liveFeed, runTelemetryEvents] = await Promise.all([
      readRunScopeMetadata(rootDir, runId),
      readExcerpt(runPaths.logFile, 7000),
      readExcerpt(runPaths.lastOutputFile, 4000),
      readRunLiveFeed(runPaths.liveFeedFile),
      readRunTelemetryEvents(rootDir, runId),
    ])

    return {
      ...summary,
      fileOperations: createFileOperationsFromLiveFeed({
        liveFeed,
        rootDir,
        runId,
      }),
      lastOutputExcerpt,
      liveFeed,
      logExcerpt,
      scope:
        scope && scope.paths.length > 0
          ? {
              layoutTitle: scope.layoutTitle,
              paths: scope.paths,
              symbolPaths: scope.symbolPaths,
              title: scope.title,
            }
          : null,
      todos: deriveRunTodoSummaries(runTelemetryEvents),
    }
  }

  async getRunTimeline(rootDir: string, runId: string): Promise<AutonomousRunTimelinePoint[]> {
    const runTelemetryEvents = await readRunTelemetryEvents(rootDir, runId)
    return deriveRunTimeline(runTelemetryEvents)
  }

  async startRun(rootDir: string, input: AutonomousRunStartRequest) {
    const normalizedRootDir = resolve(rootDir)
    const activeRecord = this.activeRunsByRootDir.get(normalizedRootDir)

    if (activeRecord?.process.exitCode === null) {
      throw new Error('An autonomous run is already active for this workspace.')
    }

    const taskFile = input.taskFile ? resolve(input.taskFile) : await detectPiTaskFile(normalizedRootDir)

    if (!taskFile) {
      throw new Error('No TODO file was found. Expected TODOS.md, TODOs.md, or TODO.md.')
    }

    await this.telemetryService.ensureWorkspaceTelemetry(normalizedRootDir)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_REQUEST_TELEMETRY_ENABLED: '1',
      PI_TASK_FILE: taskFile,
      PI_VISUALIZER: '0',
    }
    const scope = normalizeScope(input.scope ?? null)

    if (scope) {
      env.PI_DEVELOPER_INSTRUCTIONS_FILE = await this.createScopedInstructionsFile(
        normalizedRootDir,
        taskFile,
        scope,
      )
    }

    const child = spawn(process.execPath, [PI_HARNESS_ENTRY, 'run'], {
      cwd: normalizedRootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const processRecord: ActiveRunProcess = {
      process: child,
      runId: null,
      scope,
    }

    this.activeRunsByRootDir.set(normalizedRootDir, processRecord)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk ?? '').trim()

      if (text) {
        this.logger.info(`[semanticode][autonomous-run] ${text}`)
      }
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk ?? '').trim()

      if (text) {
        this.logger.warn(`[semanticode][autonomous-run] ${text}`)
      }
    })

    child.once('exit', (code, signal) => {
      this.activeRunsByRootDir.delete(normalizedRootDir)
      this.logger.info(
        `[semanticode][autonomous-run] Workspace ${normalizedRootDir} run exited with code=${String(code ?? '')} signal=${String(signal ?? '')}.`,
      )
    })

    const runId = await this.waitForRunId(normalizedRootDir)
    processRecord.runId = runId

    if (scope) {
      await writeRunScopeMetadata(normalizedRootDir, runId, scope)
    }

    const detail = await this.getRunDetail(normalizedRootDir, runId)

    if (!detail) {
      throw new Error('The autonomous run started but no run detail could be read yet.')
    }

    return detail
  }

  async stopRun(rootDir: string, runId: string) {
    const normalizedRootDir = resolve(rootDir)
    const activeRecord = this.activeRunsByRootDir.get(normalizedRootDir)
    let stopped = false

    if (activeRecord && (!runId || activeRecord.runId === runId)) {
      activeRecord.process.kill('SIGTERM')
      stopped = true
    } else {
      const paths = await resolvePiHarnessPaths(normalizedRootDir)
      const activeRun = await readActiveRunLock(paths.activeRunFile)

      if (activeRun?.runId === runId && typeof activeRun.pid === 'number') {
        try {
          process.kill(activeRun.pid, 'SIGTERM')
          stopped = true
        } catch (error) {
          if (isMissingProcessError(error)) {
            await clearActiveRunLock(paths.activeRunFile)
            stopped = true
          } else {
            throw error
          }
        }
      }
    }

    if (stopped && runId) {
      await markRunStopped(normalizedRootDir, runId)
    }

    return {
      ok: stopped,
      runId: runId || null,
    }
  }

  private async buildRunSummary(
    rootDir: string,
    runId: string,
    activeRunId: string | null,
    staleRunId: string | null,
  ): Promise<AutonomousRunSummary | null> {
    const paths = await resolvePiHarnessPaths(rootDir)
    const runDir = getPiRunDir(paths, runId)
    const runPaths = getPiRunScopedPaths(paths, runId)
    const [directoryStat, state, lastIteration, tokenSummary, runTelemetryEvents, scope] = await Promise.all([
      stat(runDir).catch(() => null),
      readJsonFile<RunStateRecord>(runPaths.stateFile),
      readJsonFile<LastIterationRecord>(runPaths.lastIterationSummaryFile),
      this.telemetryService.getRunTokenSummary(rootDir, runId),
      readRunTelemetryEvents(rootDir, runId),
      readRunScopeMetadata(rootDir, runId),
    ])

    if (!directoryStat) {
      return null
    }

    const updatedAt =
      String(state?.lastRunAt ?? '') ||
      directoryStat.mtime.toISOString()
    const status = deriveRunStatus({
      activeRunId,
      hasInProgress: Boolean(state?.inProgress),
      lastStatus: String(state?.lastStatus ?? ''),
      runId,
      staleRunId,
      stoppedAt: scope?.stoppedAt,
      terminalReason: String(lastIteration?.terminalReason ?? ''),
    })

    const todoSummaries = deriveRunTodoSummaries(runTelemetryEvents)
    const timeline = deriveRunTimeline(runTelemetryEvents)

    return {
      completedTodoCount: todoSummaries.length,
      isActive: activeRunId === runId,
      iteration: Number(state?.iteration ?? lastIteration?.iteration ?? 0),
      phase: String(state?.inProgress?.phase ?? state?.lastPhase ?? lastIteration?.phase ?? ''),
      requestCount: timeline.length,
      runId,
      startedAt: directoryStat.birthtime?.toISOString?.() ?? directoryStat.mtime.toISOString(),
      status,
      task: String(state?.inProgress?.task ?? lastIteration?.task ?? ''),
      taskFile: await detectPiTaskFile(rootDir),
      terminalReason: String(lastIteration?.terminalReason ?? '') || null,
      totalTokens: tokenSummary.totals.totalTokens,
      updatedAt,
    }
  }

  private async createScopedInstructionsFile(
    rootDir: string,
    taskFile: string,
    scope: AutonomousRunScope,
  ) {
    const key = `scope-${randomUUID()}`
    const targetPath = getScopedInstructionsFile(rootDir, key)
    const lines = [
      '# Semanticode Autonomous Run Scope',
      '',
      `Task file: ${taskFile}`,
      '',
      'Work through the TODO file normally, but treat this as the primary working set unless blocked.',
      'Do not leave this scope unless you need a dependency or caller/callee outside it.',
      'If you leave scope, mention why in the work log.',
      '',
      scope.title ? `Scope title: ${scope.title}` : '',
      scope.layoutTitle ? `Layout: ${scope.layoutTitle}` : '',
      'Scoped paths:',
      ...scope.paths.map((pathValue) => `- ${pathValue}`),
      scope.symbolPaths?.length ? '' : '',
      scope.symbolPaths?.length ? 'Scoped symbols:' : '',
      ...(scope.symbolPaths ?? []).map((pathValue) => `- ${pathValue}`),
      '',
    ].filter(Boolean)

    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, `${lines.join('\n')}\n`, 'utf8')
    return targetPath
  }

  private async waitForRunId(rootDir: string) {
    const paths = await resolvePiHarnessPaths(rootDir)
    const timeoutAt = Date.now() + 15_000

    while (Date.now() < timeoutAt) {
      const activeRun = await readActiveRunLock(paths.activeRunFile)

      if (activeRun?.runId) {
        return activeRun.runId
      }

      await delay(250)
    }

    throw new Error('The autonomous run started but did not publish an active run id in time.')
  }

  private async resolveActiveRunState(rootDir: string): Promise<ResolvedActiveRunState> {
    const normalizedRootDir = resolve(rootDir)
    const inMemoryRun = this.activeRunsByRootDir.get(normalizedRootDir)

    if (inMemoryRun?.process.exitCode === null && inMemoryRun.runId) {
      return {
        runId: inMemoryRun.runId,
        staleRunId: null,
      }
    }

    const paths = await resolvePiHarnessPaths(normalizedRootDir)
    const activeRun = await readActiveRunLock(paths.activeRunFile)

    if (!activeRun?.runId) {
      return {
        runId: null,
        staleRunId: null,
      }
    }

    const pidAlive =
      typeof activeRun.pid === 'number' ? isProcessAlive(activeRun.pid) : null
    const heartbeatFresh = isHeartbeatFresh(activeRun.heartbeatAt)

    if (pidAlive === true || (pidAlive === null && heartbeatFresh)) {
      return {
        runId: activeRun.runId,
        staleRunId: null,
      }
    }

    await clearActiveRunLock(paths.activeRunFile)
    this.logger.warn(
      `[semanticode][autonomous-run] Cleared stale active run lock for ${normalizedRootDir} run=${activeRun.runId} pid=${String(activeRun.pid ?? '')}.`,
    )

    return {
      runId: null,
      staleRunId: activeRun.runId,
    }
  }
}

function normalizeScope(scope: AutonomousRunScope | null) {
  if (!scope || !Array.isArray(scope.paths) || scope.paths.length === 0) {
    return null
  }

  return {
    layoutTitle: scope.layoutTitle,
    paths: scope.paths.map((pathValue) => String(pathValue)).filter(Boolean),
    symbolPaths: Array.isArray(scope.symbolPaths)
      ? scope.symbolPaths.map((pathValue) => String(pathValue)).filter(Boolean)
      : undefined,
    title: scope.title,
  } satisfies AutonomousRunScope
}

function deriveRunStatus(input: {
  activeRunId: string | null
  hasInProgress: boolean
  lastStatus: string
  runId: string
  staleRunId: string | null
  stoppedAt?: string
  terminalReason: string
}): AutonomousRunStatus {
  if (input.activeRunId === input.runId) {
    return 'running'
  }

  if (input.stoppedAt) {
    return 'stopped'
  }

  if (input.lastStatus === 'success' || input.lastStatus === 'complete') {
    return 'completed'
  }

  if (
    input.lastStatus === 'failed' ||
    input.lastStatus === 'error' ||
    input.lastStatus === 'stalled' ||
    input.terminalReason.startsWith('verification_')
  ) {
    return 'failed'
  }

  if (input.staleRunId === input.runId && input.hasInProgress) {
    return 'stopped'
  }

  return 'idle'
}

async function readActiveRunLock(filePath: string) {
  return readJsonFile<{
    heartbeatAt?: string
    pid?: number
    runId?: string
    startedAt?: string
    status?: string
  }>(filePath)
}

async function clearActiveRunLock(filePath: string) {
  try {
    await unlink(filePath)
  } catch {
    // Ignore cleanup failures; the caller will simply treat the lock as absent.
  }
}

function isHeartbeatFresh(heartbeatAt: string | undefined, maxAgeMs = 120_000) {
  if (!heartbeatAt) {
    return false
  }

  const heartbeatTime = new Date(heartbeatAt).getTime()

  if (!Number.isFinite(heartbeatTime)) {
    return false
  }

  return Date.now() - heartbeatTime <= maxAgeMs
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false
    }

    return true
  }
}

function isMissingProcessError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ESRCH'
  )
}

function deriveRunTimeline(events: RunTelemetryEventRecord[]): AutonomousRunTimelinePoint[] {
  return events
    .filter((event) => Number(event.totalTokens ?? 0) > 0)
    .map((event, index) => {
      const iteration = Number(event.iteration ?? 0)
      const labelParts = [
        event.role ? String(event.role) : '',
        event.kind ? String(event.kind) : '',
        iteration > 0 ? `iteration ${iteration}` : '',
      ].filter(Boolean)

      return {
        key: `${String(event.timestamp ?? '')}:${String(event.kind ?? '')}:${index}`,
        timestamp: String(event.timestamp ?? ''),
        label: labelParts.join(' · ') || String(event.reason ?? event.status ?? 'run event'),
        requestCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: Number(event.totalTokens ?? 0),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      } satisfies AutonomousRunTimelinePoint
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
}

function deriveRunTodoSummaries(events: RunTelemetryEventRecord[]) {
  const iterationSummaries = events.filter((event) => event.kind === 'iteration_summary')

  return iterationSummaries.map((event, index) => {
    const iteration = Number(event.iteration ?? index + 1)
    const task =
      String(event.task ?? '').trim() ||
      String(event.reason ?? '').trim() ||
      `Iteration ${iteration}`

    return {
      key: `todo:${iteration}:${String(event.timestamp ?? index)}`,
      iteration,
      phase: String(event.phase ?? ''),
      task,
      status: String(event.status ?? 'success'),
      requestCount: 1,
      firstTimestamp: String(event.timestamp ?? ''),
      lastTimestamp: String(event.timestamp ?? ''),
      roles: [],
      kinds: ['iteration_summary'],
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: Number(event.totalTokens ?? 0),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  })
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function readExcerpt(filePath: string, maxCharacters: number) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const text = raw.trim()

    if (text.length <= maxCharacters) {
      return text
    }

    return `${text.slice(0, maxCharacters - 18)}\n... [truncated]`
  } catch {
    return ''
  }
}

async function readRunLiveFeed(filePath: string): Promise<AutonomousRunLiveFeedEntry[]> {
  const records = await readJsonlTail<AutonomousRunLiveFeedEntry>(filePath, {
    maxBytes: 768 * 1024,
    maxItems: 300,
  })

  return records
    .map(normalizeLiveFeedEntry)
    .filter((entry): entry is AutonomousRunLiveFeedEntry => entry !== null)
    .sort(compareLiveFeedEntries)
}

function createFileOperationsFromLiveFeed(input: {
  liveFeed: AutonomousRunLiveFeedEntry[]
  rootDir: string
  runId: string
}): AgentFileOperation[] {
  const operationsById = new Map<string, AgentFileOperation>()
  const activeToolIdsByName = new Map<string, string>()

  input.liveFeed.forEach((entry, index) => {
    if (!isToolLiveFeedEntry(entry)) {
      return
    }

    const toolName = String(entry.toolName ?? '').trim()

    if (!toolName) {
      return
    }

    const toolKey = getLiveFeedToolKey(input.runId, entry, index)
    const normalizedToolName = toolName.toLowerCase()
    const activeToolId =
      entry.type === 'tool_start'
        ? toolKey
        : activeToolIdsByName.get(normalizedToolName) ?? toolKey

    if (entry.type === 'tool_start') {
      activeToolIdsByName.set(normalizedToolName, activeToolId)
    }

    const operations = createFileOperationsFromToolInvocation({
      invocation: {
        args: getLiveFeedInvocationArgs(entry),
        endedAt: entry.type === 'tool_end' ? entry.timestamp : undefined,
        isError: entry.isError,
        paths: getLiveFeedPaths(entry),
        resultPreview: entry.resultSummary ?? entry.partialSummary,
        startedAt: entry.timestamp,
        toolCallId: activeToolId,
        toolName,
      },
      sessionId: String(entry.sessionId ?? '').trim() || input.runId,
      source: 'request-telemetry',
      status: getLiveFeedOperationStatus(entry),
      timestamp: entry.timestamp,
      workspaceRootDir: input.rootDir,
    })

    for (const operation of operations) {
      const current = operationsById.get(operation.id)

      if (!current || compareOperationsAscending(current, operation) <= 0) {
        operationsById.set(operation.id, operation)
      }
    }

    if (entry.type === 'tool_end') {
      activeToolIdsByName.delete(normalizedToolName)
    }
  })

  return [...operationsById.values()].sort(compareOperationsAscending)
}

function isToolLiveFeedEntry(entry: AutonomousRunLiveFeedEntry) {
  return (
    entry.type === 'tool_start' ||
    entry.type === 'tool_update' ||
    entry.type === 'tool_end'
  )
}

function getLiveFeedToolKey(
  runId: string,
  entry: AutonomousRunLiveFeedEntry,
  index: number,
) {
  return [
    'autonomous-live-feed',
    runId,
    String(entry.seq ?? index),
    String(entry.toolName ?? ''),
  ].join(':')
}

function getLiveFeedInvocationArgs(entry: AutonomousRunLiveFeedEntry) {
  return parseLiveFeedSummary(entry.argsSummary) ?? {
    files: entry.files ?? [],
    path: entry.primaryFile ?? '',
  }
}

function getLiveFeedPaths(entry: AutonomousRunLiveFeedEntry) {
  return [
    entry.primaryFile,
    ...(Array.isArray(entry.files) ? entry.files : []),
  ]
    .map((pathValue) => String(pathValue ?? '').trim())
    .filter(Boolean)
}

function getLiveFeedOperationStatus(entry: AutonomousRunLiveFeedEntry) {
  if (entry.type === 'tool_end') {
    return entry.isError ? 'error' : 'completed'
  }

  return 'running'
}

function parseLiveFeedSummary(value: string | undefined) {
  const trimmed = String(value ?? '').trim()

  if (!trimmed) {
    return undefined
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return trimmed
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return trimmed
  }
}

function compareOperationsAscending(
  left: AgentFileOperation,
  right: AgentFileOperation,
) {
  const leftTime = new Date(left.timestamp).getTime()
  const rightTime = new Date(right.timestamp).getTime()

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  if (left.status !== right.status) {
    return getOperationStatusRank(left.status) - getOperationStatusRank(right.status)
  }

  return left.id.localeCompare(right.id)
}

function getOperationStatusRank(status: AgentFileOperation['status']) {
  if (status === 'running') {
    return 0
  }

  if (status === 'error') {
    return 1
  }

  return 2
}

async function readJsonlTail<T>(
  filePath: string,
  input: {
    maxBytes: number
    maxItems: number
  },
) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const truncated = raw.length > input.maxBytes
    const tail = truncated ? raw.slice(-input.maxBytes) : raw
    const lines = tail.split('\n')

    if (truncated && lines.length > 0) {
      lines.shift()
    }

    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-input.maxItems)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function normalizeLiveFeedEntry(entry: AutonomousRunLiveFeedEntry | null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }

  const normalized: AutonomousRunLiveFeedEntry = {
    ...entry,
    iteration: Number(entry.iteration ?? 0),
    kind: String(entry.kind ?? ''),
    phase: String(entry.phase ?? ''),
    role: String(entry.role ?? ''),
    text: String(entry.text ?? ''),
    timestamp: String(entry.timestamp ?? ''),
    type: String(entry.type ?? 'event'),
  }

  const seq = Number(entry.seq)
  if (Number.isFinite(seq)) {
    normalized.seq = seq
  }

  return normalized
}

function compareLiveFeedEntries(
  left: AutonomousRunLiveFeedEntry,
  right: AutonomousRunLiveFeedEntry,
) {
  const leftSeq = Number(left.seq)
  const rightSeq = Number(right.seq)

  if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) {
    return leftSeq - rightSeq
  }

  return left.timestamp.localeCompare(right.timestamp)
}

async function readRunTelemetryEvents(rootDir: string, runId: string): Promise<RunTelemetryEventRecord[]> {
  const paths = await resolvePiHarnessPaths(rootDir)
  const runPaths = getPiRunScopedPaths(paths, runId)

  try {
    const raw = await readFile(runPaths.telemetryJsonl, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunTelemetryEventRecord)
  } catch {
    return []
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds)
  })
}

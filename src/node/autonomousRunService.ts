import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import type {
  AutonomousRunDetail,
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

interface ActiveRunProcess {
  process: ReturnType<typeof spawn>
  runId: string | null
  scope: AutonomousRunScope | null
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
    const activeRun = await readActiveRunLock(paths.activeRunFile)
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
      entries.map(async (entry) => this.buildRunSummary(rootDir, entry.name, activeRun?.runId ?? null)),
    )

    return {
      activeRunId: activeRun?.runId ?? null,
      runs: runs
        .filter((run): run is AutonomousRunSummary => run !== null)
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))),
    }
  }

  async getRunDetail(rootDir: string, runId: string): Promise<AutonomousRunDetail | null> {
    const paths = await resolvePiHarnessPaths(rootDir)
    const activeRun = await readActiveRunLock(paths.activeRunFile)
    const summary = await this.buildRunSummary(rootDir, runId, activeRun?.runId ?? null)

    if (!summary) {
      return null
    }

    const runPaths = getPiRunScopedPaths(paths, runId)
    const [scope, logExcerpt, lastOutputExcerpt, runTelemetryEvents] = await Promise.all([
      readRunScopeMetadata(rootDir, runId),
      readExcerpt(runPaths.logFile, 7000),
      readExcerpt(runPaths.lastOutputFile, 4000),
      readRunTelemetryEvents(rootDir, runId),
    ])

    return {
      ...summary,
      lastOutputExcerpt,
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
        process.kill(activeRun.pid, 'SIGTERM')
        stopped = true
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
      lastStatus: String(state?.lastStatus ?? ''),
      runId,
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
  lastStatus: string
  runId: string
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

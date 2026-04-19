import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { AutonomousRunScope } from '../types'

interface PiHarnessConfig {
  activeRunFile?: string
  piRuntimeDir?: string
  taskFile?: string
  tokenUsageEventsFile?: string
  tokenUsageSummaryFile?: string
}

export interface PiHarnessPaths {
  activeRunFile: string
  piRuntimeDir: string
  requestTelemetryRootDir: string
  rootDir: string
  taskFile: string
  tokenUsageEventsFile: string
  tokenUsageSummaryFile: string
}

export interface RunScopeMetadata {
  layoutTitle?: string
  paths: string[]
  stoppedAt?: string
  symbolPaths?: string[]
  title?: string
}

const DEFAULT_TASK_FILE_CANDIDATES = ['TODOS.md', 'TODOs.md', 'TODO.md'] as const

export async function resolvePiHarnessPaths(rootDir: string): Promise<PiHarnessPaths> {
  const normalizedRootDir = resolve(rootDir)
  const config = await readRepoPiConfig(normalizedRootDir)

  return {
    activeRunFile: resolveSetting(normalizedRootDir, config.activeRunFile, '.pi-runtime/active-run.json'),
    piRuntimeDir: resolveSetting(normalizedRootDir, config.piRuntimeDir, '.pi-runtime'),
    requestTelemetryRootDir: join(normalizedRootDir, 'pi-output', 'request-telemetry'),
    rootDir: normalizedRootDir,
    taskFile: resolveSetting(normalizedRootDir, config.taskFile, 'TODOS.md'),
    tokenUsageEventsFile: resolveSetting(
      normalizedRootDir,
      config.tokenUsageEventsFile,
      'pi-output/token-usage/events.jsonl',
    ),
    tokenUsageSummaryFile: resolveSetting(
      normalizedRootDir,
      config.tokenUsageSummaryFile,
      'pi-output/token-usage/summary.json',
    ),
  }
}

export async function detectPiTaskFile(rootDir: string) {
  const paths = await resolvePiHarnessPaths(rootDir)

  if (await pathExists(paths.taskFile)) {
    return paths.taskFile
  }

  for (const candidate of DEFAULT_TASK_FILE_CANDIDATES) {
    const candidatePath = join(paths.rootDir, candidate)

    if (await pathExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

export function getPiRunDir(paths: PiHarnessPaths, runId: string) {
  return join(paths.piRuntimeDir, 'runs', runId)
}

export function getPiRunScopedPaths(paths: PiHarnessPaths, runId: string) {
  const runDir = getPiRunDir(paths, runId)

  return {
    lastIterationSummaryFile: join(runDir, 'last-iteration.json'),
    lastOutputFile: join(runDir, 'last-output.txt'),
    liveFeedFile: join(runDir, 'live-feed.jsonl'),
    logFile: join(runDir, 'pi.log'),
    runDir,
    stateFile: join(runDir, 'state.json'),
    telemetryJsonl: join(runDir, 'pi_telemetry.jsonl'),
    tokenUsageEventsFile: join(runDir, 'token-usage.events.jsonl'),
    tokenUsageSummaryFile: join(runDir, 'token-usage.summary.json'),
  }
}

export async function readRunScopeMetadata(rootDir: string, runId: string) {
  const filePath = getRunScopeMetadataFile(rootDir, runId)

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as RunScopeMetadata

    if (!Array.isArray(parsed.paths)) {
      return null
    }

    return {
      layoutTitle: typeof parsed.layoutTitle === 'string' ? parsed.layoutTitle : undefined,
      paths: parsed.paths.map((pathValue) => String(pathValue)).filter(Boolean),
      stoppedAt: typeof parsed.stoppedAt === 'string' ? parsed.stoppedAt : undefined,
      symbolPaths: Array.isArray(parsed.symbolPaths)
        ? parsed.symbolPaths.map((pathValue) => String(pathValue)).filter(Boolean)
        : undefined,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
    } satisfies RunScopeMetadata
  } catch {
    return null
  }
}

export async function writeRunScopeMetadata(
  rootDir: string,
  runId: string,
  scope: AutonomousRunScope | RunScopeMetadata | null,
) {
  if (!scope) {
    return
  }

  const filePath = getRunScopeMetadataFile(rootDir, runId)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(scope, null, 2)}\n`, 'utf8')
}

export async function markRunStopped(rootDir: string, runId: string) {
  const existing = await readRunScopeMetadata(rootDir, runId)

  await writeRunScopeMetadata(rootDir, runId, {
    ...(existing ?? { paths: [] }),
    stoppedAt: new Date().toISOString(),
  })
}

export function getSemanticodePiRuntimeDir(rootDir: string) {
  return join(resolve(rootDir), '.semanticode', 'pi-autonomous-agents')
}

export function getScopedInstructionsFile(rootDir: string, key: string) {
  return join(getSemanticodePiRuntimeDir(rootDir), 'instructions', `${key}.md`)
}

async function readRepoPiConfig(rootDir: string): Promise<PiHarnessConfig> {
  const configPath = join(rootDir, 'pi.config.json')

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as PiHarnessConfig

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return parsed
  } catch {
    return {}
  }
}

function resolveSetting(rootDir: string, value: string | undefined, fallback: string) {
  return resolve(rootDir, value?.trim() || fallback)
}

function getRunScopeMetadataFile(rootDir: string, runId: string) {
  return join(getSemanticodePiRuntimeDir(rootDir), 'runs', `${runId}.json`)
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { ProjectSnapshot, ReadProjectSnapshotOptions } from '../types'
import { getGitWorkspaceStatus } from './gitWorkspaceSync'
import { getBuiltInProjectPluginCacheSignatures } from './project-plugins'

const SNAPSHOT_CACHE_DIRECTORY = '.semanticode/cache'
const SNAPSHOT_CACHE_FILE = 'project-snapshot.json'
const SNAPSHOT_CACHE_VERSION = 8

interface PersistedProjectSnapshotCache {
  version: number
  rootDir: string
  optionsKey: string
  fingerprint: string
  snapshot: ProjectSnapshot
}

const snapshotMemoryCache = new Map<string, PersistedProjectSnapshotCache>()
const MAX_SNAPSHOT_MEMORY_CACHE_ENTRIES = 6

export async function readCachedProjectSnapshot(input: {
  rootDir: string
  options: ReadProjectSnapshotOptions
}) {
  if (!canUseProjectSnapshotCache(input.options)) {
    return null
  }

  const fingerprint = await getProjectSnapshotFingerprint(input.rootDir)
  const optionsKey = getProjectSnapshotOptionsKey(input.options)

  if (!fingerprint) {
    return null
  }

  const memoryKey = getSnapshotMemoryCacheKey(input.rootDir, optionsKey)
  const memoryEntry = snapshotMemoryCache.get(memoryKey)

  if (
    memoryEntry &&
    memoryEntry.version === SNAPSHOT_CACHE_VERSION &&
    memoryEntry.rootDir === input.rootDir &&
    memoryEntry.optionsKey === optionsKey &&
    memoryEntry.fingerprint === fingerprint
  ) {
    snapshotMemoryCache.delete(memoryKey)
    snapshotMemoryCache.set(memoryKey, memoryEntry)
    return memoryEntry.snapshot
  }

  try {
    const rawValue = await readFile(getProjectSnapshotCachePath(input.rootDir), 'utf8')
    const parsed = JSON.parse(rawValue) as PersistedProjectSnapshotCache

    if (
      !parsed ||
      parsed.version !== SNAPSHOT_CACHE_VERSION ||
      parsed.rootDir !== input.rootDir ||
      parsed.optionsKey !== optionsKey ||
      parsed.fingerprint !== fingerprint ||
      !parsed.snapshot ||
      parsed.snapshot.rootDir !== input.rootDir
    ) {
      return null
    }

    setSnapshotMemoryCacheEntry(memoryKey, parsed)

    return parsed.snapshot
  } catch {
    return null
  }
}

export async function writeCachedProjectSnapshot(input: {
  rootDir: string
  options: ReadProjectSnapshotOptions
  snapshot: ProjectSnapshot
}) {
  if (!canUseProjectSnapshotCache(input.options)) {
    return
  }

  const fingerprint = await getProjectSnapshotFingerprint(input.rootDir)

  if (!fingerprint) {
    return
  }

  const cachePayload: PersistedProjectSnapshotCache = {
    version: SNAPSHOT_CACHE_VERSION,
    rootDir: input.rootDir,
    optionsKey: getProjectSnapshotOptionsKey(input.options),
    fingerprint,
    snapshot: input.snapshot,
  }
  const path = getProjectSnapshotCachePath(input.rootDir)
  const memoryKey = getSnapshotMemoryCacheKey(input.rootDir, cachePayload.optionsKey)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(cachePayload), 'utf8')
  setSnapshotMemoryCacheEntry(memoryKey, cachePayload)
}

export function clearProjectSnapshotMemoryCache(rootDir?: string) {
  if (!rootDir) {
    snapshotMemoryCache.clear()
    return
  }

  for (const key of snapshotMemoryCache.keys()) {
    if (key.startsWith(`${rootDir}::`)) {
      snapshotMemoryCache.delete(key)
    }
  }
}

function canUseProjectSnapshotCache(options: ReadProjectSnapshotOptions) {
  return !options.adapters?.length && !options.projectPlugins?.length
}

function getProjectSnapshotOptionsKey(options: ReadProjectSnapshotOptions) {
  return JSON.stringify({
    analyzeCalls: options.analyzeCalls ?? false,
    analyzeImports: options.analyzeImports ?? false,
    analyzeSymbols: options.analyzeSymbols ?? false,
    ignoredNames: [...(options.ignoredNames ?? [])].sort(),
    includeContents: options.includeContents ?? true,
    maxDepth: options.maxDepth ?? 12,
    maxFileSize: options.maxFileSize ?? 100_000,
    maxFiles: options.maxFiles ?? 2_000,
    projectPlugins: getBuiltInProjectPluginCacheSignatures(),
  })
}

async function getProjectSnapshotFingerprint(rootDir: string) {
  const git = await getGitWorkspaceStatus(rootDir)

  if (!git.isGitRepo || !git.head) {
    return null
  }

  const changedEntries = await Promise.all(
    git.changedFiles.map(async (relativePath) => ({
      path: relativePath,
      signature: await getChangedPathSignature(rootDir, relativePath),
    })),
  )

  return JSON.stringify({
    head: git.head,
    changedEntries,
  })
}

async function getChangedPathSignature(rootDir: string, relativePath: string) {
  try {
    const stats = await stat(resolve(rootDir, relativePath))

    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      mtimeMs: Math.trunc(stats.mtimeMs),
      size: stats.size,
    }
  } catch {
    return {
      exists: false,
    }
  }
}

function getProjectSnapshotCachePath(rootDir: string) {
  return join(rootDir, SNAPSHOT_CACHE_DIRECTORY, SNAPSHOT_CACHE_FILE)
}

function getSnapshotMemoryCacheKey(rootDir: string, optionsKey: string) {
  return `${rootDir}::${optionsKey}`
}

function setSnapshotMemoryCacheEntry(
  key: string,
  value: PersistedProjectSnapshotCache,
) {
  snapshotMemoryCache.delete(key)
  snapshotMemoryCache.set(key, value)

  while (snapshotMemoryCache.size > MAX_SNAPSHOT_MEMORY_CACHE_ENTRIES) {
    const oldestKey = snapshotMemoryCache.keys().next().value

    if (!oldestKey) {
      break
    }

    snapshotMemoryCache.delete(oldestKey)
  }
}

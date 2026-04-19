import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { buildSemanticLayout } from '../semantic/semanticLayout'
import type { PreprocessedWorkspaceContext } from '../preprocessing/types'
import type { LayoutSpec, ProjectSnapshot } from '../types'

const SEMANTIC_LAYOUT_CACHE_FILE = '.semanticode/cache/semantic-layout.json'
const SEMANTIC_LAYOUT_CACHE_VERSION = 1

interface PersistedSemanticLayoutCache {
  version: number
  rootDir: string
  cacheKey: string
  layout: LayoutSpec
}

export interface SemanticLayoutCacheResult {
  cached: boolean
  layout: LayoutSpec
}

export async function readOrBuildSemanticLayout(input: {
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  rootDir: string
  snapshot: ProjectSnapshot
}): Promise<SemanticLayoutCacheResult> {
  const cacheKey = getSemanticLayoutCacheKey(
    input.snapshot,
    input.preprocessedWorkspaceContext,
  )
  const cachedLayout = await readCachedSemanticLayout(input.rootDir, cacheKey)

  if (cachedLayout) {
    return {
      cached: true,
      layout: cachedLayout,
    }
  }

  const layout = buildSemanticLayout(input.snapshot, input.preprocessedWorkspaceContext)
  await writeCachedSemanticLayout({
    cacheKey,
    layout,
    rootDir: input.rootDir,
  })

  return {
    cached: false,
    layout,
  }
}

async function readCachedSemanticLayout(rootDir: string, cacheKey: string) {
  try {
    const raw = await readFile(getSemanticLayoutCachePath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as PersistedSemanticLayoutCache

    if (
      parsed.version !== SEMANTIC_LAYOUT_CACHE_VERSION ||
      parsed.rootDir !== rootDir ||
      parsed.cacheKey !== cacheKey ||
      !parsed.layout ||
      parsed.layout.strategy !== 'semantic'
    ) {
      return null
    }

    return parsed.layout
  } catch {
    return null
  }
}

async function writeCachedSemanticLayout(input: {
  cacheKey: string
  layout: LayoutSpec
  rootDir: string
}) {
  const path = getSemanticLayoutCachePath(input.rootDir)
  const payload: PersistedSemanticLayoutCache = {
    version: SEMANTIC_LAYOUT_CACHE_VERSION,
    rootDir: input.rootDir,
    cacheKey: input.cacheKey,
    layout: input.layout,
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(payload), 'utf8')
}

function getSemanticLayoutCachePath(rootDir: string) {
  return join(rootDir, SEMANTIC_LAYOUT_CACHE_FILE)
}

function getSemanticLayoutCacheKey(
  snapshot: ProjectSnapshot,
  context: PreprocessedWorkspaceContext | null,
) {
  const hash = createHash('sha256')

  hash.update(
    JSON.stringify({
      generatedAt: snapshot.generatedAt,
      rootDir: snapshot.rootDir,
      schemaVersion: snapshot.schemaVersion,
      totalEdges: snapshot.edges.length,
      totalFiles: snapshot.totalFiles,
      totalNodes: Object.keys(snapshot.nodes).length,
    }),
  )
  hash.update('\n')
  hash.update(
    JSON.stringify({
      contextComplete: context?.isComplete ?? false,
      contextSnapshotId: context?.snapshotId ?? null,
      embeddingCount: context?.semanticEmbeddings.length ?? 0,
      embeddingModelId: context?.semanticEmbeddingModelId ?? null,
      summaryCount: context?.purposeSummaries.length ?? 0,
    }),
  )

  return hash.digest('hex')
}

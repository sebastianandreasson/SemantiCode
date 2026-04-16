import {
  isDirectoryNode,
  isFileNode,
  isSymbolNode,
  type ProjectNode,
  type ProjectSnapshot,
} from '../schema/snapshot'
import type { LayoutDraft } from '../schema/planner'
import type { LayoutSpec } from '../schema/layout'
import { buildSemanticSymbolTextRecord, hashSemanticText } from '../semantic/symbolText'
import type {
  GitWorkspaceStatus,
  LayoutArtifactSyncStatus,
  PreprocessedWorkspaceContext,
  SymbolArtifactSyncStatus,
  WorkspaceArtifactSyncStatus,
} from './types'
import { getPreprocessableSymbols } from './preprocessingService'

export function analyzeWorkspaceArtifactSync(input: {
  snapshot: ProjectSnapshot
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  layouts: LayoutSpec[]
  draftLayouts: LayoutDraft[]
  git: GitWorkspaceStatus
}): WorkspaceArtifactSyncStatus {
  const changedFiles = new Set(input.git.changedFiles)

  return {
    git: input.git,
    summaries: analyzeSummarySync(
      input.snapshot,
      input.preprocessedWorkspaceContext,
    ),
    embeddings: analyzeEmbeddingSync(
      input.snapshot,
      input.preprocessedWorkspaceContext,
    ),
    layouts: input.layouts.map((layout) =>
      analyzeLayoutSync({
        snapshot: input.snapshot,
        sourceType: 'layout',
        changedFiles,
        id: layout.id,
        title: layout.title,
        layout,
      }),
    ),
    drafts: input.draftLayouts
      .filter((draft) => Boolean(draft.layout))
      .map((draft) =>
        analyzeLayoutSync({
          snapshot: input.snapshot,
          sourceType: 'draft',
          changedFiles,
          id: draft.id,
          title: draft.layout?.title ?? draft.id,
          layout: draft.layout!,
        }),
      ),
  }
}

function analyzeSummarySync(
  snapshot: ProjectSnapshot,
  context: PreprocessedWorkspaceContext | null,
): SymbolArtifactSyncStatus {
  const currentSymbols = getPreprocessableSymbols(snapshot)
  const currentSymbolIds = new Set(currentSymbols.map((symbol) => symbol.id))
  const summaryBySymbolId = new Map(
    context?.purposeSummaries.map((summary) => [summary.symbolId, summary]) ?? [],
  )
  const staleSymbolIds: string[] = []
  const obsoleteSymbolIds: string[] = []
  const affectedPaths = new Set<string>()

  for (const symbol of currentSymbols) {
    const currentSourceHash = buildSemanticSymbolTextRecord(snapshot, symbol, '').textHash
    const summary = summaryBySymbolId.get(symbol.id)

    if (!summary || summary.sourceHash !== currentSourceHash) {
      staleSymbolIds.push(symbol.id)
      affectedPaths.add(getNodeFilePath(snapshot, symbol) ?? symbol.path)
    }
  }

  for (const summary of context?.purposeSummaries ?? []) {
    if (!currentSymbolIds.has(summary.symbolId)) {
      obsoleteSymbolIds.push(summary.symbolId)
      affectedPaths.add(summary.path)
    }
  }

  return {
    state: getArtifactSyncState({
      availableCount: context?.purposeSummaries.length ?? 0,
      staleCount: staleSymbolIds.length,
      obsoleteCount: obsoleteSymbolIds.length,
    }),
    totalTracked: currentSymbols.length,
    staleCount: staleSymbolIds.length,
    obsoleteCount: obsoleteSymbolIds.length,
    staleSymbolIds,
    obsoleteSymbolIds,
    affectedPaths: [...affectedPaths].sort(),
  }
}

function analyzeEmbeddingSync(
  snapshot: ProjectSnapshot,
  context: PreprocessedWorkspaceContext | null,
): SymbolArtifactSyncStatus {
  const currentSymbols = getPreprocessableSymbols(snapshot)
  const currentSymbolIds = new Set(currentSymbols.map((symbol) => symbol.id))
  const summaryBySymbolId = new Map(
    context?.purposeSummaries.map((summary) => [summary.symbolId, summary]) ?? [],
  )
  const embeddingBySymbolId = new Map(
    context?.semanticEmbeddings.map((embedding) => [embedding.symbolId, embedding]) ?? [],
  )
  const staleSymbolIds: string[] = []
  const obsoleteSymbolIds: string[] = []
  const affectedPaths = new Set<string>()

  for (const symbol of currentSymbols) {
    const summary = summaryBySymbolId.get(symbol.id)
    const currentSourceHash = buildSemanticSymbolTextRecord(snapshot, symbol, '').textHash

    if (!summary || summary.sourceHash !== currentSourceHash) {
      staleSymbolIds.push(symbol.id)
      affectedPaths.add(getNodeFilePath(snapshot, symbol) ?? symbol.path)
      continue
    }

    const embedding = embeddingBySymbolId.get(symbol.id)
    const expectedTextHash = hashSemanticText(summary.embeddingText)

    if (!embedding || embedding.textHash !== expectedTextHash) {
      staleSymbolIds.push(symbol.id)
      affectedPaths.add(getNodeFilePath(snapshot, symbol) ?? symbol.path)
    }
  }

  for (const embedding of context?.semanticEmbeddings ?? []) {
    if (!currentSymbolIds.has(embedding.symbolId)) {
      obsoleteSymbolIds.push(embedding.symbolId)
    }
  }

  return {
    state: getArtifactSyncState({
      availableCount: context?.semanticEmbeddings.length ?? 0,
      staleCount: staleSymbolIds.length,
      obsoleteCount: obsoleteSymbolIds.length,
    }),
    totalTracked: currentSymbols.length,
    staleCount: staleSymbolIds.length,
    obsoleteCount: obsoleteSymbolIds.length,
    staleSymbolIds,
    obsoleteSymbolIds,
    affectedPaths: [...affectedPaths].sort(),
  }
}

function analyzeLayoutSync(input: {
  snapshot: ProjectSnapshot
  sourceType: 'layout' | 'draft'
  changedFiles: Set<string>
  id: string
  title: string
  layout: LayoutSpec
}): LayoutArtifactSyncStatus {
  const nodeIds = collectLayoutNodeIds(input.layout)
  const affectedNodeIds: string[] = []
  const missingNodeIds: string[] = []
  const affectedPaths = new Set<string>()

  for (const nodeId of nodeIds) {
    const node = input.snapshot.nodes[nodeId]

    if (!node) {
      missingNodeIds.push(nodeId)
      continue
    }

    const nodePaths = getNodeComparisonPaths(input.snapshot, node)
    const isAffected = nodePaths.some((path) => input.changedFiles.has(path))

    if (isAffected) {
      affectedNodeIds.push(nodeId)

      for (const path of nodePaths) {
        if (input.changedFiles.has(path)) {
          affectedPaths.add(path)
        }
      }
    }
  }

  return {
    id: input.id,
    title: input.title,
    sourceType: input.sourceType,
    state:
      affectedNodeIds.length > 0 || missingNodeIds.length > 0
        ? 'outdated'
        : 'in_sync',
    staleCount: affectedNodeIds.length,
    missingCount: missingNodeIds.length,
    affectedNodeIds,
    missingNodeIds,
    affectedPaths: [...affectedPaths].sort(),
  }
}

function getArtifactSyncState(input: {
  availableCount: number
  staleCount: number
  obsoleteCount: number
}) {
  if (input.availableCount === 0) {
    return 'missing' as const
  }

  if (input.staleCount > 0 || input.obsoleteCount > 0) {
    return 'outdated' as const
  }

  return 'in_sync' as const
}

function collectLayoutNodeIds(layout: LayoutSpec) {
  const nodeIds = new Set<string>([
    ...Object.keys(layout.placements),
    ...layout.hiddenNodeIds,
  ])

  for (const group of layout.groups) {
    for (const nodeId of group.nodeIds) {
      nodeIds.add(nodeId)
    }
  }

  for (const lane of layout.lanes) {
    for (const nodeId of lane.nodeIds) {
      nodeIds.add(nodeId)
    }
  }

  return [...nodeIds]
}

function getNodeComparisonPaths(
  snapshot: ProjectSnapshot,
  node: ProjectNode,
) {
  if (isFileNode(node)) {
    return [node.path]
  }

  if (isSymbolNode(node)) {
    const filePath = getNodeFilePath(snapshot, node)
    return filePath ? [filePath] : [node.path]
  }

  if (isDirectoryNode(node)) {
    return Object.values(snapshot.nodes)
      .filter(isFileNode)
      .map((fileNode) => fileNode.path)
      .filter((path) => path === node.path || path.startsWith(`${node.path}/`))
  }

  return []
}

function getNodeFilePath(
  snapshot: ProjectSnapshot,
  node: ProjectNode,
) {
  if (isFileNode(node)) {
    return node.path
  }

  if (!isSymbolNode(node)) {
    return null
  }

  const fileNode = snapshot.nodes[node.fileId]
  return fileNode && isFileNode(fileNode) ? fileNode.path : null
}

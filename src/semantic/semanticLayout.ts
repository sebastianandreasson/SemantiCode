import type { LayoutNodePlacement, LayoutSpec } from '../schema/layout'
import {
  isSymbolNode,
  type ProjectSnapshot,
  type SymbolKind,
  type SymbolNode,
} from '../schema/snapshot'
import { embedTextsWithTfidf } from './embeddings/tfidfEmbeddingProvider'
import { buildSemanticPurposeSummaryRecords } from './purposeSummaries'
import { projectSemanticEmbeddings } from './projection/umap'
import { refineSemanticLayout } from './projection/refinement'
import { hashSemanticText } from './symbolText'
import type {
  SemanticEmbeddingVectorRecord,
  SemanticPurposeSummaryRecord,
  SemanticProjectionRecord,
} from './types'
import type { PreprocessedWorkspaceContext } from '../preprocessing/types'

const SEMANTIC_SYMBOL_NODE_WIDTH = 248
const SEMANTIC_SYMBOL_NODE_HEIGHT = 82
const SEMANTIC_PROJECTION_SEED = 17

const SUPPORTED_SYMBOL_KINDS = new Set<SymbolKind>([
  'class',
  'function',
  'method',
  'constant',
  'variable',
])

export function buildSemanticLayout(
  snapshot: ProjectSnapshot,
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null = null,
): LayoutSpec {
  const purposeSummaries = (
    preprocessedWorkspaceContext?.purposeSummaries.length
      ? preprocessedWorkspaceContext.purposeSummaries
      : buildSemanticPurposeSummaryRecords(snapshot)
  ).filter((record) => {
    const node = snapshot.nodes[record.symbolId]
    return Boolean(node && isSupportedSemanticSymbol(node))
  })
  const embeddings = buildSemanticEmbeddingRecords(
    purposeSummaries,
    preprocessedWorkspaceContext,
  )
  const projection = projectSemanticEmbeddings({
    seed: SEMANTIC_PROJECTION_SEED,
    vectors: embeddings,
  })
  const baseLayout = buildSemanticLayoutFromProjection(snapshot, projection)

  return refineSemanticLayout(projection, {
    baseLayout,
    minimumSpacing: 96,
  })
}

export function buildSemanticLayoutScaffold(snapshot: ProjectSnapshot): LayoutSpec {
  return {
    id: `layout:semantic:${snapshot.rootDir}`,
    title: 'Semantic symbols',
    strategy: 'semantic',
    nodeScope: 'symbols',
    description: 'Experimental semantic symbol layout scaffold.',
    placements: {},
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: [],
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  }
}

export function buildSemanticLayoutFromProjection(
  snapshot: ProjectSnapshot,
  projection: SemanticProjectionRecord,
): LayoutSpec {
  const placements: Record<string, LayoutNodePlacement> = {}

  for (const point of projection.points) {
    placements[point.symbolId] = {
      nodeId: point.symbolId,
      x: point.x,
      y: point.y,
      width: SEMANTIC_SYMBOL_NODE_WIDTH,
      height: SEMANTIC_SYMBOL_NODE_HEIGHT,
    }
  }

  const visibleNodeIds = new Set(projection.symbolIds)

  return {
    id: `layout:semantic:${snapshot.rootDir}`,
    title: 'Semantic symbols',
    strategy: 'semantic',
    nodeScope: 'symbols',
    description: 'Experimental symbol layout based on semantic embeddings.',
    placements,
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: Object.values(snapshot.nodes)
      .filter((node) => !isSupportedSemanticSymbol(node) || !visibleNodeIds.has(node.id))
      .map((node) => node.id),
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  }
}

export function collectSemanticSymbolTexts(snapshot: ProjectSnapshot) {
  return buildSemanticPurposeSummaryRecords(snapshot)
}

function buildSemanticEmbeddingRecords(
  purposeSummaries: SemanticPurposeSummaryRecord[],
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null,
): SemanticEmbeddingVectorRecord[] {
  const cachedEmbeddingsBySymbolId = new Map(
    preprocessedWorkspaceContext?.semanticEmbeddings.map((embedding) => [
      embedding.symbolId,
      embedding,
    ]) ?? [],
  )
  const embeddings = embedTextsWithTfidf(
    purposeSummaries.map((record) => ({
      id: record.symbolId,
      text: record.embeddingText,
    })),
  )
  const canUseCachedEmbeddings = hasCompleteCachedEmbeddingCoverage(
    purposeSummaries,
    cachedEmbeddingsBySymbolId,
  )

  return purposeSummaries.map((record) => {
    const cachedEmbedding = cachedEmbeddingsBySymbolId.get(record.symbolId)
    const embeddingTextHash = hashSemanticText(record.embeddingText)

    if (
      canUseCachedEmbeddings &&
      cachedEmbedding &&
      cachedEmbedding.textHash === embeddingTextHash
    ) {
      return cachedEmbedding
    }

    return {
      symbolId: record.symbolId,
      modelId: 'local-purpose-tfidf-v1',
      dimensions: embeddings[record.symbolId]?.length ?? 0,
      textHash: embeddingTextHash,
      values: embeddings[record.symbolId] ?? [],
      generatedAt: record.generatedAt,
    }
  })
}

function hasCompleteCachedEmbeddingCoverage(
  purposeSummaries: SemanticPurposeSummaryRecord[],
  cachedEmbeddingsBySymbolId: Map<string, SemanticEmbeddingVectorRecord>,
) {
  if (purposeSummaries.length === 0) {
    return false
  }

  const dimensions = new Set<number>()
  const modelIds = new Set<string>()

  for (const record of purposeSummaries) {
    const embedding = cachedEmbeddingsBySymbolId.get(record.symbolId)
    const expectedTextHash = hashSemanticText(record.embeddingText)

    if (!embedding || embedding.textHash !== expectedTextHash || embedding.values.length === 0) {
      return false
    }

    dimensions.add(embedding.dimensions)
    modelIds.add(embedding.modelId)
  }

  return dimensions.size === 1 && modelIds.size === 1
}

function isSupportedSemanticSymbol(
  node: ProjectSnapshot['nodes'][string],
): node is SymbolNode {
  return isSymbolNode(node) && SUPPORTED_SYMBOL_KINDS.has(node.symbolKind)
}

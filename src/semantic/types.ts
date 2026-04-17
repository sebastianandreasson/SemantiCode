import type { LayoutSpec } from '../schema/layout'
import type { SymbolNode } from '../schema/snapshot'

export type SemanticEmbeddingProviderKind = 'local' | 'remote'
export type SemanticIndexState = 'idle' | 'building' | 'ready' | 'stale' | 'error'

export interface SemanticSymbolTextRecord {
  symbolId: string
  fileId: string
  path: string
  language?: string
  symbolKind: SymbolNode['symbolKind']
  text: string
  textHash: string
  generatedAt: string
}

export interface SemanticPurposeSummaryRecord {
  symbolId: string
  fileId: string
  path: string
  language?: string
  symbolKind: SymbolNode['symbolKind']
  generator: 'heuristic' | 'llm'
  summary: string
  domainHints: string[]
  sideEffects: string[]
  embeddingText: string
  sourceHash: string
  generatedAt: string
}

export interface SemanticEmbeddingVectorRecord {
  symbolId: string
  modelId: string
  dimensions: number
  textHash: string
  values: number[]
  generatedAt: string
}

export interface SemanticProjectionPoint {
  symbolId: string
  x: number
  y: number
}

export interface SemanticProjectionRecord {
  id: string
  modelId: string
  symbolIds: string[]
  points: SemanticProjectionPoint[]
  seed: number
  generatedAt: string
}

export interface GroupPrototypeCacheSnapshot {
  records: {
    layoutId: string
    groupId: string
    groupTitle: string
    inputHash: string
    memberNodeIds: string[]
    usableMemberNodeIds: string[]
    usableMemberCount: number
    modelId: string
    dimensions: number
    values: number[]
    cohesionScore: number | null
    generatedAt: string
  }[]
  updatedAt: string
}

export interface SemanticLayoutBuildResult {
  layout: LayoutSpec
  symbolTexts: SemanticSymbolTextRecord[]
  projection: SemanticProjectionRecord
}

export interface SemanticEmbeddingProvider {
  id: string
  kind: SemanticEmbeddingProviderKind
  embedTexts(
    input: { id: string; text: string }[],
  ): Promise<Record<string, number[]>>
}

export interface SemanticCacheManifest {
  version: 1
  workspaceRootDir: string
  modelId: string
  updatedAt: string
}

export interface SemanticCacheSnapshot {
  manifest: SemanticCacheManifest
  symbolTexts: SemanticSymbolTextRecord[]
  purposeSummaries: SemanticPurposeSummaryRecord[]
  embeddings: SemanticEmbeddingVectorRecord[]
  projection: SemanticProjectionRecord | null
}

export interface SemanticUmapInput {
  seed: number
  vectors: SemanticEmbeddingVectorRecord[]
}

export interface SemanticRefinementInput {
  baseLayout: LayoutSpec
  minimumSpacing: number
}

import type {
  GraphEdgeKind,
  NodeTagId,
  ProjectNode,
  SourceRange,
  SymbolKind,
} from './snapshot'
import type { LayoutAnnotation, LayoutNodeScope } from './layout'
import type { LayoutDraft } from './planner'

export type LayoutSuggestionExecutionPath = 'native_tools' | 'codex_cli_bridge'
export type LayoutArrangementMode = 'lanes' | 'grid' | 'dependency_flow' | 'radial'
export type LayoutArrangementSortKey = 'loc' | 'degree' | 'path' | 'name' | 'kind'
export type LayoutArrangementSpacing = 'compact' | 'normal' | 'wide'

export interface LayoutSelector {
  degreeMax?: number
  degreeMin?: number
  facet?: string | string[]
  kind?: ProjectNode['kind'] | ProjectNode['kind'][]
  locMax?: number
  locMin?: number
  nameContains?: string
  nameRegex?: string
  nodeIds?: string[]
  pathContains?: string
  pathPrefix?: string
  symbolKind?: SymbolKind | SymbolKind[]
  tag?: NodeTagId | NodeTagId[]
}

export interface HybridLayoutLane {
  id: string
  nodeIds?: string[]
  order?: number
  selector?: LayoutSelector
  title: string
}

export interface HybridLayoutGroup {
  collapsed?: boolean
  id: string
  nodeIds?: string[]
  selector?: LayoutSelector
  title: string
}

export interface HybridLayoutAnchor {
  height?: number
  nodeId: string
  width?: number
  x: number
  y: number
}

export interface HybridLayoutProposal {
  anchors?: HybridLayoutAnchor[]
  annotations?: LayoutAnnotation[]
  arrangement?: {
    mode: LayoutArrangementMode
    sortBy?: LayoutArrangementSortKey[]
    spacing?: LayoutArrangementSpacing
  }
  description?: string
  edgeEmphasis?: GraphEdgeKind[]
  groups?: HybridLayoutGroup[]
  lanes?: HybridLayoutLane[]
  nodeScope?: LayoutNodeScope
  title: string
  visibility?: {
    exclude?: LayoutSelector[]
    hiddenNodeIds?: string[]
    include?: LayoutSelector[]
  }
}

export interface LayoutSuggestionRequest {
  baseLayoutId?: string | null
  nodeScope?: LayoutNodeScope
  prompt: string
  visibleNodeIds?: string[]
}

export interface LayoutQueryStats {
  executionPath: LayoutSuggestionExecutionPath
  returnedEdgeCount: number
  returnedNodeCount: number
  toolCallCount: number
  truncatedResultCount: number
}

export interface LayoutSuggestionResponse {
  draft: LayoutDraft
  queryStats: LayoutQueryStats
}

export interface LayoutQueryNodeRef {
  degree: number
  facets: string[]
  fileId?: string
  id: string
  kind: ProjectNode['kind']
  loc?: number
  name: string
  path: string
  range?: SourceRange
  symbolKind?: SymbolKind
  tags: NodeTagId[]
}

export interface LayoutQueryEdgeRef {
  id: string
  inferred?: boolean
  kind: GraphEdgeKind
  label?: string
  source: string
  target: string
}

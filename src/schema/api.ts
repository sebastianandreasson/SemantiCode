import type { LayoutNodeScope, LayoutStrategyKind } from './layout'
import type { LayoutDraft } from './planner'
import type { GraphEdge, ProjectSnapshot } from './snapshot'
import type { LayoutSpec } from './layout'

export type AnalysisState = 'idle' | 'loading' | 'ready' | 'error'

export interface AnalysisStatus {
  state: AnalysisState
  updatedAt?: string
  message?: string
}

export interface SnapshotResponse {
  snapshot: ProjectSnapshot
}

export interface LayoutSummary {
  id: string
  title: string
  strategy: LayoutStrategyKind
  nodeScope: LayoutNodeScope
  updatedAt?: string
}

export interface LayoutListResponse {
  layouts: LayoutSummary[]
  activeLayoutId: string | null
}

export interface LayoutStateResponse {
  layouts: LayoutSpec[]
  draftLayouts: LayoutDraft[]
  activeLayoutId: string | null
  activeDraftId: string | null
}

export interface DraftMutationResponse {
  ok: true
  draftId: string
  layout?: LayoutSpec
}

export interface GraphNeighborsResponse {
  nodeId: string
  incomingEdges: GraphEdge[]
  outgoingEdges: GraphEdge[]
  connectedNodeIds: string[]
}

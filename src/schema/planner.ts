import type {
  LayoutAnnotation,
  LayoutGroup,
  LayoutLane,
  LayoutNodeScope,
  LayoutNodePlacement,
  LayoutSpec,
  LayoutStrategyKind,
} from './layout'
import type {
  GraphEdgeKind,
  NodeTag,
  ProjectNode,
  SourceRange,
  SymbolKind,
} from './snapshot'

export type PlannerCoordinateSpace = 'absolute_canvas'
export type LayoutDraftSource = 'agent'
export type LayoutDraftStatus = 'draft' | 'accepted' | 'rejected'
export type ValidationIssueSeverity = 'error' | 'warning'

export interface LayoutPlannerConstraints {
  nodeScope: LayoutNodeScope
  allowFiles: boolean
  allowDirectories: boolean
  allowSymbols: boolean
  allowLanes: boolean
  allowGroups: boolean
  allowAnnotations: boolean
  maxAnnotations: number
  maxLanes: number
  maxHiddenNodes: number | null
  coordinateSpace: PlannerCoordinateSpace
}

export const DEFAULT_LAYOUT_PLANNER_CONSTRAINTS: LayoutPlannerConstraints = {
  nodeScope: 'mixed',
  allowFiles: true,
  allowDirectories: true,
  allowSymbols: true,
  allowLanes: true,
  allowGroups: true,
  allowAnnotations: true,
  maxAnnotations: 24,
  maxLanes: 16,
  maxHiddenNodes: null,
  coordinateSpace: 'absolute_canvas',
}

export interface PlannerNodeRef {
  id: string
  kind: ProjectNode['kind']
  path: string
  fileId?: string
  symbolKind?: SymbolKind
  tags: string[]
  size?: number
  range?: SourceRange
}

export interface PlannerEdgeRef {
  id: string
  kind: GraphEdgeKind
  source: string
  target: string
  label?: string
  inferred?: boolean
}

export interface PlannerSnapshotMeta {
  schemaVersion: number
  rootDir: string
  generatedAt: string
  totalFiles: number
  totalNodes: number
  totalEdges: number
}

export interface PlannerExistingLayoutSummary {
  id: string
  title: string
  strategy: LayoutStrategyKind
  nodeScope: LayoutNodeScope
  description?: string
  updatedAt?: string
}

export interface PlannerExistingLayout extends PlannerExistingLayoutSummary {
  placements: LayoutNodePlacement[]
  hiddenNodeIds: string[]
}

export interface LayoutPlannerContext {
  snapshotMeta: PlannerSnapshotMeta
  nodes: PlannerNodeRef[]
  edges: PlannerEdgeRef[]
  entryFileIds: string[]
  visibleNodeIds: string[]
  availableTags: NodeTag[]
  existingLayouts: PlannerExistingLayoutSummary[]
  baseLayout: PlannerExistingLayout | null
  prompt: string
  constraints: LayoutPlannerConstraints
}

export interface LayoutPlannerRequest {
  prompt: string
  context: LayoutPlannerContext
  baseLayoutId?: string | null
  constraints: LayoutPlannerConstraints
}

export type LayoutPlanner = (
  request: LayoutPlannerRequest,
) => Promise<LayoutPlannerProposalEnvelope>

export interface LayoutPlannerPlacement {
  nodeId: string
  x: number
  y: number
  width?: number
  height?: number
  parentId?: string | null
  laneId?: string
  hidden?: boolean
  zIndex?: number
}

export interface LayoutPlannerProposal {
  title: string
  description?: string
  strategy: 'agent'
  placements: LayoutPlannerPlacement[]
  groups: LayoutGroup[]
  lanes: LayoutLane[]
  annotations: LayoutAnnotation[]
  hiddenNodeIds: string[]
}

export interface LayoutPlannerProposalEnvelope {
  proposal: LayoutPlannerProposal
  rationale: string
  warnings: string[]
  ambiguities: string[]
  confidence: number | null
}

export type ValidationIssueCode =
  | 'missing_proposal'
  | 'missing_title'
  | 'invalid_strategy'
  | 'duplicate_node_placement'
  | 'unknown_node'
  | 'invalid_node_kind'
  | 'disallowed_node_kind'
  | 'invalid_coordinate'
  | 'unknown_parent'
  | 'unknown_lane'
  | 'duplicate_lane_id'
  | 'duplicate_group_id'
  | 'duplicate_annotation_id'
  | 'duplicate_hidden_node'
  | 'max_annotations_exceeded'
  | 'max_lanes_exceeded'
  | 'max_hidden_nodes_exceeded'
  | 'disallowed_lanes'
  | 'disallowed_groups'
  | 'disallowed_annotations'

export interface ValidationIssue {
  code: ValidationIssueCode
  message: string
  severity: ValidationIssueSeverity
  field?: string
  nodeId?: string
}

export interface ValidationResult {
  valid: boolean
  issues: ValidationIssue[]
}

export interface LayoutDraft {
  id: string
  source: LayoutDraftSource
  status: LayoutDraftStatus
  prompt: string
  proposalEnvelope: LayoutPlannerProposalEnvelope
  layout: LayoutSpec | null
  validation: ValidationResult
  createdAt: string
  updatedAt: string
}

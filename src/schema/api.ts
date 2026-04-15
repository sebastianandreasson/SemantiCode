import type { LayoutNodeScope, LayoutStrategyKind } from './layout'
import type { LayoutDraft } from './planner'
import type { GraphEdge, ProjectSnapshot } from './snapshot'
import type { LayoutSpec } from './layout'
import type {
  AgentBrokerSessionSummary,
  AgentMessage,
  AgentSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
} from './agent'

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

export interface AgentStateResponse {
  session: AgentSessionSummary | null
  messages: AgentMessage[]
}

export interface AgentPromptRequest {
  message: string
}

export interface AgentSettingsResponse {
  settings: AgentSettingsState
}

export type AgentSettingsUpdateRequest = AgentSettingsInput

export interface AgentBrokerSessionResponse {
  brokerSession: AgentBrokerSessionSummary
}

export interface AgentBrokerCompleteRequest {
  callbackUrl: string
}

export interface AgentBrokerLoginStartResponse {
  brokerSession: AgentBrokerSessionSummary
  implemented: boolean
  loginUrl: string | null
  message?: string
}

export interface AgentCodexImportResponse {
  brokerSession: AgentBrokerSessionSummary
  message: string
}

export interface AgentBrokerCallbackResult {
  message: string
  ok: boolean
}

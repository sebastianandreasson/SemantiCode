import type { LayoutNodeScope, LayoutStrategyKind } from './layout'
import type { LayoutDraft } from './planner'
import type {
  PreprocessedWorkspaceContext,
  WorkspaceArtifactSyncStatus,
} from '../preprocessing/types'
import type { GroupPrototypeCacheSnapshot } from '../semantic/types'
import type { GraphEdge, ProjectSnapshot } from './snapshot'
import type { LayoutSpec } from './layout'
import type {
  LayoutSuggestionRequest,
} from './layoutSuggestion'
export type { LayoutSuggestionResponse } from './layoutSuggestion'
import type {
  AutonomousRunDetail,
  AutonomousRunScope,
  AutonomousRunStartRequest,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
} from './autonomous'
import type {
  AgentBrokerSessionSummary,
  AgentMessage,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
  AgentTimelineItem,
} from './agent'
import type { UiPreferences } from './store'
import type {
  AgentHeatSample,
  TelemetryActivityEvent,
  TelemetryMode,
  TelemetryOverview,
  TelemetrySource,
  TelemetryWindow,
} from './telemetry'

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

export interface SemanticLayoutResponse {
  cached: boolean
  layout: LayoutSpec
}

export type LayoutSuggestionPayload = LayoutSuggestionRequest

export interface PreprocessingContextResponse {
  context: PreprocessedWorkspaceContext | null
}

export interface WorkspaceSyncStatusResponse {
  sync: WorkspaceArtifactSyncStatus
}

export interface GitFileDiffLineChange {
  kind: 'added' | 'modified'
  startLine: number
  endLine: number
}

export interface GitFileDiff {
  path: string
  baseline: 'HEAD'
  fingerprint: string
  addedLineCount: number
  modifiedLineCount: number
  deletedLineCount: number
  changes: GitFileDiffLineChange[]
  hasDiff: boolean
  isUntracked: boolean
}

export interface GitFileDiffResponse {
  diff: GitFileDiff | null
}

export interface WorkspaceHistoryResponse {
  activeWorkspaceRootDir: string | null
  recentWorkspaces: {
    name: string
    rootDir: string
    lastOpenedAt: string
  }[]
}

export interface UiPreferencesResponse {
  preferences: UiPreferences
}

export interface UiPreferencesUpdateRequest {
  preferences: UiPreferences
}

export interface PreprocessingContextUpdateRequest {
  context: PreprocessedWorkspaceContext
}

export interface PreprocessingSummaryRequest {
  message: string
  metadata?: AgentPromptRequest['metadata']
  systemPrompt?: string
}

export interface PreprocessingSummaryResponse {
  text: string
}

export interface PreprocessingEmbeddingRequest {
  modelId?: string
  texts: {
    id: string
    text: string
    textHash: string
  }[]
}

export interface PreprocessingEmbeddingResponse {
  embeddings: {
    symbolId: string
    modelId: string
    dimensions: number
    textHash: string
    values: number[]
    generatedAt: string
  }[]
}

export interface GroupPrototypeCacheResponse {
  cache: GroupPrototypeCacheSnapshot | null
}

export interface GroupPrototypeCacheUpdateRequest {
  cache: GroupPrototypeCacheSnapshot
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
  timeline: AgentTimelineItem[]
}

export interface AgentPromptRequest {
  message: string
  metadata?: {
    kind?: string
    paths?: string[]
    scope?: AutonomousRunScope | null
    task?: string
  }
  mode?: 'send' | 'steer' | 'follow_up'
}

export interface AgentResumeSessionRequest {
  sessionFile: string
}

export interface AgentThinkingLevelRequest {
  thinkingLevel: NonNullable<AgentSessionSummary['thinkingLevel']>
}

export interface AgentCompactionRequest {
  instructions?: string
}

export interface AgentSessionListResponse {
  sessions: AgentSessionListItem[]
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

export interface AutonomousRunsResponse {
  activeRunId: string | null
  detectedTaskFile: string | null
  runs: AutonomousRunSummary[]
}

export interface AutonomousRunStartResponse {
  activeRunId: string | null
  detectedTaskFile: string | null
  run: AutonomousRunDetail
}

export interface AutonomousRunDetailResponse {
  run: AutonomousRunDetail | null
}

export interface AutonomousRunTimelineResponse {
  timeline: AutonomousRunTimelinePoint[]
}

export interface AutonomousRunStopResponse {
  ok: boolean
  runId: string | null
}

export interface TelemetryOverviewResponse {
  overview: TelemetryOverview
}

export interface TelemetryHeatmapRequest {
  mode?: TelemetryMode
  runId?: string
  source?: TelemetrySource
  window?: TelemetryWindow
}

export interface TelemetryHeatmapResponse {
  samples: AgentHeatSample[]
}

export interface TelemetryActivityResponse {
  events: TelemetryActivityEvent[]
}

export type AutonomousRunStartPayload = AutonomousRunStartRequest

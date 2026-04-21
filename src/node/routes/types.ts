import type { ReadProjectSnapshotOptions } from '../../types'
import type {
  AgentBrokerLoginStartResponse,
  AgentControlsResponse,
  AgentModelSelectionRequest,
  AgentPromptRequest,
  AgentBrokerSessionResponse,
  AgentCodexImportResponse,
  AutonomousRunDetail,
  AutonomousRunScope,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  AgentSessionListItem,
  LayoutSuggestionPayload,
  LayoutSuggestionResponse,
  AgentHeatSample,
  TelemetryActivityEvent,
  TelemetryMode,
  TelemetryOverview,
  TelemetrySource,
  TelemetryWindow,
  UiPreferencesResponse,
  WorkspaceHistoryResponse,
} from '../../types'
import type { UiPreferences } from '../../schema/store'

export interface AgentRuntimeRequestBridge {
  beginBrokeredLogin: () => Promise<AgentBrokerLoginStartResponse>
  cancelWorkspaceSession: (workspaceRootDir: string) => Promise<boolean>
  completeManualBrokeredLogin: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  completeBrokeredLoginCallback: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  getBrokerSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  importCodexAuthSession: () => Promise<AgentCodexImportResponse>
  ensureWorkspaceSession: (workspaceRootDir: string) => Promise<AgentStateResponse['session']>
  getWorkspaceControls: (workspaceRootDir: string) => Promise<AgentControlsResponse['controls']>
  getSettings: () => Promise<AgentSettingsResponse['settings']>
  getWorkspaceFileOperations: (workspaceRootDir: string) => NonNullable<AgentStateResponse['fileOperations']>
  getWorkspaceMessages: (workspaceRootDir: string) => AgentStateResponse['messages']
  getWorkspaceSessionSummary: (workspaceRootDir: string) => AgentStateResponse['session']
  getWorkspaceTimeline: (workspaceRootDir: string) => AgentStateResponse['timeline']
  listWorkspaceSessions: (workspaceRootDir: string) => Promise<AgentSessionListItem[]>
  logoutBrokeredAuthSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  compactWorkspaceSession: (workspaceRootDir: string, instructions?: string) => Promise<AgentStateResponse['session']>
  promptWorkspaceSession: (
    workspaceRootDir: string,
    request: string | AgentPromptRequest,
    metadata?: AgentPromptRequest['metadata'],
    mode?: AgentPromptRequest['mode'],
  ) => Promise<void>
  resumeWorkspaceSession: (workspaceRootDir: string, sessionFile: string) => Promise<AgentStateResponse['session']>
  setWorkspaceActiveTools: (
    workspaceRootDir: string,
    toolNames: string[],
  ) => Promise<AgentControlsResponse['controls']>
  setWorkspaceModel: (
    workspaceRootDir: string,
    input: AgentModelSelectionRequest,
  ) => Promise<AgentStateResponse['session']>
  setWorkspaceThinkingLevel: (
    workspaceRootDir: string,
    thinkingLevel: NonNullable<NonNullable<AgentStateResponse['session']>['thinkingLevel']>,
  ) => Promise<AgentStateResponse['session']>
  startNewWorkspaceSession: (workspaceRootDir: string) => Promise<AgentStateResponse['session']>
  suggestLayout: (
    workspaceRootDir: string,
    input: LayoutSuggestionPayload,
  ) => Promise<LayoutSuggestionResponse>
  runOneOffPrompt: (
    workspaceRootDir: string,
    input: {
      message: string
      systemPrompt?: string
      telemetry?: {
        kind?: string
        paths?: string[]
        scope?: AutonomousRunScope | null
        task?: string
      }
    },
  ) => Promise<string>
  saveSettings: (settings: AgentSettingsUpdateRequest) => Promise<AgentSettingsResponse['settings']>
}

export interface AutonomousRunRequestBridge {
  getDetectedTaskFile: (workspaceRootDir: string) => Promise<string | null>
  getRunDetail: (workspaceRootDir: string, runId: string) => Promise<AutonomousRunDetail | null>
  getRunTimeline: (workspaceRootDir: string, runId: string) => Promise<AutonomousRunTimelinePoint[]>
  listRuns: (workspaceRootDir: string) => Promise<{
    activeRunId: string | null
    runs: AutonomousRunSummary[]
  }>
  startRun: (
    workspaceRootDir: string,
    input: { scope?: AutonomousRunScope | null; taskFile?: string | null },
  ) => Promise<AutonomousRunDetail>
  stopRun: (
    workspaceRootDir: string,
    runId: string,
  ) => Promise<{
    ok: boolean
    runId: string | null
  }>
}

export interface TelemetryRequestBridge {
  getTelemetryActivity: (input: {
    mode: TelemetryMode
    rootDir: string
    runId?: string
    sessionId?: string
    sinceMs?: number
    source: TelemetrySource
    window: TelemetryWindow
  }) => Promise<TelemetryActivityEvent[]>
  getTelemetryHeatmap: (input: {
    mode: TelemetryMode
    rootDir: string
    runId?: string
    sessionId?: string
    sinceMs?: number
    source: TelemetrySource
    window: TelemetryWindow
  }) => Promise<AgentHeatSample[]>
  getTelemetryOverview: (input: {
    mode: TelemetryMode
    rootDir: string
    runId?: string
    sessionId?: string
    sinceMs?: number
    source: TelemetrySource
    window: TelemetryWindow
  }) => Promise<TelemetryOverview>
}

export interface SemanticodeRequestHandlerOptions
  extends ReadProjectSnapshotOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  autonomousRunRuntime?: AutonomousRunRequestBridge
  getUiPreferences?: () => Promise<UiPreferencesResponse>
  setUiPreferences?: (preferences: UiPreferences) => Promise<UiPreferencesResponse>
  telemetryRuntime?: TelemetryRequestBridge
  getWorkspaceHistory?: () => Promise<WorkspaceHistoryResponse>
  rootDir: string
  route?: string
}

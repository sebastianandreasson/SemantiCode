export type AgentRunState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'disabled'
  | 'error'

export type AgentAuthMode = 'api_key' | 'brokered_oauth'

export type AgentTransportMode = 'provider' | 'app' | 'codex_cli'

export type AgentRuntimeKind = 'pi-sdk' | 'codex-subscription'

export interface AgentCapabilitySet {
  compact: boolean
  followUp: boolean
  newSession: boolean
  prompt: boolean
  resumeSession: boolean
  setThinkingLevel: boolean
  steer: boolean
}

export type AgentCommandSource = 'extension' | 'prompt' | 'skill' | 'semanticode'

export interface AgentSourceInfo {
  baseDir?: string
  origin?: string
  path?: string
  scope?: string
  source?: string
}

export interface AgentCommandInfo {
  available: boolean
  description?: string
  enabled: boolean
  name: string
  source: AgentCommandSource
  sourceInfo?: AgentSourceInfo
}

export interface AgentToolControlInfo {
  active: boolean
  description?: string
  name: string
  sourceInfo?: AgentSourceInfo
}

export interface AgentModelControlOption {
  authMode: AgentAuthMode
  id: string
  provider: string
}

export interface AgentControlState {
  activeToolNames: string[]
  availableThinkingLevels: NonNullable<AgentSessionSummary['thinkingLevel']>[]
  commands: AgentCommandInfo[]
  followUpMode?: 'all' | 'one-at-a-time'
  models: AgentModelControlOption[]
  runtimeKind?: AgentRuntimeKind
  sessionId: string | null
  steeringMode?: 'all' | 'one-at-a-time'
  tools: AgentToolControlInfo[]
}

export type AgentBrokerAuthState = 'unconfigured' | 'signed_out' | 'pending' | 'authenticated'

export interface AgentBrokerSessionSummary {
  accountLabel?: string
  backendUrl?: string
  hasAppSessionToken?: boolean
  state: AgentBrokerAuthState
}

export interface AgentSessionSummary {
  authMode: AgentAuthMode
  brokerSession?: AgentBrokerSessionSummary
  id: string
  workspaceRootDir: string
  provider: string
  modelId: string
  transport: AgentTransportMode
  createdAt: string
  updatedAt: string
  runState: AgentRunState
  runtimeKind?: AgentRuntimeKind
  capabilities?: AgentCapabilitySet
  bootPromptEnabled: boolean
  hasProviderApiKey: boolean
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  sessionFile?: string
  sessionName?: string
  queue?: {
    followUp: number
    steering: number
  }
  lastError?: string
}

export interface AgentMessageBlock {
  kind: 'text' | 'thinking'
  text: string
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  blocks: AgentMessageBlock[]
  createdAt: string
  isStreaming?: boolean
}

export interface AgentToolInvocation {
  toolCallId: string
  toolName: string
  args: unknown
  startedAt: string
  endedAt?: string
  isError?: boolean
  paths?: string[]
  resultPreview?: string
}

export type AgentFileOperationKind =
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'file_rename'
  | 'file_changed'
  | 'shell_command'

export type AgentFileOperationConfidence = 'exact' | 'inferred' | 'fallback'

export type AgentFileOperationSource =
  | 'agent-tool'
  | 'assistant-message'
  | 'codex-cli'
  | 'git-dirty'
  | 'pi-sdk'
  | 'request-telemetry'

export type AgentFileOperationStatus = 'running' | 'completed' | 'error'

export interface AgentFileOperation {
  confidence: AgentFileOperationConfidence
  id: string
  kind: AgentFileOperationKind
  path?: string
  paths: string[]
  resultPreview?: string
  sessionId: string
  source: AgentFileOperationSource
  status: AgentFileOperationStatus
  timestamp: string
  toolCallId?: string
  toolName: string
}

export type AgentTimelineItem =
  | {
      id: string
      type: 'message'
      messageId: string
      role: AgentMessage['role']
      blockKind: AgentMessageBlock['kind']
      text: string
      createdAt: string
      isStreaming?: boolean
    }
  | {
      id: string
      type: 'tool'
      toolCallId: string
      toolName: string
      args: unknown
      createdAt: string
      startedAt: string
      endedAt?: string
      durationMs?: number
      isError?: boolean
      paths?: string[]
      resultPreview?: string
      status: 'running' | 'completed' | 'error'
    }
  | {
      id: string
      type: 'lifecycle'
      event:
        | 'session_created'
        | 'session_updated'
        | 'agent_start'
        | 'turn_start'
        | 'turn_end'
        | 'message_start'
        | 'message_end'
        | 'agent_end'
        | 'queue_update'
        | 'compaction_start'
        | 'compaction_end'
        | 'auto_retry_start'
        | 'auto_retry_end'
        | 'cancelled'
        | 'error'
      label: string
      createdAt: string
      detail?: string
      status?: 'running' | 'completed' | 'error' | 'queued'
      counts?: Record<string, number>
    }

export interface AgentSessionListItem {
  createdAt: string
  id: string
  messageCount: number
  modifiedAt: string
  name?: string
  path: string
  preview: string
}

export interface AgentPermissionRequest {
  id: string
  kind: 'write' | 'exec'
  title: string
  description: string
}

export type AgentSecretStorageKind = 'plaintext' | 'safe_storage'

export interface AgentModelOption {
  authMode?: AgentAuthMode
  id: string
}

export interface AgentSettingsState {
  authMode: AgentAuthMode
  brokerSession: AgentBrokerSessionSummary
  provider: string
  modelId: string
  hasApiKey: boolean
  appServerUrl?: string
  hasAppServerUrl: boolean
  canEditAppServerUrl: boolean
  openAiOAuthClientId?: string
  hasOpenAiOAuthClientId: boolean
  hasOpenAiOAuthClientSecret: boolean
  canEditOpenAiOAuthConfig: boolean
  storageKind: AgentSecretStorageKind
  availableProviders: string[]
  availableModelsByProvider: Record<string, AgentModelOption[]>
}

export interface AgentSettingsInput {
  authMode?: AgentAuthMode
  brokerBackendUrl?: string
  provider: string
  modelId: string
  apiKey?: string
  clearApiKey?: boolean
  appServerUrl?: string
  clearAppServerUrl?: boolean
  openAiOAuthClientId?: string
  openAiOAuthClientSecret?: string
  clearOpenAiOAuthClientId?: boolean
  clearOpenAiOAuthClientSecret?: boolean
}

export type AgentEvent =
  | {
      type: 'session_created'
      session: AgentSessionSummary
    }
  | {
      type: 'session_updated'
      session: AgentSessionSummary
    }
  | {
      type: 'message'
      sessionId: string
      message: AgentMessage
    }
  | {
      type: 'tool'
      sessionId: string
      invocation: AgentToolInvocation
    }
  | {
      type: 'file_operation'
      sessionId: string
      operation: AgentFileOperation
    }
  | {
      type: 'timeline'
      sessionId: string
      item: AgentTimelineItem
    }
  | {
      type: 'timeline_snapshot'
      sessionId: string
      revision: number
      items: AgentTimelineItem[]
    }
  | {
      type: 'permission_request'
      sessionId: string
      request: AgentPermissionRequest
    }

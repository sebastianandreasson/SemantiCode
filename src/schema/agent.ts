export type AgentRunState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'disabled'
  | 'error'

export type AgentAuthMode = 'api_key' | 'brokered_oauth'

export type AgentTransportMode = 'provider' | 'app' | 'codex_cli'

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
  bootPromptEnabled: boolean
  hasProviderApiKey: boolean
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
}

export interface AgentPermissionRequest {
  id: string
  kind: 'write' | 'exec'
  title: string
  description: string
}

export type AgentSecretStorageKind = 'plaintext' | 'safe_storage'

export interface AgentModelOption {
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
      type: 'permission_request'
      sessionId: string
      request: AgentPermissionRequest
    }

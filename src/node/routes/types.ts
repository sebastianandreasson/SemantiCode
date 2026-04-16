import type { ReadProjectSnapshotOptions } from '../../types'
import type {
  AgentBrokerLoginStartResponse,
  AgentBrokerSessionResponse,
  AgentCodexImportResponse,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
} from '../../types'

export interface AgentRuntimeRequestBridge {
  beginBrokeredLogin: () => Promise<AgentBrokerLoginStartResponse>
  cancelWorkspaceSession: (workspaceRootDir: string) => Promise<boolean>
  completeManualBrokeredLogin: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  completeBrokeredLoginCallback: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  getBrokerSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  importCodexAuthSession: () => Promise<AgentCodexImportResponse>
  ensureWorkspaceSession: (workspaceRootDir: string) => Promise<AgentStateResponse['session']>
  getSettings: () => Promise<AgentSettingsResponse['settings']>
  getWorkspaceMessages: (workspaceRootDir: string) => AgentStateResponse['messages']
  getWorkspaceSessionSummary: (workspaceRootDir: string) => AgentStateResponse['session']
  logoutBrokeredAuthSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  promptWorkspaceSession: (workspaceRootDir: string, message: string) => Promise<void>
  runOneOffPrompt: (
    workspaceRootDir: string,
    input: { message: string; systemPrompt?: string },
  ) => Promise<string>
  saveSettings: (settings: AgentSettingsUpdateRequest) => Promise<AgentSettingsResponse['settings']>
}

export interface SemanticodeRequestHandlerOptions
  extends ReadProjectSnapshotOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  rootDir: string
  route?: string
}

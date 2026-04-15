import type { AgentMessage, AgentSessionSummary, AgentToolInvocation } from '../../schema/agent'

export interface AgentRuntimeStateChange {
  lastError?: string
  runState: AgentSessionSummary['runState']
}

export interface AgentRuntimeEventHandlers {
  onMessage: (message: AgentMessage) => void
  onStateChange: (change: AgentRuntimeStateChange) => void
  onTool?: (invocation: AgentToolInvocation) => void
}

export interface CodexCliRuntimeSession {
  activeAssistantMessageId: string | null
  activeProcessId: string | null
  id: string
  workspaceRootDir: string
}


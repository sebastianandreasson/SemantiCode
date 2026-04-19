import type {
  AgentActiveToolsRequest,
  AgentBrokerCallbackResult,
  AgentCompactionRequest,
  AgentBrokerCompleteRequest,
  AgentCodexImportResponse,
  AgentBrokerLoginStartResponse,
  AgentControlsResponse,
  AgentModelSelectionRequest,
  AgentPromptRequest,
  AgentResumeSessionRequest,
  AgentSessionListResponse,
  AgentBrokerSessionResponse,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  AgentThinkingLevelRequest,
} from '../schema/api'
import type { AgentEvent, AgentSessionSummary } from '../schema/agent'
import {
  SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE,
  SEMANTICODE_AGENT_AUTH_IMPORT_CODEX_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE,
  SEMANTICODE_AGENT_AUTH_SESSION_ROUTE,
  SEMANTICODE_AGENT_CANCEL_ROUTE,
  SEMANTICODE_AGENT_COMPACT_ROUTE,
  SEMANTICODE_AGENT_CONTROLS_ROUTE,
  SEMANTICODE_AGENT_MESSAGE_ROUTE,
  SEMANTICODE_AGENT_MODEL_ROUTE,
  SEMANTICODE_AGENT_SESSIONS_ROUTE,
  SEMANTICODE_AGENT_SESSION_NEW_ROUTE,
  SEMANTICODE_AGENT_SESSION_RESUME_ROUTE,
  SEMANTICODE_AGENT_SETTINGS_ROUTE,
  SEMANTICODE_AGENT_SESSION_ROUTE,
  SEMANTICODE_AGENT_THINKING_ROUTE,
  SEMANTICODE_AGENT_TOOLS_ROUTE,
} from '../shared/constants'

interface DesktopAgentBridge {
  cancel?: () => Promise<boolean>
  closeWorkspace?: () => Promise<boolean>
  createSession?: () => Promise<AgentSessionSummary | null>
  isAvailable?: boolean | (() => boolean)
  isDesktop?: boolean
  onEvent?: (listener: (event: AgentEvent) => void) => () => void
  openWorkspaceDialog?: () => Promise<boolean>
  getControls?: () => Promise<AgentControlsResponse>
  sendMessage?: (
    payload: string | AgentPromptRequest,
  ) => Promise<boolean>
  listSessions?: () => Promise<AgentSessionListResponse>
  newSession?: () => Promise<AgentSessionSummary | null>
  resumeSession?: (sessionFile: string) => Promise<AgentSessionSummary | null>
  setThinkingLevel?: (thinkingLevel: NonNullable<AgentSessionSummary['thinkingLevel']>) => Promise<AgentSessionSummary | null>
  setActiveTools?: (toolNames: string[]) => Promise<AgentControlsResponse>
  setModel?: (input: AgentModelSelectionRequest) => Promise<AgentSessionSummary | null>
  compact?: (instructions?: string) => Promise<AgentStateResponse>
}

export interface DesktopAgentBridgeInfo {
  hasAgentBridge: boolean
  hasDesktopHost: boolean
}

export class DesktopAgentClient {
  getBridgeInfo(): DesktopAgentBridgeInfo {
    const bridge = this.getBridge()

    return {
      hasDesktopHost: Boolean(bridge?.isDesktop),
      hasAgentBridge: Boolean(
        bridge?.createSession &&
        bridge?.sendMessage &&
        bridge?.cancel &&
        bridge?.onEvent,
      ),
    }
  }

  isDesktopHost() {
    return Boolean(this.getBridge()?.isDesktop)
  }

  hasAgentBridge() {
    const bridge = this.getBridge()

    return Boolean(
      bridge?.createSession &&
      bridge?.sendMessage &&
      bridge?.cancel &&
      bridge?.onEvent,
    )
  }

  isAvailable() {
    const bridge = this.getBridge()

    if (!bridge) {
      return false
    }

    if (typeof bridge.isAvailable === 'function') {
      return bridge.isAvailable()
    }

    if (typeof bridge.isAvailable === 'boolean') {
      return bridge.isAvailable
    }

    return this.hasAgentBridge()
  }

  async createSession() {
    const bridge = this.getBridge()

    if (bridge?.createSession) {
      return bridge.createSession()
    }

    const state = await this.fetchAgentState(SEMANTICODE_AGENT_SESSION_ROUTE, {
      method: 'POST',
    })

    return state?.session ?? null
  }

  async sendMessage(
    message: string | AgentPromptRequest,
  ) {
    const bridge = this.getBridge()

    if (bridge?.sendMessage) {
      return bridge.sendMessage(message)
    }

    await this.fetchAgentState(SEMANTICODE_AGENT_MESSAGE_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        typeof message === 'string'
          ? { message }
          : message,
      ),
    })
    return true
  }

  async listSessions() {
    const bridge = this.getBridge()

    if (bridge?.listSessions) {
      return bridge.listSessions()
    }

    const response = await fetch(SEMANTICODE_AGENT_SESSIONS_ROUTE, {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Agent sessions request failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as AgentSessionListResponse
  }

  async getControls() {
    const bridge = this.getBridge()

    if (bridge?.getControls) {
      return (await bridge.getControls()).controls
    }

    const response = await fetch(SEMANTICODE_AGENT_CONTROLS_ROUTE, {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Agent controls request failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentControlsResponse).controls
  }

  async newSession() {
    const bridge = this.getBridge()

    if (bridge?.newSession) {
      return bridge.newSession()
    }

    const state = await this.fetchAgentState(SEMANTICODE_AGENT_SESSION_NEW_ROUTE, {
      method: 'POST',
    })

    return state.session
  }

  async resumeSession(sessionFile: string) {
    const bridge = this.getBridge()

    if (bridge?.resumeSession) {
      return bridge.resumeSession(sessionFile)
    }

    const state = await this.fetchAgentState(SEMANTICODE_AGENT_SESSION_RESUME_ROUTE, {
      body: JSON.stringify({ sessionFile } satisfies AgentResumeSessionRequest),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    return state.session
  }

  async setActiveTools(toolNames: string[]) {
    const bridge = this.getBridge()

    if (bridge?.setActiveTools) {
      return (await bridge.setActiveTools(toolNames)).controls
    }

    const response = await fetch(SEMANTICODE_AGENT_TOOLS_ROUTE, {
      body: JSON.stringify({ toolNames } satisfies AgentActiveToolsRequest),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Agent tools request failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentControlsResponse).controls
  }

  async setModel(input: AgentModelSelectionRequest) {
    const bridge = this.getBridge()

    if (bridge?.setModel) {
      return bridge.setModel(input)
    }

    const state = await this.fetchAgentState(SEMANTICODE_AGENT_MODEL_ROUTE, {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    return state.session
  }

  async setThinkingLevel(thinkingLevel: NonNullable<AgentSessionSummary['thinkingLevel']>) {
    const bridge = this.getBridge()

    if (bridge?.setThinkingLevel) {
      return bridge.setThinkingLevel(thinkingLevel)
    }

    const state = await this.fetchAgentState(SEMANTICODE_AGENT_THINKING_ROUTE, {
      body: JSON.stringify({ thinkingLevel } satisfies AgentThinkingLevelRequest),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    return state.session
  }

  async compact(instructions?: string) {
    const bridge = this.getBridge()

    if (bridge?.compact) {
      return bridge.compact(instructions)
    }

    return this.fetchAgentState(SEMANTICODE_AGENT_COMPACT_ROUTE, {
      body: JSON.stringify({ instructions } satisfies AgentCompactionRequest),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
  }

  async cancel() {
    const bridge = this.getBridge()

    if (bridge?.cancel) {
      return bridge.cancel()
    }

    await this.fetchAgentState(SEMANTICODE_AGENT_CANCEL_ROUTE, {
      method: 'POST',
    })
    return true
  }

  subscribe(listener: (event: AgentEvent) => void) {
    const bridge = this.getBridge()

    if (!bridge?.onEvent) {
      return () => undefined
    }

    return bridge.onEvent(listener)
  }

  private getBridge() {
    return (
      globalThis as typeof globalThis & {
        semanticodeDesktop?: DesktopAgentBridge
        semanticodeDesktopAgent?: DesktopAgentBridge
      }
    ).semanticodeDesktop ?? (
      globalThis as typeof globalThis & {
        semanticodeDesktopAgent?: DesktopAgentBridge
      }
    ).semanticodeDesktopAgent
  }

  async getHttpState() {
    return this.fetchAgentState(SEMANTICODE_AGENT_SESSION_ROUTE, {
      method: 'GET',
    })
  }

  async getSettings() {
    const response = await fetch(SEMANTICODE_AGENT_SETTINGS_ROUTE, {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Agent settings request failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentSettingsResponse).settings
  }

  async saveSettings(settings: AgentSettingsUpdateRequest) {
    const response = await fetch(SEMANTICODE_AGENT_SETTINGS_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Saving agent settings failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentSettingsResponse).settings
  }

  async getBrokerSession() {
    const response = await fetch(SEMANTICODE_AGENT_AUTH_SESSION_ROUTE, {
      method: 'GET',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Broker auth session request failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentBrokerSessionResponse).brokerSession
  }

  async beginBrokeredLogin() {
    const response = await fetch(SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE, {
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Broker login start failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as AgentBrokerLoginStartResponse
  }

  async completeBrokeredLogin(callbackUrl: string) {
    const response = await fetch(SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        callbackUrl,
      } satisfies AgentBrokerCompleteRequest),
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Broker login completion failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as AgentBrokerCallbackResult
  }

  async importCodexAuthSession() {
    const response = await fetch(SEMANTICODE_AGENT_AUTH_IMPORT_CODEX_ROUTE, {
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Codex auth import failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as AgentCodexImportResponse
  }

  async logoutBrokeredAuthSession() {
    const response = await fetch(SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE, {
      method: 'POST',
    })

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Broker logout failed with status ${response.status}.`,
      ))
    }

    return ((await response.json()) as AgentBrokerSessionResponse).brokerSession
  }

  private async fetchAgentState(path: string, init: RequestInit) {
    const response = await fetch(path, init)

    if (!response.ok) {
      throw new Error(await getResponseErrorMessage(
        response,
        `Agent request failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as AgentStateResponse
  }
}

async function getResponseErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const payload = (await response.json()) as { message?: string }

    if (payload?.message) {
      return payload.message
    }
  } catch {
    // Ignore non-JSON error bodies and fall back to the caller-provided message.
  }

  return fallbackMessage
}

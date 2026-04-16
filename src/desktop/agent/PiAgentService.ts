import { randomUUID } from 'node:crypto'

import { Agent, ProviderTransport, type AgentEvent as PiAgentEvent } from '@mariozechner/pi-agent'
import {
  getApiKey,
  getModel,
  getModels,
  type AssistantMessage,
  type Message,
  type KnownProvider,
} from '@mariozechner/pi-ai'

import type {
  AgentAuthMode,
  AgentBrokerSessionSummary,
  AgentEvent,
  AgentMessage,
  AgentSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
  AgentToolInvocation,
} from '../../schema/agent'
import type {
  AgentCodexImportResponse,
  AgentBrokerCallbackResult,
  AgentBrokerLoginStartResponse,
} from '../../schema/api'
import { PiAgentSettingsStore } from './PiAgentSettingsStore'
import { CodexCliTransport, createCodexCliModel } from '../agent-runtime/CodexCliTransport'
import { OpenAICodexProvider } from '../providers/openai-codex/provider'

const DEFAULT_PI_PROVIDER = 'openai'
const DEFAULT_PI_MODEL_ID = 'gpt-4.1-mini'
const BOOT_PROMPT_ENV_NAME = 'SEMANTICODE_PI_BOOT_PROMPT'
const PI_PROVIDER_ENV_NAME = 'SEMANTICODE_PI_PROVIDER'
const PI_MODEL_ENV_NAME = 'SEMANTICODE_PI_MODEL'

interface PiAgentSessionRecord {
  kind: 'pi'
  agent: Agent
  activeAssistantMessageId: string | null
  messages: AgentMessage[]
  summary: AgentSessionSummary
  toolInvocationById: Map<string, AgentToolInvocation>
  unsubscribe: () => void
  workspaceRootDir: string
}

type AgentSessionRecord = PiAgentSessionRecord

export interface PiAgentServiceOptions {
  logger?: Pick<Console, 'error' | 'info' | 'warn'>
  openExternal?: (url: string) => Promise<void> | void
}

export class PiAgentService {
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>
  private readonly openExternal?: (url: string) => Promise<void> | void
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly sessionsByWorkspaceRootDir = new Map<string, AgentSessionRecord>()
  private readonly openAICodexProvider: OpenAICodexProvider
  private readonly settingsStore: PiAgentSettingsStore

  constructor(options: PiAgentServiceOptions = {}) {
    this.logger = options.logger ?? console
    this.openExternal = options.openExternal
    this.settingsStore = new PiAgentSettingsStore({
      logger: this.logger,
    })
    this.openAICodexProvider = new OpenAICodexProvider({
      getClientConfig: () => this.settingsStore.getOpenAIOAuthClientConfig(),
      logger: this.logger,
      onAuthStateChanged: async () => {
        await this.disposeAllSessions()
      },
      openExternal: this.openExternal,
    })
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async ensureWorkspaceSession(workspaceRootDir: string) {
    const existingRecord = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (existingRecord) {
      this.emit({
        type: 'session_updated',
        session: existingRecord.summary,
      })
      return existingRecord.summary
    }

    await this.settingsStore.applyConfiguredApiKeys()
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const hasProviderApiKey =
      settings.authMode === 'api_key' ? Boolean(getApiKey(provider)) : false
    const bootPrompt = process.env[BOOT_PROMPT_ENV_NAME]?.trim() ?? ''
    const sessionTransport = resolveTransportMode(settings.authMode)
    const disabledReason = resolveDisabledReason(settings.authMode, provider, settings)
    const resolvedModelId =
      settings.authMode === 'brokered_oauth'
        ? settings.modelId
        : resolveModel(provider, settings.modelId).id
    const summary: AgentSessionSummary = {
      authMode: settings.authMode,
      brokerSession: settings.brokerSession,
      id: `pi-session:${randomUUID()}`,
      workspaceRootDir,
      provider,
      modelId: resolvedModelId,
      transport: sessionTransport,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runState: disabledReason ? 'disabled' : 'ready',
      bootPromptEnabled: bootPrompt.length > 0,
      hasProviderApiKey,
      lastError: disabledReason,
    }
    const transport = disabledReason
      ? createDisabledTransport()
      : settings.authMode === 'brokered_oauth'
        ? new CodexCliTransport({
            authProvider: this.openAICodexProvider,
            logger: this.logger,
            workspaceRootDir,
          })
        : this.createTransport(provider)
    const model =
      settings.authMode === 'brokered_oauth'
        ? createCodexCliModel(settings.modelId)
        : resolveModel(provider, settings.modelId)
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: buildWorkspaceSystemPrompt(workspaceRootDir),
        thinkingLevel: 'medium',
        tools: [],
      },
      transport,
    })

    const unsubscribe = agent.subscribe((event) => {
      this.handleAgentEvent(summary.id, workspaceRootDir, event)
    })
    const record: PiAgentSessionRecord = {
      kind: 'pi',
      agent,
      activeAssistantMessageId: null,
      messages: [],
      summary,
      toolInvocationById: new Map(),
      unsubscribe,
      workspaceRootDir,
    }

    this.sessionsByWorkspaceRootDir.set(workspaceRootDir, record)
    this.emit({
      type: 'session_created',
      session: summary,
    })

    this.logger.info(
      `[semanticode][pi] Created ${summary.transport === 'codex_cli' ? 'Codex CLI' : 'provider'} workspace session ${summary.id} for ${workspaceRootDir} using ${summary.provider}/${summary.modelId}.`,
    )

    if (disabledReason) {
      this.logger.warn(
        `[semanticode][pi] ${summary.lastError}`,
      )
      return summary
    }

    if (bootPrompt.length > 0) {
      await this.runBootPrompt(record, bootPrompt)
    }

    return record.summary
  }

  async disposeWorkspaceSession(workspaceRootDir: string) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      return
    }

    record.agent.abort()
    await record.agent.waitForIdle().catch(() => undefined)
    record.unsubscribe()

    this.sessionsByWorkspaceRootDir.delete(workspaceRootDir)
    this.logger.info(
      `[semanticode][pi] Disposed workspace session ${record.summary.id} for ${workspaceRootDir}.`,
    )
  }

  async disposeAllSessions() {
    for (const workspaceRootDir of [...this.sessionsByWorkspaceRootDir.keys()]) {
      await this.disposeWorkspaceSession(workspaceRootDir)
    }
  }

  getWorkspaceSessionSummary(workspaceRootDir: string) {
    return this.sessionsByWorkspaceRootDir.get(workspaceRootDir)?.summary ?? null
  }

  getWorkspaceMessages(workspaceRootDir: string) {
    return this.sessionsByWorkspaceRootDir.get(workspaceRootDir)?.messages ?? []
  }

  async getSettings() {
    const settings = await this.settingsStore.getSettings()

    return {
      ...settings,
      brokerSession: await this.openAICodexProvider.getAuthState(),
    }
  }

  async saveSettings(settings: AgentSettingsInput) {
    const nextSettings = await this.settingsStore.saveSettings(settings)
    await this.disposeAllSessions()
    return {
      ...nextSettings,
      brokerSession: await this.openAICodexProvider.getAuthState(),
    }
  }

  async getBrokerSession() {
    return this.openAICodexProvider.getAuthState()
  }

  async beginBrokeredLogin(): Promise<AgentBrokerLoginStartResponse> {
    return this.openAICodexProvider.startLogin()
  }

  async logoutBrokeredAuthSession(): Promise<AgentBrokerSessionSummary> {
    return this.openAICodexProvider.logout()
  }

  async importCodexAuthSession(): Promise<AgentCodexImportResponse> {
    return this.openAICodexProvider.importCodexAuthSession()
  }

  async completeBrokeredLoginCallback(
    callbackUrl: string,
  ): Promise<AgentBrokerCallbackResult> {
    return this.openAICodexProvider.handleCallback(callbackUrl)
  }

  async completeManualBrokeredLogin(
    callbackUrl: string,
  ): Promise<AgentBrokerCallbackResult> {
    return this.openAICodexProvider.completeManualRedirect(callbackUrl)
  }

  async promptWorkspaceSession(workspaceRootDir: string, message: string) {
    this.logger.info(
      `[semanticode][agent] promptWorkspaceSession called for ${workspaceRootDir}.`,
    )
    let record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      this.logger.info(
        `[semanticode][agent] No existing session for ${workspaceRootDir}; creating one lazily.`,
      )
      await this.ensureWorkspaceSession(workspaceRootDir)
      record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)
    }

    if (!record) {
      throw new Error('No workspace agent session exists for the active repository.')
    }

    if (record.summary.runState === 'disabled') {
      throw new Error(
        record.summary.lastError ??
          `No API key found for provider "${record.summary.provider}".`,
      )
    }

    const now = new Date().toISOString()
    const normalizedMessage: AgentMessage = {
      id: `agent-message:${randomUUID()}`,
      role: 'user',
      blocks: [{ kind: 'text', text: message }],
      createdAt: now,
      isStreaming: false,
    }

    record.messages = upsertNormalizedMessage(record.messages, normalizedMessage)
    this.emit({
      type: 'message',
      sessionId: record.summary.id,
      message: normalizedMessage,
    })

    record.summary = updateSessionSummary(record.summary, {
      lastError: undefined,
      runState: 'running',
    })
    this.emit({
      type: 'session_updated',
      session: record.summary,
    })

    try {
      this.logger.info(
        `[semanticode][agent] Prompting ${record.summary.transport === 'codex_cli' ? 'Codex CLI' : 'PI'} session ${record.summary.id} with model ${record.summary.modelId}.`,
      )
      await record.agent.prompt(message)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown embedded agent runtime failure.'

      record.summary = updateSessionSummary(record.summary, {
        lastError: message,
        runState: 'error',
      })
      this.emit({
        type: 'session_updated',
        session: record.summary,
      })
      throw error
    }
  }

  async runOneOffPrompt(
    workspaceRootDir: string,
    input: { message: string; systemPrompt?: string },
  ) {
    await this.settingsStore.applyConfiguredApiKeys()
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const disabledReason = resolveDisabledReason(settings.authMode, provider, settings)

    if (disabledReason) {
      throw new Error(disabledReason)
    }

    const transport =
      settings.authMode === 'brokered_oauth'
        ? new CodexCliTransport({
            authProvider: this.openAICodexProvider,
            logger: this.logger,
            workspaceRootDir,
          })
        : this.createTransport(provider)
    const model =
      settings.authMode === 'brokered_oauth'
        ? createCodexCliModel(settings.modelId)
        : resolveModel(provider, settings.modelId)
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: input.systemPrompt ?? buildWorkspaceSystemPrompt(workspaceRootDir),
        thinkingLevel: 'medium',
        tools: [],
      },
      transport,
    })

    let assistantText = ''
    const unsubscribe = agent.subscribe((event) => {
      if (
        (event.type === 'message_end' || event.type === 'turn_end') &&
        event.message.role === 'assistant'
      ) {
        const nextText = extractAssistantText(event.message)

        if (nextText) {
          assistantText = nextText
        }
      }
    })

    try {
      await agent.prompt(input.message)
      await agent.waitForIdle().catch(() => undefined)

      if (!assistantText.trim()) {
        throw new Error('The preprocessing prompt returned no assistant text.')
      }

      return assistantText.trim()
    } finally {
      unsubscribe()
      agent.abort()
      await agent.waitForIdle().catch(() => undefined)
    }
  }

  async cancelWorkspaceSession(workspaceRootDir: string) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      return false
    }

    record.agent.abort()
    return true
  }

  private createTransport(provider: KnownProvider) {
    return new ProviderTransport({
      getApiKey: () => getApiKey(provider),
    })
  }

  private async runBootPrompt(record: PiAgentSessionRecord, prompt: string) {
    record.summary = updateSessionSummary(record.summary, {
      runState: 'running',
      lastError: undefined,
    })

    try {
      this.logger.info(
        `[semanticode][pi] Running boot prompt for workspace ${record.workspaceRootDir}.`,
      )
      await record.agent.prompt(prompt)
      record.summary = updateSessionSummary(record.summary, {
        runState: 'ready',
      })
      this.logger.info(
        `[semanticode][pi] Boot prompt completed for workspace ${record.workspaceRootDir}.`,
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown pi boot prompt failure.'
      record.summary = updateSessionSummary(record.summary, {
        runState: 'error',
        lastError: message,
      })
      this.logger.error(
        `[semanticode][pi] Boot prompt failed for workspace ${record.workspaceRootDir}: ${message}`,
      )
    }
  }

  private handleAgentEvent(
    sessionId: string,
    workspaceRootDir: string,
    event: PiAgentEvent,
  ) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record || record.kind !== 'pi') {
      return
    }

    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
      case 'message_start':
        this.updateRecordSummary(record, {
          runState: 'running',
          lastError: undefined,
        })
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          record.activeAssistantMessageId = `agent-message:${randomUUID()}`
          this.emitNormalizedMessage(record, event.message, true)
        }
        break

      case 'tool_execution_start':
        record.toolInvocationById.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: new Date().toISOString(),
        })
        this.logger.info(
          `[semanticode][pi] ${sessionId} tool start: ${event.toolName}`,
        )
        this.emit({
          type: 'tool',
          sessionId,
          invocation: record.toolInvocationById.get(event.toolCallId)!,
        })
        break

      case 'tool_execution_end':
        this.finishToolInvocation(record, sessionId, event)
        if (event.isError) {
          this.logger.warn(
            `[semanticode][pi] ${sessionId} tool error: ${event.toolName}`,
          )
        } else {
          this.logger.info(
            `[semanticode][pi] ${sessionId} tool end: ${event.toolName}`,
          )
        }
        break

      case 'message_update':
        this.emitNormalizedMessage(record, event.message, true)
        if (event.assistantMessageEvent.type === 'text_delta') {
          this.logger.info(
            `[semanticode][pi] ${sessionId} delta: ${event.assistantMessageEvent.delta}`,
          )
        }
        break

      case 'turn_end':
      case 'agent_end':
        this.updateRecordSummary(record, {
          runState: resolveSessionReadyState(record.summary),
          lastError:
            event.type === 'turn_end' &&
            event.message.role === 'assistant' &&
            'errorMessage' in event.message &&
            event.message.errorMessage
              ? event.message.errorMessage
              : record.summary.lastError,
        })
        if (event.type === 'turn_end' && event.message.role === 'assistant') {
          this.emitNormalizedMessage(record, event.message, false)
          record.activeAssistantMessageId = null
        }
        break

      case 'message_end':
        if (event.message.role === 'assistant') {
          this.emitNormalizedMessage(record, event.message, false)
          record.activeAssistantMessageId = null
        }
        break
    }
  }

  private updateRecordSummary(
    record: PiAgentSessionRecord,
    changes: Partial<Pick<AgentSessionSummary, 'lastError' | 'runState'>>,
  ) {
    record.summary = updateSessionSummary(record.summary, changes)
    this.emit({
      type: 'session_updated',
      session: record.summary,
    })
  }

  private emitNormalizedMessage(
    record: PiAgentSessionRecord,
    message: Message | AssistantMessage,
    isStreaming: boolean,
  ) {
    const normalizedMessage = normalizeAgentMessage(
      record.summary.id,
      record.activeAssistantMessageId,
      message,
      isStreaming,
    )

    if (!normalizedMessage) {
      return
    }

    this.emit({
      type: 'message',
      sessionId: record.summary.id,
      message: normalizedMessage,
    })
    record.messages = upsertNormalizedMessage(record.messages, normalizedMessage)
  }

  private finishToolInvocation(
    record: PiAgentSessionRecord,
    sessionId: string,
    event: Extract<PiAgentEvent, { type: 'tool_execution_end' }>,
  ) {
    const existingInvocation = record.toolInvocationById.get(event.toolCallId)

    if (!existingInvocation) {
      return
    }

    const completedInvocation: AgentToolInvocation = {
      ...existingInvocation,
      endedAt: new Date().toISOString(),
      isError: event.isError,
    }

    record.toolInvocationById.set(event.toolCallId, completedInvocation)
    this.emit({
      type: 'tool',
      sessionId,
      invocation: completedInvocation,
    })
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

function upsertNormalizedMessage(messages: AgentMessage[], nextMessage: AgentMessage) {
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex === -1) {
    return [...messages, nextMessage]
  }

  return messages.map((message, index) =>
    index === existingIndex ? nextMessage : message,
  )
}

function resolveProvider(settings?: AgentSettingsState): KnownProvider {
  const envProvider = process.env[PI_PROVIDER_ENV_NAME]?.trim()

  if (!envProvider) {
    return (settings?.provider ?? DEFAULT_PI_PROVIDER) as KnownProvider
  }

  return envProvider as KnownProvider
}

function createDisabledTransport() {
  return new ProviderTransport({
    getApiKey: () => undefined,
  })
}

function resolveTransportMode(authMode: AgentAuthMode): AgentSessionSummary['transport'] {
  return authMode === 'brokered_oauth' ? 'codex_cli' : 'provider'
}

function resolveSessionReadyState(summary: AgentSessionSummary): AgentSessionSummary['runState'] {
  if (summary.authMode === 'brokered_oauth') {
    return summary.brokerSession?.state === 'authenticated' ? 'ready' : 'disabled'
  }

  return summary.hasProviderApiKey ? 'ready' : 'disabled'
}

function resolveDisabledReason(
  authMode: AgentAuthMode,
  provider: KnownProvider,
  settings: AgentSettingsState,
) {
  if (authMode === 'brokered_oauth') {
    if (provider !== 'openai') {
      return 'OpenAI Codex auth currently only supports the openai provider.'
    }

    if (settings.brokerSession.state === 'signed_out') {
      return 'OpenAI Codex auth is selected, but you are not signed in yet.'
    }

    if (settings.brokerSession.state === 'authenticated') {
      return undefined
    }

    return 'OpenAI Codex sign-in is in progress.'
  }

  if (!getApiKey(provider)) {
    return `No API key found for provider "${provider}".`
  }

  return undefined
}

function resolveModel(provider: KnownProvider, preferredModelId?: string) {
  const envModelId = process.env[PI_MODEL_ENV_NAME]?.trim()
  const desiredModelId = envModelId || preferredModelId || DEFAULT_PI_MODEL_ID
  const exactModel = tryGetModel(provider, desiredModelId)

  if (exactModel) {
    return exactModel
  }

  const fallbackModel = getModels(provider)[0]

  if (!fallbackModel) {
    throw new Error(`No PI models available for provider "${provider}".`)
  }

  return fallbackModel
}

function tryGetModel(provider: KnownProvider, modelId: string) {
  try {
    return getModel(provider, modelId as never)
  } catch {
    return null
  }
}

function buildWorkspaceSystemPrompt(workspaceRootDir: string) {
  return [
    'You are embedded inside Semanticode, a desktop code exploration and editing environment.',
    `The active workspace root is: ${workspaceRootDir}`,
    'Prefer reasoning about the active repository and use tools rather than making assumptions about the workspace state.',
  ].join('\n')
}

function updateSessionSummary(
  summary: AgentSessionSummary,
  changes: Partial<Pick<AgentSessionSummary, 'lastError' | 'runState'>>,
): AgentSessionSummary {
  return {
    ...summary,
    ...changes,
    updatedAt: new Date().toISOString(),
  }
}

function normalizeAgentMessage(
  sessionId: string,
  activeAssistantMessageId: string | null,
  message: Message | AssistantMessage,
  isStreaming: boolean,
): AgentMessage | null {
  if (message.role !== 'assistant' && message.role !== 'toolResult') {
    return null
  }

  const id =
    message.role === 'assistant'
      ? activeAssistantMessageId ?? `agent-message:${sessionId}:assistant`
      : `agent-message:${sessionId}:${message.role}:${message.timestamp ?? Date.now()}`

  const contentBlocks = Array.isArray(message.content) ? message.content : []
  const blocks: AgentMessage['blocks'] = contentBlocks.reduce<AgentMessage['blocks']>((result, block) => {
    if (block.type === 'text') {
      result.push({ kind: 'text', text: block.text })
      return result
    }

    if (block.type === 'thinking') {
      result.push({ kind: 'thinking', text: block.thinking })
      return result
    }

    return result
  }, [] as AgentMessage['blocks'])

  return {
    id,
    role: message.role === 'toolResult' ? 'tool' : 'assistant',
    blocks,
    createdAt: new Date(message.timestamp ?? Date.now()).toISOString(),
    isStreaming,
  }
}

function extractAssistantText(message: Message | AssistantMessage) {
  const contentBlocks = Array.isArray(message.content) ? message.content : []

  return contentBlocks
    .flatMap((block) => {
      if (block.type === 'text') {
        return [block.text]
      }

      return []
    })
    .join('\n')
    .trim()
}

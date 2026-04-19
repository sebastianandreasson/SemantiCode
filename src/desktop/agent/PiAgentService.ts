import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Agent, ProviderTransport, type AgentEvent as PiAgentEvent } from '@mariozechner/pi-agent'
import {
  getApiKey,
  getModel,
  getModels,
  type AgentTool,
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
import { AgentTelemetryService } from '../../node/telemetryService'
import { readProjectSnapshot } from '../../node/readProjectSnapshot'
import {
  disposeLayoutQuerySession,
  registerLayoutQuerySession,
} from '../../node/layoutQueryRegistry'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
import { PiAgentSettingsStore } from './PiAgentSettingsStore'
import { CodexCliTransport, createCodexCliModel } from '../agent-runtime/CodexCliTransport'
import { OpenAICodexProvider } from '../providers/openai-codex/provider'
import type {
  LayoutSuggestionPayload,
  LayoutSuggestionResponse,
} from '../../schema/api'

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
  promptSequence: number
  unsubscribe: () => void
  workspaceRootDir: string
}

type AgentSessionRecord = PiAgentSessionRecord

export interface PiAgentServiceOptions {
  logger?: Pick<Console, 'error' | 'info' | 'warn'>
  openExternal?: (url: string) => Promise<void> | void
  telemetryService?: AgentTelemetryService
}

export class PiAgentService {
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>
  private readonly openExternal?: (url: string) => Promise<void> | void
  private readonly listeners = new Set<(event: AgentEvent) => void>()
  private readonly sessionsByWorkspaceRootDir = new Map<string, AgentSessionRecord>()
  private readonly openAICodexProvider: OpenAICodexProvider
  private readonly settingsStore: PiAgentSettingsStore
  private readonly telemetryService?: AgentTelemetryService

  constructor(options: PiAgentServiceOptions = {}) {
    this.logger = options.logger ?? console
    this.openExternal = options.openExternal
    this.telemetryService = options.telemetryService
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
    await this.telemetryService?.ensureWorkspaceTelemetry(workspaceRootDir).catch((error) => {
      this.logger.warn(
        `[semanticode][telemetry] Failed to prepare request telemetry for ${workspaceRootDir}: ${error instanceof Error ? error.message : error}`,
      )
    })

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
      promptSequence: 0,
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

  async promptWorkspaceSession(
    workspaceRootDir: string,
    message: string,
    metadata?: {
      kind?: string
      paths?: string[]
      scope?: {
        paths: string[]
        symbolPaths?: string[]
        title?: string
      } | null
      task?: string
    },
  ) {
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
    const startedAt = now
    const promptSequence = record.promptSequence + 1
    const existingToolCallIds = new Set(record.toolInvocationById.keys())
    const normalizedMessage: AgentMessage = {
      id: `agent-message:${randomUUID()}`,
      role: 'user',
      blocks: [{ kind: 'text', text: message }],
      createdAt: now,
      isStreaming: false,
    }

    record.promptSequence = promptSequence
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

    let caughtError: unknown = null

    try {
      this.logger.info(
        `[semanticode][agent] Prompting ${record.summary.transport === 'codex_cli' ? 'Codex CLI' : 'PI'} session ${record.summary.id} with model ${record.summary.modelId}.`,
      )
      await record.agent.prompt(message)
    } catch (error) {
      caughtError = error
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
    } finally {
      await this.telemetryService?.recordInteractivePrompt({
        finishedAt: new Date().toISOString(),
        kind: metadata?.kind ?? 'workspace_chat',
        message,
        modelId: record.summary.modelId,
        promptSequence,
        provider: record.summary.provider,
        rootDir: workspaceRootDir,
        scope: metadata,
        sessionId: record.summary.id,
        startedAt,
        toolInvocations: collectNewToolInvocations(
          record.toolInvocationById,
          existingToolCallIds,
        ),
      }).catch((error) => {
        this.logger.warn(
          `[semanticode][telemetry] Failed to write interactive telemetry: ${error instanceof Error ? error.message : error}`,
        )
      })
    }

    if (caughtError) {
      throw caughtError
    }
  }

  async suggestLayout(
    workspaceRootDir: string,
    input: LayoutSuggestionPayload,
    options: {
      helperBaseUrl: string
    },
  ): Promise<LayoutSuggestionResponse> {
    await this.telemetryService?.ensureWorkspaceTelemetry(workspaceRootDir).catch(() => undefined)
    await this.settingsStore.applyConfiguredApiKeys()
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const disabledReason = resolveDisabledReason(settings.authMode, provider, settings)

    if (disabledReason) {
      throw new Error(disabledReason)
    }

    const executionPath =
      settings.authMode === 'brokered_oauth' ? 'codex_cli_bridge' : 'native_tools'
    const snapshot = await readProjectSnapshot({
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
      rootDir: workspaceRootDir,
    })
    const [existingLayouts, existingDrafts] = await Promise.all([
      listSavedLayouts(workspaceRootDir),
      listLayoutDrafts(workspaceRootDir),
    ])
    const existingDraftIds = new Set(existingDrafts.map((draft) => draft.id))
    const querySession = registerLayoutQuerySession({
      baseLayoutId: input.baseLayoutId,
      executionPath,
      existingLayouts,
      nodeScope: input.nodeScope ?? 'symbols',
      prompt: input.prompt,
      rootDir: workspaceRootDir,
      snapshot,
      visibleNodeIds: input.visibleNodeIds,
    })

    try {
      if (executionPath === 'native_tools') {
        await this.runNativeLayoutSuggestion({
          input,
          provider,
          querySession,
          settings,
          workspaceRootDir,
        })
      } else {
        await this.runCodexLayoutSuggestion({
          helperBaseUrl: options.helperBaseUrl,
          input,
          querySession,
          workspaceRootDir,
        })
      }

      const createdDraft =
        querySession.getCreatedDraft() ??
        (await findNewLayoutDraft(workspaceRootDir, existingDraftIds))

      if (!createdDraft) {
        throw new Error(
          'The layout planner finished without creating a layout draft. Try a narrower layout request.',
        )
      }

      return {
        draft: createdDraft,
        queryStats: querySession.getStats(),
      }
    } finally {
      disposeLayoutQuerySession(querySession.id)
    }
  }

  async runOneOffPrompt(
    workspaceRootDir: string,
    input: {
      message: string
      systemPrompt?: string
      telemetry?: {
        kind?: string
        paths?: string[]
        scope?: {
          paths: string[]
          symbolPaths?: string[]
          title?: string
        } | null
        task?: string
      }
    },
  ) {
    await this.telemetryService?.ensureWorkspaceTelemetry(workspaceRootDir).catch(() => undefined)
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
    const toolInvocationById = new Map<string, AgentToolInvocation>()
    const startedAt = new Date().toISOString()
    const sessionId = `one-off:${randomUUID()}`
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        toolInvocationById.set(event.toolCallId, {
          args: event.args,
          startedAt: new Date().toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })
      }

      if (event.type === 'tool_execution_end') {
        const existingInvocation = toolInvocationById.get(event.toolCallId)

        if (existingInvocation) {
          toolInvocationById.set(event.toolCallId, {
            ...existingInvocation,
            endedAt: new Date().toISOString(),
            isError: event.isError,
          })
        }
      }

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
      await this.telemetryService?.recordInteractivePrompt({
        finishedAt: new Date().toISOString(),
        kind: input.telemetry?.kind ?? 'one_off_prompt',
        message: input.message,
        modelId: model.id,
        promptSequence: 1,
        provider,
        rootDir: workspaceRootDir,
        scope: input.telemetry,
        sessionId,
        startedAt,
        toolInvocations: [...toolInvocationById.values()],
      }).catch((error) => {
        this.logger.warn(
          `[semanticode][telemetry] Failed to write one-off telemetry: ${error instanceof Error ? error.message : error}`,
        )
      })
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

  private async runNativeLayoutSuggestion(input: {
    input: LayoutSuggestionPayload
    provider: KnownProvider
    querySession: ReturnType<typeof registerLayoutQuerySession>
    settings: AgentSettingsState
    workspaceRootDir: string
  }) {
    const model = resolveModel(input.provider, input.settings.modelId)
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: buildLayoutSuggestionSystemPrompt(),
        thinkingLevel: 'medium',
        tools: createLayoutQueryTools(input.querySession),
      },
      transport: this.createTransport(input.provider),
    })
    const startedAt = new Date().toISOString()
    const toolInvocationById = new Map<string, AgentToolInvocation>()
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        toolInvocationById.set(event.toolCallId, {
          args: event.args,
          startedAt: new Date().toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })
      }

      if (event.type === 'tool_execution_end') {
        const existingInvocation = toolInvocationById.get(event.toolCallId)

        if (existingInvocation) {
          toolInvocationById.set(event.toolCallId, {
            ...existingInvocation,
            endedAt: new Date().toISOString(),
            isError: event.isError,
          })
        }
      }
    })

    try {
      await agent.prompt(buildLayoutSuggestionUserPrompt(input.input))
      await agent.waitForIdle().catch(() => undefined)
    } finally {
      await this.telemetryService?.recordInteractivePrompt({
        finishedAt: new Date().toISOString(),
        kind: 'layout_suggestion',
        message: input.input.prompt,
        modelId: model.id,
        promptSequence: 1,
        provider: input.provider,
        rootDir: input.workspaceRootDir,
        scope: {
          task: input.input.prompt,
        },
        sessionId: `layout-suggestion:${randomUUID()}`,
        startedAt,
        toolInvocations: [...toolInvocationById.values()],
      }).catch((error) => {
        this.logger.warn(
          `[semanticode][telemetry] Failed to write layout suggestion telemetry: ${error instanceof Error ? error.message : error}`,
        )
      })
      unsubscribe()
      agent.abort()
      await agent.waitForIdle().catch(() => undefined)
    }
  }

  private async runCodexLayoutSuggestion(input: {
    helperBaseUrl: string
    input: LayoutSuggestionPayload
    querySession: ReturnType<typeof registerLayoutQuerySession>
    workspaceRootDir: string
  }) {
    const helperUrl = `${input.helperBaseUrl}/${encodeURIComponent(input.querySession.id)}`
    const helperCommand = buildLayoutHelperCommand(input.workspaceRootDir)

    await this.runOneOffPrompt(input.workspaceRootDir, {
      message: buildCodexLayoutSuggestionPrompt({
        helperCommand,
        helperUrl,
        input: input.input,
      }),
      systemPrompt: buildWorkspaceSystemPrompt(input.workspaceRootDir),
      telemetry: {
        kind: 'layout_suggestion',
        task: input.input.prompt,
      },
    })
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

function collectNewToolInvocations(
  toolInvocationById: Map<string, AgentToolInvocation>,
  existingToolCallIds: Set<string>,
) {
  return [...toolInvocationById.values()].filter(
    (invocation) => !existingToolCallIds.has(invocation.toolCallId),
  )
}

function createLayoutQueryTools(
  querySession: ReturnType<typeof registerLayoutQuerySession>,
): AgentTool[] {
  return [
    createLayoutQueryTool(
      'getWorkspaceSummary',
      'Get compact workspace counts, available facets/tags, top directories, and existing layout summaries.',
      querySession,
    ),
    createLayoutQueryTool(
      'findNodes',
      'Find compact node references using filters like kind, symbolKind, facet, tag, pathPrefix, pathContains, nameContains, nameRegex, LOC range, degree range, and limit.',
      querySession,
    ),
    createLayoutQueryTool(
      'getNodes',
      'Get compact node references for explicit nodeIds.',
      querySession,
    ),
    createLayoutQueryTool(
      'getNeighborhood',
      'Expand a bounded graph neighborhood from seedNodeIds using optional edgeKinds, direction, depth, and limit.',
      querySession,
    ),
    createLayoutQueryTool(
      'summarizeScope',
      'Summarize nodes matched by a selector and return counts plus representative nodes.',
      querySession,
    ),
    createLayoutQueryTool(
      'previewHybridLayout',
      'Validate a hybrid layout proposal without saving it.',
      querySession,
    ),
    createLayoutQueryTool(
      'createLayoutDraft',
      'Create and save the final draft from a hybrid layout proposal. This must be called to complete layout generation.',
      querySession,
    ),
  ]
}

function createLayoutQueryTool(
  operation: string,
  description: string,
  querySession: ReturnType<typeof registerLayoutQuerySession>,
): AgentTool {
  return {
    description,
    label: operation,
    name: operation,
    parameters: {
      additionalProperties: true,
      properties: {
        args: {
          additionalProperties: true,
          type: 'object',
        },
        proposal: {
          additionalProperties: true,
          type: 'object',
        },
      },
      type: 'object',
    } as never,
    execute: async (_toolCallId, params) => {
      const result = await querySession.execute({
        args: params && typeof params === 'object' && 'args' in params
          ? (params.args as Record<string, unknown>)
          : (params as Record<string, unknown>),
        operation: operation as never,
      })

      return {
        content: [
          {
            text: JSON.stringify(result),
            type: 'text',
          },
        ],
        details: result,
      }
    },
  }
}

function buildLayoutSuggestionSystemPrompt() {
  return [
    'You are Semanticode layout planner.',
    'Create a custom codebase layout by querying compact graph data first.',
    'Do not ask for or dump the full snapshot.',
    'Use getWorkspaceSummary first, then focused findNodes/summarizeScope/getNeighborhood calls.',
    'When ready, call createLayoutDraft with a HybridLayoutProposal. The draft tool call is the final artifact.',
    'Prefer selectors over explicit node ids when the structure can be described generically.',
    'Use explicit anchors only for a few important nodes. Semanticode fills missing coordinates locally.',
    'Default nodeScope is symbols unless the user clearly asks for files or mixed file/symbol views.',
  ].join('\n')
}

function buildLayoutSuggestionUserPrompt(input: LayoutSuggestionPayload) {
  return [
    'Create a Semanticode layout draft for this request:',
    input.prompt,
    '',
    `Requested node scope: ${input.nodeScope ?? 'symbols'}`,
    input.baseLayoutId ? `Base layout id: ${input.baseLayoutId}` : 'No base layout id was selected.',
    input.visibleNodeIds?.length
      ? `The user currently has ${input.visibleNodeIds.length} visible nodes in scope.`
      : 'No explicit visible-node subset was provided.',
    '',
    'Use the query tools and finish by calling createLayoutDraft.',
  ].join('\n')
}

function buildCodexLayoutSuggestionPrompt(input: {
  helperCommand: string
  helperUrl: string
  input: LayoutSuggestionPayload
}) {
  return [
    'Create a Semanticode layout draft for the active repository.',
    '',
    'Do not read or dump the full Semanticode snapshot. Use the query-first helper instead.',
    '',
    'Preferred helper endpoint:',
    input.helperUrl,
    '',
    'Call it with curl like:',
    `curl -sS -X POST ${JSON.stringify(input.helperUrl)} -H 'Content-Type: application/json' -d '{"operation":"getWorkspaceSummary","args":{}}'`,
    '',
    'Fallback CLI helper if the HTTP endpoint is unavailable:',
    input.helperCommand,
    '',
    'The helper operations are: getWorkspaceSummary, findNodes, getNodes, getNeighborhood, summarizeScope, previewHybridLayout, createLayoutDraft.',
    'You must finish by calling createLayoutDraft with a HybridLayoutProposal. Do not create draft files manually.',
    '',
    'Layout request:',
    input.input.prompt,
    '',
    `Requested node scope: ${input.input.nodeScope ?? 'symbols'}`,
    input.input.baseLayoutId
      ? `Base layout id: ${input.input.baseLayoutId}`
      : 'No base layout id was selected.',
  ].join('\n')
}

function buildLayoutHelperCommand(rootDir: string) {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const packageRoot = currentDir.endsWith('/dist/desktop')
    ? resolve(currentDir, '../..')
    : resolve(currentDir, '../../..')
  const cliEntryPath = resolve(packageRoot, 'bin/semanticode.js')

  return `node ${JSON.stringify(cliEntryPath)} layout-helper --root ${JSON.stringify(rootDir)}`
}

async function findNewLayoutDraft(rootDir: string, existingDraftIds: Set<string>) {
  const drafts = await listLayoutDrafts(rootDir)

  return drafts.find(
    (draft) =>
      draft.status === 'draft' &&
      Boolean(draft.layout) &&
      !existingDraftIds.has(draft.id),
  ) ?? null
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

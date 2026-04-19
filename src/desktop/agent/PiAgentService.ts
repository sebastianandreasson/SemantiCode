import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Agent, ProviderTransport, type AgentEvent as PiAgentEvent } from '@mariozechner/pi-agent'
import {
  getApiKey,
  getModel,
  getModels,
  type AgentTool,
  type AssistantMessage,
  type KnownProvider,
  type Message,
} from '@mariozechner/pi-ai'
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodingTools,
  createFindTool,
  createGrepTool,
  createLsTool,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type SessionInfo,
  type SlashCommandInfo,
  type ToolInfo,
} from '@mariozechner/pi-coding-agent'

import type {
  AgentAuthMode,
  AgentBrokerSessionSummary,
  AgentControlState,
  AgentEvent,
  AgentModelControlOption,
  AgentMessage,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
  AgentSourceInfo,
  AgentTimelineItem,
  AgentToolControlInfo,
  AgentToolInvocation,
} from '../../schema/agent'
import type {
  AgentCodexImportResponse,
  AgentBrokerCallbackResult,
  AgentBrokerLoginStartResponse,
  AgentModelSelectionRequest,
  AgentPromptRequest,
} from '../../schema/api'
import { AgentTelemetryService } from '../../node/telemetryService'
import { readProjectSnapshot } from '../../node/readProjectSnapshot'
import {
  disposeLayoutQuerySession,
  registerLayoutQuerySession,
} from '../../node/layoutQueryRegistry'
import { listLayoutDrafts, listSavedLayouts } from '../../planner'
import { CODEX_OPENAI_MODELS, PiAgentSettingsStore } from './PiAgentSettingsStore'
import { CodexCliTransport, createCodexCliModel } from '../agent-runtime/CodexCliTransport'
import { OpenAICodexProvider } from '../providers/openai-codex/provider'
import type {
  LayoutSuggestionPayload,
  LayoutSuggestionResponse,
} from '../../schema/api'
import {
  createLifecycleTimelineItem,
  createMessageTimelineItems,
  createToolTimelineItem,
  normalizeToolInvocation,
  replaceMessageTimelineItems,
  summarizeTimelineValue,
  upsertTimelineItem,
} from '../agent-runtime/agentTimeline'
import {
  CODEX_SUBSCRIPTION_AGENT_CAPABILITIES,
  DISABLED_AGENT_CAPABILITIES,
  PI_SDK_AGENT_CAPABILITIES,
  type WorkspaceAgentCapabilities,
} from '../agent-runtime/WorkspaceAgentRuntime'

const DEFAULT_PI_PROVIDER = 'openai'
const DEFAULT_PI_MODEL_ID = 'gpt-4.1-mini'
const BOOT_PROMPT_ENV_NAME = 'SEMANTICODE_PI_BOOT_PROMPT'
const PI_PROVIDER_ENV_NAME = 'SEMANTICODE_PI_PROVIDER'
const PI_MODEL_ENV_NAME = 'SEMANTICODE_PI_MODEL'

type PiRegistryModel = ReturnType<ModelRegistry['getAll']>[number]

interface BaseAgentSessionRecord {
  activeAssistantMessageId: string | null
  capabilities: WorkspaceAgentCapabilities
  completedAssistantMessageId: string | null
  messages: AgentMessage[]
  summary: AgentSessionSummary
  timeline: AgentTimelineItem[]
  timelineRevision: number
  toolInvocationById: Map<string, AgentToolInvocation>
  promptSequence: number
  unsubscribe: () => void
  workspaceRootDir: string
}

interface LegacyPiAgentSessionRecord extends BaseAgentSessionRecord {
  agent: Agent
  kind: 'legacy'
}

interface PiSdkAgentSessionRecord extends BaseAgentSessionRecord {
  kind: 'sdk'
  pendingContextQueue: string[]
  runtime: AgentSessionRuntime
  session: AgentSession
}

type AgentSessionRecord = LegacyPiAgentSessionRecord | PiSdkAgentSessionRecord

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
    const sdkAuthStorage =
      settings.authMode === 'api_key'
        ? await this.createSdkAuthStorage()
        : undefined
    const sdkModelRegistry =
      sdkAuthStorage
        ? ModelRegistry.create(sdkAuthStorage, join(getAgentDir(), 'models.json'))
        : undefined
    const sdkModel =
      sdkModelRegistry
        ? resolveSdkModel(sdkModelRegistry, provider, settings.modelId)
        : null
    const hasProviderApiKey =
      settings.authMode === 'api_key' && sdkModel && sdkModelRegistry
        ? sdkModelRegistry.hasConfiguredAuth(sdkModel)
        : false
    const bootPrompt = process.env[BOOT_PROMPT_ENV_NAME]?.trim() ?? ''
    const sessionTransport = resolveTransportMode(settings.authMode)
    const disabledReason =
      settings.authMode === 'api_key'
        ? resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
        : resolveDisabledReason(settings.authMode, provider, settings)
    const resolvedModelId =
      settings.authMode === 'brokered_oauth'
        ? settings.modelId
        : sdkModel?.id ?? settings.modelId
    const runtimeKind = resolveRuntimeKind(settings.authMode)
    const capabilities = resolveCapabilities(settings.authMode, disabledReason)
    const summary: AgentSessionSummary = {
      authMode: settings.authMode,
      brokerSession: settings.brokerSession,
      capabilities,
      id: `pi-session:${randomUUID()}`,
      workspaceRootDir,
      provider,
      modelId: resolvedModelId,
      transport: sessionTransport,
      runtimeKind,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runState: disabledReason ? 'disabled' : 'ready',
      bootPromptEnabled: bootPrompt.length > 0,
      hasProviderApiKey,
      lastError: disabledReason,
    }
    const record =
      settings.authMode === 'api_key' && !disabledReason
        ? await this.createSdkSessionRecord({
            authStorage: sdkAuthStorage,
            modelRegistry: sdkModelRegistry,
            provider,
            settings,
            summary,
            workspaceRootDir,
          })
        : this.createLegacySessionRecord({
            disabledReason,
            provider,
            settings,
            summary,
            workspaceRootDir,
          })

    this.sessionsByWorkspaceRootDir.set(workspaceRootDir, record)
    this.emit({
      type: 'session_created',
      session: record.summary,
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        event: 'session_created',
        label: 'session created',
        status: record.summary.runState === 'disabled' ? 'error' : 'completed',
        detail: `${record.summary.provider}/${record.summary.modelId}`,
      }),
    )

    this.logger.info(
      `[semanticode][pi] Created ${record.kind === 'sdk' ? 'SDK' : summary.transport === 'codex_cli' ? 'Codex CLI' : 'provider'} workspace session ${record.summary.id} for ${workspaceRootDir} using ${record.summary.provider}/${record.summary.modelId}.`,
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

    if (record.kind === 'sdk') {
      await record.session.abort().catch(() => undefined)
      await record.runtime.dispose().catch(() => {
        record.session.dispose()
      })
    } else {
      record.agent.abort()
      await record.agent.waitForIdle().catch(() => undefined)
    }
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

  getWorkspaceTimeline(workspaceRootDir: string) {
    return this.sessionsByWorkspaceRootDir.get(workspaceRootDir)?.timeline ?? []
  }

  async getWorkspaceControls(workspaceRootDir: string): Promise<AgentControlState> {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      return {
        ...createEmptyAgentControlState(),
        models: await this.createUnifiedModelControlOptions(null),
      }
    }

    return this.createControlState(
      record,
      await this.createUnifiedModelControlOptions(record),
    )
  }

  private async createSdkAuthStorage() {
    const agentDir = getAgentDir()
    const authStorage = AuthStorage.create(join(agentDir, 'auth.json'))
    const storedApiKeys = await this.settingsStore.getStoredApiKeys()

    for (const [provider, apiKey] of Object.entries(storedApiKeys)) {
      authStorage.setRuntimeApiKey(provider, apiKey)
    }

    return authStorage
  }

  private createLegacySessionRecord(input: {
    disabledReason?: string
    provider: string
    settings: AgentSettingsState
    summary: AgentSessionSummary
    workspaceRootDir: string
  }): LegacyPiAgentSessionRecord {
    const transport = input.disabledReason
      ? createDisabledTransport()
      : input.settings.authMode === 'brokered_oauth'
        ? new CodexCliTransport({
            authProvider: this.openAICodexProvider,
            logger: this.logger,
            workspaceRootDir: input.workspaceRootDir,
          })
        : this.createTransport(input.provider)
    const model =
      input.settings.authMode === 'brokered_oauth'
        ? createCodexCliModel(input.settings.modelId)
        : resolveLegacyProviderModel(input.provider, input.settings.modelId)
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: buildWorkspaceSystemPrompt(input.workspaceRootDir),
        thinkingLevel: 'medium',
        tools: [],
      },
      transport,
    })
    const unsubscribe = agent.subscribe((event) => {
      this.handleLegacyAgentEvent(input.summary.id, input.workspaceRootDir, event)
    })

    return {
      activeAssistantMessageId: null,
      agent,
      capabilities: resolveCapabilities(input.settings.authMode, input.disabledReason),
      completedAssistantMessageId: null,
      kind: 'legacy',
      messages: [],
      promptSequence: 0,
      summary: {
        ...input.summary,
        capabilities: resolveCapabilities(input.settings.authMode, input.disabledReason),
        runtimeKind: resolveRuntimeKind(input.settings.authMode),
        thinkingLevel: 'medium',
      },
      timeline: [],
      timelineRevision: 0,
      toolInvocationById: new Map(),
      unsubscribe,
      workspaceRootDir: input.workspaceRootDir,
    }
  }

  private async createSdkSessionRecord(input: {
    authStorage?: AuthStorage
    modelRegistry?: ModelRegistry
    provider: string
    sessionManager?: SessionManager
    settings: AgentSettingsState
    summary: AgentSessionSummary
    workspaceRootDir: string
  }): Promise<PiSdkAgentSessionRecord> {
    const agentDir = getAgentDir()
    const authStorage = input.authStorage ?? await this.createSdkAuthStorage()
    const modelRegistry =
      input.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, 'models.json'))
    const initialModel = resolveSdkModel(modelRegistry, input.provider, input.settings.modelId)

    if (!initialModel) {
      throw new Error(`No pi SDK model is available for provider "${input.provider}".`)
    }

    const pendingContextQueue: string[] = []
    const settingsManager = SettingsManager.inMemory({
      defaultModel: initialModel.id,
      defaultProvider: String(initialModel.provider),
      defaultThinkingLevel: 'medium',
      retry: {
        enabled: true,
      },
    })
    const sessionManager = input.sessionManager ?? SessionManager.continueRecent(input.workspaceRootDir)
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        agentDir,
        authStorage,
        cwd,
        modelRegistry,
        resourceLoaderOptions: {
          extensionFactories: [
            createSemanticodeContextExtension(() => pendingContextQueue.shift()),
          ],
        },
        settingsManager,
      })
      const model = resolveSdkModel(services.modelRegistry, input.provider, input.settings.modelId)

      if (!model) {
        throw new Error(`No pi SDK model is available for provider "${input.provider}".`)
      }

      return {
        ...(await createAgentSessionFromServices({
          model,
          services,
          sessionManager,
          sessionStartEvent,
          thinkingLevel: 'medium',
          tools: [
            ...createCodingTools(cwd),
            createGrepTool(cwd),
            createFindTool(cwd),
            createLsTool(cwd),
          ],
        })),
        diagnostics: services.diagnostics,
        services,
      }
    }
    const runtime = await createAgentSessionRuntime(createRuntime, {
      agentDir,
      cwd: input.workspaceRootDir,
      sessionManager,
    })
    const session = runtime.session
    const hydratedMessages = normalizeStoredSessionMessages(
      input.summary.id,
      session.state.messages as unknown[],
    )
    const record: PiSdkAgentSessionRecord = {
      activeAssistantMessageId: null,
      capabilities: PI_SDK_AGENT_CAPABILITIES,
      completedAssistantMessageId: null,
      kind: 'sdk',
      messages: hydratedMessages,
      pendingContextQueue,
      promptSequence: 0,
      runtime,
      session,
      summary: {
        ...input.summary,
        capabilities: PI_SDK_AGENT_CAPABILITIES,
        modelId: session.model?.id ?? initialModel.id,
        provider: String(session.model?.provider ?? initialModel.provider),
        queue: {
          followUp: 0,
          steering: 0,
        },
        runtimeKind: 'pi-sdk',
        sessionFile: session.sessionFile,
        sessionName: session.sessionName,
        thinkingLevel: session.thinkingLevel,
      },
      timeline: hydratedMessages.flatMap(createMessageTimelineItems),
      timelineRevision: 0,
      toolInvocationById: new Map(),
      unsubscribe: () => undefined,
      workspaceRootDir: input.workspaceRootDir,
    }

    record.unsubscribe = session.subscribe((event) => {
      this.handleSdkAgentEvent(record.summary.id, record.workspaceRootDir, event)
    })

    return record
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
    messageOrRequest: string | AgentPromptRequest,
    metadata?: AgentPromptRequest['metadata'],
    mode: AgentPromptRequest['mode'] = 'send',
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

    const promptRequest = normalizeAgentPromptRequest(messageOrRequest, metadata, mode)
    const displayText = (promptRequest.displayText ?? promptRequest.message).trim()
    const contextInjection = promptRequest.contextInjection?.trim()
    const promptMode = promptRequest.mode ?? 'send'
    const agentText =
      promptRequest.agentText?.trim() ||
      (contextInjection ? buildContextualAgentPrompt(contextInjection, displayText) : displayText)
    const now = new Date().toISOString()
    const startedAt = now
    const promptSequence = record.promptSequence + 1
    const existingToolCallIds = new Set(record.toolInvocationById.keys())

    record.promptSequence = promptSequence
    if (record.kind === 'legacy') {
      const normalizedMessage: AgentMessage = {
        id: `agent-message:${randomUUID()}`,
        role: 'user',
        blocks: [{ kind: 'text', text: displayText }],
        createdAt: now,
        isStreaming: false,
      }

      record.messages = upsertNormalizedMessage(record.messages, normalizedMessage)
      this.emit({
        type: 'message',
        sessionId: record.summary.id,
        message: normalizedMessage,
      })
      this.addMessageTimelineItems(record, normalizedMessage)
    }

    record.summary = updateSessionSummary(record.summary, {
      lastError: undefined,
      runState: 'running',
    })
    this.emit({
      type: 'session_updated',
      session: record.summary,
    })

    let caughtError: unknown = null
    let queuedContextInjection: string | undefined

    try {
      this.logger.info(
        `[semanticode][agent] Prompting ${record.summary.transport === 'codex_cli' ? 'Codex CLI' : 'PI'} session ${record.summary.id} with model ${record.summary.modelId}.`,
      )
      if (record.kind === 'sdk') {
        const streamingBehavior =
          promptMode === 'steer'
            ? 'steer'
            : promptMode === 'follow_up' || record.session.isStreaming
              ? 'followUp'
              : undefined

        if (contextInjection) {
          record.pendingContextQueue.push(contextInjection)
          queuedContextInjection = contextInjection
        }

        await record.session.prompt(displayText, {
          streamingBehavior,
        })
      } else {
        await record.agent.prompt(agentText)
      }
    } catch (error) {
      if (record.kind === 'sdk' && queuedContextInjection) {
        const queuedIndex = record.pendingContextQueue.indexOf(queuedContextInjection)

        if (queuedIndex !== -1) {
          record.pendingContextQueue.splice(queuedIndex, 1)
        }
      }

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
      this.addTimelineItem(
        record,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'agent error',
          status: 'error',
        }),
      )
    } finally {
      await this.telemetryService?.recordInteractivePrompt({
        finishedAt: new Date().toISOString(),
        kind: promptRequest.metadata?.kind ?? 'workspace_chat',
        message: displayText,
        modelId: record.summary.modelId,
        promptSequence,
        provider: record.summary.provider,
        rootDir: workspaceRootDir,
        scope: promptRequest.metadata,
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
        : resolveLegacyProviderModel(provider, settings.modelId)
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

    if (record.kind === 'sdk') {
      await record.session.abort().catch(() => undefined)
    } else {
      record.agent.abort()
    }
    record.summary = updateSessionSummary(record.summary, {
      runState: resolveSessionReadyState(record.summary),
    })
    this.emit({
      session: record.summary,
      type: 'session_updated',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        event: 'cancelled',
        label: 'cancelled',
        status: 'completed',
      }),
    )
    return true
  }

  async setWorkspaceActiveTools(
    workspaceRootDir: string,
    toolNames: string[],
  ): Promise<AgentControlState> {
    let record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      await this.ensureWorkspaceSession(workspaceRootDir)
      record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)
    }

    if (!record) {
      throw new Error('No workspace agent session exists for the active repository.')
    }

    if (record.kind !== 'sdk') {
      const message = 'Tool controls are only available for pi SDK sessions.'

      this.addTimelineItem(
        record,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'tools failed',
          status: 'error',
        }),
      )
      throw new Error(message)
    }

    const availableToolNames = new Set(record.session.getAllTools().map((tool) => tool.name))
    const normalizedToolNames = [...new Set(
      toolNames
        .map((toolName) => toolName.trim())
        .filter((toolName) => availableToolNames.has(toolName)),
    )]

    record.session.setActiveToolsByName(normalizedToolNames)
    record.summary = updateSessionSummary(record.summary, {})
    this.emit({
      session: record.summary,
      type: 'session_updated',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        detail: normalizedToolNames.length
          ? normalizedToolNames.join(', ')
          : 'No tools active.',
        event: 'session_updated',
        label: 'tools updated',
        status: 'completed',
      }),
    )

    return this.createControlState(
      record,
      await this.createUnifiedModelControlOptions(record),
    )
  }

  async setWorkspaceModel(
    workspaceRootDir: string,
    input: AgentModelSelectionRequest,
  ) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      const settings = await this.getSettings()
      const targetAuthMode = resolveModelSelectionAuthMode(input, settings.authMode)

      if (targetAuthMode === 'brokered_oauth') {
        if (input.provider !== 'openai' || !isCodexOpenAIModel(input.modelId)) {
          throw new Error(`Codex subscription mode does not support ${input.provider}/${input.modelId}.`)
        }
      }

      await this.saveSettings({
        authMode: targetAuthMode,
        modelId: input.modelId,
        provider: input.provider,
      })

      return this.ensureWorkspaceSession(workspaceRootDir)
    }

    const targetAuthMode = resolveModelSelectionAuthMode(input, record.summary.authMode)

    if (targetAuthMode === 'brokered_oauth') {
      if (input.provider !== 'openai' || !isCodexOpenAIModel(input.modelId)) {
        throw new Error(`Codex subscription mode does not support ${input.provider}/${input.modelId}.`)
      }

      await this.saveSettings({
        authMode: 'brokered_oauth',
        modelId: input.modelId,
        provider: 'openai',
      })

      return this.ensureWorkspaceSession(workspaceRootDir)
    }

    if (record.kind !== 'sdk') {
      await this.saveSettings({
        authMode: 'api_key',
        modelId: input.modelId,
        provider: input.provider,
      })

      return this.ensureWorkspaceSession(workspaceRootDir)
    }

    let model =
      record.session.modelRegistry.find(input.provider, input.modelId) ??
      record.session.modelRegistry
        .getAvailable()
        .find(
          (candidate) =>
            candidate.id === input.modelId &&
            String(candidate.provider) === input.provider,
        )

    if (!model) {
      record.session.modelRegistry.refresh()
      model =
        record.session.modelRegistry.find(input.provider, input.modelId) ??
        record.session.modelRegistry
          .getAvailable()
          .find(
            (candidate) =>
              candidate.id === input.modelId &&
              String(candidate.provider) === input.provider,
          )
    }

    if (!model) {
      throw new Error(`Model not found: ${input.provider}/${input.modelId}`)
    }

    if (!record.session.modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No configured PI SDK auth found for ${input.provider}/${input.modelId}.`)
    }

    await record.session.setModel(model)
    await this.settingsStore.saveSettings({
      authMode: 'api_key',
      modelId: model.id,
      provider: String(model.provider),
    })
    record.summary = updateSessionSummary(
      {
        ...record.summary,
        authMode: 'api_key',
        modelId: model.id,
        provider: String(model.provider),
        thinkingLevel: record.session.thinkingLevel,
      },
      {
        lastError: undefined,
        runState: resolveSessionReadyState(record.summary),
      },
    )
    this.emit({
      session: record.summary,
      type: 'session_updated',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        detail: `${record.summary.provider}/${record.summary.modelId}`,
        event: 'session_updated',
        label: 'model changed',
        status: 'completed',
      }),
    )

    return record.summary
  }

  async setWorkspaceThinkingLevel(
    workspaceRootDir: string,
    thinkingLevel: NonNullable<AgentSessionSummary['thinkingLevel']>,
  ) {
    let record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      await this.ensureWorkspaceSession(workspaceRootDir)
      record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)
    }

    if (!record) {
      throw new Error('No workspace agent session exists for the active repository.')
    }

    if (record.kind !== 'sdk') {
      const message = 'Thinking level changes are only available for pi SDK sessions.'

      this.addTimelineItem(
        record,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'thinking failed',
          status: 'error',
        }),
      )
      throw new Error(message)
    }

    record.session.setThinkingLevel(thinkingLevel)
    record.summary = {
      ...record.summary,
      thinkingLevel: record.session.thinkingLevel as AgentSessionSummary['thinkingLevel'],
      updatedAt: new Date().toISOString(),
    }

    this.emit({
      session: record.summary,
      type: 'session_updated',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        event: 'session_updated',
        label: `thinking ${record.summary.thinkingLevel ?? thinkingLevel}`,
        status: 'completed',
      }),
    )
    return record.summary
  }

  async compactWorkspaceSession(workspaceRootDir: string, instructions?: string) {
    let record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      await this.ensureWorkspaceSession(workspaceRootDir)
      record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)
    }

    if (!record) {
      throw new Error('No workspace agent session exists for the active repository.')
    }

    if (record.kind !== 'sdk') {
      const message = 'Manual compaction is only available for pi SDK sessions.'

      this.addTimelineItem(
        record,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'compact failed',
          status: 'error',
        }),
      )
      throw new Error(message)
    }

    record.summary = updateSessionSummary(record.summary, {
      lastError: undefined,
      runState: 'running',
    })
    this.emit({
      session: record.summary,
      type: 'session_updated',
    })

    try {
      await record.session.compact(instructions)
      record.summary = updateSessionSummary(record.summary, {
        runState: resolveSessionReadyState(record.summary),
      })
      this.emit({
        session: record.summary,
        type: 'session_updated',
      })
      return record.summary
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Manual compaction failed.'

      record.summary = updateSessionSummary(record.summary, {
        lastError: message,
        runState: 'error',
      })
      this.emit({
        session: record.summary,
        type: 'session_updated',
      })
      this.addTimelineItem(
        record,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'compact failed',
          status: 'error',
        }),
      )
      throw error
    }
  }

  async listWorkspaceSessions(workspaceRootDir: string): Promise<AgentSessionListItem[]> {
    const sessions = await SessionManager.list(workspaceRootDir).catch(() => [])
    return sessions.map(formatSessionListItem)
  }

  async startNewWorkspaceSession(workspaceRootDir: string) {
    const existingRecord = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (existingRecord?.kind === 'sdk') {
      existingRecord.summary = updateSessionSummary(existingRecord.summary, {
        lastError: undefined,
        runState: 'running',
      })
      this.emit({
        session: existingRecord.summary,
        type: 'session_updated',
      })
      await existingRecord.runtime.newSession()
      this.refreshSdkRecordFromRuntime(existingRecord, `pi-session:${randomUUID()}`)
      this.emit({
        session: existingRecord.summary,
        type: 'session_created',
      })
      this.addTimelineItem(
        existingRecord,
        createLifecycleTimelineItem({
          event: 'session_created',
          label: 'new session',
          status: 'completed',
        }),
      )
      return existingRecord.summary
    }

    await this.disposeWorkspaceSession(workspaceRootDir)
    const record = await this.createWorkspaceSessionWithManager(
      workspaceRootDir,
      SessionManager.create(workspaceRootDir),
    )

    this.sessionsByWorkspaceRootDir.set(workspaceRootDir, record)
    this.emit({
      session: record.summary,
      type: 'session_created',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        event: 'session_created',
        label: 'new session',
        status: 'completed',
      }),
    )
    return record.summary
  }

  async resumeWorkspaceSession(workspaceRootDir: string, sessionFile: string) {
    const existingRecord = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (existingRecord?.kind === 'sdk') {
      existingRecord.summary = updateSessionSummary(existingRecord.summary, {
        lastError: undefined,
        runState: 'running',
      })
      this.emit({
        session: existingRecord.summary,
        type: 'session_updated',
      })
      await existingRecord.runtime.switchSession(sessionFile, workspaceRootDir)
      this.refreshSdkRecordFromRuntime(existingRecord, `pi-session:${randomUUID()}`)
      this.emit({
        session: existingRecord.summary,
        type: 'session_created',
      })
      this.addTimelineItem(
        existingRecord,
        createLifecycleTimelineItem({
          detail: sessionFile,
          event: 'session_created',
          label: 'session resumed',
          status: 'completed',
        }),
      )
      return existingRecord.summary
    }

    await this.settingsStore.applyConfiguredApiKeys()
    const settings = await this.getSettings()

    if (settings.authMode !== 'api_key') {
      throw new Error('Resume is only available for pi SDK sessions.')
    }

    await this.disposeWorkspaceSession(workspaceRootDir)
    const record = await this.createWorkspaceSessionWithManager(
      workspaceRootDir,
      SessionManager.open(sessionFile, undefined, workspaceRootDir),
    )

    this.sessionsByWorkspaceRootDir.set(workspaceRootDir, record)
    this.emit({
      session: record.summary,
      type: 'session_created',
    })
    this.addTimelineItem(
      record,
      createLifecycleTimelineItem({
        detail: sessionFile,
        event: 'session_created',
        label: 'session resumed',
        status: 'completed',
      }),
    )
    return record.summary
  }

  private async createWorkspaceSessionWithManager(
    workspaceRootDir: string,
    sessionManager: SessionManager,
  ) {
    await this.settingsStore.applyConfiguredApiKeys()
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const sdkAuthStorage =
      settings.authMode === 'api_key'
        ? await this.createSdkAuthStorage()
        : undefined
    const sdkModelRegistry =
      sdkAuthStorage
        ? ModelRegistry.create(sdkAuthStorage, join(getAgentDir(), 'models.json'))
        : undefined
    const sdkModel =
      sdkModelRegistry
        ? resolveSdkModel(sdkModelRegistry, provider, settings.modelId)
        : null
    const hasProviderApiKey =
      settings.authMode === 'api_key' && sdkModel && sdkModelRegistry
        ? sdkModelRegistry.hasConfiguredAuth(sdkModel)
        : false
    const disabledReason =
      settings.authMode === 'api_key'
        ? resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
        : resolveDisabledReason(settings.authMode, provider, settings)
    const resolvedModelId =
      settings.authMode === 'brokered_oauth'
        ? settings.modelId
        : sdkModel?.id ?? settings.modelId
    const capabilities = resolveCapabilities(settings.authMode, disabledReason)

    if (disabledReason) {
      throw new Error(
        disabledReason ??
          'The workspace agent session is not currently available.',
      )
    }
    const summary: AgentSessionSummary = {
      authMode: settings.authMode,
      bootPromptEnabled: false,
      brokerSession: settings.brokerSession,
      capabilities,
      createdAt: new Date().toISOString(),
      hasProviderApiKey,
      id: `pi-session:${randomUUID()}`,
      lastError: undefined,
      modelId: resolvedModelId,
      provider,
      runState: 'ready',
      runtimeKind: resolveRuntimeKind(settings.authMode),
      transport: resolveTransportMode(settings.authMode),
      updatedAt: new Date().toISOString(),
      workspaceRootDir,
    }

    if (settings.authMode === 'api_key') {
      return this.createSdkSessionRecord({
        authStorage: sdkAuthStorage,
        modelRegistry: sdkModelRegistry,
        provider,
        sessionManager,
        settings,
        summary,
        workspaceRootDir,
      })
    }

    return this.createLegacySessionRecord({
      provider,
      settings,
      summary,
      workspaceRootDir,
    })
  }

  private async runNativeLayoutSuggestion(input: {
    input: LayoutSuggestionPayload
    provider: string
    querySession: ReturnType<typeof registerLayoutQuerySession>
    settings: AgentSettingsState
    workspaceRootDir: string
  }) {
    const model = resolveLegacyProviderModel(input.provider, input.settings.modelId)
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

  private createTransport(provider: string) {
    return new ProviderTransport({
      getApiKey: () => getApiKey(provider as KnownProvider),
    })
  }

  private async runBootPrompt(record: AgentSessionRecord, prompt: string) {
    record.summary = updateSessionSummary(record.summary, {
      runState: 'running',
      lastError: undefined,
    })

    try {
      this.logger.info(
        `[semanticode][pi] Running boot prompt for workspace ${record.workspaceRootDir}.`,
      )
      if (record.kind === 'sdk') {
        await record.session.prompt(prompt)
      } else {
        await record.agent.prompt(prompt)
      }
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

  private handleLegacyAgentEvent(
    sessionId: string,
    workspaceRootDir: string,
    event: PiAgentEvent,
  ) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record || record.kind !== 'legacy') {
      return
    }

    switch (event.type) {
      case 'agent_start':
        this.updateRecordSummary(record, {
          runState: 'running',
          lastError: undefined,
        })
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            event: 'agent_start',
            label: 'agent start',
            status: 'running',
          }),
        )
        break

      case 'turn_start':
        record.completedAssistantMessageId = null
        this.updateRecordSummary(record, {
          runState: 'running',
          lastError: undefined,
        })
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            event: 'turn_start',
            label: 'turn start',
            status: 'running',
          }),
        )
        break

      case 'message_start':
        this.updateRecordSummary(record, {
          runState: 'running',
          lastError: undefined,
        })
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          record.activeAssistantMessageId = `agent-message:${randomUUID()}`
          record.completedAssistantMessageId = null
          this.emitNormalizedMessage(record, event.message, true)
        }
        break

      case 'tool_execution_start':
        record.toolInvocationById.set(event.toolCallId, normalizeToolInvocation({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: new Date().toISOString(),
        }))
        this.logger.info(
          `[semanticode][pi] ${sessionId} tool start: ${event.toolName}`,
        )
        this.emit({
          type: 'tool',
          sessionId,
          invocation: record.toolInvocationById.get(event.toolCallId)!,
        })
        this.addTimelineItem(
          record,
          createToolTimelineItem(record.toolInvocationById.get(event.toolCallId)!),
        )
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
        if (
          event.type === 'turn_end' &&
          event.message.role === 'assistant' &&
          !record.completedAssistantMessageId
        ) {
          const normalizedMessage = this.emitNormalizedMessage(record, event.message, false)
          record.completedAssistantMessageId = normalizedMessage?.id ?? null
          record.activeAssistantMessageId = null
        }
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            counts:
              event.type === 'turn_end'
                ? { toolResults: event.toolResults.length }
                : undefined,
            event: event.type,
            label: event.type === 'turn_end' ? 'turn done' : 'agent done',
            status: 'completed',
          }),
        )
        break

      case 'message_end':
        if (event.message.role === 'assistant') {
          const normalizedMessage = this.emitNormalizedMessage(record, event.message, false)
          record.completedAssistantMessageId = normalizedMessage?.id ?? null
          record.activeAssistantMessageId = null
        }
        break
    }
  }

  private updateRecordSummary(
    record: AgentSessionRecord,
    changes: Partial<Pick<AgentSessionSummary, 'lastError' | 'runState'>>,
  ) {
    record.summary = updateSessionSummary(record.summary, changes)
    this.emit({
      type: 'session_updated',
      session: record.summary,
    })
  }

  private refreshSdkRecordFromRuntime(
    record: PiSdkAgentSessionRecord,
    nextSessionId: string,
  ) {
    record.unsubscribe()
    record.session = record.runtime.session
    record.activeAssistantMessageId = null
    record.completedAssistantMessageId = null
    record.promptSequence = 0
    record.toolInvocationById = new Map()
    record.messages = normalizeStoredSessionMessages(
      nextSessionId,
      record.session.state.messages as unknown[],
    )
    record.timeline = record.messages.flatMap(createMessageTimelineItems)
    record.summary = {
      ...record.summary,
      id: nextSessionId,
      lastError: undefined,
      modelId: record.session.model?.id ?? record.summary.modelId,
      provider: String(record.session.model?.provider ?? record.summary.provider),
      queue: {
        followUp: record.session.getFollowUpMessages().length,
        steering: record.session.getSteeringMessages().length,
      },
      runState: resolveSessionReadyState(record.summary),
      sessionFile: record.session.sessionFile,
      sessionName: record.session.sessionName,
      thinkingLevel: record.session.thinkingLevel,
      updatedAt: new Date().toISOString(),
    }
    record.unsubscribe = record.session.subscribe((event) => {
      this.handleSdkAgentEvent(record.summary.id, record.workspaceRootDir, event)
    })
    this.emitTimelineSnapshot(record)
  }

  private async createUnifiedModelControlOptions(
    record: AgentSessionRecord | null,
  ): Promise<AgentModelControlOption[]> {
    const models: AgentModelControlOption[] = CODEX_OPENAI_MODELS.map((id) => ({
      authMode: 'brokered_oauth',
      id,
      provider: 'openai',
    }))
    const modelRegistry = record?.kind === 'sdk'
      ? record.session.modelRegistry
      : ModelRegistry.create(
        await this.createSdkAuthStorage(),
        join(getAgentDir(), 'models.json'),
      )

    modelRegistry.refresh()

    models.push(...modelRegistry.getAvailable().map((model) => createModelControlOption(
      model,
      'api_key',
    )))

    return dedupeModelControlOptions(models)
  }

  private createControlState(
    record: AgentSessionRecord,
    models: AgentModelControlOption[],
  ): AgentControlState {
    if (record.kind !== 'sdk') {
      return {
        activeToolNames: [],
        availableThinkingLevels: [],
        commands: createSemanticodeControlCommands(record.summary),
        models,
        runtimeKind: record.summary.runtimeKind,
        sessionId: record.summary.id,
        tools: [],
      }
    }

    const activeToolNames = record.session.getActiveToolNames()
    const activeToolNameSet = new Set(activeToolNames)
    const sdkCommands = getSdkSlashCommands(record)
      .filter((command) => !isReservedSemanticodeControlName(command.name))
    const semanticodeCommands = createSemanticodeControlCommands(record.summary)

    return {
      activeToolNames,
      availableThinkingLevels: record.session.getAvailableThinkingLevels()
        .filter(isAgentThinkingLevel),
      commands: [
        ...sdkCommands,
        ...semanticodeCommands,
      ].sort((left, right) => left.name.localeCompare(right.name)),
      followUpMode: record.session.followUpMode,
      models,
      runtimeKind: record.summary.runtimeKind,
      sessionId: record.summary.id,
      steeringMode: record.session.steeringMode,
      tools: record.session.getAllTools()
        .map((tool) => createToolControlInfo(tool, activeToolNameSet))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }
  }

  private emitNormalizedMessage(
    record: AgentSessionRecord,
    message: Message | AssistantMessage,
    isStreaming: boolean,
  ): AgentMessage | null {
    const normalizedMessage = normalizeAgentMessage(
      record.summary.id,
      record.activeAssistantMessageId,
      message,
      isStreaming,
    )

    if (!normalizedMessage) {
      return null
    }

    this.emit({
      type: 'message',
      sessionId: record.summary.id,
      message: normalizedMessage,
    })
    record.messages = upsertNormalizedMessage(record.messages, normalizedMessage)
    this.addMessageTimelineItems(record, normalizedMessage)
    return normalizedMessage
  }

  private finishToolInvocation(
    record: AgentSessionRecord,
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
      resultPreview: summarizeTimelineValue(event.result),
    }

    record.toolInvocationById.set(event.toolCallId, completedInvocation)
    this.emit({
      type: 'tool',
      sessionId,
      invocation: completedInvocation,
    })
    this.addTimelineItem(record, createToolTimelineItem(completedInvocation))
  }

  private handleSdkAgentEvent(
    sessionId: string,
    workspaceRootDir: string,
    event: AgentSessionEvent,
  ) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record || record.kind !== 'sdk') {
      return
    }

    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
        record.completedAssistantMessageId = null
        this.updateRecordSummary(record, {
          runState: 'running',
          lastError: undefined,
        })
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            event: event.type,
            label: event.type === 'agent_start' ? 'agent start' : 'turn start',
            status: 'running',
          }),
        )
        break

      case 'message_start':
        if (event.message.role === 'assistant') {
          record.activeAssistantMessageId = `agent-message:${randomUUID()}`
          record.completedAssistantMessageId = null
        }
        this.emitNormalizedUnknownMessage(record, event.message, true)
        break

      case 'message_update':
        this.emitNormalizedUnknownMessage(record, event.message, true)
        break

      case 'message_end': {
        const normalizedMessage = this.emitNormalizedUnknownMessage(record, event.message, false)
        if (event.message.role === 'assistant') {
          record.completedAssistantMessageId = normalizedMessage?.id ?? null
          record.activeAssistantMessageId = null
        }
        break
      }

      case 'tool_execution_start': {
        const invocation = normalizeToolInvocation({
          args: event.args,
          startedAt: new Date().toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })

        record.toolInvocationById.set(event.toolCallId, invocation)
        this.emit({
          invocation,
          sessionId,
          type: 'tool',
        })
        this.addTimelineItem(record, createToolTimelineItem(invocation))
        break
      }

      case 'tool_execution_update': {
        const existingInvocation = record.toolInvocationById.get(event.toolCallId)

        if (!existingInvocation) {
          break
        }

        const updatedInvocation = {
          ...existingInvocation,
          resultPreview: summarizeTimelineValue(event.partialResult),
        }

        record.toolInvocationById.set(event.toolCallId, updatedInvocation)
        this.addTimelineItem(record, createToolTimelineItem(updatedInvocation))
        break
      }

      case 'tool_execution_end': {
        const existingInvocation = record.toolInvocationById.get(event.toolCallId)
        const completedInvocation = normalizeToolInvocation({
          args: existingInvocation?.args ?? {},
          endedAt: new Date().toISOString(),
          isError: event.isError,
          result: event.result,
          startedAt: existingInvocation?.startedAt,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        })

        record.toolInvocationById.set(event.toolCallId, completedInvocation)
        this.emit({
          invocation: completedInvocation,
          sessionId,
          type: 'tool',
        })
        this.addTimelineItem(record, createToolTimelineItem(completedInvocation))
        break
      }

      case 'turn_end': {
        const errorMessage = getAgentMessageErrorMessage(event.message)

        this.updateRecordSummary(record, {
          lastError: errorMessage,
          runState: resolveSessionReadyState(record.summary),
        })
        if (event.message.role !== 'assistant' || !record.completedAssistantMessageId) {
          const normalizedMessage = this.emitNormalizedUnknownMessage(record, event.message, false)
          if (event.message.role === 'assistant') {
            record.completedAssistantMessageId = normalizedMessage?.id ?? null
            record.activeAssistantMessageId = null
          }
        }
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            counts: { toolResults: event.toolResults.length },
            event: 'turn_end',
            label: 'turn done',
            status: errorMessage ? 'error' : 'completed',
          }),
        )
        break
      }

      case 'agent_end':
        this.updateRecordSummary(record, {
          runState: resolveSessionReadyState(record.summary),
        })
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            event: 'agent_end',
            label: 'agent done',
            status: 'completed',
          }),
        )
        break

      case 'queue_update':
        record.summary = {
          ...record.summary,
          queue: {
            followUp: event.followUp.length,
            steering: event.steering.length,
          },
          updatedAt: new Date().toISOString(),
        }
        this.emit({
          session: record.summary,
          type: 'session_updated',
        })
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            counts: {
              followUp: event.followUp.length,
              steering: event.steering.length,
            },
            event: 'queue_update',
            label: 'queue update',
            status: event.followUp.length + event.steering.length > 0 ? 'queued' : 'completed',
          }),
        )
        break

      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
        this.addTimelineItem(
          record,
          createLifecycleTimelineItem({
            detail: 'errorMessage' in event ? event.errorMessage : undefined,
            event: event.type,
            label: formatSdkLifecycleLabel(event),
            status: event.type.endsWith('_start')
              ? 'running'
              : 'success' in event && event.success === false
                ? 'error'
                : 'completed',
          }),
        )
        break
    }
  }

  private emitNormalizedUnknownMessage(
    record: AgentSessionRecord,
    message: unknown,
    isStreaming: boolean,
  ): AgentMessage | null {
    const normalizedMessage = normalizeUnknownAgentMessage(
      record.summary.id,
      record.activeAssistantMessageId,
      message,
      isStreaming,
    )

    if (!normalizedMessage) {
      return null
    }

    record.messages = upsertNormalizedMessage(record.messages, normalizedMessage)
    this.emit({
      message: normalizedMessage,
      sessionId: record.summary.id,
      type: 'message',
    })
    this.addMessageTimelineItems(record, normalizedMessage)
    return normalizedMessage
  }

  private addMessageTimelineItems(record: AgentSessionRecord, message: AgentMessage) {
    record.timeline = replaceMessageTimelineItems(record.timeline, message)

    for (const item of createMessageTimelineItems(message)) {
      this.emit({
        item,
        sessionId: record.summary.id,
        type: 'timeline',
      })
    }
    this.emitTimelineSnapshot(record)
  }

  private addTimelineItem(record: AgentSessionRecord, item: AgentTimelineItem) {
    record.timeline = upsertTimelineItem(record.timeline, item)
    this.emit({
      item,
      sessionId: record.summary.id,
      type: 'timeline',
    })
    this.emitTimelineSnapshot(record)
  }

  private emitTimelineSnapshot(record: AgentSessionRecord) {
    record.timelineRevision += 1
    this.emit({
      items: record.timeline,
      revision: record.timelineRevision,
      sessionId: record.summary.id,
      type: 'timeline_snapshot',
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

function formatSessionListItem(session: SessionInfo): AgentSessionListItem {
  return {
    createdAt: session.created.toISOString(),
    id: session.id,
    messageCount: session.messageCount,
    modifiedAt: session.modified.toISOString(),
    name: session.name,
    path: session.path,
    preview: session.firstMessage || session.allMessagesText.slice(0, 160),
  }
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

function resolveProvider(settings?: AgentSettingsState): string {
  const envProvider = process.env[PI_PROVIDER_ENV_NAME]?.trim()

  if (!envProvider) {
    return settings?.provider ?? DEFAULT_PI_PROVIDER
  }

  return envProvider
}

function createDisabledTransport() {
  return new ProviderTransport({
    getApiKey: () => undefined,
  })
}

function normalizeAgentPromptRequest(
  messageOrRequest: string | AgentPromptRequest,
  metadata: AgentPromptRequest['metadata'] | undefined,
  mode: AgentPromptRequest['mode'] | undefined,
): Required<Pick<AgentPromptRequest, 'message'>> &
  Pick<AgentPromptRequest, 'agentText' | 'contextInjection' | 'displayText' | 'metadata' | 'mode'> {
  if (typeof messageOrRequest === 'string') {
    return {
      displayText: messageOrRequest,
      message: messageOrRequest,
      metadata,
      mode,
    }
  }

  return {
    ...messageOrRequest,
    displayText: messageOrRequest.displayText ?? messageOrRequest.message,
    metadata: messageOrRequest.metadata ?? metadata,
    mode: messageOrRequest.mode ?? mode,
  }
}

function buildContextualAgentPrompt(contextInjection: string, displayText: string) {
  return [
    contextInjection,
    '',
    'User request:',
    displayText,
  ].join('\n')
}

function createSemanticodeContextExtension(
  takeContextInjection: () => string | undefined,
): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', () => {
      const contextInjection = takeContextInjection()?.trim()

      if (!contextInjection) {
        return undefined
      }

      return {
        message: {
          content: contextInjection,
          customType: 'semanticode-workspace-context',
          details: {
            source: 'semanticode',
          },
          display: false,
        },
      }
    })
  }
}

function createEmptyAgentControlState(): AgentControlState {
  return {
    activeToolNames: [],
    availableThinkingLevels: [],
    commands: [],
    models: [],
    sessionId: null,
    tools: [],
  }
}

function createSemanticodeControlCommands(
  summary: AgentSessionSummary,
): AgentControlState['commands'] {
  const capabilities = summary.capabilities ?? DISABLED_AGENT_CAPABILITIES
  const commands: AgentControlState['commands'] = [
    createSemanticodeControlCommand({
      description: 'Show the active session.',
      enabled: summary.runState !== 'disabled',
      name: 'session',
    }),
    createSemanticodeControlCommand({
      description: 'Show or change the active model.',
      enabled: summary.runState !== 'disabled',
      name: 'model',
    }),
    createSemanticodeControlCommand({
      description: 'Clear the visible pane transcript.',
      enabled: true,
      name: 'clear',
    }),
  ]

  if (capabilities.newSession) {
    commands.push(createSemanticodeControlCommand({
      description: 'Start a fresh workspace session.',
      enabled: true,
      name: 'new',
    }))
  }

  if (capabilities.resumeSession) {
    commands.push(createSemanticodeControlCommand({
      description: 'Resume a saved PI session.',
      enabled: true,
      name: 'resume',
    }))
  }

  if (capabilities.setThinkingLevel) {
    commands.push(createSemanticodeControlCommand({
      description: 'Show or change the SDK thinking level.',
      enabled: true,
      name: 'thinking',
    }))
  }

  if (capabilities.compact) {
    commands.push(createSemanticodeControlCommand({
      description: 'Run SDK conversation compaction.',
      enabled: true,
      name: 'compact',
    }))
  }

  if (summary.runtimeKind === 'pi-sdk') {
    commands.push(createSemanticodeControlCommand({
      description: 'Show or change SDK active tools.',
      enabled: true,
      name: 'tools',
    }))
  }

  return commands.sort((left, right) => left.name.localeCompare(right.name))
}

function createSemanticodeControlCommand(input: {
  description: string
  enabled: boolean
  name: string
}): AgentControlState['commands'][number] {
  return {
    available: true,
    description: input.description,
    enabled: input.enabled,
    name: input.name,
    source: 'semanticode',
  }
}

function isReservedSemanticodeControlName(commandName: string) {
  return (
    commandName === 'clear' ||
    commandName === 'compact' ||
    commandName === 'model' ||
    commandName === 'new' ||
    commandName === 'resume' ||
    commandName === 'session' ||
    commandName === 'thinking' ||
    commandName === 'tools'
  )
}

function getSdkSlashCommands(record: PiSdkAgentSessionRecord): AgentControlState['commands'] {
  const commands: AgentControlState['commands'] = []

  for (const command of record.session.extensionRunner?.getRegisteredCommands() ?? []) {
    commands.push(createSdkSlashCommand({
      description: command.description,
      name: command.invocationName,
      source: 'extension',
      sourceInfo: command.sourceInfo,
    }))
  }

  for (const template of record.session.promptTemplates) {
    commands.push(createSdkSlashCommand({
      description: template.description,
      name: template.name,
      source: 'prompt',
      sourceInfo: template.sourceInfo,
    }))
  }

  for (const skill of record.session.resourceLoader.getSkills().skills) {
    commands.push(createSdkSlashCommand({
      description: skill.description,
      name: `skill:${skill.name}`,
      source: 'skill',
      sourceInfo: skill.sourceInfo,
    }))
  }

  return dedupeAgentCommands(commands)
}

function createSdkSlashCommand(
  input: SlashCommandInfo,
): AgentControlState['commands'][number] {
  return {
    available: true,
    description: input.description,
    enabled: true,
    name: input.name,
    source: input.source,
    sourceInfo: normalizeAgentSourceInfo(input.sourceInfo),
  }
}

function dedupeAgentCommands(
  commands: AgentControlState['commands'],
): AgentControlState['commands'] {
  const seen = new Set<string>()
  const deduped: AgentControlState['commands'] = []

  for (const command of commands) {
    const key = `${command.source}:${command.name}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(command)
  }

  return deduped
}

function createToolControlInfo(
  tool: ToolInfo,
  activeToolNames: Set<string>,
): AgentToolControlInfo {
  return {
    active: activeToolNames.has(tool.name),
    description: tool.description,
    name: tool.name,
    sourceInfo: normalizeAgentSourceInfo(tool.sourceInfo),
  }
}

function createModelControlOption(
  model: { id: string; provider: unknown },
  authMode: AgentAuthMode,
): AgentModelControlOption {
  return {
    authMode,
    id: model.id,
    provider: String(model.provider),
  }
}

function dedupeModelControlOptions(
  models: AgentModelControlOption[],
): AgentModelControlOption[] {
  const seen = new Set<string>()
  const deduped: AgentModelControlOption[] = []

  for (const model of models) {
    const key = `${model.authMode}:${model.provider}/${model.id}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(model)
  }

  return deduped.sort((left, right) => {
    const leftRuntimeRank = left.authMode === 'brokered_oauth' ? 0 : 1
    const rightRuntimeRank = right.authMode === 'brokered_oauth' ? 0 : 1

    if (leftRuntimeRank !== rightRuntimeRank) {
      return leftRuntimeRank - rightRuntimeRank
    }

    return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`)
  })
}

function resolveModelSelectionAuthMode(
  input: AgentModelSelectionRequest,
  currentAuthMode: AgentAuthMode,
): AgentAuthMode {
  if (input.authMode) {
    return input.authMode
  }

  if (
    currentAuthMode === 'brokered_oauth' &&
    input.provider === 'openai' &&
    isCodexOpenAIModel(input.modelId)
  ) {
    return 'brokered_oauth'
  }

  return 'api_key'
}

function isCodexOpenAIModel(modelId: string) {
  return (CODEX_OPENAI_MODELS as readonly string[]).includes(modelId)
}

function isAgentThinkingLevel(
  value: string,
): value is NonNullable<AgentSessionSummary['thinkingLevel']> {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  )
}

function normalizeAgentSourceInfo(sourceInfo: unknown): AgentSourceInfo | undefined {
  if (!sourceInfo || typeof sourceInfo !== 'object') {
    return undefined
  }

  const info = sourceInfo as Record<string, unknown>

  return {
    baseDir: typeof info.baseDir === 'string' ? info.baseDir : undefined,
    origin: typeof info.origin === 'string' ? info.origin : undefined,
    path: typeof info.path === 'string' ? info.path : undefined,
    scope: typeof info.scope === 'string' ? info.scope : undefined,
    source: typeof info.source === 'string' ? info.source : undefined,
  }
}

function resolveRuntimeKind(authMode: AgentAuthMode): AgentSessionSummary['runtimeKind'] {
  return authMode === 'brokered_oauth' ? 'codex-subscription' : 'pi-sdk'
}

function resolveCapabilities(
  authMode: AgentAuthMode,
  disabledReason: string | undefined,
): WorkspaceAgentCapabilities {
  if (disabledReason) {
    return DISABLED_AGENT_CAPABILITIES
  }

  return authMode === 'brokered_oauth'
    ? CODEX_SUBSCRIPTION_AGENT_CAPABILITIES
    : PI_SDK_AGENT_CAPABILITIES
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
  provider: string,
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

  if (!getApiKey(provider as KnownProvider)) {
    return `No API key found for provider "${provider}".`
  }

  return undefined
}

function resolveSdkDisabledReason(
  provider: string,
  preferredModelId: string | undefined,
  model: PiRegistryModel | null,
  modelRegistry: ModelRegistry | undefined,
) {
  if (!model || !modelRegistry) {
    return preferredModelId
      ? `No pi SDK model "${provider}/${preferredModelId}" was found.`
      : `No pi SDK model is available for provider "${provider}".`
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    return `No API key found for provider "${provider}".`
  }

  return undefined
}

function resolveSdkModel(
  modelRegistry: ModelRegistry,
  provider: string,
  preferredModelId?: string,
): PiRegistryModel | null {
  const envModelId = process.env[PI_MODEL_ENV_NAME]?.trim()
  const desiredModelId = envModelId || preferredModelId

  if (desiredModelId) {
    const exactModel = modelRegistry.find(provider, desiredModelId)

    if (exactModel) {
      return exactModel
    }
  }

  return (
    modelRegistry.getAvailable().find((candidate) => String(candidate.provider) === provider) ??
    modelRegistry.getAll().find((candidate) => String(candidate.provider) === provider) ??
    null
  )
}

function resolveLegacyProviderModel(provider: string, preferredModelId?: string) {
  try {
    return resolveModel(provider as KnownProvider, preferredModelId)
  } catch {
    return resolveModel(DEFAULT_PI_PROVIDER as KnownProvider, DEFAULT_PI_MODEL_ID)
  }
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

function normalizeStoredSessionMessages(sessionId: string, messages: unknown[]) {
  return messages
    .map((message, index) =>
      normalizeUnknownAgentMessage(sessionId, null, message, false, index),
    )
    .filter((message): message is AgentMessage => Boolean(message))
}

function normalizeUnknownAgentMessage(
  sessionId: string,
  activeAssistantMessageId: string | null,
  rawMessage: unknown,
  isStreaming: boolean,
  index = 0,
): AgentMessage | null {
  if (!rawMessage || typeof rawMessage !== 'object') {
    return null
  }

  const message = rawMessage as {
    content?: unknown
    role?: string
    timestamp?: number
  }
  const role =
    message.role === 'user' ||
    message.role === 'assistant' ||
    message.role === 'tool' ||
    message.role === 'toolResult'
      ? message.role
      : null

  if (!role) {
    return null
  }

  const normalizedRole: AgentMessage['role'] =
    role === 'tool' || role === 'toolResult' ? 'tool' : role
  const createdAt = new Date(message.timestamp ?? Date.now()).toISOString()
  const id =
    normalizedRole === 'assistant'
      ? activeAssistantMessageId ?? `agent-message:${sessionId}:assistant:${index}`
      : `agent-message:${sessionId}:${normalizedRole}:${message.timestamp ?? index}`
  const blocks = normalizeMessageBlocks(message.content)

  return {
    blocks,
    createdAt,
    id,
    isStreaming,
    role: normalizedRole,
  }
}

function normalizeMessageBlocks(content: unknown): AgentMessage['blocks'] {
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content }]
  }

  if (!Array.isArray(content)) {
    return []
  }

  return content.reduce<AgentMessage['blocks']>((result, block) => {
    if (!block || typeof block !== 'object') {
      return result
    }

    const typedBlock = block as {
      text?: unknown
      thinking?: unknown
      type?: unknown
    }

    if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
      result.push({ kind: 'text', text: typedBlock.text })
    }

    if (typedBlock.type === 'thinking' && typeof typedBlock.thinking === 'string') {
      result.push({ kind: 'thinking', text: typedBlock.thinking })
    }

    return result
  }, [])
}

function getAgentMessageErrorMessage(message: unknown) {
  if (!message || typeof message !== 'object') {
    return undefined
  }

  const errorMessage = (message as { errorMessage?: unknown }).errorMessage

  return typeof errorMessage === 'string' && errorMessage.trim()
    ? errorMessage
    : undefined
}

function formatSdkLifecycleLabel(event: AgentSessionEvent) {
  switch (event.type) {
    case 'compaction_start':
      return `compaction start · ${event.reason}`
    case 'compaction_end':
      return `compaction done · ${event.reason}`
    case 'auto_retry_start':
      return `retry ${event.attempt}/${event.maxAttempts}`
    case 'auto_retry_end':
      return event.success ? `retry done · ${event.attempt}` : `retry failed · ${event.attempt}`
    default:
      return event.type.replaceAll('_', ' ')
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

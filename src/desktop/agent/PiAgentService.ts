import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  type OAuthCredential,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type SessionInfo,
  type SlashCommandInfo,
  type ToolDefinition,
  type ToolInfo,
} from '@mariozechner/pi-coding-agent'

import type {
  AgentAuthMode,
  AgentBrokerSessionSummary,
  AgentControlState,
  AgentEvent,
  AgentFileOperation,
  AgentFileOperationSource,
  AgentModelControlOption,
  AgentMessage,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
  AgentSourceInfo,
  AgentTimelineItem,
  AgentToolProfile,
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
import { CODEX_OPENAI_MODELS, CODEX_PROVIDER, PiAgentSettingsStore } from './PiAgentSettingsStore'
import { OpenAICodexProvider } from '../providers/openai-codex/provider'
import type {
  LayoutSuggestionPayload,
  LayoutSuggestionResponse,
} from '../../schema/api'
import {
  createSymbolQueryToolDefinitions,
} from '../agent-runtime/semanticodeSymbolTools'
import {
  createFileOperationsFromAgentMessage,
  createFileOperationsFromToolInvocation,
} from '../agent-runtime/agentFileOperations'
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
  DISABLED_AGENT_CAPABILITIES,
  PI_SDK_AGENT_CAPABILITIES,
  type WorkspaceAgentCapabilities,
} from '../agent-runtime/WorkspaceAgentRuntime'

const DEFAULT_PI_PROVIDER = 'openai'
const BOOT_PROMPT_ENV_NAME = 'SEMANTICODE_PI_BOOT_PROMPT'
const PI_PROVIDER_ENV_NAME = 'SEMANTICODE_PI_PROVIDER'
const PI_MODEL_ENV_NAME = 'SEMANTICODE_PI_MODEL'
const MAX_SESSION_FILE_OPERATIONS = 250
const STANDARD_SDK_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

type PiRegistryModel = ReturnType<ModelRegistry['getAll']>[number]

interface BaseAgentSessionRecord {
  activeAssistantMessageId: string | null
  capabilities: WorkspaceAgentCapabilities
  completedAssistantMessageId: string | null
  fileOperations: AgentFileOperation[]
  messages: AgentMessage[]
  summary: AgentSessionSummary
  timeline: AgentTimelineItem[]
  timelineRevision: number
  turnToolCallIds: Set<string>
  toolInvocationById: Map<string, AgentToolInvocation>
  toolProfile: AgentToolProfile
  promptSequence: number
  unsubscribe: () => void
  workspaceRootDir: string
}

interface DisabledPiAgentSessionRecord extends BaseAgentSessionRecord {
  kind: 'disabled'
}

interface PiSdkAgentSessionRecord extends BaseAgentSessionRecord {
  kind: 'sdk'
  pendingContextQueue: string[]
  runtime: AgentSessionRuntime
  session: AgentSession
}

type AgentSessionRecord = DisabledPiAgentSessionRecord | PiSdkAgentSessionRecord

function createTurnToolCounts(
  record: AgentSessionRecord,
  reportedToolResultCount: number,
) {
  const toolResults = Math.max(reportedToolResultCount, record.turnToolCallIds.size)

  return toolResults > 0 ? { toolResults } : undefined
}

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

    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const sdkAuthStorage = await this.createSdkAuthStorage(settings)
    const sdkModelRegistry = ModelRegistry.create(sdkAuthStorage, join(getAgentDir(), 'models.json'))
    const sdkModel = resolveSdkModel(sdkModelRegistry, provider, settings.modelId)
    const hasProviderApiKey =
      sdkModel && sdkModelRegistry
        ? sdkModelRegistry.hasConfiguredAuth(sdkModel)
        : false
    const bootPrompt = process.env[BOOT_PROMPT_ENV_NAME]?.trim() ?? ''
    const sessionTransport = resolveTransportMode()
    const disabledReason =
      settings.authMode === 'brokered_oauth'
        ? resolveDisabledReason(settings.authMode, provider, settings) ??
          resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
        : resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
    const resolvedModelId = sdkModel?.id ?? settings.modelId
    const runtimeKind = resolveRuntimeKind()
    const capabilities = resolveCapabilities(disabledReason)
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
      !disabledReason
        ? await this.createSdkSessionRecord({
            authStorage: sdkAuthStorage,
            modelRegistry: sdkModelRegistry,
            provider,
            settings,
            summary,
            workspaceRootDir,
          })
        : this.createDisabledSessionRecord({
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
      `[semanticode][pi] Created ${record.kind === 'sdk' ? 'SDK' : 'disabled'} workspace session ${record.summary.id} for ${workspaceRootDir} using ${record.summary.provider}/${record.summary.modelId}.`,
    )

    if (disabledReason) {
      this.logger.warn(
        `[semanticode][pi] ${summary.lastError}`,
      )
      return summary
    }

    if (record.kind === 'sdk' && bootPrompt.length > 0) {
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

  getWorkspaceFileOperations(workspaceRootDir: string) {
    return this.sessionsByWorkspaceRootDir.get(workspaceRootDir)?.fileOperations ?? []
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

  private async createSdkAuthStorage(settings?: AgentSettingsState) {
    const agentDir = getAgentDir()
    const authStorage = settings?.authMode === 'brokered_oauth'
      ? AuthStorage.inMemory()
      : AuthStorage.create(join(agentDir, 'auth.json'))
    const storedApiKeys = await this.settingsStore.getStoredApiKeys()

    for (const [provider, apiKey] of Object.entries(storedApiKeys)) {
      authStorage.setRuntimeApiKey(provider, apiKey)
    }

    if (settings?.authMode === 'brokered_oauth') {
      const credential = await this.openAICodexProvider.getPiOAuthCredential()

      if (credential) {
        authStorage.set(CODEX_PROVIDER, {
          type: 'oauth',
          ...credential,
        } satisfies OAuthCredential)
      }
    }

    return authStorage
  }

  private createDisabledSessionRecord(input: {
    settings: AgentSettingsState
    summary: AgentSessionSummary
    workspaceRootDir: string
  }): DisabledPiAgentSessionRecord {
    return {
      activeAssistantMessageId: null,
      capabilities: DISABLED_AGENT_CAPABILITIES,
      completedAssistantMessageId: null,
      fileOperations: [],
      kind: 'disabled',
      messages: [],
      promptSequence: 0,
      summary: {
        ...input.summary,
        capabilities: DISABLED_AGENT_CAPABILITIES,
        runtimeKind: resolveRuntimeKind(),
      },
      timeline: [],
      timelineRevision: 0,
      turnToolCallIds: new Set(),
      toolInvocationById: new Map(),
      toolProfile: input.settings.toolProfile,
      unsubscribe: () => undefined,
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
    const requestedSessionManager = input.sessionManager
    let sessionManager = requestedSessionManager ?? SessionManager.continueRecent(input.workspaceRootDir)

    if (
      !requestedSessionManager &&
      shouldStartFreshImplicitSessionForModel(
        sessionManager,
        input.provider,
        input.settings.modelId,
        input.settings.authMode,
      )
    ) {
      sessionManager = SessionManager.create(input.workspaceRootDir)
    }
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

      const toolProfile = input.settings.toolProfile
      const toolConfig = createSdkSessionToolConfig(cwd, toolProfile)

      return {
        ...(await createAgentSessionFromServices({
          model,
          services,
          sessionManager,
          sessionStartEvent,
          thinkingLevel: 'medium',
          customTools: toolConfig.customTools,
          tools: toolConfig.tools,
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
    const hydratedFileOperations = createFileOperationsFromMessages({
      messages: hydratedMessages,
      sessionId: input.summary.id,
      workspaceRootDir: input.workspaceRootDir,
    })
    const record: PiSdkAgentSessionRecord = {
      activeAssistantMessageId: null,
      capabilities: PI_SDK_AGENT_CAPABILITIES,
      completedAssistantMessageId: null,
      fileOperations: hydratedFileOperations,
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
      turnToolCallIds: new Set(),
      toolInvocationById: new Map(),
      toolProfile: input.settings.toolProfile,
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
    const now = new Date().toISOString()
    const startedAt = now
    const promptSequence = record.promptSequence + 1
    const existingToolCallIds = new Set(record.toolInvocationById.keys())

    record.promptSequence = promptSequence
    if (record.kind !== 'sdk') {
      throw new Error(
        record.summary.lastError ??
          `The workspace agent session is not available for "${record.summary.provider}".`,
      )
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
        `[semanticode][agent] Prompting PI session ${record.summary.id} with model ${record.summary.modelId}.`,
      )
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
    } catch (error) {
      if (queuedContextInjection) {
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
        toolProfile: record.toolProfile,
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
  ): Promise<LayoutSuggestionResponse> {
    await this.telemetryService?.ensureWorkspaceTelemetry(workspaceRootDir).catch(() => undefined)
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const disabledReason = resolveDisabledReason(settings.authMode, provider, settings)

    if (disabledReason) {
      throw new Error(disabledReason)
    }

    const executionPath = 'native_tools' as const
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
      await this.runSdkLayoutSuggestion({
        input,
        provider,
        querySession,
        settings,
        workspaceRootDir,
      })

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
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const disabledReason = resolveDisabledReason(settings.authMode, provider, settings)

    if (disabledReason) {
      throw new Error(disabledReason)
    }

    const result = await this.runTransientSdkPrompt({
      message: input.message,
      provider,
      rootDir: workspaceRootDir,
      settings,
      systemPrompt: input.systemPrompt ?? buildWorkspaceSystemPrompt(workspaceRootDir),
      toolProfile: settings.toolProfile,
    })

    await this.telemetryService?.recordInteractivePrompt({
      finishedAt: new Date().toISOString(),
      kind: input.telemetry?.kind ?? 'one_off_prompt',
      message: input.message,
      modelId: result.model.id,
      promptSequence: 1,
      provider: String(result.model.provider),
      rootDir: workspaceRootDir,
      scope: input.telemetry,
      sessionId: `one-off:${randomUUID()}`,
      startedAt: result.startedAt,
      toolProfile: settings.toolProfile,
      toolInvocations: result.toolInvocations,
    }).catch((error) => {
      this.logger.warn(
        `[semanticode][telemetry] Failed to write one-off telemetry: ${error instanceof Error ? error.message : error}`,
      )
    })

    return result.assistantText
  }

  async cancelWorkspaceSession(workspaceRootDir: string) {
    const record = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)

    if (!record) {
      return false
    }

    if (record.kind === 'sdk') {
      await record.session.abort().catch(() => undefined)
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
        if (!isCodexModelSelection(input.provider, input.modelId)) {
          throw new Error(`Codex subscription mode does not support ${input.provider}/${input.modelId}.`)
        }
      }

      await this.saveSettings({
        authMode: targetAuthMode,
        modelId: input.modelId,
        provider: targetAuthMode === 'brokered_oauth' ? CODEX_PROVIDER : input.provider,
      })

      return this.ensureWorkspaceSession(workspaceRootDir)
    }

    const targetAuthMode = resolveModelSelectionAuthMode(input, record.summary.authMode)

    if (targetAuthMode === 'brokered_oauth') {
      if (!isCodexModelSelection(input.provider, input.modelId)) {
        throw new Error(`Codex subscription mode does not support ${input.provider}/${input.modelId}.`)
      }

      await this.saveSettings({
        authMode: 'brokered_oauth',
        modelId: input.modelId,
        provider: CODEX_PROVIDER,
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
    const nextAuthMode: AgentAuthMode =
      String(model.provider) === CODEX_PROVIDER ? 'brokered_oauth' : 'api_key'

    await this.settingsStore.saveSettings({
      authMode: nextAuthMode,
      modelId: model.id,
      provider: String(model.provider),
    })
    record.summary = updateSessionSummary(
      {
        ...record.summary,
        authMode: nextAuthMode,
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

  async deleteWorkspaceSession(workspaceRootDir: string, sessionFile: string) {
    const sessions = await SessionManager.list(workspaceRootDir).catch(() => [])
    const sessionToDelete = sessions.find((entry) =>
      entry.path === sessionFile || entry.id === sessionFile,
    )

    if (!sessionToDelete) {
      throw new Error(`No saved pi session matched ${sessionFile}.`)
    }

    const existingRecord = this.sessionsByWorkspaceRootDir.get(workspaceRootDir)
    const deletingActiveSession =
      existingRecord?.kind === 'sdk' &&
      existingRecord.session.sessionFile === sessionToDelete.path

    if (deletingActiveSession && existingRecord.summary.runState === 'running') {
      throw new Error('Cannot delete the active session while the agent is running.')
    }

    await unlink(sessionToDelete.path).catch((error) => {
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return
      }

      throw error
    })

    if (!deletingActiveSession) {
      return existingRecord?.summary ?? null
    }

    existingRecord.summary = updateSessionSummary(existingRecord.summary, {
      lastError: undefined,
      runState: 'running',
    })
    this.emit({
      session: existingRecord.summary,
      type: 'session_updated',
    })

    try {
      await existingRecord.runtime.newSession()
      this.refreshSdkRecordFromRuntime(existingRecord, `pi-session:${randomUUID()}`)
      this.emit({
        session: existingRecord.summary,
        type: 'session_created',
      })
      this.addTimelineItem(
        existingRecord,
        createLifecycleTimelineItem({
          detail: sessionToDelete.name ?? sessionToDelete.path,
          event: 'session_created',
          label: 'session deleted',
          status: 'completed',
        }),
      )
      return existingRecord.summary
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start a fresh session.'

      existingRecord.summary = updateSessionSummary(existingRecord.summary, {
        lastError: message,
        runState: 'error',
      })
      this.emit({
        session: existingRecord.summary,
        type: 'session_updated',
      })
      this.addTimelineItem(
        existingRecord,
        createLifecycleTimelineItem({
          detail: message,
          event: 'error',
          label: 'session delete failed',
          status: 'error',
        }),
      )
      throw error
    }
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
    const settings = await this.getSettings()
    const provider = resolveProvider(settings)
    const sdkAuthStorage = await this.createSdkAuthStorage(settings)
    const sdkModelRegistry = ModelRegistry.create(sdkAuthStorage, join(getAgentDir(), 'models.json'))
    const sdkModel = resolveSdkModel(sdkModelRegistry, provider, settings.modelId)
    const hasProviderApiKey =
      sdkModel && sdkModelRegistry
        ? sdkModelRegistry.hasConfiguredAuth(sdkModel)
        : false
    const disabledReason =
      settings.authMode === 'brokered_oauth'
        ? resolveDisabledReason(settings.authMode, provider, settings) ??
          resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
        : resolveSdkDisabledReason(provider, settings.modelId, sdkModel, sdkModelRegistry)
    const resolvedModelId = sdkModel?.id ?? settings.modelId
    const capabilities = resolveCapabilities(disabledReason)

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
      runtimeKind: resolveRuntimeKind(),
      transport: resolveTransportMode(),
      updatedAt: new Date().toISOString(),
      workspaceRootDir,
    }

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

  private async runSdkLayoutSuggestion(input: {
    input: LayoutSuggestionPayload
    provider: string
    querySession: ReturnType<typeof registerLayoutQuerySession>
    settings: AgentSettingsState
    workspaceRootDir: string
  }) {
    const result = await this.runTransientSdkPrompt({
      message: buildLayoutSuggestionUserPrompt(input.input),
      provider: input.provider,
      requireAssistantText: false,
      rootDir: input.workspaceRootDir,
      settings: input.settings,
      systemPrompt: buildLayoutSuggestionSystemPrompt(),
      customTools: createLayoutQueryToolDefinitions(input.querySession),
    })

    await this.telemetryService?.recordInteractivePrompt({
      finishedAt: new Date().toISOString(),
      kind: 'layout_suggestion',
      message: input.input.prompt,
      modelId: result.model.id,
      promptSequence: 1,
      provider: String(result.model.provider),
      rootDir: input.workspaceRootDir,
      scope: {
        task: input.input.prompt,
      },
      sessionId: `layout-suggestion:${randomUUID()}`,
      startedAt: result.startedAt,
      toolInvocations: result.toolInvocations,
    }).catch((error) => {
      this.logger.warn(
        `[semanticode][telemetry] Failed to write layout suggestion telemetry: ${error instanceof Error ? error.message : error}`,
      )
    })
  }

  private async runTransientSdkPrompt(input: {
    customTools?: ToolDefinition[]
    message: string
    provider: string
    requireAssistantText?: boolean
    rootDir: string
    settings: AgentSettingsState
    systemPrompt?: string
    toolProfile?: AgentToolProfile
  }) {
    const startedAt = new Date().toISOString()
    const agentDir = getAgentDir()
    const authStorage = await this.createSdkAuthStorage(input.settings)
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, 'models.json'))
    const model = resolveSdkModel(modelRegistry, input.provider, input.settings.modelId)
    const disabledReason = resolveSdkDisabledReason(
      input.provider,
      input.settings.modelId,
      model,
      modelRegistry,
    )

    if (disabledReason || !model) {
      throw new Error(disabledReason ?? `No pi SDK model is available for provider "${input.provider}".`)
    }

    const settingsManager = SettingsManager.inMemory({
      defaultModel: model.id,
      defaultProvider: String(model.provider),
      defaultThinkingLevel: 'medium',
      retry: {
        enabled: true,
      },
    })
    const sessionManager = SessionManager.inMemory(input.rootDir)
    const extensionFactories = input.systemPrompt?.trim()
      ? [createStaticSystemPromptExtension(input.systemPrompt)]
      : []
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
          extensionFactories,
        },
        settingsManager,
      })
      const resolvedModel = resolveSdkModel(
        services.modelRegistry,
        input.provider,
        input.settings.modelId,
      )

      if (!resolvedModel) {
        throw new Error(`No pi SDK model is available for provider "${input.provider}".`)
      }

      const toolConfig = input.customTools
        ? {
            customTools: input.customTools,
            tools: input.customTools.map((tool) => tool.name),
          }
        : createSdkSessionToolConfig(cwd, input.toolProfile ?? input.settings.toolProfile)

      return {
        ...(await createAgentSessionFromServices({
          model: resolvedModel,
          services,
          sessionManager,
          sessionStartEvent,
          customTools: toolConfig.customTools,
          thinkingLevel: 'medium',
          tools: toolConfig.tools,
        })),
        diagnostics: services.diagnostics,
        services,
      }
    }
    const runtime = await createAgentSessionRuntime(createRuntime, {
      agentDir,
      cwd: input.rootDir,
      sessionManager,
    })
    let assistantText = ''
    const toolInvocationById = new Map<string, AgentToolInvocation>()
    const unsubscribe = runtime.session.subscribe((event) => {
      if (event.type === 'tool_execution_start') {
        toolInvocationById.set(event.toolCallId, normalizeToolInvocation({
          args: event.args,
          startedAt: new Date().toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }))
      }

      if (event.type === 'tool_execution_update') {
        const existingInvocation = toolInvocationById.get(event.toolCallId)

        if (existingInvocation) {
          toolInvocationById.set(event.toolCallId, {
            ...existingInvocation,
            resultPreview: summarizeTimelineValue(event.partialResult),
          })
        }
      }

      if (event.type === 'tool_execution_end') {
        const existingInvocation = toolInvocationById.get(event.toolCallId)

        toolInvocationById.set(event.toolCallId, normalizeToolInvocation({
          args: existingInvocation?.args ?? {},
          endedAt: new Date().toISOString(),
          isError: event.isError,
          result: event.result,
          startedAt: existingInvocation?.startedAt,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }))
      }

      if (
        (event.type === 'message_end' || event.type === 'turn_end') &&
        event.message.role === 'assistant'
      ) {
        const nextText = extractUnknownAssistantText(event.message)

        if (nextText) {
          assistantText = nextText
        }
      }
    })

    try {
      await runtime.session.prompt(input.message)

      if (input.requireAssistantText !== false && !assistantText.trim()) {
        throw new Error('The preprocessing prompt returned no assistant text.')
      }

      return {
        assistantText: assistantText.trim(),
        model,
        startedAt,
        toolInvocations: [...toolInvocationById.values()],
      }
    } finally {
      unsubscribe()
      await runtime.dispose().catch(() => undefined)
    }
  }

  private async runBootPrompt(record: PiSdkAgentSessionRecord, prompt: string) {
    record.summary = updateSessionSummary(record.summary, {
      runState: 'running',
      lastError: undefined,
    })

    try {
      this.logger.info(
        `[semanticode][pi] Running boot prompt for workspace ${record.workspaceRootDir}.`,
      )
      await record.session.prompt(prompt)
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
    record.turnToolCallIds = new Set()
    record.messages = normalizeStoredSessionMessages(
      nextSessionId,
      record.session.state.messages as unknown[],
    )
    record.fileOperations = createFileOperationsFromMessages({
      messages: record.messages,
      sessionId: nextSessionId,
      workspaceRootDir: record.workspaceRootDir,
    })
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
    const settings = await this.getSettings()
    const modelRegistry = record?.kind === 'sdk'
      ? record.session.modelRegistry
      : ModelRegistry.create(
        await this.createSdkAuthStorage(settings),
        join(getAgentDir(), 'models.json'),
      )

    modelRegistry.refresh()

    const brokeredModels = modelRegistry
      .getAll()
      .filter((model) => String(model.provider) === CODEX_PROVIDER)
    const models: AgentModelControlOption[] =
      (brokeredModels.length > 0
        ? brokeredModels.map((model) => createModelControlOption(model, 'brokered_oauth'))
        : CODEX_OPENAI_MODELS.map((id) => ({
            authMode: 'brokered_oauth' as const,
            id,
            provider: CODEX_PROVIDER,
          })))

    models.push(
      ...modelRegistry
        .getAvailable()
        .filter((model) => String(model.provider) !== CODEX_PROVIDER)
        .map((model) => createModelControlOption(model, 'api_key')),
    )

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

  private emitToolInvocation(
    record: AgentSessionRecord,
    sessionId: string,
    invocation: AgentToolInvocation,
  ) {
    this.emit({
      invocation,
      sessionId,
      type: 'tool',
    })
    this.emitFileOperationsForInvocation(record, sessionId, invocation)
  }

  private emitFileOperationsForInvocation(
    record: AgentSessionRecord,
    sessionId: string,
    invocation: AgentToolInvocation,
  ) {
    const operations = createFileOperationsFromToolInvocation({
      invocation,
      sessionId,
      source: getFileOperationSource(record),
      workspaceRootDir: record.workspaceRootDir,
    })

    for (const operation of operations) {
      record.fileOperations = upsertFileOperation(record.fileOperations, operation)
      this.emit({
        operation,
        sessionId,
        type: 'file_operation',
      })
    }
  }

  private emitFileOperationsForMessage(
    record: AgentSessionRecord,
    message: AgentMessage,
  ) {
    const operations = createFileOperationsFromAgentMessage({
      message,
      sessionId: record.summary.id,
      workspaceRootDir: record.workspaceRootDir,
    })

    for (const operation of operations) {
      record.fileOperations = upsertFileOperation(record.fileOperations, operation)
      this.emit({
        operation,
        sessionId: record.summary.id,
        type: 'file_operation',
      })
    }
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
        record.turnToolCallIds = new Set()
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
        record.turnToolCallIds.add(event.toolCallId)
        this.emitToolInvocation(record, sessionId, invocation)
        this.addTimelineItem(record, createToolTimelineItem(invocation))
        break
      }

      case 'tool_execution_update': {
        record.turnToolCallIds.add(event.toolCallId)
        const existingInvocation = record.toolInvocationById.get(event.toolCallId)

        if (!existingInvocation) {
          break
        }

        const updatedInvocation = {
          ...existingInvocation,
          resultPreview: summarizeTimelineValue(event.partialResult),
        }

        record.toolInvocationById.set(event.toolCallId, updatedInvocation)
        this.emitFileOperationsForInvocation(record, sessionId, updatedInvocation)
        this.addTimelineItem(record, createToolTimelineItem(updatedInvocation))
        break
      }

      case 'tool_execution_end': {
        record.turnToolCallIds.add(event.toolCallId)
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
        this.emitToolInvocation(record, sessionId, completedInvocation)
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
            counts: createTurnToolCounts(record, event.toolResults.length),
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
    this.emitFileOperationsForMessage(record, normalizedMessage)
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

function upsertFileOperation(
  operations: AgentFileOperation[],
  nextOperation: AgentFileOperation,
) {
  const existingIndex = operations.findIndex(
    (operation) => operation.id === nextOperation.id,
  )
  const nextOperations =
    existingIndex === -1
      ? [nextOperation, ...operations]
      : operations.map((operation, index) =>
          index === existingIndex ? nextOperation : operation,
        )

  return nextOperations
    .sort(compareFileOperationsDescending)
    .slice(0, MAX_SESSION_FILE_OPERATIONS)
}

function createFileOperationsFromMessages(input: {
  messages: AgentMessage[]
  sessionId: string
  workspaceRootDir: string
}) {
  return input.messages
    .flatMap((message) =>
      createFileOperationsFromAgentMessage({
        message,
        sessionId: input.sessionId,
        workspaceRootDir: input.workspaceRootDir,
      }),
    )
    .reduce<AgentFileOperation[]>(
      (operations, operation) => upsertFileOperation(operations, operation),
      [],
    )
}

function compareFileOperationsDescending(
  left: AgentFileOperation,
  right: AgentFileOperation,
) {
  const leftTimestampMs = new Date(left.timestamp).getTime()
  const rightTimestampMs = new Date(right.timestamp).getTime()

  if (Number.isFinite(leftTimestampMs) && Number.isFinite(rightTimestampMs)) {
    return rightTimestampMs - leftTimestampMs
  }

  return right.id.localeCompare(left.id)
}

function getFileOperationSource(record: AgentSessionRecord): AgentFileOperationSource {
  if (record.kind === 'sdk') {
    return 'pi-sdk'
  }

  return 'agent-tool'
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

function createLayoutQueryToolDefinitions(
  querySession: ReturnType<typeof registerLayoutQuerySession>,
): ToolDefinition[] {
  return [
    createLayoutQueryToolDefinition(
      'getWorkspaceSummary',
      'Get compact workspace counts, available facets/tags, top directories, and existing layout summaries.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'findNodes',
      'Find compact node references using filters like kind, symbolKind, facet, tag, pathPrefix, pathContains, nameContains, nameRegex, LOC range, degree range, and limit.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'getNodes',
      'Get compact node references for explicit nodeIds.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'getNeighborhood',
      'Expand a bounded graph neighborhood from seedNodeIds using optional edgeKinds, direction, depth, and limit.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'summarizeScope',
      'Summarize nodes matched by a selector and return counts plus representative nodes.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'previewHybridLayout',
      'Validate a hybrid layout proposal without saving it.',
      querySession,
    ),
    createLayoutQueryToolDefinition(
      'createLayoutDraft',
      'Create and save the final draft from a hybrid layout proposal. This must be called to complete layout generation.',
      querySession,
    ),
  ]
}

function createLayoutQueryToolDefinition(
  operation: string,
  description: string,
  querySession: ReturnType<typeof registerLayoutQuerySession>,
): ToolDefinition {
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
    promptGuidelines: [
      'For layout work, use the compact Semanticode layout query tools instead of reading or dumping the full snapshot.',
      'Finish layout generation by calling createLayoutDraft.',
    ],
    promptSnippet: description,
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

function createStaticSystemPromptExtension(systemPrompt: string): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', () => ({
      systemPrompt,
    }))
  }
}

function extractUnknownAssistantText(message: unknown) {
  if (!message || typeof message !== 'object') {
    return ''
  }

  const content = (message as { content?: unknown }).content

  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .flatMap((block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? [(block as { text: string }).text]
        : [],
    )
    .join('\n')
    .trim()
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
    isCodexModelSelection(input.provider, input.modelId)
  ) {
    return 'brokered_oauth'
  }

  return 'api_key'
}

function isCodexModelSelection(provider: string, modelId: string) {
  return (provider === CODEX_PROVIDER || provider === 'openai') && isCodexOpenAIModel(modelId)
}

function isCodexOpenAIModel(modelId: string) {
  return (CODEX_OPENAI_MODELS as readonly string[]).includes(modelId)
}

function shouldStartFreshImplicitSessionForModel(
  sessionManager: SessionManager,
  provider: string,
  modelId: string,
  authMode: AgentAuthMode,
) {
  if (authMode !== 'brokered_oauth') {
    return false
  }

  const messages = sessionManager.buildSessionContext().messages as Array<{
    model?: string
    provider?: string
    role?: string
  }>

  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.provider !== provider || message.model !== modelId),
  )
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

function resolveRuntimeKind(): AgentSessionSummary['runtimeKind'] {
  return 'pi-sdk'
}

function resolveCapabilities(
  disabledReason: string | undefined,
): WorkspaceAgentCapabilities {
  if (disabledReason) {
    return DISABLED_AGENT_CAPABILITIES
  }

  return PI_SDK_AGENT_CAPABILITIES
}

function resolveTransportMode(): AgentSessionSummary['transport'] {
  return 'provider'
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
    if (provider !== CODEX_PROVIDER) {
      return 'OpenAI Codex auth currently only supports the openai-codex provider.'
    }

    if (settings.brokerSession.state === 'signed_out') {
      return 'OpenAI Codex auth is selected, but you are not signed in yet.'
    }

    if (settings.brokerSession.state === 'authenticated') {
      return undefined
    }

    return 'OpenAI Codex sign-in is in progress.'
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
    if (provider === CODEX_PROVIDER) {
      return 'OpenAI Codex auth is selected, but no usable OAuth token was found.'
    }

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

function createSdkSessionToolConfig(cwd: string, toolProfile: AgentToolProfile) {
  const customTools = createSymbolQueryToolDefinitions(cwd)
  const customToolNames = customTools.map((tool) => tool.name)

  return {
    customTools,
    tools: toolProfile === 'symbol_first'
      ? customToolNames
      : [...customToolNames, ...STANDARD_SDK_TOOL_NAMES],
  }
}

function buildWorkspaceSystemPrompt(workspaceRootDir: string) {
  return [
    'You are embedded inside Semanticode, a desktop code exploration and editing environment.',
    `The active workspace root is: ${workspaceRootDir}`,
    'Prefer reasoning about the active repository and use tools rather than making assumptions about the workspace state.',
    'When symbol query tools are available, use getSymbolWorkspaceSummary, findSymbols, getSymbolOutline, getSymbolNeighborhood, and readSymbolSlice before broad file reads.',
    'For single-symbol edits, call readSymbolSlice first and then use replaceSymbolRange with the returned sliceHash as expectedSliceHash.',
    'Use readFileWindow and replaceFileWindow as bounded fallbacks for imports, module headers, configs, tests, multi-symbol edits, or other code that cannot be represented as one symbol, and always include a reason.',
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

function hasNodeErrorCode(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
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

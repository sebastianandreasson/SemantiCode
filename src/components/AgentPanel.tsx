import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../agent/DesktopAgentClient'
import type {
  AgentAuthMode,
  AgentCommandInfo,
  AgentControlState,
  AgentEvent,
  AgentMessage,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentSettingsState,
  AgentTimelineItem,
} from '../schema/agent'
import type {
  CodebaseFile,
  PreprocessedWorkspaceContext,
  ProjectNode,
  SemanticPurposeSummaryRecord,
  SourceRange,
  SymbolNode,
  WorkingSetState,
  WorkspaceProfile,
} from '../types'

const MAX_VISIBLE_CONTEXT_FILES = 6
const MAX_VISIBLE_PURPOSE_SUMMARIES = 8
const MODEL_MENU_GAP_PX = 4
const MODEL_MENU_MARGIN_PX = 8
const MODEL_MENU_MAX_HEIGHT_PX = 384
const MODEL_MENU_MIN_WIDTH_PX = 288
const MODEL_MENU_MIN_COMFORTABLE_HEIGHT_PX = 180

export interface AgentScopeContext {
  file: CodebaseFile | null
  files: CodebaseFile[]
  node: ProjectNode | null
  symbol: SymbolNode | null
  symbols: SymbolNode[]
}

interface AgentPanelProps {
  autoFocusComposer?: boolean
  composerFocusRequestKey?: number
  desktopHostAvailable?: boolean
  inspectorContext?: AgentScopeContext
  onOpenSettings?: () => void
  onRunSettled?: () => Promise<void>
  onAdoptInspectorContextAsWorkingSet?: () => void
  onClearWorkingSet?: () => void
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  promptSeed?: {
    id: string
    value: string
  } | null
  settingsOnly?: boolean
  workingSet?: WorkingSetState | null
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export function AgentPanel({
  autoFocusComposer = false,
  composerFocusRequestKey = 0,
  desktopHostAvailable = false,
  inspectorContext,
  onOpenSettings,
  onRunSettled,
  onAdoptInspectorContextAsWorkingSet,
  onClearWorkingSet,
  preprocessedWorkspaceContext = null,
  promptSeed = null,
  settingsOnly = false,
  workingSet = null,
  workingSetContext = null,
  workspaceProfile = null,
}: AgentPanelProps) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [bridgeInfo, setBridgeInfo] = useState<DesktopAgentBridgeInfo>(() =>
    normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable),
  )
  const [composerState, setComposerState] = useState<{
    seedId: string | null
    value: string
  }>({
    seedId: null,
    value: '',
  })
  const [, setMessages] = useState<AgentMessage[]>([])
  const [timeline, setTimeline] = useState<AgentTimelineItem[]>([])
  const [, setSessions] = useState<AgentSessionListItem[]>([])
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
  const [controls, setControls] = useState<AgentControlState | null>(null)
  const [settings, setSettings] = useState<AgentSettingsState | null>(null)
  const [authModeValue, setAuthModeValue] = useState<AgentAuthMode>('brokered_oauth')
  const [providerValue, setProviderValue] = useState('')
  const [modelValue, setModelValue] = useState('')
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [manualRedirectUrlValue, setManualRedirectUrlValue] = useState('')
  const [openAiOAuthClientIdValue, setOpenAiOAuthClientIdValue] = useState('')
  const [openAiOAuthClientSecretValue, setOpenAiOAuthClientSecretValue] = useState('')
  const [settingsDraftDirty, setSettingsDraftDirty] = useState(false)
  const [openAiOAuthClientIdDirty, setOpenAiOAuthClientIdDirty] = useState(false)
  const [, setOpenAiOAuthClientSecretDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [settingsPending, setSettingsPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [oauthStatusMessage, setOauthStatusMessage] = useState<string | null>(null)
  const [oauthLoginUrl, setOauthLoginUrl] = useState<string | null>(null)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const sessionRef = useRef<AgentSessionSummary | null>(null)
  const controlsRef = useRef<AgentControlState | null>(null)
  const previousRunStateRef = useRef<AgentSessionSummary['runState'] | null>(null)
  const shouldStickToTimelineBottomRef = useRef(true)
  const composerValue =
    promptSeed && promptSeed.id !== composerState.seedId
      ? promptSeed.value
      : composerState.value
  const displayTimeline = timeline

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    controlsRef.current = controls
  }, [controls])

  useEffect(() => {
    const previousRunState = previousRunStateRef.current
    const nextRunState = session?.runState ?? null

    if (
      previousRunState === 'running' &&
      nextRunState !== 'running' &&
      onRunSettled
    ) {
      void onRunSettled().catch((error) => {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Failed to refresh the repository after the agent run.',
        )
      })
    }

    previousRunStateRef.current = nextRunState
  }, [onRunSettled, session?.runState])

  useEffect(() => {
    const updateBridgeInfo = () => {
      const nextBridgeInfo = normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable)

      setBridgeInfo((currentBridgeInfo) =>
        areBridgeInfoEqual(currentBridgeInfo, nextBridgeInfo)
          ? currentBridgeInfo
          : nextBridgeInfo,
      )
    }

    updateBridgeInfo()
    const timeoutId = window.setTimeout(updateBridgeInfo, 0)
    const intervalId = window.setInterval(updateBridgeInfo, 750)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [agentClient, desktopHostAvailable])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: () => void = () => {}
    let intervalId = 0

    const syncSettings = async () => {
      try {
        const nextSettings = await agentClient.getSettings()

        if (cancelled) {
          return
        }

        setSettings(nextSettings)

        if (!settingsDraftDirty) {
          setAuthModeValue(nextSettings.authMode)
          setProviderValue(nextSettings.provider)
          setModelValue(nextSettings.modelId)
          setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
        }

        const currentSession = sessionRef.current
        const brokerJustBecameRunnable =
          nextSettings.authMode === 'brokered_oauth' &&
          nextSettings.brokerSession.state === 'authenticated' &&
          (
            !currentSession ||
            currentSession.authMode !== 'brokered_oauth' ||
            currentSession.brokerSession?.state !== 'authenticated' ||
            currentSession.runState === 'disabled' ||
            currentSession.runState === 'error'
          )
        const sdkSessionShouldStart =
          nextSettings.authMode === 'api_key' &&
          (
            !currentSession ||
            currentSession.authMode !== 'api_key' ||
            currentSession.provider !== nextSettings.provider ||
            currentSession.modelId !== nextSettings.modelId
          )

        if (brokerJustBecameRunnable || sdkSessionShouldStart) {
          const nextSession = await agentClient.createSession()

          if (cancelled) {
            return
          }

          setSession(nextSession)

          const nextState = await agentClient.getHttpState()

          if (cancelled) {
            return
          }

          setSession(nextState.session)
          setMessages(nextState.messages)
          setTimeline(nextState.timeline ?? [])
        }
      } catch (error) {
        if (cancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to read the agent settings.',
        )
      }
    }

    const syncHttpState = async () => {
      try {
        const state = await agentClient.getHttpState()

        if (cancelled || !state) {
          return
        }

        setSession(state.session)
        setMessages(state.messages)
        setTimeline(state.timeline ?? [])
      } catch (error) {
        if (cancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to read the agent state.',
        )
      }
    }

    const syncControls = async () => {
      try {
        const nextControls = await agentClient.getControls()

        if (cancelled) {
          return
        }

        controlsRef.current = nextControls
        setControls(nextControls)
      } catch {
        if (!cancelled) {
          controlsRef.current = null
          setControls(null)
        }
      }
    }

    const syncAll = async () => {
      await syncSettings()

      if (cancelled) {
        return
      }

      await syncHttpState()

      if (cancelled) {
        return
      }

      await syncControls()
    }

    if (bridgeInfo.hasAgentBridge) {
      unsubscribe = agentClient.subscribe((event) => {
        if (cancelled) {
          return
        }

        handleAgentEvent(event, sessionRef, setMessages, setTimeline, setSession)

        if (event.type === 'session_created' || event.type === 'session_updated') {
          void syncControls()
        }
      })
    }

    if (!bridgeInfo.hasAgentBridge) {
      intervalId = window.setInterval(() => {
        void syncAll()
      }, 1000)
    }

    void syncAll()

    return () => {
      cancelled = true
      unsubscribe()
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [agentClient, bridgeInfo.hasAgentBridge, openAiOAuthClientIdDirty, settingsDraftDirty])

  useEffect(() => {
    if (!settings || !providerValue) {
      return
    }

    const availableModels = getSelectableModels(settings, authModeValue, providerValue)

    if (availableModels.some((model) => model.id === modelValue)) {
      return
    }

    setModelValue(availableModels[0]?.id ?? '')
  }, [authModeValue, modelValue, providerValue, settings])

  useEffect(() => {
    if (authModeValue === 'brokered_oauth' && providerValue && providerValue !== 'openai') {
      setProviderValue('openai')
    }
  }, [authModeValue, providerValue])

  useEffect(() => {
    const listElement = messageListRef.current

    if (!listElement || !shouldStickToTimelineBottomRef.current) {
      return
    }

    listElement.scrollTop = listElement.scrollHeight
  }, [displayTimeline])

  useEffect(() => {
    if (!promptSeed) {
      return
    }

    window.setTimeout(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(
        promptSeed.value.length,
        promptSeed.value.length,
      )
    }, 0)
  }, [promptSeed])

  useEffect(() => {
    if (settingsOnly) {
      return
    }

    window.setTimeout(() => {
      composerRef.current?.focus()
    }, 0)
  }, [composerFocusRequestKey, settingsOnly])

  const sessionIsInteractive =
    session?.runState === 'ready' || session?.runState === 'running'
  const sessionControls =
    controls && (!controls.sessionId || controls.sessionId === session?.id)
      ? controls
      : null
  const sessionCapabilities = getSessionCapabilities(session)
  const commandSuggestions = getCommandSuggestions(composerValue, sessionControls)
  const terminalModelOptions = getAvailableAgentModelOptions({
    authMode: authModeValue,
    controls: sessionControls,
    provider: providerValue,
    session,
    settings,
  })
  const selectedModelKey = createAgentModelKey({
    authMode: session?.authMode ?? authModeValue,
    id: session?.modelId ?? modelValue,
    provider: session?.provider ?? providerValue,
  })

  useEffect(() => {
    if (!autoFocusComposer || settingsOnly || !sessionIsInteractive) {
      return
    }

    window.setTimeout(() => {
      composerRef.current?.focus()
    }, 0)
  }, [autoFocusComposer, sessionIsInteractive, settingsOnly])

  async function handleSubmit(mode: 'send' | 'steer' | 'follow_up' = 'send') {
    const nextPrompt = composerValue.trim()

    if (!nextPrompt || pending) {
      return
    }

    if (!getSessionCapabilities(sessionRef.current).prompt) {
      setErrorMessage('Prompting is not available for the current agent runtime.')
      return
    }

    try {
      setPending(true)
      setErrorMessage(null)
      shouldStickToTimelineBottomRef.current = true

      if (await handleLocalCommand(nextPrompt)) {
        setComposerState({
          seedId: promptSeed?.id ?? composerState.seedId,
          value: '',
        })
        return
      }

      await persistSettingsDraftIfNeeded()
      const contextInjection = buildWorkspaceContextInjection(
        workspaceProfile,
        preprocessedWorkspaceContext,
        workingSetContext,
        inspectorContext,
      )
      const ok = await agentClient.sendMessage(
        {
          contextInjection,
          displayText: nextPrompt,
          message: nextPrompt,
          metadata: buildAgentPromptMetadata(
            nextPrompt,
            workingSetContext,
            inspectorContext,
          ),
          mode,
        },
      )

      if (!ok) {
        throw new Error('No active desktop agent session is available.')
      }

      setComposerState({
        seedId: promptSeed?.id ?? composerState.seedId,
        value: '',
      })
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to send the prompt to the agent.',
      )
    } finally {
      setPending(false)
    }
  }

  async function switchAgentModel(input: {
    authMode?: AgentAuthMode
    modelId: string
    provider: string
  }) {
    const nextSession = await agentClient.setModel(input)
    let state = await agentClient.getHttpState()
    let resolvedSession = nextSession ?? state.session

    if (!resolvedSession) {
      const createdSession = await agentClient.createSession()
      state = await agentClient.getHttpState()
      resolvedSession = createdSession ?? state.session
    }

    const nextControls = await agentClient.getControls().catch(() => null)
    const nextSettings = await agentClient.getSettings().catch(() => null)

    if (nextControls) {
      controlsRef.current = nextControls
      setControls(nextControls)
    }

    if (nextSettings) {
      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setModelValue(nextSettings.modelId)
      setProviderValue(nextSettings.provider)
    } else {
      if (input.authMode) {
        setAuthModeValue(input.authMode)
      }
      setModelValue(input.modelId)
      setProviderValue(input.provider)
    }

    setSession(resolvedSession)
    setMessages(state.messages)
    setTimeline(state.timeline ?? [])
    appendLocalLifecycle(
      'model changed',
      formatAgentModelOption({
        authMode: input.authMode ?? nextSettings?.authMode ?? 'api_key',
        id: input.modelId,
        provider: input.provider,
      }),
      'completed',
    )
  }

  async function handleTerminalModelChange(nextModelKey: string) {
    if (!nextModelKey || nextModelKey === selectedModelKey || pending) {
      return
    }

    const nextModel = parseAgentModelKey(nextModelKey)

    if (!nextModel) {
      return
    }

    try {
      setPending(true)
      setErrorMessage(null)
      await switchAgentModel(nextModel)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to switch the agent model.',
      )
    } finally {
      setPending(false)
    }
  }

  function handleTimelineScroll() {
    const listElement = messageListRef.current

    if (!listElement) {
      return
    }

    shouldStickToTimelineBottomRef.current = isTimelineScrolledNearBottom(listElement)
  }

  async function handleLocalCommand(command: string) {
    if (!command.startsWith('/')) {
      return false
    }

    const [commandName, ...commandArgs] = command.slice(1).trim().split(/\s+/)
    const commandValue = commandArgs.join(' ').trim()
    const capabilities = getSessionCapabilities(sessionRef.current)
    const controlState = controlsRef.current
    const sdkCommand = controlState?.commands.find(
      (entry) => entry.name === commandName && entry.source !== 'semanticode',
    )

    if (sdkCommand && !isSemanticodeLocalCommand(commandName)) {
      return false
    }

    if (commandName === 'new') {
      if (!capabilities.newSession) {
        appendLocalLifecycle('new failed', 'New sessions are not available for the current agent runtime.', 'error')
        return true
      }

      const nextSession = await agentClient.newSession()
      const state = await agentClient.getHttpState()
      const nextControls = await agentClient.getControls().catch(() => null)

      if (nextControls) {
        controlsRef.current = nextControls
        setControls(nextControls)
      }
      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'resume') {
      if (!capabilities.resumeSession) {
        appendLocalLifecycle('resume failed', 'Resume is only available for pi SDK sessions.', 'error')
        return true
      }

      const result = await agentClient.listSessions()
      const latestSession = commandValue
        ? result.sessions.find((entry) => entry.path === commandValue || entry.id === commandValue)
        : result.sessions[0]

      setSessions(result.sessions)

      if (!latestSession) {
        appendLocalLifecycle(
          'resume failed',
          commandValue
            ? `No pi session matched ${commandValue}.`
            : 'No previous pi session was found for this workspace.',
          'error',
        )
        return true
      }

      const nextSession = await agentClient.resumeSession(latestSession.path)
      const state = await agentClient.getHttpState()
      const nextControls = await agentClient.getControls().catch(() => null)

      if (nextControls) {
        controlsRef.current = nextControls
        setControls(nextControls)
      }
      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'session') {
      const result = await agentClient.listSessions()
      setSessions(result.sessions)
      appendLocalLifecycle(
        'session',
        session?.sessionFile
          ? `${session.sessionName ?? session.id} · ${session.sessionFile} · ${result.sessions.length} saved`
          : `${session?.id ?? 'none'} · ${result.sessions.length} saved`,
        'completed',
      )
      return true
    }

    if (commandName === 'model') {
      const availableModels = getAvailableAgentModelOptions({
        authMode: authModeValue,
        controls: controlState,
        provider: providerValue,
        session,
        settings,
      })

      if (!commandValue) {
        appendLocalLifecycle(
          'model',
          session
            ? [
                `${session.provider}/${session.modelId}`,
                availableModels.length > 1
                  ? `available: ${availableModels.map(formatAgentModelOption).join(', ')}`
                  : '',
              ].filter(Boolean).join(' · ')
            : 'No active session.',
          'completed',
        )
        return true
      }

      const modelSelection = resolveAgentModelSelection(commandValue, {
        availableModels,
        provider: providerValue,
        session,
      })

      if (!modelSelection) {
        appendLocalLifecycle(
          'model failed',
          `Unknown model ${commandValue}. Available: ${availableModels.map(formatAgentModelOption).join(', ')}`,
          'error',
        )
        return true
      }

      await switchAgentModel(modelSelection)
      return true
    }

    if (commandName === 'thinking') {
      if (!capabilities.setThinkingLevel) {
        appendLocalLifecycle('thinking unavailable', 'Thinking level changes are only available for pi SDK sessions.', 'error')
        return true
      }

      if (!commandValue) {
        const availableLevels = controlState?.availableThinkingLevels ?? []
        appendLocalLifecycle(
          'thinking',
          [
            `Current: ${session?.thinkingLevel ?? 'medium'}`,
            availableLevels.length ? `available: ${availableLevels.join(', ')}` : '',
          ].filter(Boolean).join(' · '),
          'completed',
        )
        return true
      }

      if (!isAgentThinkingLevel(commandValue)) {
        appendLocalLifecycle(
          'thinking failed',
          `Unknown level ${commandValue}. Use off, minimal, low, medium, high, or xhigh.`,
          'error',
        )
        return true
      }

      const nextSession = await agentClient.setThinkingLevel(commandValue)
      const state = await agentClient.getHttpState()
      const nextControls = await agentClient.getControls().catch(() => null)

      if (nextControls) {
        controlsRef.current = nextControls
        setControls(nextControls)
      }
      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'tools') {
      if (sessionRef.current?.runtimeKind !== 'pi-sdk') {
        appendLocalLifecycle('tools unavailable', 'Tool controls are only available for pi SDK sessions.', 'error')
        return true
      }

      if (!controlState?.tools.length) {
        appendLocalLifecycle('tools unavailable', 'No SDK tools are loaded for this session yet.', 'error')
        return true
      }

      if (!commandValue) {
        const activeTools = controlState.activeToolNames.length
          ? controlState.activeToolNames.join(', ')
          : 'none'
        const availableTools = controlState.tools.map((tool) => tool.name).join(', ')

        appendLocalLifecycle(
          'tools',
          `active: ${activeTools} · available: ${availableTools}`,
          'completed',
        )
        return true
      }

      const requestedTools = parseToolCommandValue(commandValue, controlState)

      if (!requestedTools) {
        appendLocalLifecycle(
          'tools failed',
          `Unknown tool selection "${commandValue}". Use all, none, or names from: ${controlState.tools.map((tool) => tool.name).join(', ')}`,
          'error',
        )
        return true
      }

      const nextControls = await agentClient.setActiveTools(requestedTools)

      controlsRef.current = nextControls
      setControls(nextControls)
      appendLocalLifecycle(
        'tools updated',
        requestedTools.length ? requestedTools.join(', ') : 'No tools active.',
        'completed',
      )
      return true
    }

    if (commandName === 'compact') {
      if (!capabilities.compact) {
        appendLocalLifecycle('compact unavailable', 'Manual compaction is only available for pi SDK sessions.', 'error')
        return true
      }

      const state = await agentClient.compact(commandValue || undefined)
      const nextControls = await agentClient.getControls().catch(() => null)

      if (nextControls) {
        controlsRef.current = nextControls
        setControls(nextControls)
      }
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'clear') {
      setTimeline([])
      setMessages([])
      return true
    }

    return false
  }

  async function persistSettingsDraftIfNeeded() {
    if (!settingsDraftDirty) {
      return
    }

    if (!providerValue || !modelValue) {
      throw new Error('Select both a provider and a model before continuing.')
    }

    setSettingsPending(true)

    try {
      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: modelValue,
        apiKey: authModeValue === 'api_key' ? apiKeyValue.trim() || undefined : undefined,
        openAiOAuthClientId:
          settings?.canEditOpenAiOAuthConfig ? openAiOAuthClientIdValue : undefined,
        openAiOAuthClientSecret:
          settings?.canEditOpenAiOAuthConfig && openAiOAuthClientSecretValue.trim().length > 0
            ? openAiOAuthClientSecretValue.trim()
            : undefined,
      })

      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setProviderValue(nextSettings.provider)
      setModelValue(nextSettings.modelId)
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdDirty(false)
      setOpenAiOAuthClientSecretDirty(false)
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleCancel() {
    try {
      setErrorMessage(null)
      await agentClient.cancel()
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to cancel the active run.',
      )
    }
  }

  function appendLocalLifecycle(
    label: string,
    detail?: string,
    status: Extract<AgentTimelineItem, { type: 'lifecycle' }>['status'] = 'completed',
  ) {
    const createdAt = new Date().toISOString()

    setTimeline((current) => [
      ...current,
      {
        createdAt,
        detail,
        event: status === 'error' ? 'error' : 'session_updated',
        id: `agent-timeline:local:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        label,
        status,
        type: 'lifecycle',
      },
    ])
  }

  async function handleSaveSettings() {
    if (!providerValue || !modelValue) {
      setErrorMessage('Select both a provider and a model before saving.')
      return
    }

    try {
      setSettingsPending(true)
      setErrorMessage(null)
      setOauthStatusMessage(null)
      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: modelValue,
        apiKey: apiKeyValue.trim() || undefined,
        openAiOAuthClientId:
          settings?.canEditOpenAiOAuthConfig ? openAiOAuthClientIdValue : undefined,
        openAiOAuthClientSecret:
          settings?.canEditOpenAiOAuthConfig && openAiOAuthClientSecretValue.trim().length > 0
            ? openAiOAuthClientSecretValue.trim()
            : undefined,
      })

      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setProviderValue(nextSettings.provider)
      setModelValue(nextSettings.modelId)
      setApiKeyValue('')
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setOpenAiOAuthClientSecretValue('')
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdDirty(false)
      setOpenAiOAuthClientSecretDirty(false)

      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to save the agent settings.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleClearApiKey() {
    if (!providerValue || !modelValue) {
      return
    }

    try {
      setSettingsPending(true)
      setErrorMessage(null)
      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: modelValue,
        clearApiKey: true,
      })

      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setSettingsDraftDirty(false)
      setApiKeyValue('')
      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to clear the stored API key.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleStartBrokeredLogin() {
    const effectiveProvider = 'openai'
    const availableOpenAiModels = settings
      ? getSelectableModels(settings, 'brokered_oauth', effectiveProvider)
      : []
    const effectiveModelId =
      modelValue ||
      settings?.modelId ||
      availableOpenAiModels[0]?.id ||
      ''

    if (!effectiveModelId) {
      setErrorMessage('No OpenAI model is available yet for sign-in.')
      return
    }

    try {
      setSettingsPending(true)
      setErrorMessage(null)
      const nextSettings = await agentClient.saveSettings({
        authMode: 'brokered_oauth',
        provider: effectiveProvider,
        modelId: effectiveModelId,
        openAiOAuthClientId:
          settings?.canEditOpenAiOAuthConfig ? openAiOAuthClientIdValue : undefined,
        openAiOAuthClientSecret:
          settings?.canEditOpenAiOAuthConfig && openAiOAuthClientSecretValue.trim().length > 0
            ? openAiOAuthClientSecretValue.trim()
            : undefined,
      })

      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setProviderValue(nextSettings.provider)
      setModelValue(nextSettings.modelId)
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setOpenAiOAuthClientSecretValue('')
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdDirty(false)
      setOpenAiOAuthClientSecretDirty(false)

      const result = await agentClient.beginBrokeredLogin()
      const brokerSession = await agentClient.getBrokerSession()

      setSettings((current) =>
        current
          ? {
              ...current,
              brokerSession,
            }
          : current,
      )
      setOauthStatusMessage(
        result.message ??
          (result.loginUrl
            ? `Opened the browser for OpenAI sign-in.`
            : 'OpenAI sign-in did not return a browser URL.'),
      )
      setOauthLoginUrl(result.loginUrl ?? null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to start OpenAI sign-in.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleBrokeredLogout() {
    try {
      setSettingsPending(true)
      setErrorMessage(null)
      setOauthStatusMessage(null)
      setOauthLoginUrl(null)
      const brokerSession = await agentClient.logoutBrokeredAuthSession()

      setSettings((current) =>
        current
          ? {
              ...current,
              brokerSession,
            }
          : current,
      )
      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to sign out from OpenAI OAuth.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleImportCodexLogin() {
    try {
      setSettingsPending(true)
      setErrorMessage(null)
      setOauthStatusMessage(null)
      const result = await agentClient.importCodexAuthSession()
      const nextSettings = await agentClient.getSettings()

      setSettings(nextSettings)
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setOpenAiOAuthClientIdDirty(false)
      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      setOauthStatusMessage(result.message)
      setOauthLoginUrl(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to import the local Codex login.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleClearOpenAiOAuthOverride() {
    if (!settings?.canEditOpenAiOAuthConfig || !providerValue || !modelValue) {
      return
    }

    try {
      setSettingsPending(true)
      setErrorMessage(null)
      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: modelValue,
        clearOpenAiOAuthClientId: true,
        clearOpenAiOAuthClientSecret: true,
      })

      setSettings(nextSettings)
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setOpenAiOAuthClientSecretValue('')
      setOpenAiOAuthClientIdDirty(false)
      setOpenAiOAuthClientSecretDirty(false)
      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to clear the OpenAI OAuth override.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  async function handleCompleteManualRedirect() {
    const callbackUrl = manualRedirectUrlValue.trim()

    if (!callbackUrl) {
      setErrorMessage('Paste the final redirected URL before completing sign-in.')
      return
    }

    try {
      setSettingsPending(true)
      setErrorMessage(null)
      setOauthStatusMessage(null)
      const result = await agentClient.completeBrokeredLogin(callbackUrl)
      const nextSettings = await agentClient.getSettings()

      setSettings(nextSettings)
      setSettingsDraftDirty(false)
      setOpenAiOAuthClientIdValue(nextSettings.openAiOAuthClientId ?? '')
      setOpenAiOAuthClientIdDirty(false)
      setManualRedirectUrlValue('')
      const nextSession = await agentClient.createSession()
      setSession(nextSession)
      const state = await agentClient.getHttpState()
      setSession(state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      setOauthStatusMessage(result.message)
      setOauthLoginUrl(null)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to complete sign-in from the pasted redirect URL.',
      )
    } finally {
      setSettingsPending(false)
    }
  }

  const availableModels = settings ? getSelectableModels(settings, authModeValue, providerValue) : []
  const sendDisabledReason =
    !sessionCapabilities.prompt
      ? 'Prompting is not available for the current agent runtime.'
      : session?.runState === 'disabled'
      ? session.lastError ?? 'The current agent session is disabled.'
      : session?.runState === 'initializing'
        ? 'The agent session is still initializing.'
        : composerValue.trim().length === 0
          ? 'Enter a prompt to send.'
          : pending
            ? 'A prompt is already being sent.'
            : null
  const hasInspectorContext = hasScopeContext(inspectorContext)
  const hasWorkingSetContext = hasScopeContext(workingSetContext)
  const workingSetMatchesInspectorContext =
    hasWorkingSetContext && hasInspectorContext
      ? areScopeContextsEquivalent(workingSetContext, inspectorContext)
      : false

  return (
    <div className={`cbv-agent-panel${settingsOnly ? ' is-settings-only' : ''}`}>
      <div className="cbv-agent-meta">
        <div className="cbv-agent-meta-main">
          <p className="cbv-eyebrow">Session</p>
          {session || terminalModelOptions.length > 0 ? (
            <AgentModelPicker
              disabled={
                pending ||
                settingsPending ||
                session?.runState === 'running' ||
                terminalModelOptions.length <= 1
              }
              models={terminalModelOptions}
              onSelect={(modelKey) => {
                void handleTerminalModelChange(modelKey)
              }}
              selectedModelKey={selectedModelKey}
              title={
                session?.runState === 'running'
                  ? 'Model switching is disabled while the agent is running.'
                  : 'Switch agent model'
              }
            />
          ) : (
            <strong>Starting…</strong>
          )}
        </div>
        <div className={`cbv-agent-status is-${session?.runState ?? 'idle'}`}>
          {session?.runState ?? 'idle'}
        </div>
      </div>

      {session?.lastError ? (
        <p className="cbv-agent-warning">{session.lastError}</p>
      ) : null}

      {errorMessage ? (
        <p className="cbv-agent-error">{errorMessage}</p>
      ) : null}

      {settingsOnly ? (
      <section className="cbv-agent-settings">
        <div className="cbv-agent-settings-header">
          <div>
            <p className="cbv-eyebrow">Agent settings</p>
            <strong>Provider, model, and API key</strong>
          </div>
          {settings ? (
            <span className="cbv-agent-settings-storage">
              {settings.storageKind === 'safe_storage' ? 'Stored with system encryption' : 'Stored in app data'}
            </span>
          ) : null}
        </div>

        <div className="cbv-agent-settings-grid">
          <label>
            <span>Auth mode</span>
            <select
              disabled={settingsPending || !settings}
              onChange={(event) => {
                setAuthModeValue(event.target.value as AgentAuthMode)
                setSettingsDraftDirty(true)
              }}
              value={authModeValue}
            >
              <option value="brokered_oauth">OpenAI OAuth</option>
              <option value="api_key">API key</option>
            </select>
          </label>

          <label>
            <span>Provider</span>
            <select
              disabled={settingsPending || !settings || authModeValue === 'brokered_oauth'}
              onChange={(event) => {
                setProviderValue(event.target.value)
                setSettingsDraftDirty(true)
              }}
              value={providerValue}
            >
              {(settings?.availableProviders ?? []).map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Model</span>
            <select
              disabled={settingsPending || availableModels.length === 0}
              onChange={(event) => {
                setModelValue(event.target.value)
                setSettingsDraftDirty(true)
              }}
              value={modelValue}
            >
              {availableModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>

          {authModeValue === 'api_key' ? (
            <label className="is-wide">
              <span>API key</span>
              <input
                autoComplete="off"
                disabled={settingsPending}
                onChange={(event) => {
                  setApiKeyValue(event.target.value)
                  setSettingsDraftDirty(true)
                }}
                placeholder={settings?.hasApiKey ? 'Stored key present. Enter a new key to replace it.' : 'Enter provider API key'}
                type="password"
                value={apiKeyValue}
              />
            </label>
          ) : (
            <div className="cbv-agent-oauth-placeholder">
              <strong>OpenAI OAuth</strong>
              <p>
                Sign in through your OpenAI account in the browser. The desktop app
                handles a localhost callback and stores the returned tokens locally.
              </p>
              <p>
                OAuth session state: {settings?.brokerSession.state ?? 'signed_out'}.
              </p>
              {settings?.brokerSession.accountLabel ? (
                <p>Signed in as: {settings.brokerSession.accountLabel}</p>
              ) : null}
              <p>
                If the browser does not open automatically, use the login URL below.
              </p>
              <p>
                The desktop app starts a localhost callback server automatically.
                If that does not complete sign-in, paste the final redirected URL
                below and finish the flow manually.
              </p>
              <label className="is-wide">
                <span>Manual redirect URL fallback</span>
                <input
                  autoComplete="off"
                  disabled={settingsPending}
                  onChange={(event) => setManualRedirectUrlValue(event.target.value)}
                  placeholder="Paste the final redirected browser URL"
                  type="url"
                  value={manualRedirectUrlValue}
                />
              </label>
              {oauthStatusMessage ? (
                <p className="cbv-agent-warning">{oauthStatusMessage}</p>
              ) : null}
              {oauthLoginUrl ? (
                <p className="cbv-agent-warning">
                  Login URL:{' '}
                  <a href={oauthLoginUrl} rel="noreferrer" target="_blank">
                    open sign-in page
                  </a>
                </p>
              ) : null}
              <p>
                For local development, you can also import your existing Codex
                ChatGPT login from <code>~/.codex/auth.json</code>.
              </p>
              {settings?.canEditOpenAiOAuthConfig ? (
                <>
                  <label>
                    <span>Dev client ID override</span>
                    <input
                      autoComplete="off"
                      disabled={settingsPending}
                      onChange={(event) => {
                        setOpenAiOAuthClientIdValue(event.target.value)
                        setSettingsDraftDirty(true)
                        setOpenAiOAuthClientIdDirty(true)
                      }}
                      placeholder="app_..."
                      type="text"
                      value={openAiOAuthClientIdValue}
                    />
                  </label>
                  <label>
                    <span>Dev client secret override</span>
                    <input
                      autoComplete="off"
                      disabled={settingsPending}
                      onChange={(event) => {
                        setOpenAiOAuthClientSecretValue(event.target.value)
                        setSettingsDraftDirty(true)
                        setOpenAiOAuthClientSecretDirty(true)
                      }}
                      placeholder={
                        settings?.hasOpenAiOAuthClientSecret
                          ? 'Stored secret present. Enter a new value to replace it.'
                          : 'Optional client secret'
                      }
                      type="password"
                      value={openAiOAuthClientSecretValue}
                    />
                  </label>
                </>
              ) : null}
            </div>
          )}
        </div>

        <div className="cbv-agent-actions">
          {authModeValue === 'api_key' ? (
            <button
              className="is-secondary"
              disabled={settingsPending || !settings?.hasApiKey}
              onClick={() => {
                void handleClearApiKey()
              }}
              type="button"
            >
              Remove Key
            </button>
          ) : null}
          {authModeValue === 'brokered_oauth' ? (
            <>
              <button
                className="is-secondary"
                disabled={settingsPending || settings?.brokerSession.state === 'signed_out'}
                onClick={() => {
                  void handleBrokeredLogout()
                }}
                type="button"
              >
                Sign Out
              </button>
              {settings?.canEditOpenAiOAuthConfig ? (
                <button
                  className="is-secondary"
                  disabled={
                    settingsPending ||
                    (!settings.hasOpenAiOAuthClientId && !settings.hasOpenAiOAuthClientSecret)
                  }
                  onClick={() => {
                    void handleClearOpenAiOAuthOverride()
                  }}
                  type="button"
                >
                  Clear OAuth Override
                </button>
              ) : null}
              <button
                className="is-secondary"
                disabled={settingsPending}
                onClick={() => {
                  void handleImportCodexLogin()
                }}
                type="button"
              >
                Use Codex Login
              </button>
              <button
                className="is-secondary"
                disabled={settingsPending || manualRedirectUrlValue.trim().length === 0}
                onClick={() => {
                  void handleCompleteManualRedirect()
                }}
                type="button"
              >
                Complete Sign-In
              </button>
              <button
                onClick={() => {
                  void handleStartBrokeredLogin()
                }}
                type="button"
              >
                Sign In With OpenAI
              </button>
            </>
          ) : (
            <button
              disabled={settingsPending || !providerValue || !modelValue}
              onClick={() => {
                void handleSaveSettings()
              }}
              type="button"
            >
              {settingsPending ? 'Saving…' : 'Save Settings'}
            </button>
          )}
        </div>
      </section>
      ) : !sessionIsInteractive ? (
        <div className="cbv-agent-setup-prompt">
          <strong>Agent settings needed</strong>
          <p>
            {session?.lastError ??
              'Open settings to sign in, choose a model, or update agent configuration before chatting here.'}
          </p>
          {onOpenSettings ? (
            <button
              onClick={onOpenSettings}
              type="button"
            >
              Open Settings
            </button>
          ) : null}
        </div>
      ) : (
      <div className="cbv-agent-terminal">
        <div className="cbv-agent-terminal-bar">
          <span>thinking {session.thinkingLevel ?? 'medium'}</span>
          <span className={`cbv-agent-terminal-state is-${session.runState}`}>
            {session.runState}
          </span>
          <span title={session.sessionFile ?? undefined}>
            session {session.sessionName ?? abbreviateId(session.id)}
          </span>
          {sessionControls?.tools.length ? (
            <span title={sessionControls.tools.map((tool) => `${tool.active ? 'on' : 'off'} ${tool.name}`).join(' · ')}>
              tools {sessionControls.activeToolNames.length}/{sessionControls.tools.length}
            </span>
          ) : null}
          <span>
            queue s:{session.queue?.steering ?? 0} f:{session.queue?.followUp ?? 0}
          </span>
        </div>

        <AgentTerminalTimeline
          items={displayTimeline}
          listRef={messageListRef}
          onScroll={handleTimelineScroll}
        />

        <div className="cbv-agent-composer is-terminal">
          {renderTerminalContextRows({
            hasInspectorContext,
            hasWorkingSetContext,
            inspectorContext,
            onAdoptInspectorContextAsWorkingSet,
            onClearWorkingSet,
            workingSet,
            workingSetContext,
            workingSetMatchesInspectorContext,
          })}
          {commandSuggestions.length > 0 ? (
            <AgentCommandSuggestions commands={commandSuggestions} />
          ) : null}
          <textarea
            ref={composerRef}
            onChange={(event) =>
              setComposerState({
                seedId: promptSeed?.id ?? composerState.seedId,
                value: event.target.value,
              })
            }
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.metaKey || event.ctrlKey || !event.shiftKey)
              ) {
                event.preventDefault()
                void handleSubmit(session.runState === 'running' ? 'steer' : 'send')
              }
            }}
            placeholder={buildComposerPlaceholder(session, sessionControls)}
            rows={1}
            value={composerValue}
          />
          <div className="cbv-agent-actions">
            <button
              className="is-secondary"
              disabled={session.runState !== 'running'}
              onClick={() => {
                void handleCancel()
              }}
              type="button"
            >
              Cancel
            </button>
            {session.runState === 'running' ? (
              <>
                {sessionCapabilities.steer ? (
                  <button
                    disabled={pending || composerValue.trim().length === 0}
                    onClick={() => {
                      void handleSubmit('steer')
                    }}
                    title={sendDisabledReason ?? undefined}
                    type="button"
                  >
                    Steer
                  </button>
                ) : null}
                {sessionCapabilities.followUp ? (
                  <button
                    className="is-secondary"
                    disabled={pending || composerValue.trim().length === 0}
                    onClick={() => {
                      void handleSubmit('follow_up')
                    }}
                    title={sendDisabledReason ?? undefined}
                    type="button"
                  >
                    Follow-Up
                  </button>
                ) : null}
              </>
            ) : (
              <button
                disabled={
                  pending ||
                  composerValue.trim().length === 0 ||
                  !sessionCapabilities.prompt ||
                  session.runState === 'disabled' ||
                  session.runState === 'initializing'
                }
                title={sendDisabledReason ?? undefined}
                onClick={() => {
                  void handleSubmit('send')
                }}
                type="button"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
      )}
    </div>
  )
}

function handleAgentEvent(
  event: AgentEvent,
  sessionRef: { current: AgentSessionSummary | null },
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>,
  setTimeline: Dispatch<SetStateAction<AgentTimelineItem[]>>,
  setSession: Dispatch<SetStateAction<AgentSessionSummary | null>>,
) {
  const activeSession = sessionRef.current

  if (
    activeSession &&
    event.type === 'session_updated' &&
    event.session.id !== activeSession.id
  ) {
    return
  }

  if (
    activeSession &&
    'sessionId' in event &&
    event.sessionId !== activeSession.id
  ) {
    return
  }

  switch (event.type) {
    case 'session_created':
    case 'session_updated':
      sessionRef.current = event.session
      setSession(event.session)
      break

    case 'message':
      setMessages((messages) => upsertMessage(messages, event.message))
      break

    case 'tool':
      break

    case 'file_operation':
      break

    case 'timeline':
      break

    case 'timeline_snapshot':
      setTimeline(event.items)
      break

    case 'permission_request':
      setTimeline((timeline) => [
        ...timeline,
        {
          createdAt: new Date().toISOString(),
          detail: event.request.description,
          event: 'session_updated',
          id: `agent-timeline:permission:${event.request.id}`,
          label: event.request.title,
          status: 'queued',
          type: 'lifecycle',
        },
      ])
      break
  }
}

function AgentModelPicker({
  disabled,
  models,
  onSelect,
  selectedModelKey,
  title,
}: {
  disabled: boolean
  models: AgentControlState['models']
  onSelect: (modelKey: string) => void
  selectedModelKey: string
  title: string
}) {
  const [open, setOpen] = useState(false)
  const [menuPlacement, setMenuPlacement] = useState<AgentModelMenuPlacement | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const selectedModel = useMemo(
    () => models.find((model) => createAgentModelKey(model) === selectedModelKey) ?? null,
    [models, selectedModelKey],
  )
  const modelGroups = useMemo(() => groupAgentModelOptions(models), [models])

  useLayoutEffect(() => {
    if (!open) {
      return
    }

    const updateMenuPlacement = () => {
      const triggerRect = pickerRef.current?.getBoundingClientRect()

      if (!triggerRect) {
        return
      }

      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const availableWidth = Math.max(0, viewportWidth - MODEL_MENU_MARGIN_PX * 2)
      const menuWidth = Math.min(
        Math.max(triggerRect.width, MODEL_MENU_MIN_WIDTH_PX),
        availableWidth,
      )
      const maxLeft = Math.max(MODEL_MENU_MARGIN_PX, viewportWidth - menuWidth - MODEL_MENU_MARGIN_PX)
      const left = Math.min(
        Math.max(MODEL_MENU_MARGIN_PX, triggerRect.left),
        maxLeft,
      )
      const availableBelow = Math.max(
        0,
        viewportHeight - triggerRect.bottom - MODEL_MENU_GAP_PX - MODEL_MENU_MARGIN_PX,
      )
      const availableAbove = Math.max(
        0,
        triggerRect.top - MODEL_MENU_GAP_PX - MODEL_MENU_MARGIN_PX,
      )
      const opensBelow =
        availableBelow >= MODEL_MENU_MIN_COMFORTABLE_HEIGHT_PX ||
        availableBelow >= availableAbove
      const availableHeight = opensBelow ? availableBelow : availableAbove

      setMenuPlacement({
        bottom: opensBelow
          ? 'auto'
          : viewportHeight - triggerRect.top + MODEL_MENU_GAP_PX,
        left,
        maxHeight: Math.min(MODEL_MENU_MAX_HEIGHT_PX, availableHeight),
        top: opensBelow ? triggerRect.bottom + MODEL_MENU_GAP_PX : 'auto',
        width: menuWidth,
      })
    }

    updateMenuPlacement()

    window.addEventListener('resize', updateMenuPlacement)
    window.addEventListener('scroll', updateMenuPlacement, true)
    window.visualViewport?.addEventListener('resize', updateMenuPlacement)
    window.visualViewport?.addEventListener('scroll', updateMenuPlacement)

    return () => {
      window.removeEventListener('resize', updateMenuPlacement)
      window.removeEventListener('scroll', updateMenuPlacement, true)
      window.visualViewport?.removeEventListener('resize', updateMenuPlacement)
      window.visualViewport?.removeEventListener('scroll', updateMenuPlacement)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node

      if (
        pickerRef.current &&
        !pickerRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const menuStyle = useMemo<CSSProperties>(() => {
    if (!menuPlacement) {
      return {
        left: -9999,
        maxHeight: 0,
        position: 'fixed',
        top: 0,
      }
    }

    return {
      bottom: menuPlacement.bottom,
      left: menuPlacement.left,
      maxHeight: menuPlacement.maxHeight,
      position: 'fixed',
      top: menuPlacement.top,
      width: menuPlacement.width,
    }
  }, [menuPlacement])

  const menu = open ? (
    <div
      className="cbv-agent-model-menu"
      id={menuId}
      ref={menuRef}
      role="listbox"
      style={menuStyle}
    >
      {modelGroups.map((group) => (
        <div
          className="cbv-agent-model-group"
          key={group.key}
          role="group"
        >
          <div className="cbv-agent-model-group-header">
            <span>{group.provider}</span>
            <span>{getAgentRuntimeLabel(group.authMode)}</span>
          </div>
          {group.models.map((model) => {
            const modelKey = createAgentModelKey(model)
            const selected = modelKey === selectedModelKey

            return (
              <button
                aria-selected={selected}
                className={`cbv-agent-model-option${selected ? ' is-selected' : ''}`}
                key={modelKey}
                onClick={() => {
                  if (!selected) {
                    onSelect(modelKey)
                  }

                  setOpen(false)
                }}
                role="option"
                type="button"
              >
                <span aria-hidden="true" className="cbv-agent-model-option-dot" />
                <span className="cbv-agent-model-option-label">{model.id}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  ) : null

  return (
    <div
      className={`cbv-agent-model-picker${open ? ' is-open' : ''}`}
      ref={pickerRef}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Agent model"
        className="cbv-agent-model-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={title}
        type="button"
      >
        <span aria-hidden="true" className="cbv-agent-model-trigger-dot" />
        <span className="cbv-agent-model-trigger-copy">
          <span className="cbv-agent-model-trigger-model">
            {selectedModel?.id ?? 'Select model'}
          </span>
          {selectedModel ? (
            <span className="cbv-agent-model-trigger-provider">
              {selectedModel.provider} · {getAgentRuntimeLabel(selectedModel.authMode)}
            </span>
          ) : null}
        </span>
        <span aria-hidden="true" className="cbv-agent-model-trigger-caret">
          ▾
        </span>
      </button>
      {menu && typeof document !== 'undefined' ? createPortal(menu, document.body) : null}
    </div>
  )
}

interface AgentModelMenuPlacement {
  bottom: number | 'auto'
  left: number
  maxHeight: number
  top: number | 'auto'
  width: number
}

function AgentCommandSuggestions({
  commands,
}: {
  commands: AgentCommandInfo[]
}) {
  return (
    <div className="cbv-agent-command-suggestions">
      {commands.map((command) => (
        <div
          className={[
            'cbv-agent-command-suggestion',
            `is-${command.source}`,
            command.enabled ? '' : 'is-disabled',
          ].filter(Boolean).join(' ')}
          key={`${command.source}:${command.name}`}
        >
          <strong>/{command.name}</strong>
          <span>{command.description ?? command.source}</span>
        </div>
      ))}
    </div>
  )
}

function AgentTerminalTimeline({
  items,
  listRef,
  onScroll,
}: {
  items: AgentTimelineItem[]
  listRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
}) {
  return (
    <div className="cbv-agent-terminal-timeline" onScroll={onScroll} ref={listRef}>
      {items.length > 0 ? (
        items.map((item, index) => (
          <AgentTimelineRow
            isLast={index === items.length - 1}
            item={item}
            key={item.id}
          />
        ))
      ) : (
        <div className="cbv-agent-terminal-empty">
          <span>└ idle · no timeline yet</span>
          <p>Send a prompt or run /resume to attach to a pi session.</p>
        </div>
      )}
    </div>
  )
}

function AgentTimelineRow({
  isLast,
  item,
}: {
  isLast: boolean
  item: AgentTimelineItem
}) {
  if (item.type === 'tool') {
    return <ToolTimelineRow glyph={isLast ? '└' : '├'} item={item} />
  }

  if (item.type === 'lifecycle') {
    return <LifecycleTimelineRow glyph={isLast ? '└' : '├'} item={item} />
  }

  return <MessageTimelineRow glyph={isLast ? '└' : '├'} item={item} />
}

function MessageTimelineRow({
  glyph,
  item,
}: {
  glyph: string
  item: Extract<AgentTimelineItem, { type: 'message' }>
}) {
  const rowLabel = item.blockKind === 'thinking' ? 'thinking' : item.role
  const statusText = item.isStreaming ? 'streaming' : 'done'

  if (item.blockKind === 'thinking') {
    return (
      <details
        className="cbv-agent-terminal-row is-thinking"
        open={item.isStreaming}
      >
        <summary>
          <span className="cbv-agent-terminal-glyph">{glyph}</span>
          <span>{rowLabel}</span>
          <span>· {statusText}</span>
        </summary>
        <pre>{item.text || '...'}</pre>
      </details>
    )
  }

  return (
    <article
      className={[
        'cbv-agent-terminal-row',
        'is-message',
        `is-${item.role}`,
        item.isStreaming ? 'is-streaming' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="cbv-agent-terminal-row-line">
        <span className="cbv-agent-terminal-glyph">{glyph}</span>
        <span>{rowLabel}</span>
        {item.isStreaming ? <span>· streaming</span> : null}
      </div>
      <div className="cbv-agent-terminal-message-body">
        {item.text || (item.role === 'assistant' ? '...' : ' ')}
      </div>
    </article>
  )
}

function ToolTimelineRow({
  glyph,
  item,
}: {
  glyph: string
  item: Extract<AgentTimelineItem, { type: 'tool' }>
}) {
  const toolTitle = formatToolTitle(item)
  const statusText = item.status === 'completed'
    ? 'ok'
    : item.status === 'error'
      ? 'error'
      : 'running'
  const durationText = item.durationMs === undefined
    ? null
    : formatDuration(item.durationMs)

  return (
    <details
      className={`cbv-agent-terminal-row is-tool is-${item.status}`}
      open={item.status !== 'completed'}
    >
      <summary>
        <span className="cbv-agent-terminal-glyph">{glyph}</span>
        <span>{toolTitle}</span>
        {durationText ? <span>· {durationText}</span> : null}
        <span>· {statusText}</span>
      </summary>
      <div className="cbv-agent-terminal-details">
        {item.paths?.length ? (
          <p>paths {item.paths.join(' · ')}</p>
        ) : null}
        <pre>args {formatJsonPreview(item.args)}</pre>
        {item.resultPreview ? (
          <pre>result {item.resultPreview}</pre>
        ) : null}
        {item.isError ? <p>error true</p> : null}
      </div>
    </details>
  )
}

function LifecycleTimelineRow({
  glyph,
  item,
}: {
  glyph: string
  item: Extract<AgentTimelineItem, { type: 'lifecycle' }>
}) {
  const detail = formatLifecycleDetail(item)

  return (
    <div className={`cbv-agent-terminal-row is-lifecycle is-${item.status ?? 'idle'}`}>
      <div className="cbv-agent-terminal-row-line">
        <span className="cbv-agent-terminal-glyph">{glyph}</span>
        <span>{item.label}</span>
        {detail ? <span>· {detail}</span> : null}
      </div>
      {item.detail ? (
        <p className="cbv-agent-terminal-detail-line">{item.detail}</p>
      ) : null}
    </div>
  )
}

function renderTerminalContextRows(input: {
  hasInspectorContext: boolean
  hasWorkingSetContext: boolean
  inspectorContext: AgentScopeContext | null | undefined
  onAdoptInspectorContextAsWorkingSet?: () => void
  onClearWorkingSet?: () => void
  workingSet: WorkingSetState | null
  workingSetContext: AgentScopeContext | null
  workingSetMatchesInspectorContext: boolean
}) {
  if (input.hasWorkingSetContext && input.workingSetContext) {
    return (
      <div className="cbv-agent-context-inline">
        <span>ctx pinned</span>
        <strong>{describeScopeContextTitle(input.workingSetContext)}</strong>
        <em>{input.workingSet?.source === 'selection' ? 'selection' : 'working-set'}</em>
        <details>
          <summary>paths</summary>
          {renderScopeContextList(input.workingSetContext)}
          {renderScopeContextOverflow(input.workingSetContext)}
        </details>
        <div className="cbv-agent-context-actions">
          {input.hasInspectorContext &&
          !input.workingSetMatchesInspectorContext &&
          input.onAdoptInspectorContextAsWorkingSet ? (
            <button onClick={input.onAdoptInspectorContextAsWorkingSet} type="button">
              replace
            </button>
          ) : null}
          {input.onClearWorkingSet ? (
            <button className="is-secondary" onClick={input.onClearWorkingSet} type="button">
              clear
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (input.hasInspectorContext && input.inspectorContext) {
    return (
      <div className="cbv-agent-context-inline">
        <span>ctx select</span>
        <strong>{describeScopeContextTitle(input.inspectorContext)}</strong>
        <em>{describeInspectorContext(input.inspectorContext)}</em>
        <details>
          <summary>paths</summary>
          {renderScopeContextList(input.inspectorContext)}
          {renderScopeContextOverflow(input.inspectorContext)}
        </details>
        {input.onAdoptInspectorContextAsWorkingSet ? (
          <div className="cbv-agent-context-actions">
            <button onClick={input.onAdoptInspectorContextAsWorkingSet} type="button">
              pin
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return null
}

function isTimelineScrolledNearBottom(listElement: HTMLDivElement) {
  return (
    listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight <= 48
  )
}

function formatToolTitle(item: Extract<AgentTimelineItem, { type: 'tool' }>) {
  const normalizedName = item.toolName.toLowerCase()
  const target = getToolTarget(item)

  if (normalizedName === 'bash' || normalizedName === 'shell') {
    return `shell ${target || item.toolName}`
  }

  if (normalizedName === 'edit') {
    return `edit ${target || item.toolName}`
  }

  return `tool ${item.toolName}${target ? ` ${target}` : ''}`
}

function getToolTarget(item: Extract<AgentTimelineItem, { type: 'tool' }>) {
  if (item.toolName === 'bash' || item.toolName === 'shell') {
    return getArgString(item.args, ['command', 'cmd'])
  }

  return (
    getArgString(item.args, ['path', 'file', 'filePath', 'filepath', 'query', 'pattern']) ||
    item.paths?.[0] ||
    ''
  )
}

function getArgString(args: unknown, keys: string[]) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return ''
  }

  const record = args as Record<string, unknown>

  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return compactLine(value.trim(), 96)
    }
  }

  return ''
}

function formatLifecycleDetail(item: Extract<AgentTimelineItem, { type: 'lifecycle' }>) {
  const countText = item.counts
    ? Object.entries(item.counts)
        .map(([key, value]) => `${key}:${value}`)
        .join(' ')
    : ''
  const statusText = item.status && item.status !== 'completed' ? item.status : ''

  return [countText, statusText].filter(Boolean).join(' · ')
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`
  }

  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

function formatJsonPreview(value: unknown) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  return compactLine(text, 1800)
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function compactLine(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function abbreviateId(id: string) {
  return id.length > 10 ? id.slice(0, 10) : id
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

function normalizeBridgeInfo(
  bridgeInfo: DesktopAgentBridgeInfo,
  desktopHostAvailable: boolean,
): DesktopAgentBridgeInfo {
  return {
    hasDesktopHost: bridgeInfo.hasDesktopHost || desktopHostAvailable,
    hasAgentBridge: bridgeInfo.hasAgentBridge,
  }
}

function areBridgeInfoEqual(
  left: DesktopAgentBridgeInfo,
  right: DesktopAgentBridgeInfo,
) {
  return (
    left.hasAgentBridge === right.hasAgentBridge &&
    left.hasDesktopHost === right.hasDesktopHost
  )
}

function getSessionCapabilities(session: AgentSessionSummary | null) {
  return session?.capabilities ?? {
    compact: false,
    followUp: false,
    newSession: false,
    prompt: false,
    resumeSession: false,
    setThinkingLevel: false,
    steer: false,
  }
}

function getAvailableAgentModelOptions(input: {
  authMode: AgentAuthMode
  controls: AgentControlState | null
  provider: string
  session: AgentSessionSummary | null
  settings: AgentSettingsState | null
}) {
  const models = input.controls?.models.length
    ? input.controls.models
    : input.settings
      ? getSelectableModels(input.settings, input.authMode, input.provider)
        .map((model) => ({
          authMode: model.authMode ?? input.authMode,
          id: model.id,
          provider: input.provider,
        }))
      : []
  const withCurrentModel = input.session
    ? [
        {
          authMode: input.session.authMode,
          id: input.session.modelId,
          provider: input.session.provider,
        },
        ...models,
      ]
    : models
  const seen = new Set<string>()

  return withCurrentModel.filter((model) => {
    const key = createAgentModelKey(model)

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function createAgentModelKey(model: AgentControlState['models'][number]) {
  return `${model.authMode}:${model.provider}/${model.id}`
}

function groupAgentModelOptions(models: AgentControlState['models']) {
  const groups: Array<{
    authMode: AgentAuthMode
    key: string
    models: AgentControlState['models']
    provider: string
  }> = []
  const groupByKey = new Map<string, (typeof groups)[number]>()

  for (const model of models) {
    const key = `${model.authMode}:${model.provider}`
    let group = groupByKey.get(key)

    if (!group) {
      group = {
        authMode: model.authMode,
        key,
        models: [],
        provider: model.provider,
      }
      groupByKey.set(key, group)
      groups.push(group)
    }

    group.models.push(model)
  }

  return groups
}

function parseAgentModelKey(modelKey: string) {
  const authSeparatorIndex = modelKey.indexOf(':')
  const authModeValue = authSeparatorIndex > 0
    ? modelKey.slice(0, authSeparatorIndex)
    : null
  const modelPath = authSeparatorIndex > 0
    ? modelKey.slice(authSeparatorIndex + 1)
    : modelKey
  const separatorIndex = modelPath.indexOf('/')

  if (separatorIndex <= 0 || separatorIndex === modelPath.length - 1) {
    return null
  }

  const authMode = authModeValue && isAgentAuthMode(authModeValue)
    ? authModeValue
    : undefined

  return {
    authMode,
    provider: modelPath.slice(0, separatorIndex),
    modelId: modelPath.slice(separatorIndex + 1),
  }
}

function resolveAgentModelSelection(
  value: string,
  input: {
    availableModels: AgentControlState['models']
    provider: string
    session: AgentSessionSummary | null
  },
) {
  const parsedModel = value.includes('/')
    ? parseAgentModelKey(value)
    : {
        authMode: input.session?.authMode,
        modelId: value,
        provider: input.session?.provider ?? input.provider,
      }

  if (!parsedModel) {
    return null
  }

  const preferredAuthMode = parsedModel.authMode ?? input.session?.authMode
  const matchingModel = input.availableModels.find(
    (model) =>
      model.id === parsedModel.modelId &&
      model.provider === parsedModel.provider &&
      (!preferredAuthMode || model.authMode === preferredAuthMode),
  ) ?? input.availableModels.find(
    (model) =>
      model.id === parsedModel.modelId &&
      model.provider === parsedModel.provider &&
      (!parsedModel.authMode || model.authMode === parsedModel.authMode),
  )

  return matchingModel
    ? {
        authMode: matchingModel.authMode,
        modelId: matchingModel.id,
        provider: matchingModel.provider,
      }
    : null
}

function getAgentRuntimeLabel(authMode: AgentAuthMode) {
  return authMode === 'brokered_oauth' ? 'Codex OAuth' : 'PI SDK'
}

function formatAgentModelOption(model: AgentControlState['models'][number]) {
  return `${model.provider}/${model.id} (${getAgentRuntimeLabel(model.authMode)})`
}

function isAgentAuthMode(value: string): value is AgentAuthMode {
  return value === 'api_key' || value === 'brokered_oauth'
}

function buildComposerPlaceholder(
  session: AgentSessionSummary | null,
  controls: AgentControlState | null,
) {
  const commands = getVisibleCommandNames(controls)

  if (commands.length > 0) {
    return `${commands.slice(0, 7).map((command) => `/${command}`).join(' ')} or ask...`
  }

  const capabilities = getSessionCapabilities(session)
  const fallbackCommands = ['/model', '/session', '/clear']

  if (capabilities.newSession) {
    fallbackCommands.unshift('/new')
  }

  return `${fallbackCommands.join(' ')} or ask...`
}

function getVisibleCommandNames(controls: AgentControlState | null) {
  if (!controls) {
    return []
  }

  return controls.commands
    .filter((command) => command.available && command.enabled)
    .sort((left, right) => {
      if (left.source === 'semanticode' && right.source !== 'semanticode') {
        return 1
      }

      if (left.source !== 'semanticode' && right.source === 'semanticode') {
        return -1
      }

      return left.name.localeCompare(right.name)
    })
    .map((command) => command.name)
}

function getCommandSuggestions(
  composerValue: string,
  controls: AgentControlState | null,
) {
  if (!controls) {
    return []
  }

  const trimmed = composerValue.trimStart()

  if (!trimmed.startsWith('/')) {
    return []
  }

  const query = trimmed.slice(1).split(/\s+/)[0].toLowerCase()

  return controls.commands
    .filter((command) =>
      command.available &&
      (query.length === 0 || command.name.toLowerCase().includes(query)),
    )
    .sort((left, right) => {
      if (left.source === 'semanticode' && right.source !== 'semanticode') {
        return 1
      }

      if (left.source !== 'semanticode' && right.source === 'semanticode') {
        return -1
      }

      return left.name.localeCompare(right.name)
    })
    .slice(0, 8)
}

function isSemanticodeLocalCommand(commandName: string) {
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

function parseToolCommandValue(
  commandValue: string,
  controls: AgentControlState,
) {
  const normalized = commandValue.trim().toLowerCase()

  if (normalized === 'all') {
    return controls.tools.map((tool) => tool.name)
  }

  if (normalized === 'none' || normalized === 'off') {
    return []
  }

  const availableTools = new Set(controls.tools.map((tool) => tool.name))
  const requestedTools = commandValue
    .split(/[,\s]+/)
    .map((toolName) => toolName.trim())
    .filter(Boolean)

  if (
    requestedTools.length === 0 ||
    requestedTools.some((toolName) => !availableTools.has(toolName))
  ) {
    return null
  }

  return [...new Set(requestedTools)]
}

function getSelectableModels(
  settings: AgentSettingsState,
  authMode: AgentAuthMode,
  provider: string,
) {
  const availableModels = settings.availableModelsByProvider[provider] ?? []

  if (authMode !== 'brokered_oauth' || provider !== 'openai') {
    return availableModels
  }

  return availableModels.filter((model) => model.id !== 'gpt-4.1-nano')
}

function upsertMessage(messages: AgentMessage[], nextMessage: AgentMessage) {
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex === -1) {
    return [...messages, nextMessage]
  }

  return messages.map((message, index) =>
    index === existingIndex ? nextMessage : message,
  )
}

function buildWorkspaceContextInjection(
  workspaceProfile: WorkspaceProfile | null | undefined,
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentPanelProps['inspectorContext'],
) {
  const sentinel = '__SEMANTICODE_USER_REQUEST__'
  const scopedPrompt = buildWorkspaceScopedPrompt(
    sentinel,
    workspaceProfile,
    preprocessedWorkspaceContext,
    workingSetContext,
    inspectorContext,
  )

  if (scopedPrompt === sentinel) {
    return undefined
  }

  const marker = `\n\nUser request:\n${sentinel}`
  const contextInjection = scopedPrompt.endsWith(marker)
    ? scopedPrompt.slice(0, -marker.length).trim()
    : scopedPrompt.replace(sentinel, '').trim()

  return contextInjection || undefined
}

function buildInspectorScopedPrompt(
  prompt: string,
  inspectorContext: AgentScopeContext | undefined | null,
) {
  if (!hasScopeContext(inspectorContext)) {
    return prompt
  }

  const contextLines = [
    'Semanticode inspector context:',
    'Treat the current inspector selection as the primary target for this request.',
    'If the user is asking for an edit, inspect and modify this file or symbol first unless they clearly redirect you elsewhere.',
  ]

  if (inspectorContext.symbols.length > 1) {
    contextLines.push('Selected symbols (primary first):')

    for (const symbol of inspectorContext.symbols) {
      contextLines.push(`- ${symbol.path}`)
    }

    contextLines.push(
      'Treat this symbol set as the default edit scope for the request. Start with these symbols before searching elsewhere in the repository.',
    )
  } else if (inspectorContext.files.length > 1) {
    contextLines.push('Selected files (primary first):')

    for (const file of inspectorContext.files) {
      contextLines.push(`- ${file.path}`)
    }

    contextLines.push(
      'Treat this file set as the default edit scope for the request. Start with these files before searching elsewhere in the repository.',
    )
  } else if (inspectorContext.file) {
    contextLines.push(`Selected file: ${inspectorContext.file.path}`)
  }

  if (inspectorContext.symbol) {
    contextLines.push(`Selected symbol: ${inspectorContext.symbol.path}`)
    contextLines.push(`Selected symbol kind: ${inspectorContext.symbol.symbolKind}`)

    if (inspectorContext.symbol.range) {
      contextLines.push(
        `Selected symbol range: lines ${formatRange(inspectorContext.symbol.range)}`,
      )
    }
  } else if (inspectorContext.node) {
    contextLines.push(`Selected node: ${inspectorContext.node.path}`)
    contextLines.push(`Selected node kind: ${inspectorContext.node.kind}`)
  }

  return `${contextLines.join('\n')}\n\nUser request:\n${prompt}`
}

function buildWorkspaceScopedPrompt(
  prompt: string,
  workspaceProfile: WorkspaceProfile | null | undefined,
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentPanelProps['inspectorContext'],
) {
  const scopedPrompt = buildScopeAwarePrompt(prompt, workingSetContext, inspectorContext)
  const workspaceContextLines = workspaceProfile
    ? [
        'Workspace preprocessing context:',
        `- root: ${workspaceProfile.rootDir}`,
        `- summary: ${workspaceProfile.summary}`,
        workspaceProfile.languages.length > 0
          ? `- languages: ${workspaceProfile.languages.join(', ')}`
          : '',
        workspaceProfile.topDirectories.length > 0
          ? `- dominant directories: ${workspaceProfile.topDirectories.join(', ')}`
          : '',
        workspaceProfile.entryFiles.length > 0
          ? `- likely entry files: ${workspaceProfile.entryFiles.join(', ')}`
          : '',
        workspaceProfile.notableTags.length > 0
          ? `- notable tags: ${workspaceProfile.notableTags.join(', ')}`
          : '',
      ].filter(Boolean)
    : []
  const purposeSummaryLines = buildPurposeSummaryContext(
    preprocessedWorkspaceContext,
    workingSetContext,
    inspectorContext,
  )

  if (workspaceContextLines.length === 0 && purposeSummaryLines.length === 0) {
    return scopedPrompt
  }

  return [
    ...workspaceContextLines,
    ...purposeSummaryLines,
    'Use this preprocessed workspace context first, then inspect raw code only where needed.',
    '',
    scopedPrompt,
  ].join('\n')
}

function buildAgentPromptMetadata(
  prompt: string,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  const workingSetScope = hasScopeContext(workingSetContext)
    ? buildScopeMetadata(workingSetContext)
    : null
  const inspectorPaths = hasScopeContext(inspectorContext)
    ? getScopePaths(inspectorContext)
    : []
  const workingSetPaths = workingSetScope?.paths ?? []

  return {
    kind: 'workspace_chat',
    paths: [...new Set([...workingSetPaths, ...inspectorPaths])],
    scope: workingSetScope,
    task: prompt.trim().replace(/\s+/g, ' ').slice(0, 160),
  }
}

function buildScopeAwarePrompt(
  prompt: string,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  if (hasScopeContext(workingSetContext)) {
    const contextLines = [
      'Semanticode working set:',
      'Treat this pinned working set as the primary scope for the request.',
      'Inspect and modify these files or symbols before searching elsewhere in the repository.',
      'Only leave this working set when you need external dependency context or the user clearly redirects you.',
      'If you leave scope, state briefly why.',
      ...buildScopeContextLines(workingSetContext),
    ]

    if (hasScopeContext(inspectorContext) && !areScopeContextsEquivalent(workingSetContext, inspectorContext)) {
      contextLines.push(
        '',
        'Current transient inspector selection:',
        ...buildScopeContextLines(inspectorContext),
      )
    }

    return `${contextLines.join('\n')}\n\nUser request:\n${prompt}`
  }

  return buildInspectorScopedPrompt(prompt, inspectorContext)
}

function buildPurposeSummaryContext(
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentPanelProps['inspectorContext'],
) {
  if (!preprocessedWorkspaceContext?.purposeSummaries.length) {
    return []
  }

  const selectedSummaries = selectRelevantPurposeSummaries(
    preprocessedWorkspaceContext.purposeSummaries,
    workingSetContext,
    inspectorContext,
  )

  if (selectedSummaries.length === 0) {
    return []
  }

  return [
    'Relevant preprocessed purpose summaries:',
    ...selectedSummaries.map((summary) => {
      const domains =
        summary.domainHints.length > 0 ? ` domains=${summary.domainHints.join(', ')}` : ''
      const sideEffects =
        summary.sideEffects.length > 0 ? ` side_effects=${summary.sideEffects.join(', ')}` : ''
      return `- ${summary.path}: ${summary.summary}${domains}${sideEffects}`
    }),
  ]
}

function selectRelevantPurposeSummaries(
  summaries: SemanticPurposeSummaryRecord[],
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentPanelProps['inspectorContext'],
) {
  const workingSetFileIds = new Set(
    workingSetContext?.files.map((file) => file.id) ??
      (workingSetContext?.file ? [workingSetContext.file.id] : []),
  )
  const workingSetSymbolIds = new Set(
    workingSetContext?.symbols.map((symbol) => symbol.id) ??
      (workingSetContext?.symbol ? [workingSetContext.symbol.id] : []),
  )
  const selectedFileIds = new Set(
    inspectorContext?.files.map((file) => file.id) ??
      (inspectorContext?.file ? [inspectorContext.file.id] : []),
  )
  const selectedSymbolIds = new Set(
    inspectorContext?.symbols.map((symbol) => symbol.id) ??
      (inspectorContext?.symbol ? [inspectorContext.symbol.id] : []),
  )
  const selectedNodePath = inspectorContext?.node?.path ?? ''
  const selectedSymbolId = inspectorContext?.symbol?.id ?? ''
  const selectedSymbolPath = inspectorContext?.symbol?.path ?? ''

  return [...summaries]
    .map((summary) => ({
      summary,
      score: scorePurposeSummary(summary, {
        workingSetFileIds,
        workingSetSymbolIds,
        selectedFileIds,
        selectedSymbolIds,
        selectedNodePath,
        selectedSymbolId,
        selectedSymbolPath,
      }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return left.summary.path.localeCompare(right.summary.path)
    })
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_VISIBLE_PURPOSE_SUMMARIES)
    .map((entry) => entry.summary)
}

function scorePurposeSummary(
  summary: SemanticPurposeSummaryRecord,
  input: {
    workingSetFileIds: Set<string>
    workingSetSymbolIds: Set<string>
    selectedFileIds: Set<string>
    selectedSymbolIds: Set<string>
    selectedNodePath: string
    selectedSymbolId: string
    selectedSymbolPath: string
  },
) {
  let score = 0

  if (input.workingSetFileIds.has(summary.fileId)) {
    score += 12
  }

  if (input.workingSetSymbolIds.has(summary.symbolId)) {
    score += 14
  }

  if (input.selectedFileIds.has(summary.fileId)) {
    score += 8
  }

  if (input.selectedSymbolId && summary.symbolId === input.selectedSymbolId) {
    score += 12
  }

  if (input.selectedSymbolIds.has(summary.symbolId)) {
    score += 10
  }

  if (input.selectedSymbolPath && summary.path === input.selectedSymbolPath) {
    score += 10
  }

  if (input.selectedNodePath && summary.path.startsWith(input.selectedNodePath)) {
    score += 6
  }

  score += Math.min(summary.sideEffects.length, 3)
  score += Math.min(summary.domainHints.length, 2)

  if (
    score === 0 &&
    (summary.sideEffects.length > 0 || summary.domainHints.length > 0)
  ) {
    score = 1
  }

  return score
}

function describeInspectorContext(inspectorContext: {
  file: CodebaseFile | null
  files: CodebaseFile[]
  node: ProjectNode | null
  symbol: SymbolNode | null
  symbols: SymbolNode[]
}) {
  if (inspectorContext.symbol) {
    const rangeText = inspectorContext.symbol.range
      ? ` at lines ${formatRange(inspectorContext.symbol.range)}`
      : ''
    return `${inspectorContext.symbol.symbolKind}${rangeText}. Requests will default to this symbol.`
  }

  if (inspectorContext.symbols.length > 1) {
    return `Requests will default to this ${inspectorContext.symbols.length}-symbol edit set.`
  }

  if (inspectorContext.files.length > 1) {
    return `Requests will default to this ${inspectorContext.files.length}-file edit set.`
  }

  if (inspectorContext.file) {
    return 'Requests will default to this file.'
  }

  if (inspectorContext.node) {
    return `Requests will default to this ${inspectorContext.node.kind}.`
  }

  return ''
}

function hasScopeContext(
  context: AgentScopeContext | null | undefined,
): context is AgentScopeContext {
  return Boolean(
    context &&
      (
        context.file ||
        context.files.length > 0 ||
        context.symbols.length > 0 ||
        context.symbol ||
        context.node
      ),
  )
}

function buildScopeContextLines(context: AgentScopeContext) {
  const contextLines: string[] = []

  if (context.symbols.length > 1) {
    contextLines.push('Selected symbols (primary first):')

    for (const symbol of context.symbols) {
      contextLines.push(`- ${symbol.path}`)
    }
  } else if (context.files.length > 1) {
    contextLines.push('Selected files (primary first):')

    for (const file of context.files) {
      contextLines.push(`- ${file.path}`)
    }
  } else if (context.file) {
    contextLines.push(`Selected file: ${context.file.path}`)
  }

  if (context.symbol) {
    contextLines.push(`Selected symbol: ${context.symbol.path}`)
    contextLines.push(`Selected symbol kind: ${context.symbol.symbolKind}`)
    if (context.symbol.facets.length > 0) {
      contextLines.push(`Selected symbol facets: ${context.symbol.facets.join(', ')}`)
    }

    if (context.symbol.range) {
      contextLines.push(`Selected symbol range: lines ${formatRange(context.symbol.range)}`)
    }
  } else if (context.file) {
    if (context.file.facets.length > 0) {
      contextLines.push(`Selected file facets: ${context.file.facets.join(', ')}`)
    }
  } else if (context.node) {
    contextLines.push(`Selected node: ${context.node.path}`)
    contextLines.push(`Selected node kind: ${context.node.kind}`)
    if (context.node.facets.length > 0) {
      contextLines.push(`Selected node facets: ${context.node.facets.join(', ')}`)
    }
  }

  return contextLines
}

function buildScopeMetadata(context: AgentScopeContext) {
  const paths = getScopePaths(context)

  if (paths.length === 0) {
    return null
  }

  return {
    paths,
    symbolPaths: getScopeSymbolPaths(context),
    title: describeScopeContextTitle(context),
  }
}

function getScopePaths(context: AgentScopeContext) {
  const paths = new Set<string>()

  if (context.file) {
    paths.add(context.file.path)
  }

  for (const file of context.files) {
    paths.add(file.path)
  }

  if (context.symbol) {
    const ownerFile = context.files.find((file) => file.id === context.symbol?.fileId)

    if (ownerFile) {
      paths.add(ownerFile.path)
    }
  }

  return [...paths]
}

function getScopeSymbolPaths(context: AgentScopeContext) {
  const symbolPaths = new Set<string>()

  if (context.symbol) {
    symbolPaths.add(context.symbol.path)
  }

  for (const symbol of context.symbols) {
    symbolPaths.add(symbol.path)
  }

  return [...symbolPaths]
}

function describeScopeContextTitle(context: AgentScopeContext) {
  if (context.symbols.length > 1) {
    return `${context.symbols.length} selected symbols`
  }

  if (context.files.length > 1) {
    return `${context.files.length} selected files`
  }

  return context.symbol?.path ?? context.file?.path ?? context.node?.path ?? 'Current selection'
}

function renderScopeContextList(context: AgentScopeContext) {
  if (context.symbols.length > 1) {
    return (
      <ul className="cbv-agent-context-list">
        {context.symbols.slice(0, MAX_VISIBLE_CONTEXT_FILES).map((symbol, index) => (
          <li key={symbol.id}>
            <strong>{index === 0 ? 'Primary' : `Symbol ${index + 1}`}</strong>
            <span>{symbol.path}</span>
          </li>
        ))}
      </ul>
    )
  }

  if (context.files.length > 1) {
    return (
      <ul className="cbv-agent-context-list">
        {context.files.slice(0, MAX_VISIBLE_CONTEXT_FILES).map((file, index) => (
          <li key={file.id}>
            <strong>{index === 0 ? 'Primary' : `File ${index + 1}`}</strong>
            <span>{file.path}</span>
          </li>
        ))}
      </ul>
    )
  }

  return null
}

function renderScopeContextOverflow(context: AgentScopeContext) {
  if (context.symbols.length > MAX_VISIBLE_CONTEXT_FILES) {
    return (
      <p className="cbv-agent-context-more">
        + {context.symbols.length - MAX_VISIBLE_CONTEXT_FILES} more selected symbol
        {context.symbols.length - MAX_VISIBLE_CONTEXT_FILES === 1 ? '' : 's'}
      </p>
    )
  }

  if (context.files.length > MAX_VISIBLE_CONTEXT_FILES) {
    return (
      <p className="cbv-agent-context-more">
        + {context.files.length - MAX_VISIBLE_CONTEXT_FILES} more selected file
        {context.files.length - MAX_VISIBLE_CONTEXT_FILES === 1 ? '' : 's'}
      </p>
    )
  }

  return null
}

function areScopeContextsEquivalent(
  left: AgentScopeContext | null | undefined,
  right: AgentScopeContext | null | undefined,
) {
  if (!hasScopeContext(left) || !hasScopeContext(right)) {
    return false
  }

  const leftIds = getScopeContextNodeIds(left)
  const rightIds = getScopeContextNodeIds(right)

  if (leftIds.length !== rightIds.length) {
    return false
  }

  return leftIds.every((nodeId, index) => nodeId === rightIds[index])
}

function getScopeContextNodeIds(context: AgentScopeContext) {
  if (context.symbols.length > 0) {
    return context.symbols.map((symbol) => symbol.id)
  }

  if (context.files.length > 0) {
    return context.files.map((file) => file.id)
  }

  if (context.symbol) {
    return [context.symbol.id]
  }

  if (context.file) {
    return [context.file.id]
  }

  return context.node ? [context.node.id] : []
}

function formatRange(range: SourceRange) {
  const startLine = range.start.line
  const endLine = range.end.line

  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`
}

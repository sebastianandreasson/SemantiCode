import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../../agent/DesktopAgentClient'
import {
  getCommandSuggestions,
  runAgentLocalCommand,
} from '../../agent/agentCommands'
import {
  buildAgentPromptMetadata,
  buildWorkspaceContextInjection,
} from '../../agent/agentPromptContext'
import {
  areScopeContextsEquivalent,
  hasScopeContext,
  type AgentScopeContext,
} from '../../agent/agentScopeContext'
import {
  createAgentModelKey,
  formatAgentModelOption,
  getAvailableAgentModelOptions,
  getSelectableModels,
  getSessionCapabilities,
  parseAgentModelKey,
} from '../../agent/agentModelOptions'
import type {
  AgentAuthMode,
  AgentControlState,
  AgentEvent,
  AgentSessionSummary,
  AgentSettingsState,
  AgentTimelineItem,
} from '../../schema/agent'
import type {
  PreprocessedWorkspaceContext,
  WorkspaceProfile,
} from '../../types'
import { useAgentSettingsDraft } from '../agentPanel/useAgentSettingsDraft'
import { isTimelineScrolledNearBottom } from './agentTimelineScroll'
import { useAgentSettingsActions } from './useAgentSettingsActions'

interface UseAgentSessionControllerInput {
  autoFocusComposer?: boolean
  composerFocusRequestKey?: number
  desktopHostAvailable?: boolean
  inspectorContext?: AgentScopeContext
  onActiveSessionChange?: (session: AgentSessionSummary | null) => void
  onChatSessionCleared?: (session: AgentSessionSummary | null) => void
  onRunSettled?: () => Promise<void>
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  promptSeed?: {
    id: string
    value: string
  } | null
  settingsOnly?: boolean
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export function useAgentSessionController({
  autoFocusComposer = false,
  composerFocusRequestKey = 0,
  desktopHostAvailable = false,
  inspectorContext,
  onActiveSessionChange,
  onChatSessionCleared,
  onRunSettled,
  preprocessedWorkspaceContext = null,
  promptSeed = null,
  settingsOnly = false,
  workingSetContext = null,
  workspaceProfile = null,
}: UseAgentSessionControllerInput) {
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
  const [timeline, setTimeline] = useState<AgentTimelineItem[]>([])
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
  const [controls, setControls] = useState<AgentControlState | null>(null)
  const [settings, setSettings] = useState<AgentSettingsState | null>(null)
  const {
    applySettingsDraftFromSettings,
    settingsDraft,
    updateSettingsDraft,
  } = useAgentSettingsDraft()
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
  const authModeValue = settingsDraft.authMode
  const providerValue = settingsDraft.provider
  const modelValue = settingsDraft.modelId
  const apiKeyValue = settingsDraft.apiKey
  const manualRedirectUrlValue = settingsDraft.manualRedirectUrl
  const openAiOAuthClientIdValue = settingsDraft.openAiOAuthClientId
  const openAiOAuthClientSecretValue = settingsDraft.openAiOAuthClientSecret
  const toolProfileValue = settingsDraft.toolProfile
  const settingsDraftDirty = settingsDraft.dirty

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    if (settingsOnly) {
      return
    }

    onActiveSessionChange?.(session)
  }, [onActiveSessionChange, session, settingsOnly])

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
          applySettingsDraftFromSettings(nextSettings)
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

        handleAgentEvent(event, sessionRef, setTimeline, setSession)

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
  }, [
    agentClient,
    applySettingsDraftFromSettings,
    bridgeInfo.hasAgentBridge,
    settingsDraftDirty,
  ])

  useEffect(() => {
    if (!settings || !providerValue) {
      return
    }

    const availableModels = getSelectableModels(settings, authModeValue, providerValue)

    if (availableModels.some((model) => model.id === modelValue)) {
      return
    }

    updateSettingsDraft({ modelId: availableModels[0]?.id ?? '' })
  }, [authModeValue, modelValue, providerValue, settings, updateSettingsDraft])

  useEffect(() => {
    if (authModeValue === 'brokered_oauth' && providerValue && providerValue !== 'openai-codex') {
      updateSettingsDraft({ provider: 'openai-codex' })
    }
  }, [authModeValue, providerValue, updateSettingsDraft])

  useEffect(() => {
    const listElement = messageListRef.current

    if (!listElement || !shouldStickToTimelineBottomRef.current) {
      return
    }

    listElement.scrollTop = listElement.scrollHeight
  }, [timeline])

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

      const localCommandName = getLocalCommandName(nextPrompt)

      if (await handleLocalCommand(nextPrompt)) {
        if (localCommandName === 'clear') {
          onChatSessionCleared?.(sessionRef.current)
        }

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
      applySettingsDraftFromSettings(nextSettings)
    } else {
      updateSettingsDraft({
        authMode: input.authMode ?? authModeValue,
        modelId: input.modelId,
        provider: input.provider,
      })
    }

    setSession(resolvedSession)
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
    return runAgentLocalCommand({
      agentClient,
      appendLocalLifecycle,
      applyControls,
      applySessionState,
      authModeValue,
      command,
      getControls: () => controlsRef.current,
      getSession: () => sessionRef.current,
      providerValue,
      session,
      settings,
      setTimeline,
      switchAgentModel,
    })
  }

  function applyControls(nextControls: AgentControlState) {
    controlsRef.current = nextControls
    setControls(nextControls)
  }

  function applySessionState(
    nextSession: AgentSessionSummary | null,
    nextTimeline: AgentTimelineItem[] | undefined,
  ) {
    setSession(nextSession)
    setTimeline(nextTimeline ?? [])
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

  const {
    handleBrokeredLogout,
    handleClearApiKey,
    handleClearOpenAiOAuthOverride,
    handleCompleteManualRedirect,
    handleImportCodexLogin,
    handleSaveSettings,
    handleStartBrokeredLogin,
    persistSettingsDraftIfNeeded,
  } = useAgentSettingsActions({
    agentClient,
    apiKeyValue,
    applySettingsDraftFromSettings,
    authModeValue,
    manualRedirectUrlValue,
    modelValue,
    openAiOAuthClientIdValue,
    openAiOAuthClientSecretValue,
    providerValue,
    setErrorMessage,
    setOauthLoginUrl,
    setOauthStatusMessage,
    setSession,
    setSettings,
    setSettingsPending,
    setTimeline,
    settings,
    settingsDraftDirty,
    toolProfileValue,
  })

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

  function handleComposerChange(value: string) {
    setComposerState({
      seedId: promptSeed?.id ?? composerState.seedId,
      value,
    })
  }

  return {
    apiKeyValue,
    authModeValue,
    availableModels,
    commandSuggestions,
    composerRef,
    composerValue,
    errorMessage,
    handleBrokeredLogout,
    handleCancel,
    handleClearApiKey,
    handleClearOpenAiOAuthOverride,
    handleCompleteManualRedirect,
    handleComposerChange,
    handleImportCodexLogin,
    handleSaveSettings,
    handleStartBrokeredLogin,
    handleSubmit,
    handleTerminalModelChange,
    handleTimelineScroll,
    hasInspectorContext,
    hasWorkingSetContext,
    manualRedirectUrlValue,
    messageListRef,
    modelValue,
    oauthLoginUrl,
    oauthStatusMessage,
    openAiOAuthClientIdValue,
    openAiOAuthClientSecretValue,
    pending,
    providerValue,
    selectedModelKey,
    sendDisabledReason,
    session,
    sessionCapabilities,
    sessionControls,
    sessionIsInteractive,
    settings,
    settingsPending,
    terminalModelOptions,
    timeline,
    toolProfileValue,
    updateSettingsDraft,
    workingSetMatchesInspectorContext,
  }
}

function handleAgentEvent(
  event: AgentEvent,
  sessionRef: { current: AgentSessionSummary | null },
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

    case 'tool':
      break

    case 'message':
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

function getLocalCommandName(command: string) {
  if (!command.startsWith('/')) {
    return null
  }

  return command.slice(1).trim().split(/\s+/)[0] || null
}

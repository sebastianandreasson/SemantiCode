import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../agent/DesktopAgentClient'
import type {
  AgentAuthMode,
  AgentEvent,
  AgentMessage,
  AgentSessionListItem,
  AgentSessionSummary,
  AgentSettingsState,
  AgentTimelineItem,
  AgentToolInvocation,
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
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [timeline, setTimeline] = useState<AgentTimelineItem[]>([])
  const [, setSessions] = useState<AgentSessionListItem[]>([])
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
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
  const previousRunStateRef = useRef<AgentSessionSummary['runState'] | null>(null)
  const composerValue =
    promptSeed && promptSeed.id !== composerState.seedId
      ? promptSeed.value
      : composerState.value
  const displayTimeline = useMemo(
    () => timeline.length > 0 ? timeline : createTimelineFromMessages(messages),
    [messages, timeline],
  )

  useEffect(() => {
    sessionRef.current = session
  }, [session])

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
      setBridgeInfo(normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable))
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

        if (brokerJustBecameRunnable) {
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

    const syncAll = async () => {
      await syncSettings()

      if (cancelled) {
        return
      }

      await syncHttpState()
    }

    if (bridgeInfo.hasAgentBridge) {
      unsubscribe = agentClient.subscribe((event) => {
        if (cancelled) {
          return
        }

        handleAgentEvent(event, setMessages, setTimeline, setSession)
      })
    }

    intervalId = window.setInterval(() => {
      void syncAll()
    }, 1000)

    void syncAll()

    return () => {
      cancelled = true
      unsubscribe()
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [agentClient, bridgeInfo, openAiOAuthClientIdDirty, settingsDraftDirty])

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
    if (!messageListRef.current) {
      return
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight
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

    try {
      setPending(true)
      setErrorMessage(null)

      if (await handleLocalCommand(nextPrompt)) {
        setComposerState({
          seedId: promptSeed?.id ?? composerState.seedId,
          value: '',
        })
        return
      }

      await persistSettingsDraftIfNeeded()
      const ok = await agentClient.sendMessage(
        {
          message: buildWorkspaceScopedPrompt(
            nextPrompt,
            workspaceProfile,
            preprocessedWorkspaceContext,
            workingSetContext,
            inspectorContext,
          ),
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

  async function handleLocalCommand(command: string) {
    if (!command.startsWith('/')) {
      return false
    }

    const [commandName, ...commandArgs] = command.slice(1).trim().split(/\s+/)
    const commandValue = commandArgs.join(' ').trim()

    if (commandName === 'new') {
      const nextSession = await agentClient.newSession()
      const state = await agentClient.getHttpState()

      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'resume') {
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
      if (!commandValue) {
        appendLocalLifecycle(
          'model',
          session ? `${session.provider}/${session.modelId}` : 'No active session.',
          'completed',
        )
        return true
      }

      if (!settings) {
        appendLocalLifecycle('model failed', 'Agent settings are not loaded yet.', 'error')
        return true
      }

      const availableModels = getSelectableModels(settings, authModeValue, providerValue)

      if (!availableModels.some((model) => model.id === commandValue)) {
        appendLocalLifecycle(
          'model failed',
          `Unknown model ${commandValue}. Available: ${availableModels.map((model) => model.id).join(', ')}`,
          'error',
        )
        return true
      }

      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: commandValue,
      })
      const nextSession = await agentClient.createSession()
      const state = await agentClient.getHttpState()

      setSettings(nextSettings)
      setModelValue(nextSettings.modelId)
      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      appendLocalLifecycle('model changed', `${providerValue}/${commandValue}`, 'completed')
      return true
    }

    if (commandName === 'thinking') {
      if (!commandValue) {
        appendLocalLifecycle(
          'thinking',
          `Current: ${session?.thinkingLevel ?? 'medium'}`,
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

      setSession(nextSession ?? state.session)
      setMessages(state.messages)
      setTimeline(state.timeline ?? [])
      return true
    }

    if (commandName === 'compact') {
      const state = await agentClient.compact(commandValue || undefined)

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
    session?.runState === 'disabled'
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
        <div>
          <p className="cbv-eyebrow">Session</p>
          <strong>
            {session ? `${session.provider}/${session.modelId}` : 'Starting…'}
          </strong>
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
          <span>model {session.provider}/{session.modelId}</span>
          <span>thinking {session.thinkingLevel ?? 'medium'}</span>
          <span className={`cbv-agent-terminal-state is-${session.runState}`}>
            {session.runState}
          </span>
          <span title={session.sessionFile ?? undefined}>
            session {session.sessionName ?? abbreviateId(session.id)}
          </span>
          <span>
            queue s:{session.queue?.steering ?? 0} f:{session.queue?.followUp ?? 0}
          </span>
        </div>

        <AgentTerminalTimeline items={displayTimeline} listRef={messageListRef} />

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
            placeholder="/new /resume /model /thinking /session /compact /clear or ask…"
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
              </>
            ) : (
              <button
                disabled={
                  pending ||
                  composerValue.trim().length === 0 ||
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
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>,
  setTimeline: Dispatch<SetStateAction<AgentTimelineItem[]>>,
  setSession: Dispatch<SetStateAction<AgentSessionSummary | null>>,
) {
  switch (event.type) {
    case 'session_created':
    case 'session_updated':
      setSession(event.session)
      break

    case 'message':
      setMessages((messages) => upsertMessage(messages, event.message))
      setTimeline((timeline) =>
        createTimelineFromMessages([event.message]).reduce(upsertTimelineItem, timeline),
      )
      break

    case 'tool':
      setTimeline((timeline) =>
        upsertTimelineItem(timeline, createToolTimelineItemFromInvocation(event.invocation)),
      )
      break

    case 'timeline':
      setTimeline((timeline) => upsertTimelineItem(timeline, event.item))
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

function AgentTerminalTimeline({
  items,
  listRef,
}: {
  items: AgentTimelineItem[]
  listRef: RefObject<HTMLDivElement | null>
}) {
  return (
    <div className="cbv-agent-terminal-timeline" ref={listRef}>
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
    <article className={`cbv-agent-terminal-row is-message is-${item.role}`}>
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

function createTimelineFromMessages(messages: AgentMessage[]): AgentTimelineItem[] {
  return messages.flatMap((message) => {
    if (message.blocks.length === 0) {
      return [
        {
          blockKind: 'text',
          createdAt: message.createdAt,
          id: `agent-timeline:message:${message.id}:empty`,
          isStreaming: message.isStreaming,
          messageId: message.id,
          role: message.role,
          text: '',
          type: 'message' as const,
        },
      ]
    }

    return message.blocks.map((block, index) => ({
      blockKind: block.kind,
      createdAt: message.createdAt,
      id: `agent-timeline:message:${message.id}:${block.kind}:${index}`,
      isStreaming: message.isStreaming,
      messageId: message.id,
      role: message.role,
      text: block.text,
      type: 'message' as const,
    }))
  })
}

function createToolTimelineItemFromInvocation(
  invocation: AgentToolInvocation,
): AgentTimelineItem {
  const startedAtMs = new Date(invocation.startedAt).getTime()
  const endedAtMs = invocation.endedAt ? new Date(invocation.endedAt).getTime() : null
  const durationMs =
    endedAtMs !== null && Number.isFinite(startedAtMs)
      ? Math.max(0, endedAtMs - startedAtMs)
      : undefined

  return {
    args: invocation.args,
    createdAt: invocation.startedAt,
    durationMs,
    endedAt: invocation.endedAt,
    id: `agent-timeline:tool:${invocation.toolCallId}`,
    isError: invocation.isError,
    paths: invocation.paths,
    resultPreview: invocation.resultPreview,
    startedAt: invocation.startedAt,
    status: invocation.endedAt ? (invocation.isError ? 'error' : 'completed') : 'running',
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    type: 'tool',
  }
}

function upsertTimelineItem(
  timeline: AgentTimelineItem[],
  nextItem: AgentTimelineItem,
) {
  const existingIndex = timeline.findIndex((item) => item.id === nextItem.id)

  if (existingIndex === -1) {
    return [...timeline, nextItem]
  }

  return timeline.map((item, index) => index === existingIndex ? nextItem : item)
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

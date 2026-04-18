import { useEffect, useMemo, useRef, useState } from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../agent/DesktopAgentClient'
import type {
  AgentAuthMode,
  AgentEvent,
  AgentMessage,
  AgentSessionSummary,
  AgentSettingsState,
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

        handleAgentEvent(event, setMessages, setSession)
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

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelValue(availableModels[0]?.id ?? '')
  }, [authModeValue, modelValue, providerValue, settings])

  useEffect(() => {
    if (authModeValue === 'brokered_oauth' && providerValue && providerValue !== 'openai') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProviderValue('openai')
    }
  }, [authModeValue, providerValue])

  useEffect(() => {
    if (!messageListRef.current) {
      return
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight
  }, [messages])

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

  async function handleSubmit() {
    const nextPrompt = composerValue.trim()

    if (!nextPrompt || pending) {
      return
    }

    try {
      setPending(true)
      setErrorMessage(null)
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
      <div className="cbv-agent-thread">
        <div className="cbv-agent-messages" ref={messageListRef}>
          {messages.length ? (
            messages.map((message) => (
              <article
                className={`cbv-agent-message is-${message.role}`}
                key={message.id}
              >
                <header>
                  <strong>{message.role}</strong>
                  {message.isStreaming ? <span>streaming</span> : null}
                </header>
                <div className="cbv-agent-message-body">
                  {message.blocks.length ? (
                    message.blocks.map((block, index) => (
                      <p key={`${message.id}:${block.kind}:${index}`}>{block.text || ' '}</p>
                    ))
                  ) : (
                    <p>{message.role === 'assistant' ? '…' : ''}</p>
                  )}
                </div>
              </article>
            ))
          ) : (
            <div className="cbv-empty">
              <h2>No agent messages yet</h2>
              <p>Send a prompt to the embedded PI runtime from here.</p>
            </div>
          )}
        </div>

        <div className="cbv-agent-composer">
          {hasWorkingSetContext ? (
            <div className="cbv-agent-context">
              <p className="cbv-eyebrow">Pinned working set</p>
              <strong>
                {describeScopeContextTitle(workingSetContext)}
              </strong>
              <p>
                Agent requests will start from this working set and only leave it when blocked.
                {workingSet?.source === 'selection' ? ' Pinned from selection.' : ''}
              </p>
              {renderScopeContextList(workingSetContext)}
              {renderScopeContextOverflow(workingSetContext)}
              <div className="cbv-agent-context-actions">
                {hasInspectorContext && !workingSetMatchesInspectorContext && onAdoptInspectorContextAsWorkingSet ? (
                  <button onClick={onAdoptInspectorContextAsWorkingSet} type="button">
                    Replace with current selection
                  </button>
                ) : null}
                {onClearWorkingSet ? (
                  <button className="is-secondary" onClick={onClearWorkingSet} type="button">
                    Clear working set
                  </button>
                ) : null}
              </div>
            </div>
          ) : hasInspectorContext ? (
            <div className="cbv-agent-context">
              <p className="cbv-eyebrow">Current inspector target</p>
              <strong>
                {describeScopeContextTitle(inspectorContext)}
              </strong>
              <p>
                {describeInspectorContext(inspectorContext)}
              </p>
              {renderScopeContextList(inspectorContext)}
              {renderScopeContextOverflow(inspectorContext)}
              {onAdoptInspectorContextAsWorkingSet ? (
                <div className="cbv-agent-context-actions">
                  <button onClick={onAdoptInspectorContextAsWorkingSet} type="button">
                    Use as working set
                  </button>
                </div>
              ) : null}
            </div>
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
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleSubmit()
              }
            }}
            placeholder="Ask about this repository or request a change…"
            rows={4}
            value={composerValue}
          />
          <div className="cbv-agent-actions">
            <button
              className="is-secondary"
              disabled={session?.runState !== 'running'}
              onClick={() => {
                void handleCancel()
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              disabled={
                pending ||
                composerValue.trim().length === 0 ||
                session?.runState === 'disabled' ||
                session?.runState === 'initializing'
              }
              title={sendDisabledReason ?? undefined}
              onClick={() => {
                void handleSubmit()
              }}
              type="button"
            >
              Send
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  )
}

function handleAgentEvent(
  event: AgentEvent,
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>,
  setSession: React.Dispatch<React.SetStateAction<AgentSessionSummary | null>>,
) {
  switch (event.type) {
    case 'session_created':
    case 'session_updated':
      setSession(event.session)
      break

    case 'message':
      setMessages((messages) => upsertMessage(messages, event.message))
      break

    case 'tool':
    case 'permission_request':
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

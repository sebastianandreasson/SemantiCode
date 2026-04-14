import { useEffect, useMemo, useRef, useState } from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../agent/DesktopAgentClient'
import type {
  AgentAuthMode,
  AgentEvent,
  AgentMessage,
  AgentSessionSummary,
  AgentSettingsState,
} from '../schema/agent'

interface AgentPanelProps {
  desktopHostAvailable?: boolean
}

export function AgentPanel({ desktopHostAvailable = false }: AgentPanelProps) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [bridgeInfo, setBridgeInfo] = useState<DesktopAgentBridgeInfo>(() =>
    normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable),
  )
  const [composerValue, setComposerValue] = useState('')
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
  const [settings, setSettings] = useState<AgentSettingsState | null>(null)
  const [authModeValue, setAuthModeValue] = useState<AgentAuthMode>('brokered_oauth')
  const [providerValue, setProviderValue] = useState('')
  const [modelValue, setModelValue] = useState('')
  const [apiKeyValue, setApiKeyValue] = useState('')
  const [pending, setPending] = useState(false)
  const [settingsPending, setSettingsPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const messageListRef = useRef<HTMLDivElement | null>(null)

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
        setAuthModeValue(nextSettings.authMode)
        setProviderValue(nextSettings.provider)
        setModelValue(nextSettings.modelId)
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

    if (bridgeInfo.hasAgentBridge) {
      unsubscribe = agentClient.subscribe((event) => {
        if (cancelled) {
          return
        }

        handleAgentEvent(event, setMessages, setSession)
      })
    } else {
      intervalId = window.setInterval(() => {
        void syncHttpState()
      }, 1000)
    }

    void agentClient.createSession().then(async (nextSession) => {
      if (cancelled) {
        return
      }

      if (nextSession) {
        setSession(nextSession)
      }

      await syncHttpState()
      await syncSettings()
      setErrorMessage(null)
    }).catch((error) => {
      if (cancelled) {
        return
      }

      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to initialize the agent session.',
      )
    })

    return () => {
      cancelled = true
      unsubscribe()
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [agentClient, bridgeInfo])

  useEffect(() => {
    if (!settings || !providerValue) {
      return
    }

    const availableModels = settings.availableModelsByProvider[providerValue] ?? []

    if (availableModels.some((model) => model.id === modelValue)) {
      return
    }

    setModelValue(availableModels[0]?.id ?? '')
  }, [modelValue, providerValue, settings])

  useEffect(() => {
    if (!messageListRef.current) {
      return
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight
  }, [messages])

  async function handleSubmit() {
    const nextPrompt = composerValue.trim()

    if (!nextPrompt || pending) {
      return
    }

    try {
      setPending(true)
      setErrorMessage(null)
      const ok = await agentClient.sendMessage(nextPrompt)

      if (!ok) {
        throw new Error('No active desktop agent session is available.')
      }

      setComposerValue('')
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to send the prompt to the agent.',
      )
    } finally {
      setPending(false)
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
      const nextSettings = await agentClient.saveSettings({
        authMode: authModeValue,
        provider: providerValue,
        modelId: modelValue,
        apiKey: apiKeyValue.trim() || undefined,
      })

      setSettings(nextSettings)
      setAuthModeValue(nextSettings.authMode)
      setProviderValue(nextSettings.provider)
      setModelValue(nextSettings.modelId)
      setApiKeyValue('')

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

  const availableModels = settings?.availableModelsByProvider[providerValue] ?? []

  return (
    <div className="cbv-agent-panel">
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

      {!bridgeInfo.hasAgentBridge ? (
        <p className="cbv-agent-warning">
          Bridge state: {bridgeInfo.hasDesktopHost ? 'desktop host detected' : 'desktop host not detected'}, agent bridge not detected. Using HTTP fallback.
        </p>
      ) : null}

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
              onChange={(event) => setAuthModeValue(event.target.value as AgentAuthMode)}
              value={authModeValue}
            >
              <option value="brokered_oauth">Brokered OAuth</option>
              <option value="api_key">API key</option>
            </select>
          </label>

          <label>
            <span>Provider</span>
            <select
              disabled={settingsPending || !settings}
              onChange={(event) => setProviderValue(event.target.value)}
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
              onChange={(event) => setModelValue(event.target.value)}
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
                onChange={(event) => setApiKeyValue(event.target.value)}
                placeholder={settings?.hasApiKey ? 'Stored key present. Enter a new key to replace it.' : 'Enter provider API key'}
                type="password"
                value={apiKeyValue}
              />
            </label>
          ) : (
            <div className="cbv-agent-oauth-placeholder">
              <strong>Brokered OAuth</strong>
              <p>
                This is now modeled as the primary auth path. The backend broker,
                browser login flow, and `AppTransport` integration still need to be
                implemented.
              </p>
              <p>
                {settings?.brokerSession.state === 'unconfigured'
                  ? 'No broker backend is configured yet.'
                  : 'A broker backend is configured, but sign-in is not implemented yet.'}
              </p>
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
          <button
            disabled={settingsPending || !providerValue || !modelValue}
            onClick={() => {
              void handleSaveSettings()
            }}
            type="button"
          >
            {settingsPending ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </section>

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
        <textarea
          onChange={(event) => setComposerValue(event.target.value)}
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

function upsertMessage(messages: AgentMessage[], nextMessage: AgentMessage) {
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex === -1) {
    return [...messages, nextMessage]
  }

  return messages.map((message, index) =>
    index === existingIndex ? nextMessage : message,
  )
}

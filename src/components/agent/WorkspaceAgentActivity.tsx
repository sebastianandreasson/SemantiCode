import { useEffect, useMemo, useRef, useState } from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../../agent/DesktopAgentClient'
import type { AgentEvent, AgentMessage, AgentSessionSummary } from '../../schema/agent'

interface WorkspaceAgentActivityProps {
  desktopHostAvailable?: boolean
  preprocessingStatus?: {
    activity: 'embeddings' | 'summaries' | null
    currentItemPath: string | null
    processedSymbols: number
    runState: 'idle' | 'building' | 'ready' | 'stale' | 'error'
    totalSymbols: number
  } | null
  workingSetSummary?: {
    label: string
    title: string
    paths: string[]
  } | null
}

export function WorkspaceAgentActivity({
  desktopHostAvailable = false,
  preprocessingStatus = null,
  workingSetSummary = null,
}: WorkspaceAgentActivityProps) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [bridgeInfo, setBridgeInfo] = useState<DesktopAgentBridgeInfo>(() =>
    normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable),
  )
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const sessionFingerprintRef = useRef<string | null>(null)
  const messagesFingerprintRef = useRef<string | null>(null)

  useEffect(() => {
    const updateBridgeInfo = () => {
      setBridgeInfo(normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable))
    }

    updateBridgeInfo()
    const timeoutId = window.setTimeout(updateBridgeInfo, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [agentClient, desktopHostAvailable])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: () => void = () => undefined
    let intervalId = 0

    const syncState = async () => {
      try {
        const state = await agentClient.getHttpState()

        if (cancelled || !state) {
          return
        }

        const nextSessionFingerprint = getSessionFingerprint(state.session)
        const nextMessagesFingerprint = getMessagesFingerprint(state.messages)

        if (sessionFingerprintRef.current !== nextSessionFingerprint) {
          sessionFingerprintRef.current = nextSessionFingerprint
          setSession(state.session)
        }

        if (modalOpen && messagesFingerprintRef.current !== nextMessagesFingerprint) {
          messagesFingerprintRef.current = nextMessagesFingerprint
          setMessages(state.messages)
        }

        setErrorMessage(null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to read the workspace agent state.',
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
    }

    intervalId = window.setInterval(() => {
      void syncState()
    }, 1000)

    void agentClient
      .createSession()
      .then(async (nextSession) => {
        if (cancelled) {
          return
        }

        if (nextSession) {
          setSession(nextSession)
        }

        await syncState()
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to initialize the workspace agent session.',
        )
      })

    return () => {
      cancelled = true
      unsubscribe()
      if (intervalId) {
        window.clearInterval(intervalId)
      }
    }
  }, [agentClient, bridgeInfo, modalOpen])

  useEffect(() => {
    if (!modalOpen) {
      return
    }

    void agentClient
      .getHttpState()
      .then((state) => {
        if (!state) {
          return
        }

        messagesFingerprintRef.current = getMessagesFingerprint(state.messages)
        setMessages(state.messages)
      })
      .catch(() => undefined)
  }, [agentClient, modalOpen])

  useEffect(() => {
    if (!modalOpen || !messageListRef.current) {
      return
    }

    messageListRef.current.scrollTop = messageListRef.current.scrollHeight
  }, [messages, modalOpen])

  const isActive =
    session?.runState === 'running' || session?.runState === 'initializing'
  const preprocessingActive =
    preprocessingStatus?.runState === 'building' &&
    preprocessingStatus.activity === 'summaries'

  if (!isActive && !preprocessingActive && !modalOpen) {
    return null
  }

  return (
    <>
      {isActive || preprocessingActive ? (
        <button
          className="cbv-agent-activity-button"
          onClick={() => setModalOpen(true)}
          type="button"
        >
          <span className="cbv-agent-activity-spinner" aria-hidden="true" />
          <span>
            {isActive
              ? session?.runState === 'initializing'
                ? 'Preparing agent…'
                : 'Agent working…'
              : 'Building summaries…'}
          </span>
        </button>
      ) : null}

      {modalOpen ? (
        <div
          className="cbv-modal-backdrop"
          onClick={() => setModalOpen(false)}
          role="presentation"
        >
          <section
            aria-label="Workspace agent activity"
            className="cbv-modal cbv-agent-activity-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cbv-modal-header">
              <div>
                <p className="cbv-eyebrow">Workspace agent</p>
                <strong>
                  {session ? `${session.provider}/${session.modelId}` : 'No active session'}
                </strong>
              </div>
              <button
                aria-label="Close workspace agent activity"
                className="cbv-inspector-close"
                onClick={() => setModalOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>

            <div className="cbv-agent-activity-modal-body">
              <div className="cbv-agent-meta">
                <div>
                  <p className="cbv-eyebrow">Status</p>
                  <strong>{session?.workspaceRootDir ?? 'Unknown workspace'}</strong>
                </div>
                <div className={`cbv-agent-status is-${session?.runState ?? 'idle'}`}>
                  {session?.runState ?? 'idle'}
                </div>
              </div>

              {preprocessingActive ? (
                <div className="cbv-agent-working-set">
                  <p className="cbv-eyebrow">Summary build</p>
                  <strong>
                    {preprocessingStatus?.processedSymbols ?? 0}/
                    {preprocessingStatus?.totalSymbols ?? 0} symbols
                  </strong>
                  <p>
                    These are one-off Codex runs used for preprocessing, so they do not stream
                    through the normal workspace agent session.
                  </p>
                  {preprocessingStatus?.currentItemPath ? (
                    <p
                      className="cbv-agent-working-set-more"
                      title={preprocessingStatus.currentItemPath}
                    >
                      Current: {preprocessingStatus.currentItemPath}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {workingSetSummary ? (
                <div className="cbv-agent-working-set" title={workingSetSummary.title}>
                  <p className="cbv-eyebrow">Working set</p>
                  <strong>{workingSetSummary.label}</strong>
                  {workingSetSummary.paths.length > 0 ? (
                    <ul className="cbv-agent-working-set-list">
                      {workingSetSummary.paths.slice(0, 6).map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  ) : null}
                  {workingSetSummary.paths.length > 6 ? (
                    <p className="cbv-agent-working-set-more">
                      + {workingSetSummary.paths.length - 6} more in scope
                    </p>
                  ) : null}
                </div>
              ) : null}

              {session?.lastError ? (
                <p className="cbv-agent-warning">{session.lastError}</p>
              ) : null}

              {errorMessage ? <p className="cbv-agent-error">{errorMessage}</p> : null}

              <div className="cbv-agent-messages cbv-agent-activity-messages" ref={messageListRef}>
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
                            <p key={`${message.id}:${block.kind}:${index}`}>
                              {block.text || ' '}
                            </p>
                          ))
                        ) : (
                          <p>{message.role === 'assistant' ? '…' : ''}</p>
                        )}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="cbv-empty">
                    <h2>No agent output yet</h2>
                    <p>Streaming output will appear here while the workspace agent is active.</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
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

function upsertMessage(messages: AgentMessage[], nextMessage: AgentMessage) {
  const existingIndex = messages.findIndex((message) => message.id === nextMessage.id)

  if (existingIndex === -1) {
    return [...messages, nextMessage]
  }

  return messages.map((message, index) =>
    index === existingIndex ? nextMessage : message,
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

function getSessionFingerprint(session: AgentSessionSummary | null) {
  if (!session) {
    return 'none'
  }

  return [
    session.id,
    session.runState,
    session.updatedAt,
    session.lastError ?? '',
  ].join('::')
}

function getMessagesFingerprint(messages: AgentMessage[]) {
  return messages
    .map((message) => {
      const text = message.blocks.map((block) => block.text ?? '').join('\n')

      return [
        message.id,
        message.createdAt,
        message.isStreaming ? '1' : '0',
        text.length,
        text.slice(-48),
      ].join(':')
    })
    .join('|')
}

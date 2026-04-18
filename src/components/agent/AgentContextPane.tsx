import { useEffect, useMemo, useState } from 'react'

import { DesktopAgentClient, type DesktopAgentBridgeInfo } from '../../agent/DesktopAgentClient'
import type { AgentSessionSummary } from '../../schema/agent'
import type { WorkingSetState, WorkspaceProfile } from '../../types'
import type { AgentScopeContext } from '../AgentPanel'

interface AgentContextPaneProps {
  desktopHostAvailable?: boolean
  inspectorContext?: AgentScopeContext
  onAdoptInspectorContextAsWorkingSet?: () => void
  onClearWorkingSet?: () => void
  onOpenDrawer?: () => void
  onOpenSettings?: () => void
  workingSet?: WorkingSetState | null
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export function AgentContextPane({
  desktopHostAvailable = false,
  inspectorContext,
  onAdoptInspectorContextAsWorkingSet,
  onClearWorkingSet,
  onOpenDrawer,
  onOpenSettings,
  workingSet = null,
  workingSetContext = null,
  workspaceProfile = null,
}: AgentContextPaneProps) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [bridgeInfo, setBridgeInfo] = useState<DesktopAgentBridgeInfo>(() =>
    normalizeBridgeInfo(agentClient.getBridgeInfo(), desktopHostAvailable),
  )
  const [session, setSession] = useState<AgentSessionSummary | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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

    const syncSession = async () => {
      try {
        const state = await agentClient.getHttpState()

        if (!cancelled) {
          setSession(state?.session ?? null)
          setErrorMessage(null)
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Failed to read agent session state.',
          )
        }
      }
    }

    const intervalId = window.setInterval(() => {
      void syncSession()
    }, 1000)

    void syncSession()

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [agentClient, bridgeInfo.hasAgentBridge])

  const hasInspectorContext = hasScopeContext(inspectorContext)
  const hasWorkingSetContext = hasScopeContext(workingSetContext)
  const workingSetMatchesInspectorContext =
    hasWorkingSetContext && hasInspectorContext
      ? areScopeContextsEquivalent(workingSetContext, inspectorContext)
      : false

  return (
    <div className="cbv-agent-context-pane">
      <section className="cbv-agent-context-card">
        <div className="cbv-agent-context-card-header">
          <div>
            <p className="cbv-eyebrow">Session</p>
            <strong>
              {session ? `${session.provider}/${session.modelId}` : 'No active session'}
            </strong>
          </div>
          <div className={`cbv-agent-status is-${session?.runState ?? 'idle'}`}>
            {session?.runState ?? 'idle'}
          </div>
        </div>
        <p className="cbv-agent-context-copy">
          {workspaceProfile?.summary ??
            'The bottom drawer is the primary place to chat with the embedded agent.'}
        </p>
        <div className="cbv-agent-context-actions">
          {onOpenDrawer ? (
            <button onClick={onOpenDrawer} type="button">
              Open Drawer
            </button>
          ) : null}
          {onOpenSettings ? (
            <button className="is-secondary" onClick={onOpenSettings} type="button">
              Settings
            </button>
          ) : null}
        </div>
        {session?.lastError ? <p className="cbv-agent-warning">{session.lastError}</p> : null}
        {errorMessage ? <p className="cbv-agent-error">{errorMessage}</p> : null}
      </section>

      {hasWorkingSetContext ? (
        <section className="cbv-agent-context-card">
          <p className="cbv-eyebrow">Pinned working set</p>
          <strong>{describeScopeContextTitle(workingSetContext)}</strong>
          <p className="cbv-agent-context-copy">
            Agent requests will start from this working set and only leave it when blocked.
            {workingSet?.source === 'selection' ? ' Pinned from selection.' : ''}
          </p>
          {renderScopeContextList(workingSetContext)}
          {renderScopeContextOverflow(workingSetContext)}
          <div className="cbv-agent-context-actions">
            {hasInspectorContext &&
            !workingSetMatchesInspectorContext &&
            onAdoptInspectorContextAsWorkingSet ? (
              <button onClick={onAdoptInspectorContextAsWorkingSet} type="button">
                Replace With Selection
              </button>
            ) : null}
            {onClearWorkingSet ? (
              <button className="is-secondary" onClick={onClearWorkingSet} type="button">
                Clear Working Set
              </button>
            ) : null}
          </div>
        </section>
      ) : hasInspectorContext ? (
        <section className="cbv-agent-context-card">
          <p className="cbv-eyebrow">Current selection</p>
          <strong>{describeScopeContextTitle(inspectorContext)}</strong>
          <p className="cbv-agent-context-copy">{describeInspectorContext(inspectorContext)}</p>
          {renderScopeContextList(inspectorContext)}
          {renderScopeContextOverflow(inspectorContext)}
          {onAdoptInspectorContextAsWorkingSet ? (
            <div className="cbv-agent-context-actions">
              <button onClick={onAdoptInspectorContextAsWorkingSet} type="button">
                Use As Working Set
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
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

function hasScopeContext(
  context: AgentScopeContext | null | undefined,
): context is AgentScopeContext {
  return Boolean(
    context &&
      (context.file || context.symbol || context.node || context.files.length || context.symbols.length),
  )
}

function describeScopeContextTitle(context: AgentScopeContext) {
  if (context.symbols.length > 1) {
    return `${context.symbols.length} symbols`
  }

  if (context.files.length > 1) {
    return `${context.files.length} files`
  }

  return context.symbol?.name ?? context.file?.name ?? context.node?.name ?? 'Selection'
}

function describeInspectorContext(context: AgentScopeContext) {
  if (context.symbols.length > 1) {
    return 'Treat the currently selected symbols as the primary edit scope.'
  }

  if (context.files.length > 1) {
    return 'Treat the currently selected files as the primary edit scope.'
  }

  if (context.symbol) {
    return `Focused symbol in ${context.file?.path ?? context.symbol.path}.`
  }

  if (context.file) {
    return `Focused file ${context.file.path}.`
  }

  return 'The current inspector target will be used as the default context.'
}

function renderScopeContextList(context: AgentScopeContext) {
  if (context.symbols.length > 1) {
    return (
      <ul className="cbv-agent-context-list">
        {context.symbols.slice(0, 6).map((symbol) => (
          <li key={symbol.id}>
            <strong>{symbol.name}</strong>
            <span>{symbol.path}</span>
          </li>
        ))}
      </ul>
    )
  }

  if (context.files.length > 1) {
    return (
      <ul className="cbv-agent-context-list">
        {context.files.slice(0, 6).map((file) => (
          <li key={file.id}>
            <strong>{file.name}</strong>
            <span>{file.path}</span>
          </li>
        ))}
      </ul>
    )
  }

  return null
}

function renderScopeContextOverflow(context: AgentScopeContext) {
  if (context.symbols.length > 6) {
    return (
      <p className="cbv-agent-context-more">+ {context.symbols.length - 6} more symbols in scope</p>
    )
  }

  if (context.files.length > 6) {
    return (
      <p className="cbv-agent-context-more">+ {context.files.length - 6} more files in scope</p>
    )
  }

  return null
}

function areScopeContextsEquivalent(left: AgentScopeContext, right: AgentScopeContext) {
  return JSON.stringify(getScopePaths(left)) === JSON.stringify(getScopePaths(right))
}

function getScopePaths(context: AgentScopeContext) {
  const paths = [
    ...context.symbols.map((symbol) => symbol.path),
    ...context.files.map((file) => file.path),
    context.symbol?.path ?? '',
    context.file?.path ?? '',
    context.node?.path ?? '',
  ]

  return [...new Set(paths.filter(Boolean))].sort()
}

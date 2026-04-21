import { useMemo, useState, type ReactNode } from 'react'

import type { AgentScopeContext } from '../../agent/agentScopeContext'
import type {
  AgentSessionSummary,
  AutonomousRunDetail,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
  PreprocessedWorkspaceContext,
  WorkspaceProfile,
  WorkingSetState,
} from '../../types'
import { AgentPanel } from '../AgentPanel'
import { AutonomousRunsSurface } from '../runs/AutonomousRunsSurface'

export type AgentDrawerTab = 'chat' | 'agents' | 'layout'

export interface AgentPromptSeed {
  id: string
  value: string
}

export interface AgentPanelContentProps {
  activeRunId: string | null
  activeTab: AgentDrawerTab
  autonomousRuns: AutonomousRunSummary[]
  autoFocusComposer?: boolean
  composerFocusRequestKey?: number
  desktopHostAvailable?: boolean
  detectedTaskFile?: string | null
  dockMoveHandle?: ReactNode
  errorMessage?: string | null
  inspectorContext?: AgentScopeContext
  layoutDraftError?: string | null
  layoutDraftPending?: boolean
  layoutDraftPrompt?: string
  onAdoptInspectorContextAsWorkingSet?: () => void
  onActiveSessionChange?: (session: AgentSessionSummary | null) => void
  onChangeTab: (tab: AgentDrawerTab) => void
  onChatSessionCleared?: (session: AgentSessionSummary | null) => void
  onClearWorkingSet?: () => void
  onClose: () => void
  onLayoutDraftPromptChange?: (value: string) => void
  onLayoutDraftSubmit?: () => void
  onOpenSettings?: () => void
  onRunSettled?: () => Promise<void>
  onSelectRun?: (runId: string) => void
  onStartRun?: () => void
  onStopRun?: (runId: string) => void
  pendingRunAction?: boolean
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  promptSeed?: AgentPromptSeed | null
  selectedRunDetail?: AutonomousRunDetail | null
  selectedRunId?: string | null
  timeline?: AutonomousRunTimelinePoint[]
  workingSet?: WorkingSetState | null
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export interface AgentCollapsedLauncherProps {
  active: boolean
  onOpen: () => void
  onPromptSeed?: (value: string) => void
  trailLabel?: string | null
}

interface AgentDrawerProps extends Omit<AgentPanelContentProps, 'onClose' | 'promptSeed'> {
  onToggleOpen: () => void
  open: boolean
  trailLabel?: string | null
}

export function AgentCollapsedLauncher({
  active,
  onOpen,
  onPromptSeed,
  trailLabel = null,
}: AgentCollapsedLauncherProps) {
  const [stripValue, setStripValue] = useState('')
  const stripStatus = active ? 'running' : 'idle'
  const stripTrail = trailLabel?.trim() || 'idle'

  function handlePromoteComposer() {
    const nextPrompt = stripValue.trim()

    onOpen()

    if (nextPrompt) {
      onPromptSeed?.(nextPrompt)
      setStripValue('')
    }
  }

  return (
    <section className="cbv-agent-drawer is-collapsed">
      <div className="cbv-agent-strip">
        <span className={`cbv-agent-strip-dot is-${stripStatus}`} />
        <span className="cbv-agent-strip-label">agent</span>
        <span className="cbv-agent-strip-trail" title={stripTrail}>
          following · {stripTrail}
        </span>
        <input
          className="cbv-agent-strip-input"
          onChange={(event) => setStripValue(event.target.value)}
          onFocus={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handlePromoteComposer()
            }
          }}
          placeholder="ask agent"
          type="text"
          value={stripValue}
        />
        <button
          className="cbv-agent-strip-submit"
          onClick={handlePromoteComposer}
          title="Open agent composer"
          type="button"
        >
          ↵
        </button>
        <button
          aria-expanded={false}
          className="cbv-agent-strip-toggle"
          onClick={onOpen}
          type="button"
        >
          ⌘K
        </button>
      </div>
    </section>
  )
}

export function AgentPanelContent({
  activeRunId,
  activeTab,
  autonomousRuns,
  autoFocusComposer = true,
  composerFocusRequestKey = 0,
  desktopHostAvailable = false,
  detectedTaskFile = null,
  dockMoveHandle = null,
  errorMessage = null,
  inspectorContext,
  layoutDraftError = null,
  layoutDraftPending = false,
  layoutDraftPrompt = '',
  onAdoptInspectorContextAsWorkingSet,
  onActiveSessionChange,
  onChangeTab,
  onChatSessionCleared,
  onClearWorkingSet,
  onClose,
  onLayoutDraftPromptChange,
  onLayoutDraftSubmit,
  onOpenSettings,
  onRunSettled,
  onSelectRun,
  onStartRun,
  onStopRun,
  pendingRunAction = false,
  preprocessedWorkspaceContext = null,
  promptSeed = null,
  selectedRunDetail = null,
  selectedRunId = null,
  timeline = [],
  workingSet = null,
  workingSetContext = null,
  workspaceProfile = null,
}: AgentPanelContentProps) {
  return (
    <section className="cbv-agent-drawer is-open is-docked">
      <div className="cbv-agent-drawer-body">
        <div className="cbv-agent-drawer-header">
          <div className="cbv-agent-drawer-header-actions">
            {dockMoveHandle}
            <button
              aria-expanded
              aria-label="Close agent drawer"
              className="cbv-inspector-close cbv-agent-drawer-close"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
          <div className="cbv-agent-drawer-tabs" role="tablist" aria-label="Agent drawer">
            {([
              { id: 'chat', label: 'chat' },
              { id: 'agents', label: 'agents' },
              { id: 'layout', label: 'layout' },
            ] as const).map((tab) => (
              <button
                aria-selected={activeTab === tab.id}
                className={`is-${tab.id}${activeTab === tab.id ? ' is-active' : ''}`}
                key={tab.id}
                onClick={() => onChangeTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        {activeTab === 'chat' ? (
          <AgentPanel
            autoFocusComposer={autoFocusComposer}
            composerFocusRequestKey={composerFocusRequestKey}
            desktopHostAvailable={desktopHostAvailable}
            inspectorContext={inspectorContext}
            onAdoptInspectorContextAsWorkingSet={onAdoptInspectorContextAsWorkingSet}
            onActiveSessionChange={onActiveSessionChange}
            onChatSessionCleared={onChatSessionCleared}
            onClearWorkingSet={onClearWorkingSet}
            onOpenSettings={onOpenSettings}
            onRunSettled={onRunSettled}
            preprocessedWorkspaceContext={preprocessedWorkspaceContext}
            promptSeed={promptSeed}
            workingSet={workingSet}
            workingSetContext={workingSetContext}
            workspaceProfile={workspaceProfile}
          />
        ) : activeTab === 'agents' ? (
          <div className="cbv-agent-drawer-panel">
            <AutonomousRunsSurface
              activeRunId={activeRunId}
              detectedTaskFile={detectedTaskFile}
              errorMessage={errorMessage}
              onSelectRun={onSelectRun ?? (() => {})}
              onStartRun={onStartRun ?? (() => {})}
              onStopRun={onStopRun ?? (() => {})}
              pending={pendingRunAction}
              selectedRunDetail={selectedRunDetail}
              selectedRunId={selectedRunId}
              timeline={timeline}
              runs={autonomousRuns}
            />
          </div>
        ) : (
          <div className="cbv-agent-drawer-panel cbv-agent-layout-panel">
            <section className="cbv-agent-layout-card">
              <div className="cbv-agent-layout-copy">
                <p className="cbv-eyebrow">Layout</p>
                <strong>Create a new scene</strong>
                <p>
                  Describe how the current codebase should be arranged. This uses the layout
                  planner and creates a draft layout rather than sending a normal chat message.
                </p>
              </div>
              <form
                className={`cbv-agent-layout-form${layoutDraftPending ? ' is-pending' : ''}`}
                onSubmit={(event) => {
                  event.preventDefault()
                  onLayoutDraftSubmit?.()
                }}
              >
                <textarea
                  aria-label="Describe a new layout"
                  disabled={layoutDraftPending || !onLayoutDraftPromptChange}
                  onChange={(event) => onLayoutDraftPromptChange?.(event.target.value)}
                  placeholder="Arrange React components around routes and keep backend APIs grouped by feature"
                  value={layoutDraftPrompt}
                />
                <div className="cbv-agent-layout-actions">
                  <p>
                    {layoutDraftPending
                      ? 'Generating a new layout draft...'
                      : layoutDraftError ?? 'The generated draft opens in the inspector context panel for review.'}
                  </p>
                  <button
                    className="cbv-toolbar-button"
                    disabled={
                      layoutDraftPending ||
                      !layoutDraftPrompt.trim() ||
                      !onLayoutDraftSubmit
                    }
                    type="submit"
                  >
                    {layoutDraftPending ? 'working...' : 'create layout'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </div>
    </section>
  )
}

export function AgentDrawer({
  activeRunId,
  activeTab,
  autonomousRuns,
  onChangeTab,
  onToggleOpen,
  open,
  trailLabel = null,
  ...contentProps
}: AgentDrawerProps) {
  const activeRun = useMemo(
    () => autonomousRuns.find((run) => run.runId === activeRunId) ?? null,
    [activeRunId, autonomousRuns],
  )
  const [promptSeed, setPromptSeed] = useState<AgentPromptSeed | null>(null)

  if (!open) {
    return (
      <AgentCollapsedLauncher
        active={Boolean(activeRun)}
        onOpen={() => {
          onChangeTab('chat')
          onToggleOpen()
        }}
        onPromptSeed={(value) => {
          onChangeTab('chat')
          setPromptSeed({
            id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
            value,
          })
        }}
        trailLabel={trailLabel}
      />
    )
  }

  return (
    <AgentPanelContent
      {...contentProps}
      activeRunId={activeRunId}
      activeTab={activeTab}
      autonomousRuns={autonomousRuns}
      onChangeTab={onChangeTab}
      onClose={onToggleOpen}
      promptSeed={promptSeed}
    />
  )
}

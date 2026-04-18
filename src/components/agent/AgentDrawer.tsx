import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type {
  AutonomousRunDetail,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
  PreprocessedWorkspaceContext,
  WorkspaceProfile,
  WorkingSetState,
} from '../../types'
import { AgentPanel, type AgentScopeContext } from '../AgentPanel'
import { AutonomousRunsSurface } from '../runs/AutonomousRunsSurface'

type AgentDrawerTab = 'chat' | 'agents' | 'layout'

const DEFAULT_DRAWER_HEIGHT = 288
const MIN_DRAWER_HEIGHT = 220
const MAX_DRAWER_HEIGHT = 640

interface AgentDrawerProps {
  activeRunId: string | null
  activeTab: AgentDrawerTab
  autonomousRuns: AutonomousRunSummary[]
  composerFocusRequestKey?: number
  desktopHostAvailable?: boolean
  detectedTaskFile?: string | null
  errorMessage?: string | null
  inspectorContext?: AgentScopeContext
  layoutSuggestionError?: string | null
  layoutSuggestionPending?: boolean
  layoutSuggestionText?: string
  onAdoptInspectorContextAsWorkingSet?: () => void
  onChangeTab: (tab: AgentDrawerTab) => void
  onClearWorkingSet?: () => void
  onLayoutSuggestionChange?: (value: string) => void
  onLayoutSuggestionSubmit?: () => void
  onOpenSettings?: () => void
  onRunSettled?: () => Promise<void>
  onSelectRun?: (runId: string) => void
  onStartRun?: () => void
  onStopRun?: (runId: string) => void
  onToggleOpen: () => void
  open: boolean
  pendingRunAction?: boolean
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  selectedRunDetail?: AutonomousRunDetail | null
  selectedRunId?: string | null
  timeline?: AutonomousRunTimelinePoint[]
  trailLabel?: string | null
  workingSet?: WorkingSetState | null
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export function AgentDrawer({
  activeRunId,
  activeTab,
  autonomousRuns,
  composerFocusRequestKey = 0,
  desktopHostAvailable = false,
  detectedTaskFile = null,
  errorMessage = null,
  inspectorContext,
  layoutSuggestionError = null,
  layoutSuggestionPending = false,
  layoutSuggestionText = '',
  onAdoptInspectorContextAsWorkingSet,
  onChangeTab,
  onClearWorkingSet,
  onLayoutSuggestionChange,
  onLayoutSuggestionSubmit,
  onOpenSettings,
  onRunSettled,
  onSelectRun,
  onStartRun,
  onStopRun,
  onToggleOpen,
  open,
  pendingRunAction = false,
  preprocessedWorkspaceContext = null,
  selectedRunDetail = null,
  selectedRunId = null,
  timeline = [],
  trailLabel = null,
  workingSet = null,
  workingSetContext = null,
  workspaceProfile = null,
}: AgentDrawerProps) {
  const activeRun = useMemo(
    () => autonomousRuns.find((run) => run.runId === activeRunId) ?? null,
    [activeRunId, autonomousRuns],
  )
  const [stripValue, setStripValue] = useState('')
  const [promptSeed, setPromptSeed] = useState<{ id: string; value: string } | null>(null)
  const [drawerHeight, setDrawerHeight] = useState(DEFAULT_DRAWER_HEIGHT)
  const [activeResizePointerId, setActiveResizePointerId] = useState<number | null>(null)
  const resizeStateRef = useRef<{
    startHeight: number
    startY: number
  } | null>(null)

  useEffect(() => {
    if (activeResizePointerId === null) {
      return
    }

    const previousUserSelect = document.body.style.userSelect

    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current

      if (!resizeState) {
        return
      }

      const viewportMaxHeight = Math.max(
        MIN_DRAWER_HEIGHT,
        Math.min(MAX_DRAWER_HEIGHT, window.innerHeight - 180),
      )
      const nextHeight = resizeState.startHeight + (resizeState.startY - event.clientY)

      setDrawerHeight(
        Math.min(viewportMaxHeight, Math.max(MIN_DRAWER_HEIGHT, nextHeight)),
      )
    }

    function handlePointerUp() {
      resizeStateRef.current = null
      setActiveResizePointerId(null)
    }

    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [activeResizePointerId])

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!open) {
      return
    }

    resizeStateRef.current = {
      startHeight: drawerHeight,
      startY: event.clientY,
    }
    setActiveResizePointerId(event.pointerId)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function ensureOpen() {
    if (!open) {
      onToggleOpen()
    }
  }

  function handlePromoteComposer() {
    const nextPrompt = stripValue.trim()
    onChangeTab('chat')
    ensureOpen()

    if (nextPrompt) {
      setPromptSeed({
        id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
        value: nextPrompt,
      })
      setStripValue('')
    }
  }

  const stripStatus = activeRun ? 'running' : 'idle'
  const stripTrail = trailLabel?.trim() || 'idle'

  return (
    <section
      className={`cbv-agent-drawer${open ? ' is-open' : ' is-collapsed'}`}
      style={{
        '--cbv-agent-drawer-height': `${drawerHeight}px`,
      } as CSSProperties}
    >
      {open ? (
        <button
          aria-label="Resize agent drawer"
          className="cbv-agent-drawer-resize-handle"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize agent drawer"
          type="button"
        >
          <span />
        </button>
      ) : null}
      {!open ? (
        <div className="cbv-agent-strip">
          <span className={`cbv-agent-strip-dot is-${stripStatus}`} />
          <span className="cbv-agent-strip-label">agent</span>
          <span className="cbv-agent-strip-trail" title={stripTrail}>
            following · {stripTrail}
          </span>
          <input
            className="cbv-agent-strip-input"
            onChange={(event) => setStripValue(event.target.value)}
            onFocus={() => {
              onChangeTab('chat')
              ensureOpen()
            }}
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
            aria-expanded={open}
            className="cbv-agent-strip-toggle"
            onClick={() => {
              onChangeTab('chat')
              onToggleOpen()
            }}
            type="button"
          >
            ⌘K
          </button>
        </div>
      ) : null}

      {open ? (
        <div className="cbv-agent-drawer-body">
          <div className="cbv-agent-drawer-header">
            <button
              aria-expanded={open}
              aria-label="Close agent drawer"
              className="cbv-inspector-close cbv-agent-drawer-close"
              onClick={onToggleOpen}
              type="button"
            >
              ×
            </button>
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
              autoFocusComposer
              composerFocusRequestKey={composerFocusRequestKey}
              desktopHostAvailable={desktopHostAvailable}
              inspectorContext={inspectorContext}
              onAdoptInspectorContextAsWorkingSet={onAdoptInspectorContextAsWorkingSet}
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
                  className={`cbv-agent-layout-form${layoutSuggestionPending ? ' is-pending' : ''}`}
                  onSubmit={(event) => {
                    event.preventDefault()
                    onLayoutSuggestionSubmit?.()
                  }}
                >
                  <textarea
                    aria-label="Describe a new layout"
                    disabled={layoutSuggestionPending || !onLayoutSuggestionChange}
                    onChange={(event) => onLayoutSuggestionChange?.(event.target.value)}
                    placeholder="Arrange React components around routes and keep backend APIs grouped by feature"
                    value={layoutSuggestionText}
                  />
                  <div className="cbv-agent-layout-actions">
                    <p>
                      {layoutSuggestionPending
                        ? 'Generating a new layout draft...'
                        : layoutSuggestionError ?? 'The generated draft can be accepted or rejected from the scene strip.'}
                    </p>
                    <button
                      className="cbv-toolbar-button"
                      disabled={
                        layoutSuggestionPending ||
                        !layoutSuggestionText.trim() ||
                        !onLayoutSuggestionSubmit
                      }
                      type="submit"
                    >
                      {layoutSuggestionPending ? 'working...' : 'create layout'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

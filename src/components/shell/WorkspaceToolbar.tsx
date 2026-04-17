interface LayoutOption {
  label: string
  value: string
}

interface WorkspaceToolbarProps {
  activeDraft: boolean
  activeLayoutSyncNote?: {
    label: string
    title: string
  } | null
  compareOverlayActive: boolean
  layoutActionsPending: boolean
  layoutOptions: LayoutOption[]
  onAcceptDraft?: () => void | Promise<void>
  onActivateCompareOverlay?: () => void
  onBuildSemanticEmbeddings?: () => void
  onClearCompareOverlay?: () => void
  onOpenAgentSettings: () => void
  onRejectDraft?: () => void | Promise<void>
  onSelectLayoutValue: (value: string) => void
  onStartPreprocessing?: () => void
  onToggleProjectsSidebar?: () => void
  preprocessingStatus?: {
    canBuildEmbeddings: boolean
    currentItemPath?: string | null
    embeddingActionLabel: string
    label: string
    lastError?: string | null
    preprocessingActionLabel: string
    progressPercent: number
    runState: string
    title: string
    workspaceSync?: {
      isOutdated: boolean
      label: string
      title: string
    } | null
  } | null
  onOpenWorkspaceSync?: () => void
  projectsSidebarOpen: boolean
  selectedLayoutValue: string
  showCompareAction: boolean
  workingSetSummary?: {
    label: string
    title: string
  } | null
  workspaceName: string
  workspaceRootDir: string
}

export function WorkspaceToolbar({
  activeDraft,
  activeLayoutSyncNote = null,
  compareOverlayActive,
  layoutActionsPending,
  layoutOptions,
  onAcceptDraft,
  onActivateCompareOverlay,
  onBuildSemanticEmbeddings,
  onClearCompareOverlay,
  onOpenAgentSettings,
  onOpenWorkspaceSync,
  onRejectDraft,
  onSelectLayoutValue,
  onStartPreprocessing,
  onToggleProjectsSidebar,
  preprocessingStatus = null,
  projectsSidebarOpen,
  selectedLayoutValue,
  showCompareAction,
  workingSetSummary = null,
  workspaceName,
  workspaceRootDir,
}: WorkspaceToolbarProps) {
  return (
    <header className="cbv-toolbar">
      <div className="cbv-toolbar-left">
        <div className="cbv-workspace-summary">
          <strong>{workspaceName}</strong>
          <p className="cbv-toolbar-path">{workspaceRootDir}</p>
        </div>
        {workingSetSummary ? (
          <div className="cbv-working-set-chip" title={workingSetSummary.title}>
            <span className="cbv-working-set-chip-dot" />
            <span>{workingSetSummary.label}</span>
          </div>
        ) : null}
        {preprocessingStatus ? (
          <div className="cbv-preprocessing-status-block">
            <div className="cbv-preprocessing-inline">
              <div
                className={`cbv-preprocessing-status is-${preprocessingStatus.runState}`}
                title={preprocessingStatus.title}
              >
                <span className="cbv-preprocessing-status-dot" />
                <span>{preprocessingStatus.label}</span>
              </div>
              {onStartPreprocessing ? (
                <button
                  className="cbv-preprocessing-action"
                  disabled={preprocessingStatus.runState === 'building'}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onStartPreprocessing()
                  }}
                  title="Use the agent to generate semantic purpose summaries."
                  type="button"
                >
                  {preprocessingStatus.preprocessingActionLabel}
                </button>
              ) : null}
              {onBuildSemanticEmbeddings ? (
                <button
                  className="cbv-preprocessing-action is-secondary"
                  disabled={
                    preprocessingStatus.runState === 'building' ||
                    !preprocessingStatus.canBuildEmbeddings
                  }
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onBuildSemanticEmbeddings()
                  }}
                  title="Build local semantic embeddings from cached summaries."
                  type="button"
                >
                  {preprocessingStatus.embeddingActionLabel}
                </button>
              ) : null}
            </div>
            {preprocessingStatus.runState === 'building' ||
            preprocessingStatus.runState === 'stale' ? (
              <div className="cbv-preprocessing-progress">
                <div
                  className="cbv-preprocessing-progress-bar"
                  style={{
                    width: `${preprocessingStatus.progressPercent}%`,
                  }}
                />
              </div>
            ) : null}
            {preprocessingStatus.currentItemPath ? (
              <p
                className="cbv-preprocessing-current"
                title={preprocessingStatus.currentItemPath}
              >
                {preprocessingStatus.currentItemPath}
              </p>
            ) : null}
            {preprocessingStatus.lastError ? (
              <p className="cbv-preprocessing-error">{preprocessingStatus.lastError}</p>
            ) : null}
            {preprocessingStatus.workspaceSync ? (
              <button
                className={`cbv-sync-summary${preprocessingStatus.workspaceSync.isOutdated ? ' is-outdated' : ''}`}
                onClick={onOpenWorkspaceSync}
                title={preprocessingStatus.workspaceSync.title}
                type="button"
              >
                {preprocessingStatus.workspaceSync.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="cbv-toolbar-center">
        <div className="cbv-layout-controls">
          <label className="cbv-layout-picker">
            <span className="cbv-eyebrow">Layouts</span>
            <select
              onChange={(event) => {
                onSelectLayoutValue(event.target.value)
              }}
              value={selectedLayoutValue}
            >
              {layoutOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {activeLayoutSyncNote ? (
            <p className="cbv-layout-sync-note" title={activeLayoutSyncNote.title}>
              {activeLayoutSyncNote.label}
            </p>
          ) : null}
        </div>
      </div>

      <div className="cbv-toolbar-right">
        {activeDraft ? (
          <div className="cbv-draft-actions">
            <button
              disabled={layoutActionsPending || !onAcceptDraft}
              onClick={() => {
                void onAcceptDraft?.()
              }}
              type="button"
            >
              Accept Draft
            </button>
            <button
              className="is-danger"
              disabled={layoutActionsPending || !onRejectDraft}
              onClick={() => {
                void onRejectDraft?.()
              }}
              type="button"
            >
              Reject Draft
            </button>
          </div>
        ) : null}
        {showCompareAction ? (
          <div className="cbv-compare-actions">
            <button
              className={`cbv-toolbar-button${compareOverlayActive ? ' is-active' : ''}`}
              onClick={onActivateCompareOverlay}
              type="button"
            >
              {compareOverlayActive
                ? 'Comparing in Semantic View'
                : 'Compare in Semantic View'}
            </button>
            {compareOverlayActive ? (
              <button
                className="cbv-toolbar-button is-secondary"
                onClick={onClearCompareOverlay}
                type="button"
              >
                Clear Compare
              </button>
            ) : null}
          </div>
        ) : null}
        {onToggleProjectsSidebar ? (
          <button
            className={`cbv-toolbar-button is-secondary${projectsSidebarOpen ? ' is-active' : ''}`}
            onClick={onToggleProjectsSidebar}
            type="button"
          >
            {projectsSidebarOpen ? 'Hide Folders' : 'Folders'}
          </button>
        ) : null}
        <button
          aria-label="Settings"
          className="cbv-toolbar-icon-button"
          onClick={onOpenAgentSettings}
          title="Settings"
          type="button"
        >
          ⚙
        </button>
      </div>
    </header>
  )
}

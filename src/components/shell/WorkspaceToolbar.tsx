interface LayoutOption {
  label: string
  value: string
}

interface WorkspaceToolbarProps {
  layoutOptions: LayoutOption[]
  onOpenAgentSettings: () => void
  onSelectLayoutValue: (value: string) => void
  onToggleProjectsSidebar?: () => void
  preprocessingStatus?: {
    label: string
    runState: string
    title: string
    workspaceSync?: {
      isOutdated: boolean
      title: string
    } | null
  } | null
  onOpenWorkspaceSync?: () => void
  projectsSidebarOpen: boolean
  selectedLayoutValue: string
  workingSetSummary?: {
    label: string
    title: string
  } | null
  workspaceName: string
  workspaceRootDir: string
}

export function WorkspaceToolbar({
  layoutOptions,
  onOpenAgentSettings,
  onOpenWorkspaceSync,
  onSelectLayoutValue,
  onToggleProjectsSidebar,
  preprocessingStatus = null,
  projectsSidebarOpen,
  selectedLayoutValue,
  workingSetSummary = null,
  workspaceName,
  workspaceRootDir,
}: WorkspaceToolbarProps) {
  const preprocessingTone =
    preprocessingStatus?.runState === 'error'
      ? 'error'
      : preprocessingStatus?.runState === 'building'
        ? 'running'
        : preprocessingStatus?.workspaceSync?.isOutdated ||
            preprocessingStatus?.runState === 'stale'
          ? 'stale'
          : preprocessingStatus?.runState === 'ready'
          ? 'ready'
          : 'idle'

  const preprocessingTitle =
    preprocessingStatus?.workspaceSync?.isOutdated
      ? `${preprocessingStatus.title}\n\n${preprocessingStatus.workspaceSync.title}`
      : preprocessingStatus?.title ?? ''

  return (
    <header className="cbv-toolbar">
      <div className="cbv-toolbar-brand">
        {onToggleProjectsSidebar && !projectsSidebarOpen ? (
          <button
            aria-label={`Show ${workspaceName} outline`}
            className="cbv-toolbar-rail-toggle"
            onClick={onToggleProjectsSidebar}
            title={`Show outline for ${workspaceRootDir}`}
            type="button"
          >
            <span aria-hidden="true">▸</span>
            <span>{workspaceName}</span>
          </button>
        ) : null}
        <span aria-hidden="true" className="cbv-brand-mark">
          <span />
        </span>
        <div className="cbv-toolbar-workspace">
          <div className="cbv-toolbar-eyebrow-row">
            <span className="cbv-eyebrow">Semanticode</span>
            {workingSetSummary ? (
              <div className="cbv-working-set-chip" title={workingSetSummary.title}>
                <span className="cbv-working-set-chip-dot" />
                <span>{workingSetSummary.label}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="cbv-toolbar-center">
        <div className="cbv-layout-controls">
          <div className="cbv-layout-picker">
            <select
              aria-label="Layout"
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
          </div>
        </div>
      </div>

      <div className="cbv-toolbar-right">
        {preprocessingStatus ? (
          <div className="cbv-toolbar-status-cluster">
            {onOpenWorkspaceSync ? (
              <button
                className={`cbv-toolbar-status is-${preprocessingTone} is-interactive`}
                onClick={onOpenWorkspaceSync}
                title={preprocessingTitle}
                type="button"
              >
                <span className="cbv-toolbar-status-dot" />
                <span>{preprocessingStatus.label}</span>
              </button>
            ) : (
              <div className={`cbv-toolbar-status is-${preprocessingTone}`} title={preprocessingTitle}>
                <span className="cbv-toolbar-status-dot" />
                <span>{preprocessingStatus.label}</span>
              </div>
            )}
          </div>
        ) : null}
        <button
          className="cbv-toolbar-meta-button"
          onClick={onOpenAgentSettings}
          title="Settings"
          type="button"
        >
          Settings
        </button>
        <span className="cbv-toolbar-shortcut">⌘K</span>
      </div>
    </header>
  )
}

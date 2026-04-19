import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

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
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  const layoutPickerRef = useRef<HTMLDivElement | null>(null)
  const layoutMenuId = useId()
  const selectedLayoutOption = useMemo(
    () =>
      layoutOptions.find((option) => option.value === selectedLayoutValue) ??
      layoutOptions[0] ??
      null,
    [layoutOptions, selectedLayoutValue],
  )
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

  useEffect(() => {
    if (!layoutMenuOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        layoutPickerRef.current &&
        !layoutPickerRef.current.contains(event.target as Node)
      ) {
        setLayoutMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setLayoutMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [layoutMenuOpen])

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
          <div
            className={`cbv-layout-picker${layoutMenuOpen ? ' is-open' : ''}`}
            ref={layoutPickerRef}
          >
            <button
              aria-controls={layoutMenuOpen ? layoutMenuId : undefined}
              aria-expanded={layoutMenuOpen}
              aria-haspopup="listbox"
              aria-label="Layout"
              className="cbv-layout-trigger"
              onClick={() => setLayoutMenuOpen((current) => !current)}
              type="button"
            >
              <span aria-hidden="true" className="cbv-layout-trigger-dot" />
              <span className="cbv-layout-trigger-label">
                {selectedLayoutOption?.label ?? 'Select layout'}
              </span>
              <span aria-hidden="true" className="cbv-layout-trigger-caret">
                ▾
              </span>
            </button>
            {layoutMenuOpen ? (
              <div
                className="cbv-layout-menu"
                id={layoutMenuId}
                role="listbox"
              >
                {layoutOptions.map((option) => (
                  <button
                    aria-selected={option.value === selectedLayoutValue}
                    className={`cbv-layout-option${
                      option.value === selectedLayoutValue ? ' is-selected' : ''
                    }`}
                    key={option.value}
                    onClick={() => {
                      if (option.value !== selectedLayoutValue) {
                        onSelectLayoutValue(option.value)
                      }

                      setLayoutMenuOpen(false)
                    }}
                    role="option"
                    type="button"
                  >
                    <span aria-hidden="true" className="cbv-layout-option-dot" />
                    <span className="cbv-layout-option-label">{option.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
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

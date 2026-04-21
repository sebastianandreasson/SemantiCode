import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'

interface RecentProject {
  name: string
  rootDir: string
  lastOpenedAt: string
}

export interface WorkspaceSidebarGroupItem {
  id: string
  title: string
  subtitle: string
  badge?: string | null
  metric?: number | null
}

export interface WorkspaceSidebarGroup {
  id: string
  label: string
  metricLabel: string
  tone: string
  items: WorkspaceSidebarGroupItem[]
}

interface WorkspaceSidebarProps {
  canManageProjects: boolean
  currentRootDir: string
  groups: WorkspaceSidebarGroup[]
  onClose: () => void
  onOpenRecentProject: (rootDir: string) => void
  onOpenWorkspace: () => void
  onRemoveRecentProject: (rootDir: string) => void | Promise<void>
  onSelectSymbol: (nodeId: string) => void
  open: boolean
  recentProjects: RecentProject[]
  selectedNodeId: string | null
  dockMoveHandle?: ReactNode
  workspaceActionError?: string | null
  workspaceActionPending?: boolean
}

export function WorkspaceSidebar({
  canManageProjects,
  currentRootDir,
  groups,
  onClose,
  onOpenRecentProject,
  onOpenWorkspace,
  onRemoveRecentProject,
  onSelectSymbol,
  open,
  recentProjects,
  selectedNodeId,
  dockMoveHandle = null,
  workspaceActionError = null,
  workspaceActionPending = false,
}: WorkspaceSidebarProps) {
  const [filterValue, setFilterValue] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [workspacesViewRootDir, setWorkspacesViewRootDir] = useState<string | null>(null)
  const [removalCandidate, setRemovalCandidate] = useState<RecentProject | null>(null)
  const normalizedFilter = filterValue.trim().toLowerCase()
  const totalVisibleSymbols = groups.reduce((count, group) => count + group.items.length, 0)
  const totalVisibleLoc = groups.reduce(
    (count, group) =>
      count + group.items.reduce((itemCount, item) => itemCount + (item.metric ?? 0), 0),
    0,
  )
  const currentWorkspaceName =
    currentRootDir.split('/').filter(Boolean).at(-1) ?? currentRootDir
  const sidebarView = workspacesViewRootDir === currentRootDir ? 'workspaces' : 'outline'

  const filteredGroups = useMemo(() => {
    if (!normalizedFilter) {
      return groups
    }

    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const haystack = `${item.title}\n${item.subtitle}\n${item.badge ?? ''}`.toLowerCase()
          return haystack.includes(normalizedFilter)
        }),
      }))
      .filter((group) => group.items.length > 0)
  }, [groups, normalizedFilter])

  return (
    <aside className={`cbv-workspace-sidebar${open ? '' : ' is-collapsed'}`}>
      <div className="cbv-workspace-sidebar-actions">
        {dockMoveHandle}
        <button
          aria-label="Hide workspace sidebar"
          className="cbv-inspector-close cbv-workspace-sidebar-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>

      {sidebarView === 'workspaces' ? (
        <section className="cbv-sidebar-section cbv-sidebar-workspaces">
          <div className="cbv-sidebar-section-header">
            <button
              className="cbv-sidebar-inline-action"
              onClick={() => setWorkspacesViewRootDir(null)}
              type="button"
            >
              ← outline
            </button>
            <small>{recentProjects.length}</small>
          </div>
          {recentProjects.length ? (
            <div className="cbv-workspace-recents">
              {recentProjects.slice(0, 8).map((project) => {
                const isActive = project.rootDir === currentRootDir

                return (
                  <article
                    className={`cbv-workspace-recent-row${isActive ? ' is-active' : ''}`}
                    key={project.rootDir}
                  >
                    <button
                      className={`cbv-workspace-recent-item${isActive ? ' is-active' : ''}`}
                      disabled={workspaceActionPending || isActive}
                      onClick={() => onOpenRecentProject(project.rootDir)}
                      type="button"
                    >
                      <strong>{project.name}</strong>
                      <span title={project.rootDir}>{project.rootDir}</span>
                    </button>
                    {!isActive ? (
                      <button
                        aria-label={`Remove ${project.name} from workspace history`}
                        className="cbv-workspace-recent-remove"
                        disabled={workspaceActionPending}
                        onClick={() => setRemovalCandidate(project)}
                        type="button"
                      >
                        ×
                      </button>
                    ) : null}
                  </article>
                )
              })}
            </div>
          ) : (
            <p className="cbv-projects-empty">No recent folders yet.</p>
          )}
          <button
            className="cbv-workspace-add-button"
            disabled={workspaceActionPending || !canManageProjects}
            onClick={onOpenWorkspace}
            type="button"
          >
            + add workspace
          </button>
        </section>
      ) : (
        <>
          <section className="cbv-sidebar-section cbv-sidebar-current-workspace">
            <div className="cbv-sidebar-section-header">
              <button
                className="cbv-sidebar-inline-action"
                onClick={() => setWorkspacesViewRootDir(currentRootDir)}
                type="button"
              >
                ← workspaces
              </button>
            </div>
            <button
              className="cbv-workspace-recent-item is-active cbv-workspace-current-item"
              disabled={workspaceActionPending || !canManageProjects}
              onClick={() => setWorkspacesViewRootDir(currentRootDir)}
              type="button"
            >
              <strong>{currentWorkspaceName}</strong>
              <span title={currentRootDir}>{currentRootDir}</span>
            </button>
          </section>

          <section className="cbv-sidebar-section cbv-sidebar-outline">
            <div className="cbv-sidebar-section-header">
              <span>Symbols · {filteredGroups.reduce((count, group) => count + group.items.length, 0)}</span>
              <small>sort: loc ▾</small>
            </div>
            <label className="cbv-sidebar-filter">
              <span className="cbv-sidebar-filter-icon">⌕</span>
              <input
                onChange={(event) => setFilterValue(event.target.value)}
                placeholder="Filter symbols"
                type="text"
                value={filterValue}
              />
            </label>
            <div className="cbv-workspace-outline">
              {filteredGroups.length ? (
                filteredGroups.map((group) => {
                  const isCollapsed = Boolean(collapsedGroups[group.id])
                  const maxMetric = Math.max(
                    1,
                    ...group.items.map((item) => item.metric ?? 0),
                  )

                  return (
                    <section
                      className="cbv-outline-group"
                      key={group.id}
                      style={{ '--cbv-outline-tone': `var(${group.tone})` } as CSSProperties}
                    >
                      <button
                        className="cbv-outline-group-header"
                        onClick={() =>
                          setCollapsedGroups((current) => ({
                            ...current,
                            [group.id]: !current[group.id],
                          }))
                        }
                        type="button"
                      >
                        <span className="cbv-outline-group-toggle">{isCollapsed ? '▸' : '▾'}</span>
                        <span className="cbv-outline-group-dot" />
                        <span className="cbv-outline-group-title">{group.label}</span>
                        <span className="cbv-outline-group-meta">{group.metricLabel}</span>
                      </button>
                      {isCollapsed ? null : (
                        <div className="cbv-outline-group-items">
                          {group.items.map((item) => (
                            <button
                              className={`cbv-outline-item${selectedNodeId === item.id ? ' is-active' : ''}`}
                              aria-label={`${item.title}, ${item.subtitle}, ${item.metric ?? 0} LOC`}
                              key={item.id}
                              onClick={() => onSelectSymbol(item.id)}
                              type="button"
                            >
                              <span className="cbv-outline-item-main">
                                <strong title={item.title}>{item.title}</strong>
                              </span>
                              <span
                                className="cbv-outline-item-loc"
                                title={`${item.metric ?? 0} LOC`}
                              >
                                {item.metric ?? 0} loc
                              </span>
                              <span className="cbv-outline-item-subtitle" title={item.subtitle}>
                                {item.subtitle}
                              </span>
                              <span className="cbv-outline-item-meta">
                                {item.badge ? (
                                  <span className="cbv-outline-item-badge">{item.badge}</span>
                                ) : null}
                                <span className="cbv-outline-item-bar" aria-hidden="true">
                                  <span
                                    style={{
                                      width: `${Math.max(18, Math.round(((item.metric ?? 0) / maxMetric) * 100))}%`,
                                    }}
                                  />
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  )
                })
              ) : (
                <p className="cbv-projects-empty">No visible symbols match the current filter.</p>
              )}
            </div>
            <div className="cbv-sidebar-outline-footer">
              <span>≡ group · kind</span>
              <span>
                {totalVisibleSymbols} · {totalVisibleLoc} loc
              </span>
            </div>
          </section>
        </>
      )}

      {workspaceActionError ? <p className="cbv-workspace-error">{workspaceActionError}</p> : null}
      {removalCandidate ? (
        <div
          className="cbv-modal-backdrop"
          onClick={() => setRemovalCandidate(null)}
          role="presentation"
        >
          <section
            aria-label="Remove workspace"
            className="cbv-modal cbv-workspace-remove-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cbv-modal-header">
              <div>
                <p className="cbv-eyebrow">Workspaces</p>
                <strong>Remove workspace</strong>
              </div>
              <button
                aria-label="Close remove workspace dialog"
                className="cbv-inspector-close"
                onClick={() => setRemovalCandidate(null)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="cbv-workspace-remove-modal-body">
              <p>
                Remove <strong>{removalCandidate.name}</strong> from the recent workspace list?
              </p>
              <p title={removalCandidate.rootDir}>{removalCandidate.rootDir}</p>
              <div className="cbv-workspace-remove-modal-actions">
                <button
                  className="cbv-toolbar-button is-secondary"
                  onClick={() => setRemovalCandidate(null)}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="cbv-toolbar-button"
                  disabled={workspaceActionPending}
                  onClick={() => {
                    void Promise.resolve(
                      onRemoveRecentProject(removalCandidate.rootDir),
                    ).finally(() => {
                      setRemovalCandidate(null)
                    })
                  }}
                  type="button"
                >
                  remove
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  )
}

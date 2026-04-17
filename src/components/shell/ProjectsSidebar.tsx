interface RecentProject {
  name: string
  rootDir: string
  lastOpenedAt: string
}

interface ProjectsSidebarProps {
  canManageProjects: boolean
  currentRootDir: string
  onClose: () => void
  onCloseWorkspace: () => void
  onOpenRecentProject: (rootDir: string) => void
  onOpenWorkspace: () => void
  open: boolean
  recentProjects: RecentProject[]
  workspaceActionError?: string | null
  workspaceActionPending?: boolean
}

export function ProjectsSidebar({
  canManageProjects,
  currentRootDir,
  onClose,
  onCloseWorkspace,
  onOpenRecentProject,
  onOpenWorkspace,
  open,
  recentProjects,
  workspaceActionError = null,
  workspaceActionPending = false,
}: ProjectsSidebarProps) {
  return (
    <aside className={`cbv-projects-sidebar${open ? '' : ' is-collapsed'}`}>
      <div className="cbv-projects-sidebar-header">
        <div>
          <p className="cbv-eyebrow">Projects</p>
          <strong>{recentProjects.length ? `${recentProjects.length} recent` : 'Folders'}</strong>
        </div>
        <button className="cbv-inspector-close" onClick={onClose} type="button">
          ×
        </button>
      </div>
      <div className="cbv-projects-sidebar-actions">
        <button
          disabled={workspaceActionPending || !canManageProjects}
          onClick={onOpenWorkspace}
          type="button"
        >
          Open Folder
        </button>
        <button
          className="is-secondary"
          disabled={workspaceActionPending || !canManageProjects}
          onClick={onCloseWorkspace}
          type="button"
        >
          Close Current
        </button>
      </div>
      {!canManageProjects ? (
        <p className="cbv-projects-empty">
          Folder management is unavailable in this host.
        </p>
      ) : null}
      <div className="cbv-projects-list">
        {recentProjects.length > 0 ? (
          recentProjects.map((project) => {
            const isActive = project.rootDir === currentRootDir

            return (
              <button
                className={`cbv-projects-item${isActive ? ' is-active' : ''}`}
                disabled={workspaceActionPending || isActive}
                key={project.rootDir}
                onClick={() => onOpenRecentProject(project.rootDir)}
                type="button"
              >
                <strong>{project.name}</strong>
                <span>{project.rootDir}</span>
                <small>
                  {isActive
                    ? 'Current folder'
                    : `Opened ${new Date(project.lastOpenedAt).toLocaleString()}`}
                </small>
              </button>
            )
          })
        ) : (
          <p className="cbv-projects-empty">
            Open a folder to keep it in the recent projects list.
          </p>
        )}
      </div>
      {workspaceActionError ? (
        <p className="cbv-workspace-error">{workspaceActionError}</p>
      ) : null}
    </aside>
  )
}

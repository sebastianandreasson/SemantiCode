import { type WorkspaceArtifactSyncStatus } from '../../types'

interface WorkspaceSyncModalProps {
  onBuildEmbeddings?: () => void
  onClose: () => void
  onRebuildSummaries?: () => void
  status: WorkspaceArtifactSyncStatus
}

export function WorkspaceSyncModal({
  onBuildEmbeddings,
  onClose,
  onRebuildSummaries,
  status,
}: WorkspaceSyncModalProps) {
  const outdatedLayouts = [...status.layouts, ...status.drafts].filter(
    (entry) => entry.state === 'outdated',
  )

  return (
    <div className="cbv-modal-backdrop" onClick={onClose} role="presentation">
      <section
        aria-label="Workspace sync details"
        className="cbv-modal cbv-sync-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="cbv-modal-header">
          <div>
            <p className="cbv-eyebrow">Workspace Sync</p>
            <strong>Generated artifact parity</strong>
          </div>
          <button
            aria-label="Close workspace sync details"
            className="cbv-inspector-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="cbv-sync-modal-body">
          <section className="cbv-sync-card">
            <p className="cbv-eyebrow">Git</p>
            <strong>
              {status.git.isGitRepo
                ? status.git.branch
                  ? `${status.git.branch} @ ${status.git.head?.slice(0, 7) ?? 'unknown'}`
                  : status.git.head?.slice(0, 7) ?? 'unknown'
                : 'Not a git repository'}
            </strong>
            {status.git.changedFiles.length > 0 ? (
              <>
                <p>{status.git.changedFiles.length} changed file(s) are affecting parity.</p>
                <CodeList items={status.git.changedFiles} />
              </>
            ) : (
              <p>No working tree changes detected.</p>
            )}
          </section>

          <section className="cbv-sync-grid">
            <ArtifactSyncCard
              actionLabel={
                status.summaries.state !== 'in_sync' && onRebuildSummaries
                  ? 'Rebuild summaries'
                  : undefined
              }
              affectedPaths={status.summaries.affectedPaths}
              obsoleteCount={status.summaries.obsoleteCount}
              onAction={onRebuildSummaries}
              staleCount={status.summaries.staleCount}
              state={status.summaries.state}
              title="Semantic summaries"
              totalTracked={status.summaries.totalTracked}
            />
            <ArtifactSyncCard
              actionLabel={
                status.embeddings.state !== 'in_sync' && onBuildEmbeddings
                  ? 'Build embeddings'
                  : undefined
              }
              affectedPaths={status.embeddings.affectedPaths}
              obsoleteCount={status.embeddings.obsoleteCount}
              onAction={onBuildEmbeddings}
              staleCount={status.embeddings.staleCount}
              state={status.embeddings.state}
              title="Embeddings"
              totalTracked={status.embeddings.totalTracked}
            />
          </section>

          <section className="cbv-sync-card">
            <p className="cbv-eyebrow">Layouts</p>
            <strong>
              {outdatedLayouts.length > 0
                ? `${outdatedLayouts.length} layout artifact${outdatedLayouts.length === 1 ? '' : 's'} need attention`
                : 'Layouts are in sync'}
            </strong>
            {outdatedLayouts.length > 0 ? (
              <div className="cbv-sync-layout-list">
                {outdatedLayouts.map((entry) => (
                  <div className="cbv-sync-layout-item" key={`${entry.sourceType}:${entry.id}`}>
                    <div className="cbv-sync-layout-item-header">
                      <strong>{entry.title}</strong>
                      <span>{entry.sourceType === 'draft' ? 'Draft' : 'Layout'}</span>
                    </div>
                    <p>
                      {entry.staleCount > 0 ? `${entry.staleCount} changed node(s)` : 'No changed nodes'}
                      {entry.missingCount > 0 ? ` · ${entry.missingCount} missing node(s)` : ''}
                    </p>
                    {entry.affectedPaths.length > 0 ? (
                      <CodeList items={entry.affectedPaths} />
                    ) : entry.missingNodeIds.length > 0 ? (
                      <CodeList items={entry.missingNodeIds} />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p>No saved layouts or drafts are currently impacted by repo drift.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

function ArtifactSyncCard({
  actionLabel,
  affectedPaths,
  obsoleteCount,
  onAction,
  staleCount,
  state,
  title,
  totalTracked,
}: {
  actionLabel?: string
  affectedPaths: string[]
  obsoleteCount: number
  onAction?: () => void
  staleCount: number
  state: 'in_sync' | 'outdated' | 'missing'
  title: string
  totalTracked: number
}) {
  return (
    <section className={`cbv-sync-card is-${state}`}>
      <p className="cbv-eyebrow">{title}</p>
      <strong>{formatArtifactHeadline(state, staleCount, obsoleteCount, totalTracked)}</strong>
      <p>{formatArtifactDescription(state, staleCount, obsoleteCount, totalTracked)}</p>
      {affectedPaths.length > 0 ? <CodeList items={affectedPaths} /> : null}
      {actionLabel && onAction ? (
        <button className="cbv-toolbar-button" onClick={onAction} type="button">
          {actionLabel}
        </button>
      ) : null}
    </section>
  )
}

function CodeList({ items }: { items: string[] }) {
  const visibleItems = items.slice(0, 12)
  const hiddenCount = Math.max(0, items.length - visibleItems.length)

  return (
    <ul className="cbv-sync-code-list">
      {visibleItems.map((item) => (
        <li key={item}>
          <code>{item}</code>
        </li>
      ))}
      {hiddenCount > 0 ? <li>+ {hiddenCount} more…</li> : null}
    </ul>
  )
}

function formatArtifactHeadline(
  state: 'in_sync' | 'outdated' | 'missing',
  staleCount: number,
  obsoleteCount: number,
  totalTracked: number,
) {
  if (state === 'missing') {
    return `Missing for ${totalTracked} tracked symbol${totalTracked === 1 ? '' : 's'}`
  }

  if (state === 'in_sync') {
    return 'In sync'
  }

  const totalCount = staleCount + obsoleteCount
  return `${totalCount} item${totalCount === 1 ? '' : 's'} need update`
}

function formatArtifactDescription(
  state: 'in_sync' | 'outdated' | 'missing',
  staleCount: number,
  obsoleteCount: number,
  totalTracked: number,
) {
  if (state === 'missing') {
    return `No generated artifact exists yet for ${totalTracked} tracked symbol${totalTracked === 1 ? '' : 's'}.`
  }

  if (state === 'in_sync') {
    return 'All tracked entries match the current repository state.'
  }

  const parts = []

  if (staleCount > 0) {
    parts.push(`${staleCount} stale`)
  }

  if (obsoleteCount > 0) {
    parts.push(`${obsoleteCount} obsolete`)
  }

  return parts.join(' · ')
}

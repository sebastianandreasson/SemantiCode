import type {
  AutonomousRunDetail,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
} from '../../types'

interface AutonomousRunsSurfaceProps {
  activeRunId: string | null
  detectedTaskFile: string | null
  errorMessage: string | null
  onSelectRun: (runId: string) => void
  onStartRun: () => void
  onStopRun: (runId: string) => void
  pending: boolean
  selectedRunDetail: AutonomousRunDetail | null
  selectedRunId: string | null
  timeline: AutonomousRunTimelinePoint[]
  runs: AutonomousRunSummary[]
}

export function AutonomousRunsSurface({
  activeRunId,
  detectedTaskFile,
  errorMessage,
  onSelectRun,
  onStartRun,
  onStopRun,
  pending,
  selectedRunDetail,
  selectedRunId,
  timeline,
  runs,
}: AutonomousRunsSurfaceProps) {
  const activeRun = activeRunId
    ? runs.find((run) => run.runId === activeRunId) ?? null
    : null
  const selectedRun = selectedRunDetail ?? runs.find((run) => run.runId === selectedRunId) ?? null
  const totalTokens = runs.reduce((sum, run) => sum + run.totalTokens, 0)
  const totalRequests = runs.reduce((sum, run) => sum + run.requestCount, 0)

  return (
    <div className="cbv-runs-surface">
      <div className="cbv-runs-toolbar">
        <div className="cbv-runs-headline">
          <p className="cbv-eyebrow">agents</p>
          <strong>autonomous TODO runs</strong>
          <span>
            {runs.length} runs · {totalRequests} requests · {formatTokenCount(totalTokens)} tokens
          </span>
        </div>
        <div className="cbv-runs-task-file">
          <p className="cbv-eyebrow">TODO source</p>
          <strong title={detectedTaskFile ?? 'No TODO file detected'}>
            {detectedTaskFile ?? 'No TODO file found'}
          </strong>
        </div>
        <div className="cbv-runs-actions">
          <button
            disabled={pending || !detectedTaskFile || Boolean(activeRunId)}
            onClick={onStartRun}
            type="button"
          >
            {pending ? 'starting...' : 'start run'}
          </button>
          {activeRunId ? (
            <button
              className="is-danger"
              disabled={pending}
              onClick={() => onStopRun(activeRunId)}
              type="button"
            >
              stop run
            </button>
          ) : null}
        </div>
      </div>

      {errorMessage ? (
        <p className="cbv-runs-error">{errorMessage}</p>
      ) : null}

      <div className="cbv-runs-layout">
        <div className="cbv-runs-list">
          {runs.length === 0 ? (
            <div className="cbv-empty">
              <h2>No runs yet</h2>
              <p>Start a harness-managed run to see progress, TODO completion, and telemetry here.</p>
            </div>
          ) : (
            runs.map((run) => (
              <button
                className={`cbv-run-list-item${selectedRunId === run.runId ? ' is-active' : ''}${run.status === 'running' ? ' is-running' : ''}`}
                key={run.runId}
                onClick={() => onSelectRun(run.runId)}
                type="button"
              >
                <div className="cbv-run-list-item-header">
                  <strong title={run.task || run.runId}>{run.task || run.runId}</strong>
                  <span className={`cbv-agent-status is-${run.status}`}>{run.status}</span>
                </div>
                <p>{run.phase || 'no phase yet'}</p>
                <small>
                  iter {run.iteration || 0} · {run.requestCount} req · {formatTokenCount(run.totalTokens)} tok · {run.completedTodoCount} done
                </small>
              </button>
            ))
          )}
        </div>

        <div className="cbv-run-detail">
          {selectedRun ? (
            <>
              <div className="cbv-run-summary-card">
                <div className="cbv-run-summary-row">
                  <span>status</span>
                  <strong>{selectedRun.status}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>task</span>
                  <strong>{selectedRun.task || activeRun?.task || 'no active task'}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>phase</span>
                  <strong>{selectedRun.phase || 'not started'}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>iteration</span>
                  <strong>{selectedRun.iteration || 0}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>completed</span>
                  <strong>{selectedRun.completedTodoCount}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>requests</span>
                  <strong>{selectedRun.requestCount}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>tokens</span>
                  <strong>{formatTokenCount(selectedRun.totalTokens)}</strong>
                </div>
                <div className="cbv-run-summary-row">
                  <span>updated</span>
                  <strong>{formatTimestamp(selectedRun.updatedAt ?? selectedRun.startedAt)}</strong>
                </div>
                {selectedRun.terminalReason ? (
                  <div className="cbv-run-summary-row">
                    <span>terminal</span>
                    <strong>{selectedRun.terminalReason}</strong>
                  </div>
                ) : null}
                {selectedRunDetail?.scope ? (
                  <div className="cbv-run-scope">
                    <p className="cbv-eyebrow">scope</p>
                    <strong>{selectedRunDetail.scope.title ?? 'scoped run'}</strong>
                    <ul>
                      {selectedRunDetail.scope.paths.slice(0, 8).map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="cbv-run-detail-grid">
                <div className="cbv-run-detail-card">
                  <p className="cbv-eyebrow">timeline</p>
                  {timeline.length > 0 ? (
                    <ul className="cbv-run-timeline">
                      {timeline.slice(-12).map((point) => (
                        <li key={point.key}>
                          <strong>{point.label || formatTimestamp(point.timestamp)}</strong>
                          <span>{formatTokenCount(point.totalTokens)} tokens</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No request timeline yet.</p>
                  )}
                </div>

                <div className="cbv-run-detail-card">
                  <p className="cbv-eyebrow">completed TODOs</p>
                  {selectedRunDetail?.todos.length ? (
                    <ul className="cbv-run-todos">
                      {selectedRunDetail.todos.slice(0, 12).map((todo) => (
                        <li key={todo.key}>
                          <strong>{todo.task}</strong>
                          <span>
                            iter {todo.iteration} · {formatTokenCount(todo.totalTokens)} tokens
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No completed TODOs yet.</p>
                  )}
                </div>
              </div>

              {selectedRunDetail?.logExcerpt ? (
                <div className="cbv-run-detail-card">
                  <p className="cbv-eyebrow">recent log</p>
                  <pre className="cbv-run-log">{selectedRunDetail.logExcerpt}</pre>
                </div>
              ) : null}
            </>
          ) : (
            <div className="cbv-empty">
              <h2>No run selected</h2>
              <p>Select a run to inspect progress, completed TODOs, token use, and logs.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTokenCount(value: number) {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return Math.round(value).toLocaleString()
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'never'
  }

  const timestamp = new Date(value)

  if (Number.isNaN(timestamp.getTime())) {
    return value
  }

  return timestamp.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

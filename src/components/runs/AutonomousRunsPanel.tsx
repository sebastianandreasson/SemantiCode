import type {
  AutonomousRunDetail,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
} from '../../types'
import { AutonomousRunsSurface } from './AutonomousRunsSurface'

interface AutonomousRunsPanelProps {
  activeRunId: string | null
  detectedTaskFile: string | null
  errorMessage: string | null
  onClose: () => void
  onSelectRun: (runId: string) => void
  onStartRun: () => void
  onStopRun: (runId: string) => void
  pending: boolean
  selectedRunDetail: AutonomousRunDetail | null
  selectedRunId: string | null
  timeline: AutonomousRunTimelinePoint[]
  runs: AutonomousRunSummary[]
}

export function AutonomousRunsPanel({
  activeRunId,
  detectedTaskFile,
  errorMessage,
  onClose,
  onSelectRun,
  onStartRun,
  onStopRun,
  pending,
  selectedRunDetail,
  selectedRunId,
  timeline,
  runs,
}: AutonomousRunsPanelProps) {
  return (
    <div
      className="cbv-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-label="Autonomous runs"
        className="cbv-modal cbv-runs-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="cbv-modal-header">
          <div>
            <p className="cbv-eyebrow">Autonomous runs</p>
            <strong>TODO-driven `pi-harness` runs</strong>
          </div>
          <button
            aria-label="Close runs panel"
            className="cbv-inspector-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>

        <AutonomousRunsSurface
          activeRunId={activeRunId}
          detectedTaskFile={detectedTaskFile}
          errorMessage={errorMessage}
          onSelectRun={onSelectRun}
          onStartRun={onStartRun}
          onStopRun={onStopRun}
          pending={pending}
          selectedRunDetail={selectedRunDetail}
          selectedRunId={selectedRunId}
          timeline={timeline}
          runs={runs}
        />
      </section>
    </div>
  )
}

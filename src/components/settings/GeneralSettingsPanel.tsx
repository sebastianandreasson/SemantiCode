import { AgentPanel } from '../AgentPanel'
import type { PreprocessedWorkspaceContext, WorkspaceProfile } from '../../types'

export type ThemeMode = 'light' | 'dark'

interface GeneralSettingsPanelProps {
  desktopHostAvailable?: boolean
  onToggleDarkMode: () => void
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  themeMode: ThemeMode
  workspaceProfile?: WorkspaceProfile | null
}

export function GeneralSettingsPanel({
  desktopHostAvailable = false,
  onToggleDarkMode,
  preprocessedWorkspaceContext = null,
  themeMode,
  workspaceProfile = null,
}: GeneralSettingsPanelProps) {
  return (
    <div className="cbv-general-settings">
      <section className="cbv-settings-section">
        <div className="cbv-settings-section-header">
          <div>
            <p className="cbv-eyebrow">Appearance</p>
            <strong>Interface theme</strong>
          </div>
        </div>
        <label className="cbv-settings-toggle">
          <div className="cbv-settings-toggle-copy">
            <strong>Dark mode</strong>
            <span>Use the darker app theme across the workspace.</span>
          </div>
          <button
            aria-label="Toggle dark mode"
            aria-pressed={themeMode === 'dark'}
            className={`cbv-settings-switch${themeMode === 'dark' ? ' is-active' : ''}`}
            onClick={onToggleDarkMode}
            type="button"
          >
            <span />
          </button>
        </label>
      </section>

      <section className="cbv-settings-section">
        <div className="cbv-settings-section-header">
          <div>
            <p className="cbv-eyebrow">Agent</p>
            <strong>Provider, model, and sign-in</strong>
          </div>
        </div>
        <AgentPanel
          desktopHostAvailable={desktopHostAvailable}
          preprocessedWorkspaceContext={preprocessedWorkspaceContext}
          settingsOnly
          workspaceProfile={workspaceProfile}
        />
      </section>
    </div>
  )
}

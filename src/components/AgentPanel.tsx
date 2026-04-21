import type { AgentScopeContext } from '../agent/agentScopeContext'
import type {
  AgentSessionSummary,
  PreprocessedWorkspaceContext,
  WorkingSetState,
  WorkspaceProfile,
} from '../types'
import { AgentModelPicker } from './agent/AgentModelPicker'
import { AgentSettingsPanel } from './agent/AgentSettingsPanel'
import { AgentTerminal } from './agent/AgentTerminal'
import { useAgentSessionController } from './agent/useAgentSessionController'

export type { AgentScopeContext } from '../agent/agentScopeContext'

interface AgentPanelProps {
  autoFocusComposer?: boolean
  composerFocusRequestKey?: number
  desktopHostAvailable?: boolean
  inspectorContext?: AgentScopeContext
  onActiveSessionChange?: (session: AgentSessionSummary | null) => void
  onOpenSettings?: () => void
  onRunSettled?: () => Promise<void>
  onAdoptInspectorContextAsWorkingSet?: () => void
  onChatSessionCleared?: (session: AgentSessionSummary | null) => void
  onClearWorkingSet?: () => void
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  promptSeed?: {
    id: string
    value: string
  } | null
  settingsOnly?: boolean
  workingSet?: WorkingSetState | null
  workingSetContext?: AgentScopeContext | null
  workspaceProfile?: WorkspaceProfile | null
}

export function AgentPanel({
  autoFocusComposer = false,
  composerFocusRequestKey = 0,
  desktopHostAvailable = false,
  inspectorContext,
  onActiveSessionChange,
  onOpenSettings,
  onRunSettled,
  onAdoptInspectorContextAsWorkingSet,
  onChatSessionCleared,
  onClearWorkingSet,
  preprocessedWorkspaceContext = null,
  promptSeed = null,
  settingsOnly = false,
  workingSet = null,
  workingSetContext = null,
  workspaceProfile = null,
}: AgentPanelProps) {
  const {
    apiKeyValue,
    authModeValue,
    availableModels,
    commandSuggestions,
    composerRef,
    composerValue,
    errorMessage,
    handleBrokeredLogout,
    handleCancel,
    handleClearApiKey,
    handleClearOpenAiOAuthOverride,
    handleCompleteManualRedirect,
    handleComposerChange,
    handleImportCodexLogin,
    handleSaveSettings,
    handleStartBrokeredLogin,
    handleSubmit,
    handleTerminalModelChange,
    handleTimelineScroll,
    hasInspectorContext,
    hasWorkingSetContext,
    manualRedirectUrlValue,
    messageListRef,
    modelValue,
    oauthLoginUrl,
    oauthStatusMessage,
    openAiOAuthClientIdValue,
    openAiOAuthClientSecretValue,
    pending,
    providerValue,
    selectedModelKey,
    sendDisabledReason,
    session,
    sessionCapabilities,
    sessionControls,
    sessionIsInteractive,
    settings,
    settingsPending,
    terminalModelOptions,
    timeline,
    toolProfileValue,
    updateSettingsDraft,
    workingSetMatchesInspectorContext,
  } = useAgentSessionController({
    autoFocusComposer,
    composerFocusRequestKey,
    desktopHostAvailable,
    inspectorContext,
    onActiveSessionChange,
    onChatSessionCleared,
    onRunSettled,
    preprocessedWorkspaceContext,
    promptSeed,
    settingsOnly,
    workingSetContext,
    workspaceProfile,
  })

  return (
    <div className={`cbv-agent-panel${settingsOnly ? ' is-settings-only' : ''}`}>
      <div className="cbv-agent-meta">
        <div className="cbv-agent-meta-main">
          <p className="cbv-eyebrow">Session</p>
          {session || terminalModelOptions.length > 0 ? (
            <AgentModelPicker
              disabled={
                pending ||
                settingsPending ||
                session?.runState === 'running' ||
                terminalModelOptions.length <= 1
              }
              models={terminalModelOptions}
              onSelect={(modelKey) => {
                void handleTerminalModelChange(modelKey)
              }}
              selectedModelKey={selectedModelKey}
              title={
                session?.runState === 'running'
                  ? 'Model switching is disabled while the agent is running.'
                  : 'Switch agent model'
              }
            />
          ) : (
            <strong>Starting…</strong>
          )}
        </div>
        <div className={`cbv-agent-status is-${session?.runState ?? 'idle'}`}>
          {session?.runState ?? 'idle'}
        </div>
      </div>

      {session?.lastError ? (
        <p className="cbv-agent-warning">{session.lastError}</p>
      ) : null}

      {errorMessage ? (
        <p className="cbv-agent-error">{errorMessage}</p>
      ) : null}

      {settingsOnly ? (
        <AgentSettingsPanel
          apiKeyValue={apiKeyValue}
          authModeValue={authModeValue}
          availableModels={availableModels}
          handleBrokeredLogout={handleBrokeredLogout}
          handleClearApiKey={handleClearApiKey}
          handleClearOpenAiOAuthOverride={handleClearOpenAiOAuthOverride}
          handleCompleteManualRedirect={handleCompleteManualRedirect}
          handleImportCodexLogin={handleImportCodexLogin}
          handleSaveSettings={handleSaveSettings}
          handleStartBrokeredLogin={handleStartBrokeredLogin}
          manualRedirectUrlValue={manualRedirectUrlValue}
          modelValue={modelValue}
          oauthLoginUrl={oauthLoginUrl}
          oauthStatusMessage={oauthStatusMessage}
          openAiOAuthClientIdValue={openAiOAuthClientIdValue}
          openAiOAuthClientSecretValue={openAiOAuthClientSecretValue}
          providerValue={providerValue}
          settings={settings}
          settingsPending={settingsPending}
          toolProfileValue={toolProfileValue}
          updateSettingsDraft={updateSettingsDraft}
        />
      ) : !sessionIsInteractive ? (
        <div className="cbv-agent-setup-prompt">
          <strong>Agent settings needed</strong>
          <p>
            {session?.lastError ??
              'Open settings to sign in, choose a model, or update agent configuration before chatting here.'}
          </p>
          {onOpenSettings ? (
            <button
              onClick={onOpenSettings}
              type="button"
            >
              Open Settings
            </button>
          ) : null}
        </div>
      ) : (
        <AgentTerminal
          commandSuggestions={commandSuggestions}
          composerRef={composerRef}
          composerValue={composerValue}
          hasInspectorContext={hasInspectorContext}
          hasWorkingSetContext={hasWorkingSetContext}
          inspectorContext={inspectorContext}
          messageListRef={messageListRef}
          onAdoptInspectorContextAsWorkingSet={onAdoptInspectorContextAsWorkingSet}
          onCancel={handleCancel}
          onClearWorkingSet={onClearWorkingSet}
          onComposerChange={handleComposerChange}
          onSubmit={handleSubmit}
          onTimelineScroll={handleTimelineScroll}
          pending={pending}
          sendDisabledReason={sendDisabledReason}
          session={session!}
          sessionCapabilities={sessionCapabilities}
          sessionControls={sessionControls}
          timeline={timeline}
          workingSet={workingSet}
          workingSetContext={workingSetContext}
          workingSetMatchesInspectorContext={workingSetMatchesInspectorContext}
        />
      )}
    </div>
  )
}

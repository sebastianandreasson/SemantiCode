import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent } from '../schema/agent'
import type { AgentModelSelectionRequest, AgentPromptRequest } from '../schema/api'
import type { UiPreferences } from '../schema/store'

const initialUiPreferences = ipcRenderer.sendSync(
  'semanticode:get-initial-ui-preferences',
) as UiPreferences

contextBridge.exposeInMainWorld('semanticodeDesktop', {
  host: 'electron',
  isDesktop: true,
  initialUiPreferences,
  getUiPreferences: () => ipcRenderer.invoke('semanticode:get-ui-preferences') as Promise<UiPreferences>,
  setUiPreferences: (preferences: UiPreferences) =>
    ipcRenderer.invoke('semanticode:set-ui-preferences', preferences) as Promise<UiPreferences>,
  getWorkspaceHistory: () => ipcRenderer.invoke('semanticode:get-workspace-history'),
  removeWorkspaceHistoryEntry: (rootDir: string) =>
    ipcRenderer.invoke('semanticode:remove-workspace-history-entry', rootDir),
  openWorkspaceDialog: () => ipcRenderer.invoke('semanticode:open-workspace'),
  openWorkspaceRootDir: (rootDir: string) =>
    ipcRenderer.invoke('semanticode:open-workspace-root-dir', rootDir),
  closeWorkspace: () => ipcRenderer.invoke('semanticode:close-workspace'),
  createSession: () => ipcRenderer.invoke('semanticode:agent:create-session'),
  sendMessage: (
    payload: string | AgentPromptRequest,
  ) => ipcRenderer.invoke('semanticode:agent:send-message', payload),
  listSessions: () => ipcRenderer.invoke('semanticode:agent:list-sessions'),
  getControls: () => ipcRenderer.invoke('semanticode:agent:get-controls'),
  newSession: () => ipcRenderer.invoke('semanticode:agent:new-session'),
  resumeSession: (sessionFile: string) =>
    ipcRenderer.invoke('semanticode:agent:resume-session', sessionFile),
  setThinkingLevel: (thinkingLevel: string) =>
    ipcRenderer.invoke('semanticode:agent:set-thinking-level', thinkingLevel),
  setActiveTools: (toolNames: string[]) =>
    ipcRenderer.invoke('semanticode:agent:set-active-tools', toolNames),
  setModel: (input: AgentModelSelectionRequest) =>
    ipcRenderer.invoke('semanticode:agent:set-model', input),
  compact: (instructions?: string) =>
    ipcRenderer.invoke('semanticode:agent:compact', instructions),
  cancel: () => ipcRenderer.invoke('semanticode:agent:cancel'),
  onEvent: (listener: (event: AgentEvent) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => {
      listener(payload)
    }

    ipcRenderer.on('semanticode:agent:event', wrappedListener)
    return () => {
      ipcRenderer.off('semanticode:agent:event', wrappedListener)
    }
  },
})

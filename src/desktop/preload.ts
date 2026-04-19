import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent } from '../schema/agent'
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
    payload:
      | string
      | {
          message: string
          metadata?: {
            kind?: string
            paths?: string[]
            scope?: {
              layoutTitle?: string
              paths: string[]
              symbolPaths?: string[]
              title?: string
            } | null
            task?: string
          }
          mode?: 'send' | 'steer' | 'follow_up'
        },
  ) => ipcRenderer.invoke('semanticode:agent:send-message', payload),
  listSessions: () => ipcRenderer.invoke('semanticode:agent:list-sessions'),
  newSession: () => ipcRenderer.invoke('semanticode:agent:new-session'),
  resumeSession: (sessionFile: string) =>
    ipcRenderer.invoke('semanticode:agent:resume-session', sessionFile),
  setThinkingLevel: (thinkingLevel: string) =>
    ipcRenderer.invoke('semanticode:agent:set-thinking-level', thinkingLevel),
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

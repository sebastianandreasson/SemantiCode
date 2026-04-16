import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent } from '../schema/agent'

contextBridge.exposeInMainWorld('semanticodeDesktop', {
  host: 'electron',
  isDesktop: true,
  getWorkspaceHistory: () => ipcRenderer.invoke('semanticode:get-workspace-history'),
  openWorkspaceDialog: () => ipcRenderer.invoke('semanticode:open-workspace'),
  openWorkspaceRootDir: (rootDir: string) =>
    ipcRenderer.invoke('semanticode:open-workspace-root-dir', rootDir),
  closeWorkspace: () => ipcRenderer.invoke('semanticode:close-workspace'),
  createSession: () => ipcRenderer.invoke('semanticode:agent:create-session'),
  sendMessage: (message: string) =>
    ipcRenderer.invoke('semanticode:agent:send-message', message),
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

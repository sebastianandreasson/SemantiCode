import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent } from '../schema/agent'

contextBridge.exposeInMainWorld('codebaseVisualizerDesktop', {
  host: 'electron',
  isDesktop: true,
  openWorkspaceDialog: () => ipcRenderer.invoke('codebase-visualizer:open-workspace'),
  closeWorkspace: () => ipcRenderer.invoke('codebase-visualizer:close-workspace'),
  createSession: () => ipcRenderer.invoke('codebase-visualizer:agent:create-session'),
  sendMessage: (message: string) =>
    ipcRenderer.invoke('codebase-visualizer:agent:send-message', message),
  cancel: () => ipcRenderer.invoke('codebase-visualizer:agent:cancel'),
  onEvent: (listener: (event: AgentEvent) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => {
      listener(payload)
    }

    ipcRenderer.on('codebase-visualizer:agent:event', wrappedListener)
    return () => {
      ipcRenderer.off('codebase-visualizer:agent:event', wrappedListener)
    }
  },
})

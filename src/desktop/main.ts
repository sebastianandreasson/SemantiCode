import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { access } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PiAgentService } from './agent/PiAgentService'
import { startStandaloneServer, type StandaloneServerHandle } from '../hosts/standaloneServer'
import {
  createEmptyWorkspaceHistoryState,
  loadWorkspaceHistoryState,
  persistWorkspaceHistoryState,
  rememberWorkspace,
  type WorkspaceHistoryState,
} from './workspaceHistory'

let mainWindow: BrowserWindow | null = null
let serverHandle: StandaloneServerHandle | null = null
let activeWorkspaceRootDir: string | null = null
let workspaceHistoryState: WorkspaceHistoryState = createEmptyWorkspaceHistoryState()
const piAgentService = new PiAgentService({
  openExternal: (url) => shell.openExternal(url),
})

void app.whenReady().then(async () => {
  workspaceHistoryState = await loadWorkspaceHistoryState(app.getPath('userData'))

  piAgentService.subscribe((event) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return
    }

    mainWindow.webContents.send('semanticode:agent:event', event)
  })

  ipcMain.handle('semanticode:open-workspace', async () => {
    if (!mainWindow) {
      return false
    }

    const workspaceRootDir = await promptForWorkspaceRootDir()

    if (!workspaceRootDir) {
      return false
    }

    await openWorkspace(mainWindow, workspaceRootDir)
    return true
  })

  ipcMain.handle('semanticode:open-workspace-root-dir', async (_event, rootDir: string) => {
    if (!mainWindow || !rootDir) {
      return false
    }

    await openWorkspace(mainWindow, rootDir)
    return true
  })

  ipcMain.handle('semanticode:close-workspace', async () => {
    if (!mainWindow) {
      return false
    }

    await loadWelcomeScreen(mainWindow)
    return true
  })

  ipcMain.handle('semanticode:get-workspace-history', async () => ({
    activeWorkspaceRootDir,
    recentWorkspaces: workspaceHistoryState.recentWorkspaces,
  }))

  ipcMain.handle('semanticode:agent:create-session', async () => {
    if (!activeWorkspaceRootDir) {
      return null
    }

    return piAgentService.ensureWorkspaceSession(activeWorkspaceRootDir)
  })

  ipcMain.handle('semanticode:agent:send-message', async (_event, message: string) => {
    if (!activeWorkspaceRootDir) {
      return false
    }

    console.info(
      `[semanticode][agent] IPC send-message received for ${activeWorkspaceRootDir}.`,
    )
    void piAgentService.promptWorkspaceSession(activeWorkspaceRootDir, message).catch((error) => {
      console.error(
        '[semanticode][agent] Background prompt failed:',
        error instanceof Error ? error.message : error,
      )
    })
    return true
  })

  ipcMain.handle('semanticode:agent:cancel', async () => {
    if (!activeWorkspaceRootDir) {
      return false
    }

    return piAgentService.cancelWorkspaceSession(activeWorkspaceRootDir)
  })

  mainWindow = createMainWindow()
  const workspaceRootDir = await resolveInitialWorkspaceRootDir()

  if (workspaceRootDir) {
    await openWorkspace(mainWindow, workspaceRootDir)
  } else {
    await loadWelcomeScreen(mainWindow)
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()

      if (serverHandle && activeWorkspaceRootDir) {
        await mainWindow.loadURL(serverHandle.url)
        mainWindow.setTitle(`Semanticode - ${basename(activeWorkspaceRootDir)}`)
      } else {
        await loadWelcomeScreen(mainWindow)
      }
    }
  })
}).catch(async (error: unknown) => {
  if (serverHandle) {
    await serverHandle.close().catch(() => undefined)
    serverHandle = null
  }

  dialog.showErrorBox(
    'Semanticode failed to start',
    error instanceof Error ? error.message : 'Unknown startup error.',
  )
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  ipcMain.removeHandler('semanticode:open-workspace')
  ipcMain.removeHandler('semanticode:open-workspace-root-dir')
  ipcMain.removeHandler('semanticode:close-workspace')
  ipcMain.removeHandler('semanticode:get-workspace-history')
  ipcMain.removeHandler('semanticode:agent:create-session')
  ipcMain.removeHandler('semanticode:agent:send-message')
  ipcMain.removeHandler('semanticode:agent:cancel')

  if (serverHandle) {
    void serverHandle.close()
    serverHandle = null
  }

  void piAgentService.disposeAllSessions()
})

function createMainWindow() {
  const preloadPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'preload.js',
  )

  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: 'Semanticode',
    backgroundColor: '#f5efe3',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== 'semanticode://open-workspace') {
      return
    }

    event.preventDefault()
    void handleOpenWorkspaceRequest(window)
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  return window
}

function resolveCliWorkspaceRootDir() {
  // Electron follows Node's argv shape here: executable, entry script, then user args.
  // Only parse the actual user-supplied tail so we don't accidentally treat host/runtime
  // paths as a workspace to open on startup.
  const cliWorkspaceArg = process.argv
    .slice(2)
    .find((value) => value && !value.startsWith('-'))

  if (cliWorkspaceArg) {
    return resolve(cliWorkspaceArg)
  }

  return null
}

async function resolveInitialWorkspaceRootDir() {
  const cliWorkspaceRootDir = resolveCliWorkspaceRootDir()

  if (cliWorkspaceRootDir) {
    return cliWorkspaceRootDir
  }

  const lastOpenedRootDir = workspaceHistoryState.lastOpenedRootDir

  if (!lastOpenedRootDir) {
    return null
  }

  return (await pathExists(lastOpenedRootDir)) ? lastOpenedRootDir : null
}

async function promptForWorkspaceRootDir() {
  const result = await dialog.showOpenDialog({
    title: 'Open Repository',
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
}

async function handleOpenWorkspaceRequest(window: BrowserWindow) {
  const workspaceRootDir = await promptForWorkspaceRootDir()

  if (!workspaceRootDir) {
    return false
  }

  await openWorkspace(window, workspaceRootDir)
  return true
}

async function openWorkspace(window: BrowserWindow, workspaceRootDir: string) {
  const normalizedWorkspaceRootDir = resolve(workspaceRootDir)

  if (activeWorkspaceRootDir === normalizedWorkspaceRootDir && serverHandle) {
    workspaceHistoryState = rememberWorkspace(workspaceHistoryState, normalizedWorkspaceRootDir)
    await persistWorkspaceHistoryState(app.getPath('userData'), workspaceHistoryState)
    return
  }

  if (activeWorkspaceRootDir && activeWorkspaceRootDir !== workspaceRootDir) {
    await piAgentService.disposeWorkspaceSession(activeWorkspaceRootDir)
  }

  if (serverHandle) {
    await serverHandle.close().catch(() => undefined)
    serverHandle = null
  }

  activeWorkspaceRootDir = normalizedWorkspaceRootDir
  serverHandle = await startStandaloneServer({
    agentRuntime: piAgentService,
    rootDir: normalizedWorkspaceRootDir,
    host: '127.0.0.1',
    port: 0,
  })

  await piAgentService.ensureWorkspaceSession(normalizedWorkspaceRootDir)
  workspaceHistoryState = rememberWorkspace(
    workspaceHistoryState,
    normalizedWorkspaceRootDir,
  )
  await persistWorkspaceHistoryState(app.getPath('userData'), workspaceHistoryState)
  window.setTitle(`Semanticode - ${basename(normalizedWorkspaceRootDir)}`)
  await window.loadURL(serverHandle.url)
}

async function loadWelcomeScreen(window: BrowserWindow) {
  if (activeWorkspaceRootDir) {
    await piAgentService.disposeWorkspaceSession(activeWorkspaceRootDir)
  }

  activeWorkspaceRootDir = null

  if (serverHandle) {
    await serverHandle.close().catch(() => undefined)
    serverHandle = null
  }

  window.setTitle('Semanticode')
  await window.loadURL(buildWelcomeScreenUrl())
}

async function pathExists(pathValue: string) {
  try {
    await access(pathValue)
    return true
  } catch {
    return false
  }
}

function buildWelcomeScreenUrl() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Semanticode</title>
    <style>
      :root {
        color: #271f17;
        background:
          radial-gradient(circle at top, rgba(207, 181, 128, 0.35), transparent 30%),
          linear-gradient(180deg, #f6f0e5 0%, #efe7d8 100%);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: calc(2rem + env(safe-area-inset-top, 0px)) 1.5rem 2rem;
      }

      main {
        width: min(100%, 780px);
        padding: 2rem;
        border: 1px solid rgba(130, 110, 70, 0.18);
        border-radius: 1.5rem;
        background: rgba(255, 251, 244, 0.92);
        box-shadow: 0 24px 48px rgba(89, 68, 31, 0.12);
      }

      h1 {
        margin: 0;
        font-size: clamp(2rem, 5vw, 3.5rem);
        line-height: 1;
        letter-spacing: -0.04em;
      }

      p {
        margin: 0;
        max-width: 42rem;
        color: #5b5146;
        font-size: 1rem;
        line-height: 1.6;
      }

      .stack {
        display: grid;
        gap: 1rem;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.875rem;
        margin-top: 0.5rem;
      }

      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        padding: 0.9rem 1.35rem;
        font: inherit;
        font-weight: 600;
        color: #fff9f1;
        text-decoration: none;
        background: linear-gradient(135deg, #3f5d4e 0%, #547c69 100%);
        cursor: pointer;
        box-shadow: 0 14px 28px rgba(55, 85, 67, 0.24);
      }

      .button:hover {
        transform: translateY(-1px);
      }

      .hint {
        color: #75695c;
        font-size: 0.92rem;
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <h1>Semanticode</h1>
      <p>Open a repository to inspect its structure, explore symbols, and generate custom layouts in a desktop workspace instead of a browser tab.</p>
      <div class="actions">
        <a class="button" href="semanticode://open-workspace">Open Folder</a>
      </div>
      <p class="hint">You can still launch a project directly with <code>npm run desktop -- /path/to/repo</code>.</p>
    </main>
  </body>
</html>`

  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  fetchUiPreferences,
  fetchWorkspaceHistory,
  persistUiPreferences as persistUiPreferencesRequest,
} from './apiClient'
import {
  applyThemeMode,
  readStoredUiPreferences,
  readThemeMode,
  THEME_STORAGE_KEY,
  UI_PREFERENCES_STORAGE_KEY,
} from './themeBootstrap'
import type { ThemeMode } from './themeBootstrap'
import type {
  GraphLayerVisibility,
  UiPreferences,
  VisualizerViewMode,
  WorkspaceUiState,
} from '../types'
import { clampNumber } from '../visualizer/flowModel'

const DEFAULT_CANVAS_WIDTH_RATIO = 0.6
const MIN_CANVAS_WIDTH_RATIO = 0.32
const MAX_CANVAS_WIDTH_RATIO = 0.78

export interface DesktopBridge {
  closeWorkspace?: () => Promise<boolean>
  getUiPreferences?: () => Promise<UiPreferences>
  getWorkspaceHistory?: () => Promise<{
    activeWorkspaceRootDir: string | null
    recentWorkspaces: RecentProject[]
  }>
  isDesktop?: boolean
  openWorkspaceDialog?: () => Promise<boolean>
  openWorkspaceRootDir?: (rootDir: string) => Promise<boolean>
  removeWorkspaceHistoryEntry?: (rootDir: string) => Promise<{
    activeWorkspaceRootDir: string | null
    recentWorkspaces: RecentProject[]
  }>
  setUiPreferences?: (preferences: UiPreferences) => Promise<UiPreferences>
}

export interface RecentProject {
  name: string
  rootDir: string
  lastOpenedAt: string
}

export interface UseWorkspaceChromeControllerInput {
  activeDraftId: string | null
  activeLayoutId: string | null
  graphLayers: GraphLayerVisibility
  rootDir: string | null | undefined
  setGraphLayerVisibility: (layers: Partial<GraphLayerVisibility>) => void
  setViewMode: (viewMode: VisualizerViewMode) => void
  viewMode: VisualizerViewMode
}

export function useWorkspaceChromeController({
  activeDraftId,
  activeLayoutId,
  graphLayers,
  rootDir,
  setGraphLayerVisibility,
  setViewMode,
  viewMode,
}: UseWorkspaceChromeControllerInput) {
  const storedUiPreferences = useMemo(() => readStoredUiPreferences(), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceSyncOpen, setWorkspaceSyncOpen] = useState(false)
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false)
  const [agentDrawerTab, setAgentDrawerTab] = useState<'chat' | 'agents' | 'layout'>(
    'chat',
  )
  const [agentComposerFocusRequestKey, setAgentComposerFocusRequestKey] = useState(0)
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => storedUiPreferences.themeMode ?? readThemeMode(),
  )
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(
    storedUiPreferences.projectsSidebarOpen ?? true,
  )
  const [canvasWidthRatio, setCanvasWidthRatio] = useState(
    clampNumber(
      storedUiPreferences.canvasWidthRatio ?? DEFAULT_CANVAS_WIDTH_RATIO,
      MIN_CANVAS_WIDTH_RATIO,
      MAX_CANVAS_WIDTH_RATIO,
    ),
  )
  const [activeResizePointerId, setActiveResizePointerId] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(
    storedUiPreferences.inspectorOpen ?? false,
  )
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [workspaceActionPending, setWorkspaceActionPending] = useState(false)
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null)
  const [desktopHostAvailable, setDesktopHostAvailable] = useState(false)
  const [uiPreferencesHydrated, setUiPreferencesHydrated] = useState(false)
  const [workspaceViewResolvedRootDir, setWorkspaceViewResolvedRootDir] = useState<
    string | null
  >(null)
  const [workspaceStateByRootDir, setWorkspaceStateByRootDir] = useState<
    Record<string, WorkspaceUiState>
  >(storedUiPreferences.workspaceStateByRootDir ?? {})
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const desktopBridge = getDesktopBridge()
  const isDesktopHost = desktopHostAvailable || isElectronHost()
  const canManageProjects = Boolean(
    desktopBridge?.openWorkspaceDialog ||
      desktopBridge?.openWorkspaceRootDir ||
      desktopBridge?.closeWorkspace ||
      desktopBridge?.getWorkspaceHistory ||
      isDesktopHost,
  )
  const inspectorWidthRatio = 1 - canvasWidthRatio
  const workspaceStyle = {
    '--cbv-canvas-width': `${(canvasWidthRatio * 100).toFixed(2)}%`,
    '--cbv-inspector-width': `${(inspectorWidthRatio * 100).toFixed(2)}%`,
  } as CSSProperties
  const workspaceViewReady =
    !rootDir || (uiPreferencesHydrated && workspaceViewResolvedRootDir === rootDir)

  useEffect(() => {
    const updateDesktopHostAvailability = () => {
      const bridge = getDesktopBridge()

      setDesktopHostAvailable(Boolean(bridge?.isDesktop))
    }

    updateDesktopHostAvailability()
    const timeoutId = window.setTimeout(updateDesktopHostAvailability, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [])

  useEffect(() => {
    applyThemeMode(themeMode)

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Ignore storage failures; theme still applies for this session.
    }
  }, [themeMode])

  useEffect(() => {
    let cancelled = false

    void fetchUiPreferences()
      .then((preferences) => {
        if (cancelled || !preferences) {
          return
        }

        if (preferences.themeMode) {
          setThemeMode(preferences.themeMode)
        }

        if (typeof preferences.projectsSidebarOpen === 'boolean') {
          setProjectsSidebarOpen(preferences.projectsSidebarOpen)
        }

        if (typeof preferences.inspectorOpen === 'boolean') {
          setInspectorOpen(preferences.inspectorOpen)
        }

        if (typeof preferences.canvasWidthRatio === 'number') {
          setCanvasWidthRatio(
            clampNumber(
              preferences.canvasWidthRatio,
              MIN_CANVAS_WIDTH_RATIO,
              MAX_CANVAS_WIDTH_RATIO,
            ),
          )
        }

        if (preferences.viewMode) {
          setViewMode(preferences.viewMode)
        }

        if (preferences.graphLayers) {
          setGraphLayerVisibility(preferences.graphLayers)
        }

        if (preferences.workspaceStateByRootDir) {
          setWorkspaceStateByRootDir(preferences.workspaceStateByRootDir)
        }
      })
      .catch(() => {
        // Ignore desktop preference load failures and fall back to local storage.
      })
      .finally(() => {
        if (!cancelled) {
          setUiPreferencesHydrated(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [setGraphLayerVisibility, setViewMode])

  useEffect(() => {
    if (storedUiPreferences.viewMode) {
      setViewMode(storedUiPreferences.viewMode)
    }

    if (storedUiPreferences.graphLayers) {
      setGraphLayerVisibility(storedUiPreferences.graphLayers)
    }
  }, [setGraphLayerVisibility, setViewMode, storedUiPreferences])

  useEffect(() => {
    if (!uiPreferencesHydrated) {
      return
    }

    const preferences: UiPreferences = {
      canvasWidthRatio,
      graphLayers,
      inspectorOpen,
      projectsSidebarOpen,
      themeMode,
      viewMode,
      workspaceStateByRootDir,
    }

    try {
      window.localStorage.setItem(
        UI_PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences),
      )
    } catch {
      // Ignore storage failures; preferences still apply for this session.
    }

    void persistUiPreferencesRequest(preferences).catch(() => {
      const bridge = getDesktopBridge()

      if (bridge?.setUiPreferences) {
        void bridge.setUiPreferences(preferences).catch(() => {
          // Ignore desktop persistence failures; local storage remains as fallback.
        })
      }
    })
  }, [
    canvasWidthRatio,
    graphLayers,
    inspectorOpen,
    projectsSidebarOpen,
    themeMode,
    uiPreferencesHydrated,
    viewMode,
    workspaceStateByRootDir,
  ])

  useEffect(() => {
    let cancelled = false
    const loadHistory = async () => {
      try {
        if (desktopBridge?.getWorkspaceHistory) {
          const history = await desktopBridge.getWorkspaceHistory()

          if (cancelled) {
            return
          }

          setRecentProjects(history.recentWorkspaces)
          return
        }

        if (canManageProjects) {
          const history = await fetchWorkspaceHistory()

          if (cancelled) {
            return
          }

          setRecentProjects(history.recentWorkspaces)
        }
      } catch {
        if (cancelled) {
          return
        }
      }
    }

    void loadHistory()

    return () => {
      cancelled = true
    }
  }, [canManageProjects, desktopBridge])

  useEffect(() => {
    if (!rootDir) {
      return
    }

    setRecentProjects((currentProjects) => rememberRecentProject(currentProjects, rootDir))
  }, [rootDir])

  useEffect(() => {
    if (!rootDir) {
      return
    }

    if (!uiPreferencesHydrated || workspaceViewResolvedRootDir !== rootDir) {
      return
    }

    setWorkspaceStateByRootDir((currentState) => {
      const currentEntry = currentState[rootDir]
      const nextEntry: WorkspaceUiState = {
        activeDraftId: activeDraftId ?? undefined,
        activeLayoutId: activeDraftId ? undefined : activeLayoutId ?? undefined,
      }

      if (
        currentEntry?.activeDraftId === nextEntry.activeDraftId &&
        currentEntry?.activeLayoutId === nextEntry.activeLayoutId
      ) {
        return currentState
      }

      return {
        ...currentState,
        [rootDir]: nextEntry,
      }
    })
  }, [
    activeDraftId,
    activeLayoutId,
    rootDir,
    uiPreferencesHydrated,
    workspaceViewResolvedRootDir,
  ])

  useEffect(() => {
    if (activeResizePointerId == null) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(event: PointerEvent) {
      if (activeResizePointerId !== event.pointerId) {
        return
      }

      const workspaceElement = workspaceRef.current

      if (!workspaceElement) {
        return
      }

      const bounds = workspaceElement.getBoundingClientRect()

      if (bounds.width <= 0) {
        return
      }

      const nextRatio = clampNumber(
        (event.clientX - bounds.left) / bounds.width,
        MIN_CANVAS_WIDTH_RATIO,
        MAX_CANVAS_WIDTH_RATIO,
      )

      setCanvasWidthRatio(nextRatio)
    }

    function handlePointerUp(event: PointerEvent) {
      if (activeResizePointerId !== event.pointerId) {
        return
      }

      setActiveResizePointerId(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [activeResizePointerId])

  function handleResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!inspectorOpen) {
      return
    }

    setActiveResizePointerId(event.pointerId)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  async function handleOpenAnotherWorkspace() {
    if (!desktopBridge?.openWorkspaceDialog) {
      if (isDesktopHost) {
        navigateSemanticodeAction('open-workspace')
      }
      return
    }

    try {
      setWorkspaceActionPending(true)
      setWorkspaceActionError(null)
      const opened = await desktopBridge.openWorkspaceDialog()

      if (!opened && desktopBridge.getWorkspaceHistory) {
        const history = await desktopBridge.getWorkspaceHistory()
        setRecentProjects(history.recentWorkspaces)
      }
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error ? error.message : 'Failed to open another folder.',
      )
    } finally {
      setWorkspaceActionPending(false)
    }
  }

  async function handleOpenRecentProject(rootDir: string) {
    if (!desktopBridge?.openWorkspaceRootDir) {
      if (isDesktopHost) {
        navigateSemanticodeAction('open-workspace-root-dir', { rootDir })
      }
      return
    }

    try {
      setWorkspaceActionPending(true)
      setWorkspaceActionError(null)
      await desktopBridge.openWorkspaceRootDir(rootDir)
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error ? error.message : 'Failed to open the selected folder.',
      )
    } finally {
      setWorkspaceActionPending(false)
    }
  }

  async function handleRemoveRecentProject(rootDir: string) {
    if (!rootDir) {
      return
    }

    try {
      setWorkspaceActionPending(true)
      setWorkspaceActionError(null)

      if (desktopBridge?.removeWorkspaceHistoryEntry) {
        const history = await desktopBridge.removeWorkspaceHistoryEntry(rootDir)
        setRecentProjects(history.recentWorkspaces)
      } else {
        setRecentProjects((currentProjects) =>
          currentProjects.filter((project) => project.rootDir !== rootDir),
        )
      }
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error ? error.message : 'Failed to remove the selected workspace.',
      )
    } finally {
      setWorkspaceActionPending(false)
    }
  }

  const handleFocusAgentDrawerComposer = () => {
    setAgentDrawerTab('chat')
    setAgentDrawerOpen(true)
    setAgentComposerFocusRequestKey((current) => current + 1)
  }

  return {
    agentComposerFocusRequestKey,
    agentDrawerOpen,
    agentDrawerTab,
    canManageProjects,
    desktopBridge,
    handleFocusAgentDrawerComposer,
    handleOpenAnotherWorkspace,
    handleOpenRecentProject,
    handleRemoveRecentProject,
    handleResizePointerDown,
    inspectorOpen,
    isDesktopHost,
    projectsSidebarOpen,
    recentProjects,
    setAgentDrawerOpen,
    setAgentDrawerTab,
    setInspectorOpen,
    setProjectsSidebarOpen,
    setSettingsOpen,
    setThemeMode,
    setWorkspaceSyncOpen,
    setWorkspaceStateByRootDir,
    setWorkspaceViewResolvedRootDir,
    settingsOpen,
    themeMode,
    uiPreferencesHydrated,
    workspaceActionError,
    workspaceActionPending,
    workspaceRef,
    workspaceStateByRootDir,
    workspaceStyle,
    workspaceSyncOpen,
    workspaceViewReady,
    workspaceViewResolvedRootDir,
  }
}

export function getWorkspaceName(rootDir: string) {
  const normalizedRootDir = rootDir.replace(/[\\/]+$/, '')
  const segments = normalizedRootDir.split(/[\\/]/)
  return segments[segments.length - 1] || rootDir
}

function getDesktopBridge() {
  return (
    globalThis as typeof globalThis & {
      semanticodeDesktop?: DesktopBridge
      semanticodeDesktopAgent?: DesktopBridge
    }
  ).semanticodeDesktop ?? (
    globalThis as typeof globalThis & {
      semanticodeDesktopAgent?: DesktopBridge
    }
  ).semanticodeDesktopAgent
}

function isElectronHost() {
  return /Electron/i.test(globalThis.navigator?.userAgent ?? '')
}

function navigateSemanticodeAction(path: string, params?: Record<string, string>) {
  const url = new URL(`semanticode://${path}`)

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }

  globalThis.location.assign(url.toString())
}

function rememberRecentProject(projects: RecentProject[], rootDir: string) {
  const nextProject: RecentProject = {
    name: getWorkspaceName(rootDir),
    rootDir,
    lastOpenedAt: new Date().toISOString(),
  }

  return [nextProject, ...projects.filter((project) => project.rootDir !== rootDir)].slice(0, 12)
}

import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  Position,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'
import {
  Suspense,
  memo,
  useEffect,
  useCallback,
  lazy,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  type AgentHeatSample,
  type AutonomousRunDetail,
  type AutonomousRunSummary,
  type AutonomousRunTimelinePoint,
  isDirectoryNode,
  isFileNode,
  isSymbolNode,
  type CodebaseFile,
  type CodebaseSnapshot,
  type GraphEdgeKind,
  type GraphLayerKey,
  type LayoutDraft,
  type LayoutNodeScope,
  type LayoutSpec,
  type ProjectNode,
  type PreprocessedWorkspaceContext,
  type PreprocessingStatus,
  type SymbolNode,
  type TelemetryActivityEvent,
  type TelemetryMode,
  type TelemetryOverview,
  type TelemetrySource,
  type TelemetryWindow,
  type UiPreferences,
  type VisualizerViewMode,
  type WorkspaceUiState,
  type WorkspaceProfile,
  type WorkspaceArtifactSyncStatus,
  type GroupPrototypeCacheSnapshot,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { buildStructuralLayout } from '../layouts/structuralLayout'
import { buildSymbolLayout } from '../layouts/symbolLayout'
import { buildSemanticLayout } from '../semantic/semanticLayout'
import { WorkspaceAgentActivity } from './agent/WorkspaceAgentActivity'
import { CodebaseAnnotationNode } from './CodebaseAnnotationNode'
import { CodebaseCanvasNode } from './CodebaseCanvasNode'
import { CodebaseSymbolNode } from './CodebaseSymbolNode'
import { getInspectorHeaderSummary } from './inspector/inspectorUtils'
import { AutonomousRunsPanel } from './runs/AutonomousRunsPanel'
import { SemanticodeErrorBoundary } from './SemanticodeErrorBoundary'
import type { ThemeMode } from './settings/GeneralSettingsPanel'
import { ProjectsSidebar } from './shell/ProjectsSidebar'
import { WorkspaceSyncModal } from './shell/WorkspaceSyncModal'
import { WorkspaceToolbar } from './shell/WorkspaceToolbar'
import {
  fetchAutonomousRunDetail,
  fetchAutonomousRunTimeline,
  fetchAutonomousRuns,
  fetchTelemetryActivity,
  fetchTelemetryHeatmap,
  fetchTelemetryOverview,
  fetchGroupPrototypeCache,
  fetchUiPreferences,
  fetchWorkspaceHistory,
  persistGroupPrototypeCache,
  persistUiPreferences as persistUiPreferencesRequest,
  requestSemanticEmbeddings,
  startAutonomousRun,
  stopAutonomousRun,
} from '../app/apiClient'
import {
  applyThemeMode,
  readStoredUiPreferences,
  readThemeMode,
  THEME_STORAGE_KEY,
  UI_PREFERENCES_STORAGE_KEY,
} from '../app/themeBootstrap'
import {
  filterSemanticSearchMatches,
  filterSearchableSemanticEmbeddings,
  rankSemanticSearchMatches,
  type SemanticSearchResult,
  type SemanticSearchMatch,
} from '../semantic/semanticSearch'
import {
  buildGroupPrototypeRecords,
  mergeGroupPrototypeRecords,
  rankNearbySymbolsForGroupPrototype,
  rankGroupPrototypeMatches,
  type GroupPrototypeSearchMatch,
} from '../semantic/groups/groupPrototypes'
import {
  canCompareLayoutAgainstSemantic,
  resolveCanvasScene,
  resolveLayoutCompareOverlay,
} from '../visualizer/canvasScene'
import { hashSemanticText } from '../types'

const LazyInspectorPane = lazy(async () => {
  const module = await import('./inspector/InspectorPane')
  return { default: module.InspectorPane }
})

const LazyGeneralSettingsPanel = lazy(async () => {
  const module = await import('./settings/GeneralSettingsPanel')
  return { default: module.GeneralSettingsPanel }
})

interface SemanticodeProps {
  snapshot?: CodebaseSnapshot | null
  onAcceptDraft?: (draftId: string) => Promise<void>
  onAgentRunSettled?: () => Promise<void>
  onBuildSemanticEmbeddings?: () => void
  onRejectDraft?: (draftId: string) => Promise<void>
  onSuggestLayout?: (brief: string) => Promise<void>
  onStartPreprocessing?: () => void
  layoutActionsPending?: boolean
  layoutSuggestionPending?: boolean
  layoutSuggestionError?: string | null
  preprocessedWorkspaceContext?: PreprocessedWorkspaceContext | null
  preprocessingStatus?: PreprocessingStatus | null
  workspaceSyncStatus?: WorkspaceArtifactSyncStatus | null
  workspaceProfile?: WorkspaceProfile | null
}

type FlowEdgeData = Record<string, unknown> & {
  kind: GraphEdgeKind
  count?: number
  dimmed?: boolean
  highlighted?: boolean
}

interface GraphSummary {
  incoming: number
  outgoing: number
  neighbors: ProjectNode[]
}

interface SymbolCluster {
  id: string
  rootNodeId: string
  memberNodeIds: string[]
  label: string
  ownerByMemberNodeId: Record<string, string>
}

interface SymbolClusterState {
  clusters: SymbolCluster[]
  clusterByNodeId: Record<string, SymbolCluster | undefined>
  callerCounts: Record<string, number>
}

interface ExpandedClusterLayout {
  rootNodeId: string
  width: number
  height: number
  childPlacements: Record<
    string,
    {
      x: number
      y: number
      width: number
      height: number
    }
  >
}

interface FilesystemContainerLayout {
  width: number
  height: number
  childNodeIds: string[]
}

interface LayoutGroupContainer {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  nodeIds: string[]
}

interface NodeDimensions {
  width: number
  height: number
  compact: boolean
}

interface FlowModel {
  nodes: Node[]
  edges: Edge[]
}

const CLUSTERABLE_SYMBOL_KINDS = new Set([
  'class',
  'function',
  'method',
  'constant',
  'variable',
])
const EXPANDED_CLUSTER_CHILD_WIDTH = 188
const EXPANDED_CLUSTER_CHILD_HEIGHT = 82
const EXPANDED_CLUSTER_GAP_X = 14
const EXPANDED_CLUSTER_GAP_Y = 12
const EXPANDED_CLUSTER_PADDING_X = 14
const EXPANDED_CLUSTER_PADDING_TOP = 18
const EXPANDED_CLUSTER_PADDING_BOTTOM = 14
const DEFAULT_NODE_WIDTH = 240
const DEFAULT_NODE_HEIGHT = 108
const COMPACT_SYMBOL_NODE_WIDTH = 164
const COMPACT_SYMBOL_NODE_HEIGHT = 74
const DEFAULT_CANVAS_WIDTH_RATIO = 0.6
const MIN_CANVAS_WIDTH_RATIO = 0.32
const MAX_CANVAS_WIDTH_RATIO = 0.78
const FILESYSTEM_CONTAINER_PADDING_RIGHT = 18
const FILESYSTEM_CONTAINER_PADDING_BOTTOM = 18
const LAYOUT_GROUP_PADDING_X = 22
const LAYOUT_GROUP_PADDING_TOP = 112
const LAYOUT_GROUP_PADDING_BOTTOM = 44
const SEMANTIC_SEARCH_RESULT_LIMIT = 24
const SEMANTIC_SEARCH_MIN_QUERY_LENGTH = 2
const SEMANTIC_SEARCH_MIN_LIMIT = 1
const SEMANTIC_SEARCH_MAX_LIMIT = 60
const SEMANTIC_SEARCH_DEFAULT_STRICTNESS = 35
type SemanticSearchMode = 'symbols' | 'groups'
const nodeTypes = {
  annotationNode: CodebaseAnnotationNode,
  codebaseNode: CodebaseCanvasNode,
  symbolNode: CodebaseSymbolNode,
}

const SYMBOL_LEGEND_ITEMS = [
  { label: 'Class', kindClass: 'class' },
  { label: 'Function', kindClass: 'function' },
  { label: 'Method', kindClass: 'method' },
  { label: 'Constant', kindClass: 'constant' },
  { label: 'Variable', kindClass: 'variable' },
] as const

const VIRTUAL_LAYOUT_GROUP_NODE_PREFIX = '__layout_group__:'

interface DesktopBridge {
  closeWorkspace?: () => Promise<boolean>
  getUiPreferences?: () => Promise<UiPreferences>
  getWorkspaceHistory?: () => Promise<{
    activeWorkspaceRootDir: string | null
    recentWorkspaces: {
      name: string
      rootDir: string
      lastOpenedAt: string
    }[]
  }>
  isDesktop?: boolean
  openWorkspaceDialog?: () => Promise<boolean>
  openWorkspaceRootDir?: (rootDir: string) => Promise<boolean>
  setUiPreferences?: (preferences: UiPreferences) => Promise<UiPreferences>
}

interface RecentProject {
  name: string
  rootDir: string
  lastOpenedAt: string
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

export function Semanticode({
  snapshot,
  onAcceptDraft,
  onAgentRunSettled,
  onBuildSemanticEmbeddings,
  onRejectDraft,
  onSuggestLayout,
  onStartPreprocessing,
  layoutActionsPending = false,
  layoutSuggestionPending = false,
  layoutSuggestionError = null,
  preprocessedWorkspaceContext = null,
  preprocessingStatus = null,
  workspaceSyncStatus = null,
  workspaceProfile = null,
}: SemanticodeProps) {
  const storedUiPreferences = useMemo(() => readStoredUiPreferences(), [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [runsPanelOpen, setRunsPanelOpen] = useState(false)
  const [workspaceSyncOpen, setWorkspaceSyncOpen] = useState(false)
  const [themeMode, setThemeMode] = useState<ThemeMode>(
    () => storedUiPreferences.themeMode ?? readThemeMode(),
  )
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(
    storedUiPreferences.projectsSidebarOpen ?? true,
  )
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const [layoutSuggestionText, setLayoutSuggestionText] = useState('')
  const [canvasWidthRatio, setCanvasWidthRatio] = useState(
    clampNumber(
      storedUiPreferences.canvasWidthRatio ?? DEFAULT_CANVAS_WIDTH_RATIO,
      MIN_CANVAS_WIDTH_RATIO,
      MAX_CANVAS_WIDTH_RATIO,
    ),
  )
  const [activeResizePointerId, setActiveResizePointerId] = useState<number | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(
    storedUiPreferences.inspectorOpen ?? false,
  )
  const [recentProjects, setRecentProjects] = useState<
    RecentProject[]
  >([])
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
  const [semanticSearchQuery, setSemanticSearchQuery] = useState('')
  const [semanticSearchMode, setSemanticSearchMode] = useState<SemanticSearchMode>('symbols')
  const [semanticSearchPending, setSemanticSearchPending] = useState(false)
  const [semanticSearchError, setSemanticSearchError] = useState<string | null>(null)
  const [semanticSearchRankedMatches, setSemanticSearchRankedMatches] = useState<SemanticSearchResult[]>(
    [],
  )
  const [groupPrototypeCache, setGroupPrototypeCache] = useState<GroupPrototypeCacheSnapshot | null>(
    null,
  )
  const [groupPrototypeCacheLoaded, setGroupPrototypeCacheLoaded] = useState(false)
  const [semanticSearchMatchLimit, setSemanticSearchMatchLimit] = useState(
    SEMANTIC_SEARCH_RESULT_LIMIT,
  )
  const [semanticSearchStrictness, setSemanticSearchStrictness] = useState(
    SEMANTIC_SEARCH_DEFAULT_STRICTNESS,
  )
  const [autonomousRuns, setAutonomousRuns] = useState<AutonomousRunSummary[]>([])
  const [detectedTaskFile, setDetectedTaskFile] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedRunDetail, setSelectedRunDetail] = useState<AutonomousRunDetail | null>(null)
  const [selectedRunTimeline, setSelectedRunTimeline] = useState<AutonomousRunTimelinePoint[]>([])
  const [runActionPending, setRunActionPending] = useState(false)
  const [runActionError, setRunActionError] = useState<string | null>(null)
  const [telemetrySource, setTelemetrySource] = useState<TelemetrySource>('all')
  const [telemetryWindow, setTelemetryWindow] = useState<TelemetryWindow>(60)
  const [telemetryMode, setTelemetryMode] = useState<TelemetryMode>('symbols')
  const [telemetryEnabled, setTelemetryEnabled] = useState(false)
  const [telemetryOverview, setTelemetryOverview] = useState<TelemetryOverview | null>(null)
  const [telemetryHeatSamples, setTelemetryHeatSamples] = useState<AgentHeatSample[]>([])
  const [telemetryActivityEvents, setTelemetryActivityEvents] = useState<TelemetryActivityEvent[]>([])
  const [telemetryError, setTelemetryError] = useState<string | null>(null)
  const [telemetryObservedAt, setTelemetryObservedAt] = useState(0)
  const hasRunningAutonomousRun = autonomousRuns.some((run) => run.status === 'running')
  const currentSnapshot = useVisualizerStore((state) => state.snapshot)
  const draftLayouts = useVisualizerStore((state) => state.draftLayouts)
  const activeDraftId = useVisualizerStore((state) => state.activeDraftId)
  const layouts = useVisualizerStore((state) => state.layouts)
  const activeLayoutId = useVisualizerStore((state) => state.activeLayoutId)
  const selectedNodeId = useVisualizerStore((state) => state.selection.nodeId)
  const selectedNodeIds = useVisualizerStore((state) => state.selection.nodeIds)
  const selectedEdgeId = useVisualizerStore((state) => state.selection.edgeId)
  const inspectorTab = useVisualizerStore((state) => state.selection.inspectorTab)
  const viewport = useVisualizerStore((state) => state.viewport)
  const graphLayers = useVisualizerStore((state) => state.graphLayers)
  const viewMode = useVisualizerStore((state) => state.viewMode)
  const baseScene = useVisualizerStore((state) => state.baseScene)
  const compareOverlay = useVisualizerStore((state) => state.compareOverlay)
  const overlayVisibility = useVisualizerStore((state) => state.overlayVisibility)
  const overlayFocusMode = useVisualizerStore((state) => state.overlayFocusMode)
  const workingSet = useVisualizerStore((state) => state.workingSet)
  const collapsedDirectoryIds = useVisualizerStore(
    (state) => state.collapsedDirectoryIds,
  )
  const expandedSymbolClusterIds = useVisualizerStore(
    (state) => state.expandedSymbolClusterIds,
  )
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setDraftLayouts = useVisualizerStore((state) => state.setDraftLayouts)
  const setActiveDraftId = useVisualizerStore((state) => state.setActiveDraftId)
  const setLayouts = useVisualizerStore((state) => state.setLayouts)
  const setActiveLayoutId = useVisualizerStore((state) => state.setActiveLayoutId)
  const setViewport = useVisualizerStore((state) => state.setViewport)
  const setViewMode = useVisualizerStore((state) => state.setViewMode)
  const setGraphLayerVisibility = useVisualizerStore(
    (state) => state.setGraphLayerVisibility,
  )
  const setBaseScene = useVisualizerStore((state) => state.setBaseScene)
  const setCompareOverlay = useVisualizerStore((state) => state.setCompareOverlay)
  const clearCompareOverlay = useVisualizerStore((state) => state.clearCompareOverlay)
  const setOverlayVisibility = useVisualizerStore((state) => state.setOverlayVisibility)
  const adoptSelectionAsWorkingSet = useVisualizerStore(
    (state) => state.adoptSelectionAsWorkingSet,
  )
  const clearWorkingSet = useVisualizerStore((state) => state.clearWorkingSet)
  const toggleCollapsedDirectory = useVisualizerStore(
    (state) => state.toggleCollapsedDirectory,
  )
  const setExpandedSymbolClusterIds = useVisualizerStore(
    (state) => state.setExpandedSymbolClusterIds,
  )
  const selectNode = useVisualizerStore((state) => state.selectNode)
  const selectEdge = useVisualizerStore((state) => state.selectEdge)
  const setInspectorTab = useVisualizerStore((state) => state.setInspectorTab)
  const toggleGraphLayer = useVisualizerStore((state) => state.toggleGraphLayer)
  const toggleSymbolCluster = useVisualizerStore(
    (state) => state.toggleSymbolCluster,
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const inspectorBodyRef = useRef<HTMLDivElement | null>(null)
  const lastFittedCompareKeyRef = useRef<string | null>(null)
  const selectionAutoOpenInitializedRef = useRef(false)
  const semanticSearchCacheRef = useRef(new Map<string, SemanticSearchResult[]>())
  const containerDragPreviewPositionsRef = useRef(new Map<string, XYPosition>())
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const desktopBridge = getDesktopBridge()
  const isDesktopHost = desktopHostAvailable || isElectronHost()
  const canManageProjects = Boolean(
    desktopBridge?.openWorkspaceDialog ||
    desktopBridge?.openWorkspaceRootDir ||
    desktopBridge?.closeWorkspace ||
    desktopBridge?.getWorkspaceHistory ||
    isDesktopHost,
  )
  const effectiveSnapshot = snapshot ?? currentSnapshot

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
    let cancelled = false

    if (!effectiveSnapshot?.rootDir) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroupPrototypeCache(null)
      setGroupPrototypeCacheLoaded(false)
      return
    }

    setGroupPrototypeCacheLoaded(false)
    void fetchGroupPrototypeCache()
      .then((cache) => {
        if (!cancelled) {
          setGroupPrototypeCache(cache)
          setGroupPrototypeCacheLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGroupPrototypeCache(null)
          setGroupPrototypeCacheLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [effectiveSnapshot?.rootDir])

  useEffect(() => {
    if (snapshot === undefined) {
      return
    }

    setSnapshot(snapshot)
  }, [setSnapshot, snapshot])

  useEffect(() => {
    let cancelled = false

    if (!effectiveSnapshot?.rootDir || !telemetryEnabled) {
      return
    }

    const refreshTelemetry = async () => {
      try {
        const telemetryQuery = {
          mode: telemetryMode,
          runId: telemetryWindow === 'run' ? selectedRunId ?? undefined : undefined,
          source: telemetrySource,
          window: telemetryWindow,
        } as const
        const [overviewResponse, heatmapResponse, activityResponse] = await Promise.all([
          fetchTelemetryOverview(telemetryQuery),
          fetchTelemetryHeatmap(telemetryQuery),
          fetchTelemetryActivity(telemetryQuery),
        ])

        if (cancelled) {
          return
        }

        setTelemetryOverview(overviewResponse.overview)
        setTelemetryHeatSamples(heatmapResponse.samples)
        setTelemetryActivityEvents(activityResponse.events)
        setTelemetryError(null)
        setTelemetryObservedAt(Date.now())
      } catch (error) {
        if (!cancelled) {
          setTelemetryError(
            error instanceof Error ? error.message : 'Failed to load autonomous run telemetry.',
          )
        }
      }
    }

    void refreshTelemetry()
    const intervalId = window.setInterval(() => {
      void refreshTelemetry()
    }, runsPanelOpen || telemetryWindow === 'run' || hasRunningAutonomousRun ? 2500 : 5000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [
    effectiveSnapshot?.rootDir,
    hasRunningAutonomousRun,
    runsPanelOpen,
    selectedRunId,
    telemetryEnabled,
    telemetryMode,
    telemetrySource,
    telemetryWindow,
  ])

  useEffect(() => {
    let cancelled = false

    if (!runsPanelOpen || !effectiveSnapshot?.rootDir) {
      return
    }

    const refreshRuns = async () => {
      try {
        const runsResponse = await fetchAutonomousRuns()

        if (cancelled) {
          return
        }

        setAutonomousRuns(runsResponse.runs)
        setDetectedTaskFile(runsResponse.detectedTaskFile)
        setRunActionError(null)
        setSelectedRunId((currentRunId) =>
          currentRunId && runsResponse.runs.some((run) => run.runId === currentRunId)
            ? currentRunId
            : null,
        )
      } catch (error) {
        if (!cancelled) {
          setRunActionError(
            error instanceof Error ? error.message : 'Failed to load autonomous runs.',
          )
        }
      }
    }

    void refreshRuns()
    const intervalId = window.setInterval(() => {
      void refreshRuns()
    }, hasRunningAutonomousRun ? 2500 : 5000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [effectiveSnapshot?.rootDir, hasRunningAutonomousRun, runsPanelOpen])

  useEffect(() => {
    let cancelled = false

    if (!runsPanelOpen || !effectiveSnapshot?.rootDir || !selectedRunId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedRunDetail(null)
      setSelectedRunTimeline([])
      return
    }

    const refreshRunDetail = async () => {
      try {
        const [detailResponse, timelineResponse] = await Promise.all([
          fetchAutonomousRunDetail(selectedRunId),
          fetchAutonomousRunTimeline(selectedRunId),
        ])

        if (cancelled) {
          return
        }

        setSelectedRunDetail(detailResponse.run)
        setSelectedRunTimeline(timelineResponse.timeline)
        setRunActionError(null)
      } catch (error) {
        if (!cancelled) {
          setRunActionError(
            error instanceof Error ? error.message : 'Failed to load the selected run.',
          )
        }
      }
    }

    void refreshRunDetail()
    const intervalId = window.setInterval(() => {
      void refreshRunDetail()
    }, 2500)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [effectiveSnapshot?.rootDir, runsPanelOpen, selectedRunId])

  useEffect(() => {
    if (!effectiveSnapshot?.rootDir) {
      return
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecentProjects((currentProjects) => {
      return rememberRecentProject(currentProjects, effectiveSnapshot.rootDir)
    })
  }, [effectiveSnapshot?.rootDir])

  useEffect(() => {
    if (!effectiveSnapshot?.rootDir) {
      return
    }

    if (!uiPreferencesHydrated || workspaceViewResolvedRootDir !== effectiveSnapshot.rootDir) {
      return
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkspaceStateByRootDir((currentState) => {
      const currentEntry = currentState[effectiveSnapshot.rootDir]
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
        [effectiveSnapshot.rootDir]: nextEntry,
      }
    })
  }, [
    activeDraftId,
    activeLayoutId,
    effectiveSnapshot?.rootDir,
    uiPreferencesHydrated,
    workspaceViewResolvedRootDir,
  ])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!effectiveSnapshot?.rootDir) {
      setWorkspaceViewResolvedRootDir(null)
      return
    }

    if (!uiPreferencesHydrated) {
      setWorkspaceViewResolvedRootDir(null)
      return
    }

    if (!effectiveSnapshot) {
      setDraftLayouts([])
      setLayouts([])
      setActiveDraftId(null)
      setActiveLayoutId(null)
      setWorkspaceViewResolvedRootDir(null)
      return
    }

    const structuralLayout = buildStructuralLayout(effectiveSnapshot)
    const symbolLayout = buildSymbolLayout(effectiveSnapshot)
    const semanticLayout = buildSemanticLayout(
      effectiveSnapshot,
      preprocessedWorkspaceContext,
    )
    const nextLayouts = mergeLayoutsWithDefaults(layouts, [
      structuralLayout,
      symbolLayout,
      semanticLayout,
    ])

    if (!areLayoutListsEquivalent(layouts, nextLayouts)) {
      setLayouts(nextLayouts)
    }

    const isResolvingWorkspaceView =
      workspaceViewResolvedRootDir !== effectiveSnapshot.rootDir
    const rememberedWorkspaceState = workspaceStateByRootDir[effectiveSnapshot.rootDir]
    const rememberedDraftId = rememberedWorkspaceState?.activeDraftId
    const rememberedLayoutId = rememberedWorkspaceState?.activeLayoutId

    if (isResolvingWorkspaceView) {
      if (
        rememberedDraftId &&
        draftLayouts.some(
          (draft) =>
            draft.id === rememberedDraftId && draft.layout && draft.status === 'draft',
        )
      ) {
        if (activeDraftId !== rememberedDraftId) {
          setActiveLayoutId(null)
          setActiveDraftId(rememberedDraftId)
          return
        }

        setWorkspaceViewResolvedRootDir(effectiveSnapshot.rootDir)
        return
      }

      if (
        rememberedLayoutId &&
        nextLayouts.some((layout) => layout.id === rememberedLayoutId)
      ) {
        if (activeLayoutId !== rememberedLayoutId || activeDraftId) {
          setActiveDraftId(null)
          setActiveLayoutId(rememberedLayoutId)
          return
        }

        setWorkspaceViewResolvedRootDir(effectiveSnapshot.rootDir)
        return
      }

      const defaultLayoutId =
        viewMode === 'symbols' ? symbolLayout.id : structuralLayout.id

      if (activeLayoutId !== defaultLayoutId || activeDraftId) {
        setActiveDraftId(null)
        setActiveLayoutId(defaultLayoutId)
        return
      }

      setWorkspaceViewResolvedRootDir(effectiveSnapshot.rootDir)
      return
    }

    if (
      activeDraftId &&
      !draftLayouts.some(
        (draft) => draft.id === activeDraftId && draft.layout && draft.status === 'draft',
      )
    ) {
      setActiveDraftId(null)
      return
    }

    if (
      !activeDraftId &&
      activeLayoutId &&
      !nextLayouts.some((layout) => layout.id === activeLayoutId)
    ) {
      setActiveLayoutId(viewMode === 'symbols' ? symbolLayout.id : structuralLayout.id)
    }
  }, [
    activeDraftId,
    activeLayoutId,
    draftLayouts,
    effectiveSnapshot,
    layouts,
    setActiveDraftId,
    setActiveLayoutId,
    setDraftLayouts,
    setLayouts,
    uiPreferencesHydrated,
    viewMode,
    workspaceViewResolvedRootDir,
    workspaceStateByRootDir,
    preprocessedWorkspaceContext,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  const availableDraftLayouts = draftLayouts.filter(
    (draft) => draft.layout && draft.status === 'draft',
  )
  const activeDraft =
    availableDraftLayouts.find((draft) => draft.id === activeDraftId) ?? null
  const selectedLayoutValue = activeDraft
    ? `draft:${activeDraft.id}`
    : activeLayoutId
      ? `layout:${activeLayoutId}`
      : ''
  const activeLayout =
    activeDraft?.layout ??
    layouts.find((layout) => layout.id === activeLayoutId) ??
    layouts[0] ??
    null
  const layoutSyncById = useMemo(
    () =>
      new Map(
        workspaceSyncStatus?.layouts.map((entry) => [entry.id, entry]) ?? [],
      ),
    [workspaceSyncStatus],
  )
  const draftSyncById = useMemo(
    () =>
      new Map(
        workspaceSyncStatus?.drafts.map((entry) => [entry.id, entry]) ?? [],
      ),
    [workspaceSyncStatus],
  )
  const activeLayoutSync =
    activeDraft
      ? draftSyncById.get(activeDraft.id) ?? null
      : activeLayout
        ? layoutSyncById.get(activeLayout.id) ?? null
        : null
  const layoutOptions = useMemo(
    () => [
      ...layouts.map((layout) => ({
        label: formatLayoutOptionLabel(layout.title, layoutSyncById.get(layout.id)),
        value: `layout:${layout.id}`,
      })),
      ...availableDraftLayouts.map((draft) => ({
        label: formatLayoutOptionLabel(
          `Draft: ${draft.layout?.title ?? draft.id}`,
          draftSyncById.get(draft.id),
        ),
        value: `draft:${draft.id}`,
      })),
    ],
    [availableDraftLayouts, draftSyncById, layoutSyncById, layouts],
  )
  const resolvedScene = useMemo(
    () =>
      resolveCanvasScene({
        activeLayout,
        baseScene,
        layouts,
      }),
    [activeLayout, baseScene, layouts],
  )
  const resolvedCompareOverlay = useMemo(
    () =>
      effectiveSnapshot
        ? resolveLayoutCompareOverlay({
            snapshot: effectiveSnapshot,
            compareOverlay,
            draftLayouts,
            layouts,
            scene: resolvedScene,
          })
        : null,
    [compareOverlay, draftLayouts, effectiveSnapshot, layouts, resolvedScene],
  )
  const overlayNodeIdSet = useMemo(
    () => new Set(resolvedCompareOverlay?.nodeIds ?? []),
    [resolvedCompareOverlay],
  )
  const compareOverlayActive =
    Boolean(resolvedCompareOverlay) &&
    overlayVisibility &&
    overlayFocusMode === 'highlight_dim'
  const semanticSearchEmbeddings = useMemo(() => {
    const visibleSymbolIds = new Set(
      Object.keys(resolvedScene?.layoutSpec.placements ?? {}).filter((nodeId) => {
        return !resolvedScene?.layoutSpec.hiddenNodeIds.includes(nodeId)
      }),
    )

    return filterSearchableSemanticEmbeddings(
      preprocessedWorkspaceContext?.semanticEmbeddings ?? [],
      visibleSymbolIds,
    )
  }, [preprocessedWorkspaceContext?.semanticEmbeddings, resolvedScene])
  const semanticSearchAvailable =
    viewMode === 'symbols' && semanticSearchEmbeddings.length > 0
  const semanticSearchModelId = semanticSearchEmbeddings[0]?.modelId ?? null
  const semanticSearchGroupSourceLayout = useMemo(() => {
    const layoutSpec = resolvedScene?.layoutSpec ?? null

    if (!layoutSpec || layoutSpec.strategy !== 'agent' || layoutSpec.groups.length === 0) {
      return null
    }

    return layoutSpec
  }, [resolvedScene])
  const semanticSearchCachedGroupPrototypes = useMemo(() => {
    if (!semanticSearchGroupSourceLayout || !groupPrototypeCache?.records.length) {
      return []
    }

    return groupPrototypeCache.records.filter(
      (record) => record.layoutId === semanticSearchGroupSourceLayout.id,
    )
  }, [groupPrototypeCache, semanticSearchGroupSourceLayout])
  const semanticSearchGroupPrototypes = useMemo(
    () =>
      buildGroupPrototypeRecords(
        semanticSearchGroupSourceLayout,
        semanticSearchEmbeddings,
        semanticSearchCachedGroupPrototypes,
      ),
    [
      semanticSearchCachedGroupPrototypes,
      semanticSearchEmbeddings,
      semanticSearchGroupSourceLayout,
    ],
  )
  const semanticGroupSearchAvailable =
    semanticSearchAvailable && semanticSearchGroupPrototypes.length > 0
  const semanticSearchMatches = useMemo(
    () =>
      filterSemanticSearchMatches(semanticSearchRankedMatches, {
        limit: semanticSearchMatchLimit,
        strictness: semanticSearchStrictness,
      }),
    [semanticSearchMatchLimit, semanticSearchRankedMatches, semanticSearchStrictness],
  )
  const semanticSearchMatchNodeIds = useMemo(
    () => {
      const nodeIds = new Set<string>()

      for (const match of semanticSearchMatches) {
        if (semanticSearchMode === 'groups') {
          const groupMatch = match as Partial<GroupPrototypeSearchMatch>

          if (!groupMatch.groupId || !Array.isArray(groupMatch.memberNodeIds)) {
            continue
          }

          nodeIds.add(getLayoutGroupNodeId(groupMatch.groupId))
          for (const nodeId of groupMatch.memberNodeIds) {
            nodeIds.add(nodeId)
          }
          continue
        }

        nodeIds.add((match as SemanticSearchMatch).symbolId)
      }

      return nodeIds
    },
    [semanticSearchMatches, semanticSearchMode],
  )
  const handleSemanticSearchModeChange = useCallback((mode: SemanticSearchMode) => {
    setSemanticSearchMode(mode)
    setSemanticSearchRankedMatches([])
    setSemanticSearchError(null)
    setSemanticSearchPending(false)
  }, [])
  const semanticSearchHighlightActive =
    semanticSearchAvailable &&
    semanticSearchQuery.trim().length >= SEMANTIC_SEARCH_MIN_QUERY_LENGTH &&
    semanticSearchMatchNodeIds.size > 0
  const highlightedNodeIdSet = useMemo(() => {
    return new Set([...overlayNodeIdSet, ...semanticSearchMatchNodeIds])
  }, [overlayNodeIdSet, semanticSearchMatchNodeIds])
  const currentCompareSource = useMemo(() => {
    if (activeDraft?.layout && canCompareLayoutAgainstSemantic(activeDraft.layout)) {
      return {
        sourceType: 'draft' as const,
        sourceId: activeDraft.id,
        title: activeDraft.layout.title,
      }
    }

    if (activeLayout && canCompareLayoutAgainstSemantic(activeLayout)) {
      return {
        sourceType: 'layout' as const,
        sourceId: activeLayout.id,
        title: activeLayout.title,
      }
    }

    return null
  }, [activeDraft, activeLayout])
  const editableDraftLayout = resolvedScene?.kind === 'layout' ? activeDraft : null
  const editableLayout = resolvedScene?.layoutSpec ?? activeLayout

  useEffect(() => {
    if (!resolvedScene) {
      return
    }

    const layoutViewMode = getPreferredViewModeForLayout(resolvedScene.layoutSpec)

    if (viewMode !== layoutViewMode) {
      setViewMode(layoutViewMode)
    }
  }, [resolvedScene, setViewMode, viewMode])

  useEffect(() => {
    setExpandedSymbolClusterIds([])
  }, [resolvedScene?.layoutSpec.id, setExpandedSymbolClusterIds])

  useEffect(() => {
    semanticSearchCacheRef.current.clear()
  }, [
    effectiveSnapshot?.rootDir,
    semanticSearchEmbeddings.length,
    semanticSearchGroupPrototypes.length,
    semanticSearchModelId,
  ])

  useEffect(() => {
    if (!semanticSearchGroupSourceLayout || !groupPrototypeCacheLoaded) {
      return
    }

    const nextCache: GroupPrototypeCacheSnapshot = {
      records: mergeGroupPrototypeRecords(
        groupPrototypeCache?.records ?? [],
        semanticSearchGroupPrototypes,
        semanticSearchGroupSourceLayout.id,
      ),
      updatedAt: new Date().toISOString(),
    }

    if (areGroupPrototypeCachesEquivalent(groupPrototypeCache, nextCache)) {
      return
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGroupPrototypeCache(nextCache)
    void persistGroupPrototypeCache(nextCache).catch(() => {
      // Ignore persistence failures; in-memory cache still works for this session.
    })
  }, [
    groupPrototypeCache,
    groupPrototypeCacheLoaded,
    semanticSearchGroupPrototypes,
    semanticSearchGroupSourceLayout,
  ])

  useEffect(() => {
    if (semanticSearchMode === 'groups' && !semanticGroupSearchAvailable) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSemanticSearchMode('symbols')
    }
  }, [semanticGroupSearchAvailable, semanticSearchMode])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!semanticSearchAvailable) {
      setSemanticSearchPending(false)
      setSemanticSearchError(null)
      setSemanticSearchRankedMatches([])
      return
    }

    const trimmedQuery = semanticSearchQuery.trim()

    if (trimmedQuery.length < SEMANTIC_SEARCH_MIN_QUERY_LENGTH) {
      setSemanticSearchPending(false)
      setSemanticSearchError(null)
      setSemanticSearchRankedMatches([])
      return
    }

    const cacheKey = `${semanticSearchMode}::${semanticSearchGroupSourceLayout?.id ?? 'none'}::${trimmedQuery.toLocaleLowerCase()}::${semanticSearchModelId ?? 'unknown'}`
    const cachedMatches = semanticSearchCacheRef.current.get(cacheKey)

    if (cachedMatches) {
      setSemanticSearchPending(false)
      setSemanticSearchError(null)
      setSemanticSearchRankedMatches(cachedMatches)
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          setSemanticSearchPending(true)
          setSemanticSearchError(null)
          const [queryEmbedding] = await requestSemanticEmbeddings([
            {
              id: '__semantic_search_query__',
              text: trimmedQuery,
              textHash: hashSemanticText(trimmedQuery),
            },
          ])

          if (cancelled) {
            return
          }

          const nextMatches =
            semanticSearchMode === 'groups'
              ? rankGroupPrototypeMatches({
                  prototypes: semanticSearchGroupPrototypes,
                  queryValues: queryEmbedding?.values ?? [],
                  limit: Math.max(
                    SEMANTIC_SEARCH_MAX_LIMIT,
                    SEMANTIC_SEARCH_RESULT_LIMIT,
                  ),
                })
              : rankSemanticSearchMatches({
                  embeddings: semanticSearchEmbeddings,
                  queryValues: queryEmbedding?.values ?? [],
                  limit: Math.max(
                    SEMANTIC_SEARCH_MAX_LIMIT,
                    SEMANTIC_SEARCH_RESULT_LIMIT,
                  ),
                })

          semanticSearchCacheRef.current.set(cacheKey, nextMatches)
          setSemanticSearchRankedMatches(nextMatches)
        } catch (error) {
          if (cancelled) {
            return
          }

          setSemanticSearchRankedMatches([])
          setSemanticSearchError(
            error instanceof Error ? error.message : 'Semantic search failed.',
          )
        } finally {
          if (!cancelled) {
            setSemanticSearchPending(false)
          }
        }
      })()
    }, 260)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    semanticSearchAvailable,
    semanticSearchEmbeddings,
    semanticSearchGroupPrototypes,
    semanticSearchGroupSourceLayout?.id,
    semanticSearchModelId,
    semanticSearchMode,
    semanticSearchQuery,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (
      compareOverlay &&
      (baseScene.kind !== 'semantic_projection' || !resolvedCompareOverlay)
    ) {
      clearCompareOverlay()
    }
  }, [baseScene.kind, clearCompareOverlay, compareOverlay, resolvedCompareOverlay])

  const symbolClusterState = useMemo(
    () =>
      deriveSymbolClusterState(
        effectiveSnapshot,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
      ),
    [effectiveSnapshot, resolvedScene, viewMode],
  )
  const expandedClusterIds = useMemo(
    () => new Set(expandedSymbolClusterIds),
    [expandedSymbolClusterIds],
  )
  const collapsedDirectoryIdSet = useMemo(
    () => new Set(collapsedDirectoryIds),
    [collapsedDirectoryIds],
  )
  const expandedClusterLayouts = useMemo(
    () =>
      buildExpandedClusterLayouts(
        effectiveSnapshot,
        resolvedScene?.layoutSpec ?? null,
        symbolClusterState,
        expandedClusterIds,
      ),
    [effectiveSnapshot, expandedClusterIds, resolvedScene, symbolClusterState],
  )
  const filesystemContainerLayouts = useMemo(
    () =>
      buildFilesystemContainerLayouts(
        effectiveSnapshot,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
        collapsedDirectoryIdSet,
      ),
    [collapsedDirectoryIdSet, effectiveSnapshot, resolvedScene, viewMode],
  )
  const layoutGroupContainers = useMemo(
    () =>
      buildLayoutGroupContainers(
        effectiveSnapshot,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
      ),
    [effectiveSnapshot, resolvedScene, viewMode],
  )

  const baseFlowModel = useMemo<FlowModel | null>(() => {
    if (!effectiveSnapshot || !resolvedScene) {
      return null
    }

    return buildFlowModel(
      effectiveSnapshot,
      resolvedScene.layoutSpec,
      graphLayers,
      viewMode,
      symbolClusterState,
      expandedClusterIds,
      expandedClusterLayouts,
      filesystemContainerLayouts,
      layoutGroupContainers,
      collapsedDirectoryIdSet,
      toggleCollapsedDirectory,
    )
  }, [
    collapsedDirectoryIdSet,
    expandedClusterLayouts,
    effectiveSnapshot,
    expandedClusterIds,
    filesystemContainerLayouts,
    graphLayers,
    layoutGroupContainers,
    resolvedScene,
    symbolClusterState,
    toggleCollapsedDirectory,
    viewMode,
  ])
  const telemetryHeatByNodeId = useMemo(() => {
    const recentCutoff = telemetryObservedAt - 10_000
    const nextMap = new Map<string, { pulse: boolean; weight: number }>()
    const fileIdsByPath = new Map<string, string>()
    const symbolIdsByFileId = new Map<string, string[]>()

    if (effectiveSnapshot) {
      for (const node of Object.values(effectiveSnapshot.nodes)) {
        if (isFileNode(node)) {
          fileIdsByPath.set(node.path, node.id)
          continue
        }

        if (isSymbolNode(node)) {
          const current = symbolIdsByFileId.get(node.fileId) ?? []
          current.push(node.id)
          symbolIdsByFileId.set(node.fileId, current)
        }
      }
    }

    for (const sample of telemetryHeatSamples) {
      const pulse = new Date(sample.lastSeenAt).getTime() >= recentCutoff
      const fileNodeId = fileIdsByPath.get(sample.path)

      if (!fileNodeId) {
        continue
      }

      const targetNodeIds =
        telemetryMode === 'symbols'
          ? (symbolIdsByFileId.get(fileNodeId) ?? [])
          : [fileNodeId]

      if (targetNodeIds.length === 0) {
        continue
      }

      for (const nodeId of targetNodeIds) {
        const current = nextMap.get(nodeId)

        if (!current || sample.weight > current.weight) {
          nextMap.set(nodeId, {
            pulse,
            weight: sample.weight,
          })
          continue
        }

        if (pulse && !current.pulse) {
          nextMap.set(nodeId, {
            ...current,
            pulse: true,
          })
        }
      }
    }

    return nextMap
  }, [effectiveSnapshot, telemetryHeatSamples, telemetryMode, telemetryObservedAt])

  const presentedFlowModel = useMemo<FlowModel | null>(() => {
    if (!baseFlowModel) {
      return null
    }

    const presentationOverlayState = {
      active: compareOverlayActive || semanticSearchHighlightActive,
      nodeIds: highlightedNodeIdSet,
    }

    return {
      nodes: applyFlowNodePresentation(
        baseFlowModel.nodes,
        selectedNodeIdSet,
        presentationOverlayState,
        telemetryHeatByNodeId,
      ),
      edges: applyFlowEdgePresentation(baseFlowModel.edges, presentationOverlayState),
    }
  }, [
    baseFlowModel,
    compareOverlayActive,
    highlightedNodeIdSet,
    semanticSearchHighlightActive,
    selectedNodeIdSet,
    telemetryHeatByNodeId,
  ])

  useEffect(() => {
    if (!presentedFlowModel) {
      setNodes([])
      setEdges([])
      return
    }

    setNodes(presentedFlowModel.nodes)
    setEdges(presentedFlowModel.edges)
  }, [presentedFlowModel, setEdges, setNodes])

  const visibleNodeCount = useMemo(
    () =>
      effectiveSnapshot && resolvedScene
        ? countVisibleLayoutNodes(
            effectiveSnapshot,
            resolvedScene.layoutSpec,
            viewMode,
            symbolClusterState,
            expandedClusterIds,
          )
        : 0,
    [effectiveSnapshot, expandedClusterIds, resolvedScene, symbolClusterState, viewMode],
  )
  const denseCanvasMode = viewMode === 'symbols' && visibleNodeCount > 250
  const files = useMemo(
    () => (effectiveSnapshot ? collectFiles(effectiveSnapshot) : []),
    [effectiveSnapshot],
  )
  const selectedNode =
    selectedNodeId && effectiveSnapshot
      ? effectiveSnapshot.nodes[selectedNodeId] ?? null
      : null
  const selectedLayoutGroup = useMemo(() => {
    if (!selectedNodeId || !isLayoutGroupNodeId(selectedNodeId) || !resolvedScene?.layoutSpec) {
      return null
    }

    const groupId = getLayoutGroupIdFromNodeId(selectedNodeId)
    return resolvedScene.layoutSpec.groups.find((group) => group.id === groupId) ?? null
  }, [resolvedScene, selectedNodeId])
  const selectedSymbol = selectedNode && isSymbolNode(selectedNode) ? selectedNode : null
  const selectedSymbols = getSelectedSymbols(effectiveSnapshot, selectedNodeIds)
  const selectedFile = getSelectedFile(effectiveSnapshot, selectedNode, files)
  const selectedFiles = getSelectedFiles(effectiveSnapshot, selectedNodeIds)
  const selectedNodeTelemetry = useMemo<{
    confidence: 'exact' | 'attributed' | 'fallback'
    lastSeenAt: string | null
    requestCount: number
    source: 'interactive' | 'autonomous' | 'all'
    toolNames: string[]
    totalTokens: number
  } | null>(() => {
    const candidatePaths = new Set<string>()

    if (selectedFile) {
      candidatePaths.add(selectedFile.path)
    }

    if (selectedSymbol) {
      const ownerFile = effectiveSnapshot?.nodes[selectedSymbol.fileId]

      if (ownerFile && isFileNode(ownerFile)) {
        candidatePaths.add(ownerFile.path)
      }
    }

    if (selectedLayoutGroup && effectiveSnapshot) {
      for (const nodeId of selectedLayoutGroup.nodeIds) {
        const groupNode = effectiveSnapshot.nodes[nodeId]

        if (groupNode && isSymbolNode(groupNode)) {
          const ownerFile = effectiveSnapshot.nodes[groupNode.fileId]

          if (ownerFile && isFileNode(ownerFile)) {
            candidatePaths.add(ownerFile.path)
          }
          continue
        }

        if (groupNode && isFileNode(groupNode)) {
          candidatePaths.add(groupNode.path)
        }
      }
    }

    if (candidatePaths.size === 0) {
      return null
    }

    const matchedEvents = telemetryActivityEvents.filter((event) => candidatePaths.has(event.path))

    if (matchedEvents.length === 0) {
      return null
    }

    const toolNames = [...new Set(matchedEvents.flatMap((event) => event.toolNames))].slice(0, 8)

    const confidence: 'exact' | 'attributed' | 'fallback' = matchedEvents.some(
      (event) => event.confidence === 'exact',
    )
      ? 'exact'
      : matchedEvents.some((event) => event.confidence === 'attributed')
        ? 'attributed'
        : 'fallback'
    const source: 'interactive' | 'autonomous' | 'all' = matchedEvents.every(
      (event) => event.source === matchedEvents[0]?.source,
    )
      ? ((matchedEvents[0]?.source ?? 'all') as 'interactive' | 'autonomous' | 'all')
      : 'all'

    return {
      confidence,
      lastSeenAt: matchedEvents[0]?.timestamp ?? null,
      requestCount: matchedEvents.reduce((sum, event) => sum + event.requestCount, 0),
      source,
      toolNames,
      totalTokens: matchedEvents.reduce((sum, event) => sum + event.totalTokens, 0),
    }
  }, [
    effectiveSnapshot,
    selectedFile,
    selectedLayoutGroup,
    selectedSymbol,
    telemetryActivityEvents,
  ])
  const selectedGroupPrototype = useMemo(() => {
    if (!selectedLayoutGroup) {
      return null
    }

    return (
      semanticSearchGroupPrototypes.find(
        (prototype) => prototype.groupId === selectedLayoutGroup.id,
      ) ?? null
    )
  }, [semanticSearchGroupPrototypes, selectedLayoutGroup])
  const selectedGroupNearbySymbols = useMemo(() => {
    if (!effectiveSnapshot || !selectedGroupPrototype) {
      return []
    }

    return rankNearbySymbolsForGroupPrototype({
      prototype: selectedGroupPrototype,
      embeddings: semanticSearchEmbeddings,
      limit: 8,
    })
      .map((match) => {
        const node = effectiveSnapshot.nodes[match.symbolId]

        if (!node || !isSymbolNode(node)) {
          return null
        }

        return {
          score: match.score,
          symbol: node,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  }, [effectiveSnapshot, selectedGroupPrototype, semanticSearchEmbeddings])
  const workingSetNode = getPrimaryNode(effectiveSnapshot, workingSet.nodeIds)
  const workingSetSymbols = getSelectedSymbols(effectiveSnapshot, workingSet.nodeIds)
  const workingSetFiles = getSelectedFiles(effectiveSnapshot, workingSet.nodeIds)
  const workingSetSymbol = workingSetSymbols[0] ?? null
  const workingSetFile =
    getPrimaryFileFromNode(effectiveSnapshot, workingSetNode) ?? workingSetFiles[0] ?? null
  const workingSetContext = {
    file: workingSetFile,
    files: workingSetFiles,
    node: workingSetNode,
    symbol: workingSetSymbol,
    symbols: workingSetSymbols,
  }
  const selectedEdge =
    selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null
  const graphSummary = buildGraphSummary(
    selectedNodeId,
    edges,
    effectiveSnapshot,
  )
  const inspectorHeader = getInspectorHeaderSummary({
    selectedFile,
    selectedFiles,
    selectedLayoutGroup,
    selectedNode,
    selectedSymbols,
  })
  const workspaceName = effectiveSnapshot
    ? getWorkspaceName(effectiveSnapshot.rootDir)
    : 'Workspace'
  const workingSetSummary =
    workingSet.nodeIds.length > 0
      ? {
          label: formatWorkingSetLabel(workingSetContext),
          title: buildWorkingSetTitle(workingSetContext, workingSet),
          paths: getWorkingSetPaths(workingSetContext),
        }
      : null
  const formattedPreprocessingStatus = preprocessingStatus
      ? {
        canBuildEmbeddings: preprocessingStatus.purposeSummaryCount > 0,
        currentItemPath: preprocessingStatus.currentItemPath,
        embeddingActionLabel: formatEmbeddingActionLabel(preprocessingStatus),
        label: formatPreprocessingStatusLabel(preprocessingStatus),
        lastError: preprocessingStatus.lastError,
        preprocessingActionLabel: formatPreprocessingActionLabel(preprocessingStatus),
        progressPercent: getPreprocessingProgressPercent(preprocessingStatus),
        runState: preprocessingStatus.runState,
        title: formatPreprocessingStatusTitle(preprocessingStatus),
        workspaceSync: workspaceSyncStatus
          ? {
              isOutdated: hasWorkspaceSyncUpdates(workspaceSyncStatus),
              label: formatWorkspaceSyncLabel(workspaceSyncStatus),
              title: formatWorkspaceSyncTitle(workspaceSyncStatus),
            }
          : null,
      }
    : null
  const activeLayoutSyncNote =
    activeLayoutSync?.state === 'outdated'
      ? {
          label: formatLayoutSyncLabel(activeLayoutSync),
          title: formatLayoutSyncTitle(activeLayoutSync),
        }
      : null
  const visibleLayerToggles = useMemo(
    () => getLayerTogglesForViewMode(viewMode),
    [viewMode],
  )
  const semanticSearchStatus = useMemo(() => {
    if (!semanticSearchAvailable) {
      return {
        helper: 'Build embeddings to search the semantic projection.',
        resultCount: 0,
      }
    }

    if (semanticSearchMode === 'groups' && !semanticGroupSearchAvailable) {
      return {
        helper: 'This layout does not expose enough grouped symbols for group search yet.',
        resultCount: 0,
      }
    }

    if (semanticSearchError) {
      return {
        helper: semanticSearchError,
        resultCount: 0,
      }
    }

    if (semanticSearchPending) {
      return {
        helper:
          semanticSearchMode === 'groups'
            ? 'Searching semantic folder matches…'
            : 'Searching semantic matches…',
        resultCount: semanticSearchMatches.length,
      }
    }

    if (semanticSearchQuery.trim().length >= SEMANTIC_SEARCH_MIN_QUERY_LENGTH) {
      return {
        helper:
          semanticSearchMatches.length > 0
            ? semanticSearchMode === 'groups'
              ? `${semanticSearchMatches.length} semantic folder matches highlighted`
              : `${semanticSearchMatches.length} semantic matches highlighted`
            : semanticSearchMode === 'groups'
              ? 'No semantic folder matches found.'
              : 'No semantic matches found.',
        resultCount: semanticSearchMatches.length,
      }
    }

    return {
      helper:
        semanticSearchMode === 'groups'
          ? 'Search by feature intent against grouped symbols.'
          : 'Search by concept, behavior, or feature intent.',
      resultCount: 0,
    }
  }, [
    semanticGroupSearchAvailable,
    semanticSearchAvailable,
    semanticSearchError,
    semanticSearchMatches.length,
    semanticSearchMode,
    semanticSearchPending,
    semanticSearchQuery,
  ])
  const activeRunId =
    autonomousRuns.find((run) => run.status === 'running')?.runId ?? null
  const runsActive = activeRunId !== null
  const agentHeatHelperText = useMemo(() => {
    if (!telemetryEnabled) {
      return 'Agent heat is off. Adjust these controls to load telemetry.'
    }

    if (telemetryError) {
      return telemetryError
    }

    if (!telemetryOverview) {
      return 'Loading agent activity…'
    }

    if (telemetryOverview.requestCount === 0) {
      return telemetryWindow === 'run'
        ? 'No agent activity recorded for this run yet.'
        : 'No agent activity recorded in this window.'
    }

    const tokenText = `${Math.round(telemetryOverview.totalTokens)} tokens`
    const requestText = `${telemetryOverview.requestCount} request${telemetryOverview.requestCount === 1 ? '' : 's'}`
    const runText =
      telemetryOverview.activeRuns.length > 0
        ? ` · ${telemetryOverview.activeRuns.length} active run${telemetryOverview.activeRuns.length === 1 ? '' : 's'}`
        : ''

    return `${requestText} · ${tokenText}${runText}`
  }, [telemetryEnabled, telemetryError, telemetryOverview, telemetryWindow])

  const handleOpenRunsPanel = useCallback(() => {
    setRunsPanelOpen(true)
  }, [])

  const handleTelemetrySourceChange = useCallback((source: TelemetrySource) => {
    setTelemetryEnabled(true)
    setTelemetrySource(source)
  }, [])

  const handleTelemetryWindowChange = useCallback((windowValue: TelemetryWindow) => {
    setTelemetryEnabled(true)
    setTelemetryWindow(windowValue)
  }, [])

  const handleTelemetryModeChange = useCallback((mode: TelemetryMode) => {
    setTelemetryEnabled(true)
    setTelemetryMode(mode)
  }, [])
  const inspectorWidthRatio = 1 - canvasWidthRatio
  const workspaceViewReady =
    !effectiveSnapshot ||
    (uiPreferencesHydrated &&
      workspaceViewResolvedRootDir === effectiveSnapshot.rootDir)

  useEffect(() => {
    if (!workspaceViewReady) {
      selectionAutoOpenInitializedRef.current = false
      return
    }

    if (!selectionAutoOpenInitializedRef.current) {
      selectionAutoOpenInitializedRef.current = true
      return
    }

    if (selectedNodeIds.length > 0 || selectedEdgeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInspectorOpen(true)
    }
  }, [selectedEdgeId, selectedNodeIds, workspaceViewReady])

  useEffect(() => {
    if (!compareOverlayActive || !resolvedCompareOverlay || !flowInstance) {
      lastFittedCompareKeyRef.current = null
      return
    }

    const compareKey = `${resolvedCompareOverlay.sourceType}:${resolvedCompareOverlay.sourceId}:${resolvedCompareOverlay.nodeIds.join(',')}`

    if (
      lastFittedCompareKeyRef.current === compareKey ||
      resolvedCompareOverlay.nodeIds.length === 0
    ) {
      return
    }

    const nodesToFit = nodes.filter((node) => overlayNodeIdSet.has(node.id))

    if (nodesToFit.length === 0) {
      return
    }

    lastFittedCompareKeyRef.current = compareKey
    window.setTimeout(() => {
      void flowInstance.fitView({
        duration: 280,
        maxZoom: 2.8,
        nodes: nodesToFit,
        padding: 0.22,
      })
    }, 0)
  }, [
    compareOverlayActive,
    flowInstance,
    nodes,
    overlayNodeIdSet,
    resolvedCompareOverlay,
  ])

  useEffect(() => {
    if (!inspectorOpen || !inspectorBodyRef.current) {
      return
    }

    inspectorBodyRef.current.scrollTo({
      top: 0,
      left: 0,
      behavior: 'auto',
    })
  }, [inspectorOpen, inspectorTab, selectedEdgeId, selectedNodeId, selectedNodeIds])

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

  async function handleCloseWorkspace() {
    if (!desktopBridge?.closeWorkspace) {
      if (isDesktopHost) {
        navigateSemanticodeAction('close-workspace')
      }
      return
    }

    try {
      setWorkspaceActionPending(true)
      setWorkspaceActionError(null)
      await desktopBridge.closeWorkspace()
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error ? error.message : 'Failed to close the current folder.',
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

  async function handleStartAutonomousRun() {
    if (!effectiveSnapshot?.rootDir) {
      return
    }

    try {
      setRunActionPending(true)
      setRunActionError(null)
      const response = await startAutonomousRun({
        scope: buildAutonomousRunScopeFromContext(
          workingSetContext,
          activeDraft?.layout?.title ?? activeLayout?.title ?? null,
        ),
        taskFile: detectedTaskFile,
      })

      setRunsPanelOpen(true)
      setSelectedRunId(response.run.runId)
      setSelectedRunDetail(response.run)
      setDetectedTaskFile(response.detectedTaskFile)
      setTelemetryWindow('run')
      setTelemetrySource('all')
    } catch (error) {
      setRunActionError(
        error instanceof Error ? error.message : 'Failed to start the autonomous run.',
      )
    } finally {
      setRunActionPending(false)
    }
  }

  async function handleStopAutonomousRun(runId: string) {
    try {
      setRunActionPending(true)
      setRunActionError(null)
      await stopAutonomousRun(runId)
    } catch (error) {
      setRunActionError(
        error instanceof Error ? error.message : 'Failed to stop the autonomous run.',
      )
    } finally {
      setRunActionPending(false)
    }
  }

  function handleSelectRun(runId: string) {
    setSelectedRunId(runId)
    setTelemetryWindow('run')
    setTelemetrySource('all')
  }

  function handleClearCompareOverlay() {
    clearCompareOverlay()
    setBaseScene({
      kind: 'active_layout',
    })
  }

  function handleActivateCompareOverlay() {
    if (!currentCompareSource) {
      return
    }

    setOverlayVisibility(true)
    setBaseScene({
      kind: 'semantic_projection',
    })
    setCompareOverlay({
      kind: 'layout_compare',
      sourceType: currentCompareSource.sourceType,
      sourceId: currentCompareSource.sourceId,
    })
    setInspectorOpen(true)
    setInspectorTab('file')
  }

  function handleLayoutSelectionChange(value: string) {
    if (!value) {
      return
    }

    if (effectiveSnapshot?.rootDir) {
      const workspaceRootDir = effectiveSnapshot.rootDir
      setWorkspaceStateByRootDir((currentState) => ({
        ...currentState,
        [workspaceRootDir]: value.startsWith('draft:')
          ? {
              activeDraftId: value.slice('draft:'.length),
              activeLayoutId: undefined,
            }
          : {
              activeDraftId: undefined,
              activeLayoutId: value.slice('layout:'.length),
            },
      }))
      setWorkspaceViewResolvedRootDir(workspaceRootDir)
    }

    if (value.startsWith('draft:')) {
      const nextDraftId = value.slice('draft:'.length)
      const nextDraft =
        availableDraftLayouts.find((draft) => draft.id === nextDraftId) ?? null

      setBaseScene({
        kind: 'active_layout',
      })
      clearCompareOverlay()
      setActiveDraftId(nextDraftId)
      setDraftActionError(null)

      if (nextDraft?.layout) {
        setViewMode(getPreferredViewModeForLayout(nextDraft.layout))
      }

      return
    }

    const nextLayoutId = value.slice('layout:'.length)
    const nextLayout = layouts.find((layout) => layout.id === nextLayoutId) ?? null

    setBaseScene({
      kind: 'active_layout',
    })
    clearCompareOverlay()
    setActiveDraftId(null)
    setActiveLayoutId(nextLayoutId)
    setDraftActionError(null)

    if (nextLayout) {
      setViewMode(getPreferredViewModeForLayout(nextLayout))
    }
  }

  const handleCanvasMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, flowViewport: { x: number; y: number; zoom: number }) => {
      setViewport(flowViewport)
    },
    [setViewport],
  )

  const handleCanvasEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      selectEdge(edge.id)
      setInspectorOpen(true)
    },
    [selectEdge],
  )

  const handleCanvasNodeClick = useCallback(
    (event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, node: Node) => {
      if (isAnnotationNodeId(node.id)) {
        return
      }

      selectNode(node.id, {
        additive: Boolean(event.metaKey || event.ctrlKey || event.shiftKey),
      })
      setInspectorOpen(true)
    },
    [selectNode],
  )

  const handleCanvasNodeDoubleClick = useCallback(
    (_event: unknown, node: Node) => {
      if (viewMode === 'filesystem') {
        const snapshotNode = effectiveSnapshot?.nodes[node.id]

        if (snapshotNode && isDirectoryNode(snapshotNode)) {
          toggleCollapsedDirectory(snapshotNode.id)
          return
        }
      }

      const cluster = symbolClusterState.clusterByNodeId[node.id]

      if (cluster && cluster.rootNodeId === node.id) {
        toggleSymbolCluster(cluster.id)
      }
    },
    [effectiveSnapshot, symbolClusterState, toggleCollapsedDirectory, toggleSymbolCluster, viewMode],
  )

  const handleCanvasNodeDrag = useCallback(
    (_event: unknown, node: Node) => {
      setNodes((currentNodes) => {
        const currentNode = currentNodes.find((candidate) => candidate.id === node.id)

        if (!currentNode) {
          return currentNodes
        }

        const hasDirectChildren = currentNodes.some(
          (candidate) => candidate.parentId === node.id,
        )

        if (!hasDirectChildren) {
          containerDragPreviewPositionsRef.current.delete(node.id)
          return currentNodes
        }

        const previousPosition =
          containerDragPreviewPositionsRef.current.get(node.id) ?? currentNode.position
        const deltaX = node.position.x - previousPosition.x
        const deltaY = node.position.y - previousPosition.y

        containerDragPreviewPositionsRef.current.set(node.id, {
          x: node.position.x,
          y: node.position.y,
        })

        if (deltaX === 0 && deltaY === 0) {
          return currentNodes
        }

        return applyDirectChildDragPreviewOffset(currentNodes, node.id, {
          x: deltaX,
          y: deltaY,
        })
      })
    },
    [setNodes],
  )

  const handleCanvasNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      containerDragPreviewPositionsRef.current.delete(node.id)
      updateLayoutPlacement(
        node.id,
        node.position,
        editableLayout,
        editableDraftLayout,
        layouts,
        draftLayouts,
        setLayouts,
        setDraftLayouts,
        effectiveSnapshot,
        viewMode,
      )
    },
    [
      draftLayouts,
      editableDraftLayout,
      editableLayout,
      effectiveSnapshot,
      layouts,
      setDraftLayouts,
      setLayouts,
      viewMode,
    ],
  )

  const handleLayoutSuggestionChange = useCallback(
    (value: string) => {
      setLayoutSuggestionText(value)
    },
    [],
  )

  const handleLayoutSuggestionSubmit = useCallback(() => {
    if (!onSuggestLayout || layoutSuggestionPending) {
      return
    }

    void onSuggestLayout(layoutSuggestionText)
  }, [layoutSuggestionPending, layoutSuggestionText, onSuggestLayout])

  if (!effectiveSnapshot) {
    return (
      <section className="cbv-shell">
        <div className="cbv-empty">
          <h2>No codebase loaded</h2>
          <p>Connect a snapshot to render the project tree.</p>
        </div>
      </section>
    )
  }

  if (!workspaceViewReady) {
    return <section className="demo-status">Loading workspace view...</section>
  }

  return (
    <SemanticodeErrorBoundary
      resetKey={[
        effectiveSnapshot.rootDir,
        activeLayoutId ?? 'no-layout',
        activeDraftId ?? 'no-draft',
        semanticSearchMode,
      ].join('::')}
    >
      <ReactFlowProvider>
      <div
        className={`cbv-app-shell${canManageProjects ? ' is-desktop-host' : ''}${projectsSidebarOpen ? ' is-projects-open' : ''}`}
      >
        <ProjectsSidebar
          canManageProjects={canManageProjects}
          currentRootDir={effectiveSnapshot.rootDir}
          onClose={() => setProjectsSidebarOpen(false)}
          onCloseWorkspace={() => {
            void handleCloseWorkspace()
          }}
          onOpenRecentProject={(rootDir) => {
            void handleOpenRecentProject(rootDir)
          }}
          onOpenWorkspace={() => {
            void handleOpenAnotherWorkspace()
          }}
          open={projectsSidebarOpen}
          recentProjects={recentProjects}
          workspaceActionError={workspaceActionError}
          workspaceActionPending={workspaceActionPending}
        />
        <section className="cbv-shell">
          <WorkspaceToolbar
            activeDraft={Boolean(activeDraft)}
            activeLayoutSyncNote={activeLayoutSyncNote}
            compareOverlayActive={compareOverlayActive}
            layoutActionsPending={layoutActionsPending}
            layoutOptions={layoutOptions}
            onAcceptDraft={
              activeDraft && onAcceptDraft
                ? async () => {
                    try {
                      setDraftActionError(null)
                      await onAcceptDraft(activeDraft.id)
                    } catch (error) {
                      setDraftActionError(
                        error instanceof Error
                          ? error.message
                          : 'Failed to accept draft.',
                      )
                    }
                  }
                : undefined
            }
            onActivateCompareOverlay={
              currentCompareSource ? handleActivateCompareOverlay : undefined
            }
            onBuildSemanticEmbeddings={onBuildSemanticEmbeddings}
            onClearCompareOverlay={compareOverlayActive ? handleClearCompareOverlay : undefined}
            onOpenAgentSettings={() => setSettingsOpen(true)}
            onOpenRunsPanel={handleOpenRunsPanel}
            onOpenWorkspaceSync={
              workspaceSyncStatus ? () => setWorkspaceSyncOpen(true) : undefined
            }
            onRejectDraft={
              activeDraft && onRejectDraft
                ? async () => {
                    try {
                      setDraftActionError(null)
                      await onRejectDraft(activeDraft.id)
                    } catch (error) {
                      setDraftActionError(
                        error instanceof Error
                          ? error.message
                          : 'Failed to reject draft.',
                      )
                    }
                  }
                : undefined
            }
            onSelectLayoutValue={handleLayoutSelectionChange}
            onStartPreprocessing={onStartPreprocessing}
            onToggleProjectsSidebar={
              () => setProjectsSidebarOpen((current) => !current)
            }
            preprocessingStatus={formattedPreprocessingStatus}
            projectsSidebarOpen={projectsSidebarOpen}
            runsActive={runsActive}
            selectedLayoutValue={selectedLayoutValue}
            showCompareAction={Boolean(currentCompareSource)}
            workingSetSummary={workingSetSummary}
            workspaceName={workspaceName}
            workspaceRootDir={effectiveSnapshot.rootDir}
          />

	        <div
            className={`cbv-workspace${inspectorOpen ? '' : ' is-inspector-closed'}`}
            ref={workspaceRef}
            style={{
              '--cbv-canvas-width': `${(canvasWidthRatio * 100).toFixed(2)}%`,
              '--cbv-inspector-width': `${(inspectorWidthRatio * 100).toFixed(2)}%`,
            } as CSSProperties}
          >
          <MemoizedCanvasViewport
              agentHeatHelperText={agentHeatHelperText}
              agentHeatMode={telemetryMode}
              agentHeatSource={telemetrySource}
              agentHeatWindow={telemetryWindow}
              denseCanvasMode={denseCanvasMode}
              edges={edges}
              graphLayers={graphLayers}
              layoutSuggestionError={layoutSuggestionError}
              layoutSuggestionPending={layoutSuggestionPending}
              layoutSuggestionText={layoutSuggestionText}
              nodes={nodes}
              onEdgeClick={handleCanvasEdgeClick}
              onEdgesChange={onEdgesChange}
              onInit={setFlowInstance}
              onAgentHeatModeChange={handleTelemetryModeChange}
              onAgentHeatSourceChange={handleTelemetrySourceChange}
              onAgentHeatWindowChange={handleTelemetryWindowChange}
              onLayoutSuggestionChange={handleLayoutSuggestionChange}
              onLayoutSuggestionSubmit={handleLayoutSuggestionSubmit}
              onMoveEnd={handleCanvasMoveEnd}
              onNodeClick={handleCanvasNodeClick}
              onNodeDoubleClick={handleCanvasNodeDoubleClick}
              onNodeDrag={handleCanvasNodeDrag}
              onNodeDragStop={handleCanvasNodeDragStop}
              onNodesChange={onNodesChange}
              onSemanticSearchChange={setSemanticSearchQuery}
              onSemanticSearchClear={() => {
                setSemanticSearchQuery('')
                setSemanticSearchRankedMatches([])
                setSemanticSearchError(null)
                setSemanticSearchPending(false)
              }}
              onSemanticSearchLimitChange={setSemanticSearchMatchLimit}
              onSemanticSearchModeChange={handleSemanticSearchModeChange}
              onSemanticSearchStrictnessChange={setSemanticSearchStrictness}
              onToggleLayer={toggleGraphLayer}
              semanticSearchAvailable={semanticSearchAvailable}
              semanticSearchGroupSearchAvailable={semanticGroupSearchAvailable}
              semanticSearchHelperText={semanticSearchStatus.helper}
              semanticSearchLimit={semanticSearchMatchLimit}
              semanticSearchMode={semanticSearchMode}
              semanticSearchPending={semanticSearchPending}
              semanticSearchQuery={semanticSearchQuery}
              semanticSearchStrictness={semanticSearchStrictness}
              semanticSearchResultCount={semanticSearchStatus.resultCount}
              showLayoutSuggestion={Boolean(onSuggestLayout)}
              showSemanticSearch={viewMode === 'symbols' && semanticSearchAvailable}
              themeMode={themeMode}
              viewMode={viewMode}
              viewport={viewport}
              visibleLayerToggles={visibleLayerToggles}
            />

          {inspectorOpen ? (
            <button
              aria-label="Resize canvas and inspector"
              className="cbv-workspace-resize-handle"
              onPointerDown={handleResizePointerDown}
              type="button"
            >
              <span />
            </button>
          ) : null}

          {inspectorOpen ? (
            <Suspense fallback={<InspectorFallback header={inspectorHeader} onClose={() => setInspectorOpen(false)} />}>
              <LazyInspectorPane
                activeDraft={activeDraft}
                compareOverlayActive={compareOverlayActive}
                desktopHostAvailable={isDesktopHost}
                draftActionError={draftActionError}
                graphSummary={graphSummary}
                header={inspectorHeader}
                inspectorBodyRef={inspectorBodyRef}
                inspectorTab={inspectorTab}
                onAgentRunSettled={onAgentRunSettled}
                onAdoptInspectorContextAsWorkingSet={adoptSelectionAsWorkingSet}
                onClearCompareOverlay={handleClearCompareOverlay}
                onClearWorkingSet={clearWorkingSet}
                onClose={() => setInspectorOpen(false)}
                onOpenAgentSettings={() => setSettingsOpen(true)}
                onSetInspectorTab={setInspectorTab}
                preprocessedWorkspaceContext={preprocessedWorkspaceContext}
                resolvedCompareOverlay={resolvedCompareOverlay}
                selectedEdge={selectedEdge}
                selectedFile={selectedFile}
                selectedFiles={selectedFiles}
                selectedLayoutGroup={selectedLayoutGroup}
                selectedLayoutGroupNearbySymbols={selectedGroupNearbySymbols}
                selectedLayoutGroupPrototype={selectedGroupPrototype}
                selectedNodeTelemetry={selectedNodeTelemetry}
                selectedNode={selectedNode}
                selectedSymbol={selectedSymbol}
                selectedSymbols={selectedSymbols}
                themeMode={themeMode}
                workingSet={workingSet.nodeIds.length > 0 ? workingSet : null}
                workingSetContext={workingSetContext}
                workspaceProfile={workspaceProfile}
              />
            </Suspense>
          ) : null}
        </div>
        {settingsOpen ? (
          <div
            className="cbv-modal-backdrop"
            onClick={() => setSettingsOpen(false)}
            role="presentation"
          >
            <section
              aria-label="General settings"
              className="cbv-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="cbv-modal-header">
                <div>
                  <p className="cbv-eyebrow">Settings</p>
                  <strong>General Settings</strong>
                </div>
                <button
                  aria-label="Close settings"
                  className="cbv-inspector-close"
                  onClick={() => setSettingsOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <Suspense fallback={<GeneralSettingsFallback />}>
                <LazyGeneralSettingsPanel
                  desktopHostAvailable={isDesktopHost}
                  onToggleDarkMode={() => {
                    setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))
                  }}
                  preprocessedWorkspaceContext={preprocessedWorkspaceContext}
                  themeMode={themeMode}
                  workspaceProfile={workspaceProfile}
                />
              </Suspense>
            </section>
          </div>
        ) : null}
        {workspaceSyncOpen && workspaceSyncStatus ? (
          <WorkspaceSyncModal
            onBuildEmbeddings={onBuildSemanticEmbeddings}
            onClose={() => setWorkspaceSyncOpen(false)}
            onRebuildSummaries={onStartPreprocessing}
            status={workspaceSyncStatus}
          />
        ) : null}
        {runsPanelOpen ? (
          <AutonomousRunsPanel
            activeRunId={activeRunId}
            detectedTaskFile={detectedTaskFile}
            errorMessage={runActionError}
            onClose={() => setRunsPanelOpen(false)}
            onSelectRun={handleSelectRun}
            onStartRun={() => {
              void handleStartAutonomousRun()
            }}
            onStopRun={(runId) => {
              void handleStopAutonomousRun(runId)
            }}
            pending={runActionPending}
            selectedRunDetail={selectedRunDetail}
            selectedRunId={selectedRunId}
            timeline={selectedRunTimeline}
            runs={autonomousRuns}
          />
        ) : null}
        <WorkspaceAgentActivity
          desktopHostAvailable={isDesktopHost}
          preprocessingStatus={preprocessingStatus}
          workingSetSummary={workingSetSummary}
        />
      </section>
      </div>
      </ReactFlowProvider>
    </SemanticodeErrorBoundary>
  )
}

interface CanvasViewportProps {
  agentHeatHelperText: string
  agentHeatMode: TelemetryMode
  agentHeatSource: TelemetrySource
  agentHeatWindow: TelemetryWindow
  denseCanvasMode: boolean
  edges: Edge[]
  graphLayers: Record<GraphLayerKey, boolean>
  layoutSuggestionError: string | null
  layoutSuggestionPending: boolean
  layoutSuggestionText: string
  nodes: Node[]
  onEdgeClick: (_event: unknown, edge: Edge) => void
  onEdgesChange: ReturnType<typeof useEdgesState<Edge>>[2]
  onInit: (instance: ReactFlowInstance<Node, Edge>) => void
  onAgentHeatModeChange: (mode: TelemetryMode) => void
  onAgentHeatSourceChange: (source: TelemetrySource) => void
  onAgentHeatWindowChange: (window: TelemetryWindow) => void
  onLayoutSuggestionChange: (value: string) => void
  onLayoutSuggestionSubmit: () => void
  onMoveEnd: (_event: MouseEvent | TouchEvent | null, flowViewport: { x: number; y: number; zoom: number }) => void
  onNodeClick: (
    event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
    node: Node,
  ) => void
  onNodeDoubleClick: (_event: unknown, node: Node) => void
  onNodeDrag: (_event: unknown, node: Node) => void
  onNodeDragStop: (_event: unknown, node: Node) => void
  onNodesChange: ReturnType<typeof useNodesState<Node>>[2]
  onSemanticSearchChange: (value: string) => void
  onSemanticSearchClear: () => void
  onSemanticSearchLimitChange: (value: number) => void
  onSemanticSearchModeChange: (mode: SemanticSearchMode) => void
  onSemanticSearchStrictnessChange: (value: number) => void
  onToggleLayer: (layer: GraphLayerKey) => void
  semanticSearchAvailable: boolean
  semanticSearchGroupSearchAvailable: boolean
  semanticSearchHelperText: string
  semanticSearchLimit: number
  semanticSearchMode: SemanticSearchMode
  semanticSearchPending: boolean
  semanticSearchQuery: string
  semanticSearchResultCount: number
  semanticSearchStrictness: number
  showLayoutSuggestion: boolean
  showSemanticSearch: boolean
  themeMode: ThemeMode
  viewMode: VisualizerViewMode
  viewport: { x: number; y: number; zoom: number }
  visibleLayerToggles: GraphLayerKey[]
}

const MemoizedCanvasViewport = memo(function CanvasViewport({
  agentHeatHelperText,
  agentHeatMode,
  agentHeatSource,
  agentHeatWindow,
  denseCanvasMode,
  edges,
  graphLayers,
  layoutSuggestionError,
  layoutSuggestionPending,
  layoutSuggestionText,
  nodes,
  onEdgeClick,
  onEdgesChange,
  onInit,
  onAgentHeatModeChange,
  onAgentHeatSourceChange,
  onAgentHeatWindowChange,
  onLayoutSuggestionChange,
  onLayoutSuggestionSubmit,
  onMoveEnd,
  onNodeClick,
  onNodeDoubleClick,
  onNodeDrag,
  onNodeDragStop,
  onNodesChange,
  onSemanticSearchChange,
  onSemanticSearchClear,
  onSemanticSearchLimitChange,
  onSemanticSearchModeChange,
  onSemanticSearchStrictnessChange,
  onToggleLayer,
  semanticSearchAvailable,
  semanticSearchGroupSearchAvailable,
  semanticSearchHelperText,
  semanticSearchLimit,
  semanticSearchMode,
  semanticSearchPending,
  semanticSearchQuery,
  semanticSearchResultCount,
  semanticSearchStrictness,
  showLayoutSuggestion,
  showSemanticSearch,
  themeMode,
  viewMode,
  viewport,
  visibleLayerToggles,
}: CanvasViewportProps) {
  const canvasDotColor = themeMode === 'dark' ? '#4f5f74' : '#d8d1c3'
  const minimapMaskColor =
    themeMode === 'dark' ? 'rgba(7, 9, 12, 0.42)' : 'rgba(44, 35, 27, 0.16)'
  const minimapBgColor = themeMode === 'dark' ? '#1b2028' : '#f7f1e5'
  const minimapNodeColor = (node: Node) => {
    const data =
      node.data && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : null

    if (node.type === 'annotationNode') {
      return themeMode === 'dark' ? '#5c6573' : '#c7bda9'
    }

    if (data?.groupContainer) {
      return themeMode === 'dark' ? '#5a5249' : '#cab790'
    }

    if (data?.container) {
      return themeMode === 'dark' ? '#4a5667' : '#d2c5b2'
    }

    if (node.type === 'symbolNode') {
      return themeMode === 'dark' ? '#57a395' : '#8fb7ac'
    }

    return themeMode === 'dark' ? '#667487' : '#b7ac9e'
  }

  return (
    <section className="cbv-canvas">
      <div className="cbv-canvas-overlays">
        <div className="cbv-canvas-left-tools">
          <div className="cbv-agent-heat-panel">
            <p className="cbv-eyebrow">Agent Heat</p>
            <div className="cbv-agent-heat-controls">
              <label>
                <span>Source</span>
                <select
                  onChange={(event) => {
                    onAgentHeatSourceChange(event.target.value as TelemetrySource)
                  }}
                  value={agentHeatSource}
                >
                  <option value="all">All</option>
                  <option value="autonomous">Autonomous</option>
                  <option value="interactive">Interactive</option>
                </select>
              </label>
              <label>
                <span>Window</span>
                <select
                  onChange={(event) => {
                    onAgentHeatWindowChange(parseTelemetryWindow(event.target.value))
                  }}
                  value={String(agentHeatWindow)}
                >
                  <option value="30">30s</option>
                  <option value="60">60s</option>
                  <option value="120">2m</option>
                  <option value="run">Run</option>
                  <option value="workspace">Workspace</option>
                </select>
              </label>
              <label>
                <span>Mode</span>
                <select
                  onChange={(event) => {
                    onAgentHeatModeChange(event.target.value as TelemetryMode)
                  }}
                  value={agentHeatMode}
                >
                  <option value="files">Files</option>
                  <option value="symbols">Symbols</option>
                </select>
              </label>
            </div>
            <p className="cbv-agent-heat-meta">{agentHeatHelperText}</p>
          </div>
          {showSemanticSearch ? (
            <form
              className={`cbv-semantic-search${semanticSearchPending ? ' is-pending' : ''}${semanticSearchAvailable ? '' : ' is-disabled'}`}
              onSubmit={(event) => event.preventDefault()}
            >
              <div className="cbv-semantic-search-mode-toggle" role="tablist" aria-label="Semantic search mode">
                <button
                  aria-pressed={semanticSearchMode === 'symbols'}
                  className={`cbv-semantic-search-mode${semanticSearchMode === 'symbols' ? ' is-active' : ''}`}
                  onClick={() => onSemanticSearchModeChange('symbols')}
                  type="button"
                >
                  Symbols
                </button>
                <button
                  aria-pressed={semanticSearchMode === 'groups'}
                  className={`cbv-semantic-search-mode${semanticSearchMode === 'groups' ? ' is-active' : ''}`}
                  disabled={!semanticSearchGroupSearchAvailable}
                  onClick={() => onSemanticSearchModeChange('groups')}
                  type="button"
                >
                  Folders
                </button>
              </div>
              <div className="cbv-semantic-search-shell">
                <input
                  aria-label="Search semantic projection"
                  className="cbv-semantic-search-input"
                  disabled={!semanticSearchAvailable}
                  onChange={(event) => {
                    onSemanticSearchChange(event.target.value)
                  }}
                  placeholder={
                    semanticSearchAvailable
                      ? semanticSearchMode === 'groups'
                        ? 'Search semantic folders'
                        : 'Search semantic symbols'
                      : 'Build embeddings to search'
                  }
                  value={semanticSearchQuery}
                />
                {semanticSearchQuery ? (
                  <button
                    aria-label="Clear semantic search"
                    className="cbv-semantic-search-clear"
                    onClick={onSemanticSearchClear}
                    type="button"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="cbv-semantic-search-controls">
                <label className="cbv-semantic-search-slider">
                  <span>Matches</span>
                  <strong>{semanticSearchLimit}</strong>
                  <input
                    disabled={!semanticSearchAvailable}
                    max={SEMANTIC_SEARCH_MAX_LIMIT}
                    min={SEMANTIC_SEARCH_MIN_LIMIT}
                    onChange={(event) => {
                      onSemanticSearchLimitChange(Number(event.target.value))
                    }}
                    type="range"
                    value={semanticSearchLimit}
                  />
                </label>
                <label className="cbv-semantic-search-slider">
                  <span>Proximity</span>
                  <strong>{semanticSearchStrictness}</strong>
                  <input
                    disabled={!semanticSearchAvailable}
                    max={100}
                    min={0}
                    onChange={(event) => {
                      onSemanticSearchStrictnessChange(Number(event.target.value))
                    }}
                    type="range"
                    value={semanticSearchStrictness}
                  />
                </label>
              </div>
              <p
                className={`cbv-semantic-search-meta${semanticSearchResultCount > 0 ? ' has-results' : ''}${!semanticSearchAvailable ? ' is-disabled' : ''}`}
              >
                {semanticSearchHelperText}
              </p>
            </form>
          ) : null}
          <div className="cbv-canvas-layer-toggles">
            {visibleLayerToggles.map((layer) => (
              <LayerToggle
                active={graphLayers[layer]}
                key={layer}
                label={getLayerLabel(layer, viewMode)}
                onClick={() => onToggleLayer(layer)}
              />
            ))}
          </div>
        </div>
        {viewMode === 'symbols' ? (
          <div className="cbv-canvas-legend">
            <SymbolKindLegend />
          </div>
        ) : null}
      </div>
      <ReactFlow
        defaultViewport={viewport}
        edges={edges}
        fitView
        maxZoom={4}
        minZoom={0.1}
        nodeTypes={nodeTypes}
        nodes={nodes}
        onlyRenderVisibleElements
        onEdgeClick={onEdgeClick}
        onEdgesChange={onEdgesChange}
        onInit={onInit}
        onMoveEnd={onMoveEnd}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={onNodesChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={canvasDotColor} gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
        {denseCanvasMode ? null : (
          <MiniMap
            bgColor={minimapBgColor}
            className="cbv-minimap"
            maskColor={minimapMaskColor}
            nodeColor={minimapNodeColor}
            pannable
            zoomable
          />
        )}
      </ReactFlow>

      {showLayoutSuggestion ? (
        <form
          className={`cbv-layout-suggestion${layoutSuggestionPending ? ' is-pending' : ''}`}
          onSubmit={(event) => {
            event.preventDefault()
            onLayoutSuggestionSubmit()
          }}
        >
          <div className="cbv-layout-suggestion-shell">
            <input
              aria-label="Suggest layout"
              className="cbv-layout-suggestion-input"
              disabled={layoutSuggestionPending}
              onChange={(event) => {
                onLayoutSuggestionChange(event.target.value)
              }}
              placeholder="Suggest layout"
              value={layoutSuggestionText}
            />
            <button
              className="cbv-layout-suggestion-submit"
              disabled={layoutSuggestionPending || !layoutSuggestionText.trim()}
              type="submit"
            >
              {layoutSuggestionPending ? 'Working…' : 'Go'}
            </button>
          </div>
          {layoutSuggestionPending ? (
            <p className="cbv-layout-suggestion-status">Generating a new layout draft…</p>
          ) : layoutSuggestionError ? (
            <p className="cbv-layout-suggestion-error">{layoutSuggestionError}</p>
          ) : null}
        </form>
      ) : null}
    </section>
  )
})

function InspectorFallback({
  header,
  onClose,
}: {
  header: {
    eyebrow: string
    title: string
  }
  onClose: () => void
}) {
  return (
    <aside className="cbv-inspector">
      <div className="cbv-panel-header">
        <div className="cbv-panel-header-copy">
          <p className="cbv-eyebrow">{header.eyebrow ?? 'Inspector'}</p>
          <strong title={header.title}>{header.title}</strong>
        </div>
        <button
          aria-label="Close inspector"
          className="cbv-inspector-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
      <div className="cbv-empty">
        <h2>Loading inspector…</h2>
        <p>Preparing the code and agent tools for this selection.</p>
      </div>
    </aside>
  )
}

function GeneralSettingsFallback() {
  return (
    <div className="cbv-empty">
      <h2>Loading settings…</h2>
      <p>Preparing the appearance and agent configuration panel.</p>
    </div>
  )
}

function parseTelemetryWindow(value: string): TelemetryWindow {
  if (value === '30') {
    return 30
  }

  if (value === '120') {
    return 120
  }

  if (value === 'run') {
    return 'run'
  }

  if (value === 'workspace') {
    return 'workspace'
  }

  return 60
}

function getWorkspaceName(rootDir: string) {
  const normalizedRootDir = rootDir.replace(/[\\/]+$/, '')
  const segments = normalizedRootDir.split(/[\\/]/)
  return segments[segments.length - 1] || rootDir
}

function formatPreprocessingStatusLabel(status: PreprocessingStatus) {
  switch (status.runState) {
    case 'building':
      return status.activity === 'embeddings'
        ? `Building embeddings… ${status.processedSymbols}/${status.totalSymbols || 0}`
        : `Building context… ${status.processedSymbols}/${status.totalSymbols || 0}`
    case 'stale':
      return status.activity === 'embeddings'
        ? `Refreshing embeddings… ${status.processedSymbols}/${status.totalSymbols || 0}`
        : `Refreshing context… ${status.processedSymbols}/${status.totalSymbols || 0}`
    case 'ready':
      return status.semanticEmbeddingCount > 0
        ? `Context ready · ${status.purposeSummaryCount} summaries · ${status.semanticEmbeddingCount} embeddings`
        : `Context ready · ${status.purposeSummaryCount} summaries`
    case 'error':
      return status.activity === 'embeddings' ? 'Embedding build failed' : 'Context build failed'
    default:
      return `Context not built · ${status.totalSymbols || 0} symbols`
  }
}

function formatPreprocessingActionLabel(status: PreprocessingStatus) {
  switch (status.runState) {
    case 'ready':
    case 'stale':
      return 'Rebuild With Agent'
    case 'building':
      return 'Building With Agent…'
    case 'error':
      return 'Retry Build With Agent'
    default:
      return 'Build With Agent'
  }
}

function formatEmbeddingActionLabel(status: PreprocessingStatus) {
  switch (status.runState) {
    case 'building':
      return status.activity === 'embeddings'
        ? 'Building Embeddings…'
        : 'Build Embeddings'
    case 'error':
      return status.activity === 'embeddings'
        ? 'Retry Embeddings'
        : status.semanticEmbeddingCount > 0
          ? 'Rebuild Embeddings'
          : 'Build Embeddings'
    default:
      return status.semanticEmbeddingCount > 0
        ? 'Rebuild Embeddings'
        : 'Build Embeddings'
  }
}

function formatPreprocessingStatusTitle(status: PreprocessingStatus) {
  const parts = [formatPreprocessingStatusLabel(status)]

  if (status.currentItemPath) {
    parts.push(`Current: ${status.currentItemPath}`)
  }

  if (status.updatedAt) {
    parts.push(`Updated ${new Date(status.updatedAt).toLocaleTimeString()}`)
  }

  if (status.lastError) {
    parts.push(status.lastError)
  }

  return parts.join(' · ')
}

function getPreprocessingProgressPercent(status: PreprocessingStatus) {
  if (status.totalSymbols <= 0) {
    return 0
  }

  return Math.max(
    0,
    Math.min(100, (status.processedSymbols / status.totalSymbols) * 100),
  )
}

function hasWorkspaceSyncUpdates(status: WorkspaceArtifactSyncStatus) {
  return (
    status.summaries.state !== 'in_sync' ||
    status.embeddings.state !== 'in_sync' ||
    status.layouts.some((entry) => entry.state === 'outdated') ||
    status.drafts.some((entry) => entry.state === 'outdated')
  )
}

function formatWorkspaceSyncLabel(status: WorkspaceArtifactSyncStatus) {
  if (!status.git.isGitRepo) {
    return 'Repo sync unavailable'
  }

  const parts: string[] = []

  if (status.summaries.staleCount > 0 || status.summaries.obsoleteCount > 0) {
    parts.push(`${status.summaries.staleCount + status.summaries.obsoleteCount} summaries`)
  }

  if (status.embeddings.staleCount > 0 || status.embeddings.obsoleteCount > 0) {
    parts.push(`${status.embeddings.staleCount + status.embeddings.obsoleteCount} embeddings`)
  }

  const affectedLayoutCount = [
    ...status.layouts,
    ...status.drafts,
  ].filter((entry) => entry.state === 'outdated').length

  if (affectedLayoutCount > 0) {
    parts.push(`${affectedLayoutCount} layouts`)
  }

  if (parts.length === 0) {
    return status.git.changedFiles.length > 0
      ? `Repo changed · ${status.git.changedFiles.length} files`
      : 'Repo sync clean'
  }

  return `Needs update · ${parts.join(' · ')}`
}

function formatWorkspaceSyncTitle(status: WorkspaceArtifactSyncStatus) {
  if (!status.git.isGitRepo) {
    return 'The current workspace is not a git repository.'
  }

  const parts = [
    status.git.branch
      ? `Git ${status.git.branch} @ ${status.git.head?.slice(0, 7) ?? 'unknown'}`
      : `Git ${status.git.head?.slice(0, 7) ?? 'unknown'}`,
  ]

  if (status.git.changedFiles.length > 0) {
    parts.push(`Changed files: ${status.git.changedFiles.join(', ')}`)
  }

  if (status.summaries.affectedPaths.length > 0) {
    parts.push(`Summary diff: ${status.summaries.affectedPaths.join(', ')}`)
  }

  if (status.embeddings.affectedPaths.length > 0) {
    parts.push(`Embedding diff: ${status.embeddings.affectedPaths.join(', ')}`)
  }

  const outdatedLayouts = [...status.layouts, ...status.drafts].filter(
    (entry) => entry.state === 'outdated',
  )

  if (outdatedLayouts.length > 0) {
    parts.push(
      `Layouts needing parity updates: ${outdatedLayouts
        .map((entry) => `${entry.title} (${entry.affectedPaths.length || entry.missingCount})`)
        .join(', ')}`,
    )
  }

  return parts.join(' · ')
}

function formatLayoutOptionLabel(
  baseLabel: string,
  syncEntry:
    | WorkspaceArtifactSyncStatus['layouts'][number]
    | undefined,
) {
  if (!syncEntry || syncEntry.state !== 'outdated') {
    return baseLabel
  }

  const issueCount = syncEntry.staleCount + syncEntry.missingCount
  return `${baseLabel} · outdated (${issueCount})`
}

function formatLayoutSyncLabel(
  syncEntry: WorkspaceArtifactSyncStatus['layouts'][number],
) {
  const parts = []

  if (syncEntry.staleCount > 0) {
    parts.push(`${syncEntry.staleCount} changed nodes`)
  }

  if (syncEntry.missingCount > 0) {
    parts.push(`${syncEntry.missingCount} missing nodes`)
  }

  return parts.length > 0
    ? `Layout parity diff · ${parts.join(' · ')}`
    : 'Layout parity diff'
}

function formatLayoutSyncTitle(
  syncEntry: WorkspaceArtifactSyncStatus['layouts'][number],
) {
  const parts = [formatLayoutSyncLabel(syncEntry)]

  if (syncEntry.affectedPaths.length > 0) {
    parts.push(`Changed files: ${syncEntry.affectedPaths.join(', ')}`)
  }

  if (syncEntry.missingNodeIds.length > 0) {
    parts.push(`Missing nodes: ${syncEntry.missingNodeIds.join(', ')}`)
  }

  return parts.join(' · ')
}

function LayerToggle({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      className={`cbv-layer-toggle${active ? ' is-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

function SymbolKindLegend() {
  return (
    <div className="cbv-symbol-legend">
      <span className="cbv-symbol-legend-title">Legend</span>
      {SYMBOL_LEGEND_ITEMS.map((item) => (
        <span className="cbv-symbol-legend-item" key={item.kindClass}>
          <span
            className={`cbv-symbol-legend-swatch is-kind-${item.kindClass}`}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}

function collectFiles(snapshot: CodebaseSnapshot) {
  const files: CodebaseFile[] = []

  for (const rootId of snapshot.rootIds) {
    collectFileChildren(rootId, snapshot, files)
  }

  return files
}

function collectFileChildren(
  nodeId: string,
  snapshot: CodebaseSnapshot,
  files: CodebaseFile[],
) {
  const node = snapshot.nodes[nodeId]

  if (!node) {
    return
  }

  if (isFileNode(node)) {
    files.push(node)
    return
  }

  if (!isDirectoryNode(node)) {
    return
  }

  for (const childId of node.childIds) {
    collectFileChildren(childId, snapshot, files)
  }
}

function getCollapsedFilesystemDescendantIds(
  snapshot: CodebaseSnapshot,
  collapsedDirectoryIds: Set<string>,
) {
  const hiddenNodeIds = new Set<string>()

  for (const directoryId of collapsedDirectoryIds) {
    const node = snapshot.nodes[directoryId]

    if (!node || !isDirectoryNode(node)) {
      continue
    }

    for (const childId of node.childIds) {
      collectDirectoryDescendantIds(childId, snapshot, hiddenNodeIds)
    }
  }

  return hiddenNodeIds
}

function collectDirectoryDescendantIds(
  nodeId: string,
  snapshot: CodebaseSnapshot,
  hiddenNodeIds: Set<string>,
) {
  const node = snapshot.nodes[nodeId]

  if (!node || isSymbolNode(node) || hiddenNodeIds.has(nodeId)) {
    return
  }

  hiddenNodeIds.add(nodeId)

  if (!isDirectoryNode(node)) {
    return
  }

  for (const childId of node.childIds) {
    collectDirectoryDescendantIds(childId, snapshot, hiddenNodeIds)
  }
}

function buildFlowModel(
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec,
  graphLayers: Record<GraphLayerKey, boolean>,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
  filesystemContainerLayouts: Map<string, FilesystemContainerLayout>,
  layoutGroupContainers: Map<string, LayoutGroupContainer>,
  collapsedDirectoryIds: Set<string>,
  toggleCollapsedDirectory: (nodeId: string) => void,
) {
  const hiddenNodeIds = new Set(layout.hiddenNodeIds)
  const hiddenFilesystemDescendantIds =
    viewMode === 'filesystem'
      ? getCollapsedFilesystemDescendantIds(snapshot, collapsedDirectoryIds)
      : new Set<string>()
  const annotationNodes = layout.annotations.map((annotation) => ({
    id: getAnnotationNodeId(annotation.id),
    type: 'annotationNode',
    position: {
      x: annotation.x,
      y: annotation.y,
    },
    width: annotation.width,
    height: annotation.height,
    draggable: true,
    selectable: false,
    data: {
      label: annotation.label,
      dimmed: false,
    },
  } satisfies Node))
  const groupNodes = Array.from(layoutGroupContainers.values()).map((group) => ({
    id: getLayoutGroupNodeId(group.id),
    type: 'codebaseNode',
    position: {
      x: group.x,
      y: group.y,
    },
    width: group.width,
    height: group.height,
    draggable: true,
    selectable: true,
    data: {
      title: group.title,
      subtitle:
        group.nodeIds.length === 1
          ? '1 node'
          : `${group.nodeIds.length} nodes`,
      kind: 'directory',
      tags: [],
      container: true,
      groupContainer: true,
      dimmed: false,
      highlighted: false,
    },
  } satisfies Node))

  const codeNodes = Object.values(snapshot.nodes)
    .filter((node) => {
      if (hiddenNodeIds.has(node.id) || !layout.placements[node.id]) {
        return false
      }

      if (viewMode === 'symbols') {
        if (!isSymbolNode(node)) {
          return false
        }

        const cluster = symbolClusterState.clusterByNodeId[node.id]

        return !cluster || cluster.rootNodeId === node.id || expandedClusterIds.has(cluster.id)
      }

      return node.kind !== 'symbol' && !hiddenFilesystemDescendantIds.has(node.id)
    })
    .sort((left, right) => compareFlowNodeOrder(left, right, viewMode))
    .map((node) =>
      buildFlowNode(
        node,
        layout.placements[node.id],
        snapshot,
        layout,
        viewMode,
        symbolClusterState,
        expandedClusterIds,
        expandedClusterLayouts,
        filesystemContainerLayouts,
        layoutGroupContainers,
        collapsedDirectoryIds,
        toggleCollapsedDirectory,
      ),
    )
  const nodes = [...annotationNodes, ...groupNodes, ...codeNodes]
  const visibleNodeIds = new Set(codeNodes.map((node) => node.id))
  const edges: Edge[] = []

  if (graphLayers.contains) {
    edges.push(
      ...getContainsEdges(snapshot, viewMode)
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )
        .map((edge) =>
          buildFlowEdge(
            edge.id,
            'contains',
            edge.source,
            edge.target,
            undefined,
            undefined,
          ),
        ),
    )
  }

  if (viewMode === 'filesystem' && graphLayers.imports) {
    edges.push(
      ...snapshot.edges
        .filter((edge) => edge.kind === 'imports')
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )
        .map((edge) =>
          buildFlowEdge(
            edge.id,
            'imports',
            edge.source,
            edge.target,
            edge.label,
            undefined,
          ),
        ),
    )
  }

  if (graphLayers.calls) {
    edges.push(
      ...(viewMode === 'symbols'
        ? aggregateSymbolEdges(
            snapshot,
            'calls',
            visibleNodeIds,
            symbolClusterState,
            expandedClusterIds,
          )
        : aggregateFileEdges(snapshot, 'calls').filter(
            (edge) =>
              visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
          )),
    )
  }

  return { nodes, edges }
}

function applyFlowNodePresentation(
  nodes: Node[],
  selectedNodeIds: Set<string>,
  compareOverlayState: {
    active: boolean
    nodeIds: Set<string>
  },
  telemetryHeatByNodeId: Map<string, { pulse: boolean; weight: number }>,
) {
  let changed = false
  const nextNodes = nodes.map((node) => {
    const highlighted = compareOverlayState.nodeIds.has(node.id)
    const dimmed = compareOverlayState.active && !highlighted
    const selected = selectedNodeIds.has(node.id)
    const heat = telemetryHeatByNodeId.get(node.id)
    const heatWeight = heat?.weight ?? 0
    const heatPulse = heat?.pulse ?? false
    const data =
      node.data && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : null
    const currentHighlighted = Boolean(data?.highlighted)
    const currentDimmed = Boolean(data?.dimmed)
    const currentHeatWeight =
      typeof data?.heatWeight === 'number' ? data.heatWeight : 0
    const currentHeatPulse = Boolean(data?.heatPulse)

    if (
      node.selected === selected &&
      currentHighlighted === highlighted &&
      currentDimmed === dimmed &&
      currentHeatWeight === heatWeight &&
      currentHeatPulse === heatPulse
    ) {
      return node
    }

    changed = true
    return {
      ...node,
      selected,
      data: data
        ? {
            ...data,
            dimmed,
            heatPulse,
            heatWeight,
            highlighted,
          }
        : node.data,
    }
  })

  return changed ? nextNodes : nodes
}

function applyFlowEdgePresentation(
  edges: Edge[],
  compareOverlayState: {
    active: boolean
    nodeIds: Set<string>
  },
) {
  let changed = false
  const nextEdges = edges.map((edge) => {
    const highlighted = Boolean(
      compareOverlayState.active &&
        compareOverlayState.nodeIds.has(edge.source) &&
        compareOverlayState.nodeIds.has(edge.target),
    )
    const dimmed = Boolean(compareOverlayState.active && !highlighted)
    const data = getFlowEdgeData(edge)
    const currentHighlighted = Boolean(data?.highlighted)
    const currentDimmed = Boolean(data?.dimmed)
    const kind = data?.kind ?? 'contains'
    const strokeWidth = highlighted ? 2.4 : kind === 'contains' ? 1.2 : 1.8
    const currentOpacity = edge.style?.opacity ?? 1
    const currentStrokeWidth = edge.style?.strokeWidth ?? (kind === 'contains' ? 1.2 : 1.8)

    if (
      currentHighlighted === highlighted &&
      currentDimmed === dimmed &&
      currentOpacity === (dimmed ? 0.2 : 1) &&
      currentStrokeWidth === strokeWidth
    ) {
      return edge
    }

    changed = true
    return {
      ...edge,
      data: data
        ? {
            ...data,
            dimmed,
            highlighted,
          }
        : edge.data,
      style: {
        ...edge.style,
        opacity: dimmed ? 0.2 : 1,
        strokeWidth,
      },
    }
  })

  return changed ? nextEdges : edges
}

function applyDirectChildDragPreviewOffset(
  nodes: Node[],
  containerNodeId: string,
  delta: XYPosition,
) {
  if (delta.x === 0 && delta.y === 0) {
    return nodes
  }

  let changed = false
  const nextNodes = nodes.map((node) => {
    if (node.parentId !== containerNodeId) {
      return node
    }

    changed = true
    return {
      ...node,
      position: {
        x: node.position.x + delta.x,
        y: node.position.y + delta.y,
      },
    }
  })

  return changed ? nextNodes : nodes
}

function buildFlowNode(
  node: ProjectNode,
  placement: LayoutSpec['placements'][string],
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
  filesystemContainerLayouts: Map<string, FilesystemContainerLayout>,
  layoutGroupContainers: Map<string, LayoutGroupContainer>,
  collapsedDirectoryIds: Set<string>,
  toggleCollapsedDirectory: (nodeId: string) => void,
): Node {
  if (viewMode === 'symbols' && isSymbolNode(node)) {
    const cluster = symbolClusterState.clusterByNodeId[node.id]
    const clusterSize =
      cluster && cluster.rootNodeId === node.id ? cluster.memberNodeIds.length : 0
    const isClusterRoot = cluster?.rootNodeId === node.id
    const clusterLayout = cluster ? expandedClusterLayouts.get(cluster.id) : undefined
    const isContainedNode =
      Boolean(cluster && clusterLayout) &&
      !isClusterRoot &&
      expandedClusterIds.has(cluster?.id ?? '')
    const containedPlacement = cluster ? clusterLayout?.childPlacements[node.id] : undefined
    const symbolDimensions = getSymbolNodeDimensions(
      node,
      placement,
      isContainedNode,
      containedPlacement,
    )

    return {
      id: node.id,
      type: 'symbolNode',
      position: {
        x: containedPlacement?.x ?? placement.x,
        y: containedPlacement?.y ?? placement.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      width:
        isContainedNode
          ? symbolDimensions.width
          : (clusterLayout?.width ?? symbolDimensions.width),
      height:
        isContainedNode
          ? symbolDimensions.height
          : (clusterLayout?.height ?? symbolDimensions.height),
      draggable: true,
      parentId: isContainedNode && cluster ? cluster.rootNodeId : undefined,
      extent: isContainedNode ? 'parent' : undefined,
      data: {
        title: node.name,
        subtitle: getSymbolSubtitle(node, snapshot),
        kind: node.symbolKind,
        kindClass: getSymbolKindClass(node.symbolKind),
        tags: node.tags.slice(0, 3),
        clusterSize,
        clusterExpanded:
          clusterSize > 0 && cluster ? expandedClusterIds.has(cluster.id) : undefined,
        sharedCallerCount: symbolClusterState.callerCounts[node.id],
        contained: isContainedNode,
        compact: symbolDimensions.compact,
        dimmed: false,
        highlighted: false,
      },
    }
  }

  const layoutGroupContainer = layoutGroupContainers.get(node.id)
  const groupParentContainer = getLayoutGroupParentContainer(node.id, layoutGroupContainers)
  const filesystemContainerLayout =
    viewMode === 'filesystem' && layout.strategy === 'structural' && isDirectoryNode(node)
      ? filesystemContainerLayouts.get(node.id)
      : undefined
  const isCollapsedDirectory =
    viewMode === 'filesystem' &&
    layout.strategy === 'structural' &&
    isDirectoryNode(node) &&
    collapsedDirectoryIds.has(node.id)
  const filesystemParent =
    viewMode === 'filesystem' &&
    layout.strategy === 'structural' &&
    !groupParentContainer &&
    !isSymbolNode(node) &&
    node.parentId
      ? snapshot.nodes[node.parentId]
      : null
  const filesystemParentPlacement =
    viewMode === 'filesystem' && filesystemParent && !isSymbolNode(filesystemParent)
      ? layout.placements[filesystemParent.id]
      : null
  const isContainedFilesystemNode = Boolean(
    viewMode === 'filesystem' &&
      layout.strategy === 'structural' &&
      filesystemParent &&
      isDirectoryNode(filesystemParent) &&
      filesystemParentPlacement,
  )
  const groupParentPosition = groupParentContainer
    ? { x: groupParentContainer.x, y: groupParentContainer.y }
    : null

  return {
    id: node.id,
    type: 'codebaseNode',
    position: {
      x:
        groupParentPosition
          ? placement.x - groupParentPosition.x
          : isContainedFilesystemNode && filesystemParentPlacement
          ? placement.x - filesystemParentPlacement.x
          : placement.x,
      y:
        groupParentPosition
          ? placement.y - groupParentPosition.y
          : isContainedFilesystemNode && filesystemParentPlacement
          ? placement.y - filesystemParentPlacement.y
          : placement.y,
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    width:
      (isCollapsedDirectory ? placement.width ?? 240 : filesystemContainerLayout?.width) ??
      placement.width ??
      (node.kind === 'directory' ? 240 : 224),
    height:
      (isCollapsedDirectory ? placement.height ?? 72 : filesystemContainerLayout?.height) ??
      placement.height ??
      (node.kind === 'directory' ? 68 : 54),
    draggable: true,
    parentId:
      groupParentContainer
        ? getLayoutGroupNodeId(groupParentContainer.id)
        : isContainedFilesystemNode && filesystemParent
          ? filesystemParent.id
          : undefined,
    extent: groupParentContainer || isContainedFilesystemNode ? 'parent' : undefined,
    data: {
      title: node.name,
      subtitle: getNodeSubtitle(node),
      kind: node.kind,
      tags: node.tags.slice(0, 3),
      container: Boolean(
        (filesystemContainerLayout || layoutGroupContainer) && node.kind === 'directory',
      ),
      collapsible:
        viewMode === 'filesystem' &&
        layout.strategy === 'structural' &&
        isDirectoryNode(node) &&
        node.childIds.some((childId) => {
          const childNode = snapshot.nodes[childId]
          return Boolean(childNode && !isSymbolNode(childNode))
        }),
      collapsed: isCollapsedDirectory,
      onToggleCollapse:
        viewMode === 'filesystem' &&
        layout.strategy === 'structural' &&
        isDirectoryNode(node)
          ? () => {
              toggleCollapsedDirectory(node.id)
            }
          : undefined,
      dimmed: false,
      highlighted: false,
    },
  }
}

function getContainsEdges(
  snapshot: CodebaseSnapshot,
  viewMode: VisualizerViewMode,
) {
  return snapshot.edges.filter((edge) => {
    if (edge.kind !== 'contains') {
      return false
    }

    if (viewMode !== 'symbols') {
      return true
    }

    return (
      snapshot.nodes[edge.source]?.kind === 'symbol' &&
      snapshot.nodes[edge.target]?.kind === 'symbol'
    )
  })
}

function buildFilesystemContainerLayouts(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  viewMode: VisualizerViewMode,
  collapsedDirectoryIds: Set<string>,
) {
  const layouts = new Map<string, FilesystemContainerLayout>()

  if (!snapshot || !layout || viewMode !== 'filesystem') {
    return layouts
  }

  const hiddenNodeIds = new Set(layout.hiddenNodeIds)

  const computeLayout = (nodeId: string): FilesystemContainerLayout | null => {
    const existing = layouts.get(nodeId)

    if (existing) {
      return existing
    }

    const node = snapshot.nodes[nodeId]
    const placement = layout.placements[nodeId]

    if (!node || !placement || !isDirectoryNode(node) || hiddenNodeIds.has(node.id)) {
      return null
    }

    let width = placement.width ?? 240
    let height = placement.height ?? 68
    const childNodeIds: string[] = []

    for (const childId of node.childIds) {
      const childNode = snapshot.nodes[childId]
      const childPlacement = layout.placements[childId]

      if (!childNode || !childPlacement || hiddenNodeIds.has(childId) || isSymbolNode(childNode)) {
        continue
      }

      childNodeIds.push(childId)
      const childContainerLayout =
        isDirectoryNode(childNode) && !collapsedDirectoryIds.has(childId)
          ? computeLayout(childId)
          : null
      const childWidth =
        childContainerLayout?.width ??
        childPlacement.width ??
        (childNode.kind === 'directory' ? 240 : 224)
      const childHeight =
        childContainerLayout?.height ??
        childPlacement.height ??
        (childNode.kind === 'directory' ? 68 : 54)
      const relativeRight = childPlacement.x - placement.x + childWidth
      const relativeBottom = childPlacement.y - placement.y + childHeight

      width = Math.max(width, relativeRight + FILESYSTEM_CONTAINER_PADDING_RIGHT)
      height = Math.max(height, relativeBottom + FILESYSTEM_CONTAINER_PADDING_BOTTOM)
    }

    const nextLayout: FilesystemContainerLayout = {
      width,
      height,
      childNodeIds,
    }

    layouts.set(nodeId, nextLayout)
    return nextLayout
  }

  for (const rootId of snapshot.rootIds) {
    computeLayout(rootId)
  }

  return layouts
}

function buildLayoutGroupContainers(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  viewMode: VisualizerViewMode,
) {
  const containers = new Map<string, LayoutGroupContainer>()

  if (!snapshot || !layout || layout.strategy !== 'agent') {
    return containers
  }

  const hiddenNodeIds = new Set(layout.hiddenNodeIds)

  for (const group of layout.groups) {
    const memberPlacements = group.nodeIds
      .map((nodeId) => {
        const node = snapshot.nodes[nodeId]
        const placement = layout.placements[nodeId]

        if (
          !node ||
          !placement ||
          hiddenNodeIds.has(nodeId) ||
          (viewMode === 'symbols' ? !isSymbolNode(node) : node.kind === 'symbol')
        ) {
          return null
        }

        const width = placement.width ?? getDefaultNodeWidth(node)
        const height = placement.height ?? getDefaultNodeHeight(node)

        return {
          nodeId,
          x: placement.x,
          y: placement.y,
          width,
          height,
        }
      })
      .filter((placement): placement is NonNullable<typeof placement> => Boolean(placement))

    if (memberPlacements.length === 0) {
      continue
    }

    const minX = Math.min(...memberPlacements.map((placement) => placement.x))
    const minY = Math.min(...memberPlacements.map((placement) => placement.y))
    const maxRight = Math.max(
      ...memberPlacements.map((placement) => placement.x + placement.width),
    )
    const maxBottom = Math.max(
      ...memberPlacements.map((placement) => placement.y + placement.height),
    )

    containers.set(group.id, {
      id: group.id,
      title: group.title,
      x: minX - LAYOUT_GROUP_PADDING_X,
      y: minY - LAYOUT_GROUP_PADDING_TOP,
      width: maxRight - minX + LAYOUT_GROUP_PADDING_X * 2,
      height:
        maxBottom - minY + LAYOUT_GROUP_PADDING_TOP + LAYOUT_GROUP_PADDING_BOTTOM,
      nodeIds: memberPlacements.map((placement) => placement.nodeId),
    })
  }

  return containers
}

function getLayoutGroupParentContainer(
  nodeId: string,
  containers: Map<string, LayoutGroupContainer>,
) {
  for (const container of containers.values()) {
    if (container.nodeIds.includes(nodeId)) {
      return container
    }
  }

  return null
}

function getLayoutGroupNodeId(groupId: string) {
  return `${VIRTUAL_LAYOUT_GROUP_NODE_PREFIX}${groupId}`
}

function isLayoutGroupNodeId(nodeId: string) {
  return nodeId.startsWith(VIRTUAL_LAYOUT_GROUP_NODE_PREFIX)
}

function getLayoutGroupIdFromNodeId(nodeId: string) {
  return nodeId.slice(VIRTUAL_LAYOUT_GROUP_NODE_PREFIX.length)
}

function buildFlowEdge(
  id: string,
  kind: GraphEdgeKind,
  source: string,
  target: string,
  label?: string,
  data?: FlowEdgeData,
): Edge {
  const stroke = getEdgeColor(kind)

  return {
    id,
    source,
    target,
    label,
    data: {
      kind,
      ...data,
      dimmed: false,
      highlighted: false,
    },
    animated: kind !== 'contains',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke,
    },
    style: {
      opacity: 1,
      stroke,
      strokeWidth: kind === 'contains' ? 1.2 : 1.8,
    },
  }
}

function aggregateFileEdges(
  snapshot: CodebaseSnapshot,
  kind: GraphEdgeKind,
) {
  const edges = new Map<string, Edge>()

  for (const edge of snapshot.edges) {
    if (edge.kind !== kind) {
      continue
    }

    const sourceFileId = getFileNodeId(snapshot, edge.source)
    const targetFileId = getFileNodeId(snapshot, edge.target)

    if (!sourceFileId || !targetFileId || sourceFileId === targetFileId) {
      continue
    }

    const key = `${kind}:${sourceFileId}->${targetFileId}`
    const existingEdge = edges.get(key)

    if (existingEdge) {
      const existingData = getFlowEdgeData(existingEdge)
      const nextCount = (existingData?.count ?? 1) + 1

      edges.set(key, {
        ...existingEdge,
        data: {
          kind,
          count: nextCount,
        },
        label: `${nextCount} calls`,
      })
      continue
    }

    edges.set(
      key,
      buildFlowEdge(key, kind, sourceFileId, targetFileId, '1 call', {
        kind,
        count: 1,
      }),
    )
  }

  return Array.from(edges.values())
}

function aggregateSymbolEdges(
  snapshot: CodebaseSnapshot,
  kind: GraphEdgeKind,
  visibleNodeIds: Set<string>,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
) {
  const edges = new Map<string, Edge>()

  for (const edge of snapshot.edges) {
    if (edge.kind !== kind) {
      continue
    }

    const mappedSource = getVisibleSymbolEdgeEndpoint(
      snapshot,
      edge.source,
      symbolClusterState,
      expandedClusterIds,
    )
    const mappedTarget = getVisibleSymbolEdgeEndpoint(
      snapshot,
      edge.target,
      symbolClusterState,
      expandedClusterIds,
    )

    if (
      !mappedSource ||
      !mappedTarget ||
      mappedSource === mappedTarget ||
      !visibleNodeIds.has(mappedSource) ||
      !visibleNodeIds.has(mappedTarget)
    ) {
      continue
    }

    const key = `${kind}:${mappedSource}->${mappedTarget}`
    const existingEdge = edges.get(key)

    if (!existingEdge) {
      edges.set(
        key,
        buildFlowEdge(key, kind, mappedSource, mappedTarget, undefined, {
          kind,
          count: 1,
        }),
      )
      continue
    }

    if (kind !== 'calls') {
      continue
    }

    const existingData = getFlowEdgeData(existingEdge)
    const nextCount = (existingData?.count ?? 1) + 1

    edges.set(key, {
      ...existingEdge,
      data: {
        kind,
        count: nextCount,
      },
      label: `${nextCount} calls`,
    })
  }

  return Array.from(edges.values()).map((edge) => {
    if (kind !== 'calls') {
      return edge
    }

    const count = getFlowEdgeData(edge)?.count ?? 1

    return {
      ...edge,
      label: count > 1 ? `${count} calls` : '1 call',
    }
  })
}

function getVisibleSymbolEdgeEndpoint(
  snapshot: CodebaseSnapshot,
  nodeId: string,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
) {
  const node = snapshot.nodes[nodeId]

  if (!node || !isSymbolNode(node)) {
    return null
  }

  const cluster = symbolClusterState.clusterByNodeId[nodeId]

  if (!cluster || expandedClusterIds.has(cluster.id)) {
    return nodeId
  }

  return cluster.rootNodeId
}

function buildExpandedClusterLayouts(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
) {
  const layouts = new Map<string, ExpandedClusterLayout>()

  if (!snapshot || !layout) {
    return layouts
  }

  for (const cluster of symbolClusterState.clusters) {
    if (!expandedClusterIds.has(cluster.id)) {
      continue
    }

    const rootPlacement = layout.placements[cluster.rootNodeId]

    if (!rootPlacement) {
      continue
    }

    const rootNode = snapshot.nodes[cluster.rootNodeId]

    if (!rootNode || !isSymbolNode(rootNode)) {
      continue
    }

    const rootDimensions = getSymbolNodeDimensions(rootNode, rootPlacement, false)
    const rootWidth = rootDimensions.width
    const rootHeight = rootDimensions.height

    const memberIds = [...cluster.memberNodeIds]

    if (memberIds.length === 0) {
      continue
    }

    memberIds.sort((leftId, rightId) => {
      const leftPlacement = layout.placements[leftId]
      const rightPlacement = layout.placements[rightId]
      const leftY = leftPlacement?.y ?? Number.MAX_SAFE_INTEGER
      const rightY = rightPlacement?.y ?? Number.MAX_SAFE_INTEGER

      if (leftY !== rightY) {
        return leftY - rightY
      }

      const leftX = leftPlacement?.x ?? Number.MAX_SAFE_INTEGER
      const rightX = rightPlacement?.x ?? Number.MAX_SAFE_INTEGER

      if (leftX !== rightX) {
        return leftX - rightX
      }

      return leftId.localeCompare(rightId)
    })

    const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(memberIds.length))))
    const childPlacements: ExpandedClusterLayout['childPlacements'] = {}
    const childIdsByOwner = new Map<string, string[]>()

    for (const memberId of memberIds) {
      const ownerId = cluster.ownerByMemberNodeId[memberId] ?? cluster.rootNodeId
      const childIds = childIdsByOwner.get(ownerId) ?? []
      childIds.push(memberId)
      childIdsByOwner.set(ownerId, childIds)
    }

    for (const childIds of childIdsByOwner.values()) {
      childIds.sort((leftId, rightId) =>
        compareClusterMemberOrder(leftId, rightId, layout, snapshot),
      )
    }

    const sizeByNodeId = new Map<string, NodeDimensions>()

    for (const memberId of memberIds) {
      const memberNode = snapshot.nodes[memberId]

      if (!memberNode || !isSymbolNode(memberNode)) {
        continue
      }

      sizeByNodeId.set(
        memberId,
        getSymbolNodeDimensions(
          memberNode,
          layout.placements[memberId],
          true,
        ),
      )
    }

    const subtreeWidthByNodeId = new Map<string, number>()
    const computeSubtreeWidth = (nodeId: string): number => {
      const existingWidth = subtreeWidthByNodeId.get(nodeId)

      if (existingWidth != null) {
        return existingWidth
      }

      const childIds = childIdsByOwner.get(nodeId) ?? []
      const nodeWidth =
        sizeByNodeId.get(nodeId)?.width ??
        (nodeId === cluster.rootNodeId ? rootWidth : EXPANDED_CLUSTER_CHILD_WIDTH)

      if (childIds.length === 0) {
        subtreeWidthByNodeId.set(nodeId, nodeWidth)
        return nodeWidth
      }

      const childrenWidth = childIds.reduce(
        (total, childId, index) =>
          total +
          computeSubtreeWidth(childId) +
          (index > 0 ? EXPANDED_CLUSTER_GAP_X : 0),
        0,
      )
      const subtreeWidth = Math.max(nodeWidth, childrenWidth)
      subtreeWidthByNodeId.set(nodeId, subtreeWidth)
      return subtreeWidth
    }

    const depthByNodeId = new Map<string, number>()
    const computeDepth = (nodeId: string): number => {
      const existingDepth = depthByNodeId.get(nodeId)

      if (existingDepth != null) {
        return existingDepth
      }

      const ownerId = cluster.ownerByMemberNodeId[nodeId]
      const depth = ownerId && ownerId !== cluster.rootNodeId ? computeDepth(ownerId) + 1 : 1
      depthByNodeId.set(nodeId, depth)
      return depth
    }

    let maxDepth = 1

    const placeSubtree = (ownerId: string, startX: number) => {
      const childIds = childIdsByOwner.get(ownerId) ?? []
      let currentX = startX

      for (const childId of childIds) {
        const memberNode = snapshot.nodes[childId]

        if (!memberNode || !isSymbolNode(memberNode)) {
          continue
        }

        const memberDimensions =
          sizeByNodeId.get(childId) ??
          getSymbolNodeDimensions(
            memberNode,
            layout.placements[childId],
            true,
          )
        const subtreeWidth = computeSubtreeWidth(childId)
        const depth = computeDepth(childId)
        maxDepth = Math.max(maxDepth, depth)

        childPlacements[childId] = {
          x: currentX + Math.max(0, (subtreeWidth - memberDimensions.width) / 2),
          y:
            rootHeight +
            EXPANDED_CLUSTER_PADDING_TOP +
            (depth - 1) * (EXPANDED_CLUSTER_CHILD_HEIGHT + EXPANDED_CLUSTER_GAP_Y),
          width: memberDimensions.width,
          height: memberDimensions.height,
        }

        placeSubtree(childId, currentX)
        currentX += subtreeWidth + EXPANDED_CLUSTER_GAP_X
      }
    }

    const rootChildren = childIdsByOwner.get(cluster.rootNodeId) ?? []
    const childTreeWidth = rootChildren.reduce(
      (total, childId, index) =>
        total + computeSubtreeWidth(childId) + (index > 0 ? EXPANDED_CLUSTER_GAP_X : 0),
      0,
    )
    const innerWidth = Math.max(
      rootWidth,
      childTreeWidth,
      columns * EXPANDED_CLUSTER_CHILD_WIDTH +
        Math.max(0, columns - 1) * EXPANDED_CLUSTER_GAP_X,
    )
    const initialX =
      EXPANDED_CLUSTER_PADDING_X + Math.max(0, (innerWidth - childTreeWidth) / 2)

    placeSubtree(cluster.rootNodeId, initialX)

    const depthBandCount = Math.max(
      1,
      ...Object.values(childPlacements).map((placement) =>
        Math.round(
          (placement.y - rootHeight - EXPANDED_CLUSTER_PADDING_TOP) /
            (EXPANDED_CLUSTER_CHILD_HEIGHT + EXPANDED_CLUSTER_GAP_Y),
        ) + 1,
      ),
    )

    for (const memberId of memberIds) {
      const memberNode = snapshot.nodes[memberId]

      if (!memberNode || !isSymbolNode(memberNode) || childPlacements[memberId]) {
        continue
      }

      const memberDimensions = getSymbolNodeDimensions(
        memberNode,
        layout.placements[memberId],
        true,
      )

      childPlacements[memberId] = {
        x:
          EXPANDED_CLUSTER_PADDING_X +
          Object.keys(childPlacements).length *
            (EXPANDED_CLUSTER_CHILD_WIDTH + EXPANDED_CLUSTER_GAP_X),
        y:
          rootHeight +
          EXPANDED_CLUSTER_PADDING_TOP +
          depthBandCount * (EXPANDED_CLUSTER_CHILD_HEIGHT + EXPANDED_CLUSTER_GAP_Y),
        width: memberDimensions.width,
        height: memberDimensions.height,
      }
    }

    const width = Math.max(
      rootWidth,
      EXPANDED_CLUSTER_PADDING_X * 2 +
        innerWidth,
    )
    const height =
      rootHeight +
      EXPANDED_CLUSTER_PADDING_TOP +
      Math.max(1, maxDepth) * EXPANDED_CLUSTER_CHILD_HEIGHT +
      Math.max(0, Math.max(1, maxDepth) - 1) * EXPANDED_CLUSTER_GAP_Y +
      EXPANDED_CLUSTER_PADDING_BOTTOM

    layouts.set(cluster.id, {
      rootNodeId: cluster.rootNodeId,
      width,
      height,
      childPlacements,
    })
  }

  return layouts
}

function compareClusterMemberOrder(
  leftId: string,
  rightId: string,
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot,
) {
  const leftNode = snapshot.nodes[leftId]
  const rightNode = snapshot.nodes[rightId]
  const leftPlacement = layout.placements[leftId]
  const rightPlacement = layout.placements[rightId]
  const leftKindRank = leftNode && isSymbolNode(leftNode) ? getSymbolKindRank(leftNode) : 99
  const rightKindRank = rightNode && isSymbolNode(rightNode) ? getSymbolKindRank(rightNode) : 99

  if (leftKindRank !== rightKindRank) {
    return leftKindRank - rightKindRank
  }

  const leftY = leftPlacement?.y ?? Number.MAX_SAFE_INTEGER
  const rightY = rightPlacement?.y ?? Number.MAX_SAFE_INTEGER

  if (leftY !== rightY) {
    return leftY - rightY
  }

  const leftX = leftPlacement?.x ?? Number.MAX_SAFE_INTEGER
  const rightX = rightPlacement?.x ?? Number.MAX_SAFE_INTEGER

  if (leftX !== rightX) {
    return leftX - rightX
  }

  return leftId.localeCompare(rightId)
}

function getSymbolNodeDimensions(
  symbol: SymbolNode,
  placement: LayoutSpec['placements'][string] | undefined,
  contained: boolean,
  containedPlacement?: ExpandedClusterLayout['childPlacements'][string],
): NodeDimensions {
  if (containedPlacement) {
    return {
      width: containedPlacement.width,
      height: containedPlacement.height,
      compact: containedPlacement.width <= COMPACT_SYMBOL_NODE_WIDTH,
    }
  }

  if (symbol.symbolKind === 'constant') {
    return {
      width: contained ? COMPACT_SYMBOL_NODE_WIDTH - 12 : COMPACT_SYMBOL_NODE_WIDTH,
      height: contained ? COMPACT_SYMBOL_NODE_HEIGHT - 6 : COMPACT_SYMBOL_NODE_HEIGHT,
      compact: true,
    }
  }

  return {
    width: placement?.width ?? DEFAULT_NODE_WIDTH,
    height: placement?.height ?? DEFAULT_NODE_HEIGHT,
    compact: false,
  }
}

function getSymbolKindClass(symbolKind: SymbolNode['symbolKind']) {
  switch (symbolKind) {
    case 'class':
    case 'function':
    case 'method':
    case 'constant':
    case 'variable':
      return symbolKind
    default:
      return 'function'
  }
}

function getSymbolKindRank(symbol: SymbolNode) {
  switch (symbol.symbolKind) {
    case 'class':
      return 0
    case 'function':
      return 1
    case 'method':
      return 2
    case 'constant':
      return 3
    case 'variable':
      return 4
    default:
      return 99
  }
}

function getFileNodeId(
  snapshot: CodebaseSnapshot,
  nodeId: string,
) {
  const node = snapshot.nodes[nodeId]

  if (!node) {
    return null
  }

  if (node.kind === 'file') {
    return node.id
  }

  if (node.kind === 'symbol') {
    return node.fileId
  }

  return null
}

function compareFlowNodeOrder(
  left: ProjectNode,
  right: ProjectNode,
  viewMode: VisualizerViewMode,
) {
  if (viewMode === 'filesystem') {
    const leftDepth = getFilesystemNodeDepth(left)
    const rightDepth = getFilesystemNodeDepth(right)

    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth
    }

    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1
    }
  }

  return left.id.localeCompare(right.id)
}

function getFilesystemNodeDepth(node: ProjectNode) {
  if (node.kind === 'directory') {
    return node.depth
  }

  return isFileNode(node) && node.parentId ? node.parentId.split('/').length : 0
}

function getSelectedFile(
  snapshot: CodebaseSnapshot | null,
  selectedNode: ProjectNode | null,
  files: CodebaseFile[],
) {
  if (!snapshot) {
    return null
  }

  if (selectedNode && isFileNode(selectedNode)) {
    return selectedNode
  }

  if (selectedNode && isSymbolNode(selectedNode)) {
    const fileNode = snapshot.nodes[selectedNode.fileId]

    if (fileNode && isFileNode(fileNode)) {
      return fileNode
    }
  }

  return files[0] ?? null
}

function getPrimaryNode(
  snapshot: CodebaseSnapshot | null,
  nodeIds: string[],
) {
  if (!snapshot || nodeIds.length === 0) {
    return null
  }

  const primaryNodeId = nodeIds[0]

  return primaryNodeId ? snapshot.nodes[primaryNodeId] ?? null : null
}

function getPrimaryFileFromNode(
  snapshot: CodebaseSnapshot | null,
  node: ProjectNode | null,
) {
  if (!snapshot || !node) {
    return null
  }

  if (isFileNode(node)) {
    return node
  }

  if (isSymbolNode(node)) {
    const fileNode = snapshot.nodes[node.fileId]
    return fileNode && isFileNode(fileNode) ? fileNode : null
  }

  return null
}

function formatWorkingSetLabel(context: {
  file: CodebaseFile | null
  files: CodebaseFile[]
  node: ProjectNode | null
  symbol: SymbolNode | null
  symbols: SymbolNode[]
}) {
  if (context.symbols.length > 1) {
    return `Working set · ${context.symbols.length} symbols`
  }

  if (context.files.length > 1) {
    return `Working set · ${context.files.length} files`
  }

  return `Working set · ${context.symbol?.name ?? context.file?.name ?? context.node?.name ?? '1 item'}`
}

function buildWorkingSetTitle(
  context: {
    file: CodebaseFile | null
    files: CodebaseFile[]
    node: ProjectNode | null
    symbol: SymbolNode | null
    symbols: SymbolNode[]
  },
  workingSet: { source: 'selection' | 'manual'; updatedAt: string | null },
) {
  const paths = getWorkingSetPaths(context)
  const lines = ['Pinned agent working set']

  lines.push(
    workingSet.source === 'selection'
      ? 'Source: pinned from selection'
      : 'Source: pinned manually',
  )

  if (workingSet.updatedAt) {
    lines.push(`Updated: ${workingSet.updatedAt}`)
  }

  if (paths.length > 0) {
    lines.push('', ...paths)
  }

  return lines.join('\n')
}

function getWorkingSetPaths(context: {
  file: CodebaseFile | null
  files: CodebaseFile[]
  node: ProjectNode | null
  symbol: SymbolNode | null
  symbols: SymbolNode[]
}) {
  if (context.symbols.length > 0) {
    return context.symbols.map((symbol) => symbol.path)
  }

  if (context.files.length > 0) {
    return context.files.map((file) => file.path)
  }

  if (context.symbol) {
    return [context.symbol.path]
  }

  if (context.file) {
    return [context.file.path]
  }

  return context.node ? [context.node.path] : []
}

function buildAutonomousRunScopeFromContext(
  context: {
    file: CodebaseFile | null
    files: CodebaseFile[]
    node: ProjectNode | null
    symbol: SymbolNode | null
    symbols: SymbolNode[]
  },
  layoutTitle: string | null,
) {
  const paths = [...new Set(
    context.files.length > 0
      ? context.files.map((file) => file.path)
      : context.file
        ? [context.file.path]
        : [],
  )]
  const symbolPaths = [...new Set(
    context.symbols.length > 0
      ? context.symbols.map((symbol) => symbol.path)
      : context.symbol
        ? [context.symbol.path]
        : [],
  )]

  if (paths.length === 0 && symbolPaths.length === 0) {
    return null
  }

  return {
    layoutTitle: layoutTitle ?? undefined,
    paths: paths.length > 0 ? paths : symbolPaths,
    symbolPaths: symbolPaths.length > 0 ? symbolPaths : undefined,
    title: layoutTitle ?? formatWorkingSetLabel(context),
  }
}

function getSelectedFiles(
  snapshot: CodebaseSnapshot | null,
  selectedNodeIds: string[],
) {
  if (!snapshot || selectedNodeIds.length === 0) {
    return []
  }

  const selectedFiles: CodebaseFile[] = []
  const seenFileIds = new Set<string>()

  for (const nodeId of selectedNodeIds) {
    const selectedNode = snapshot.nodes[nodeId]

    if (!selectedNode) {
      continue
    }

    const selectedFile = isFileNode(selectedNode)
      ? selectedNode
      : isSymbolNode(selectedNode)
        ? (() => {
            const fileNode = snapshot.nodes[selectedNode.fileId]
            return fileNode && isFileNode(fileNode) ? fileNode : null
          })()
        : null

    if (!selectedFile || seenFileIds.has(selectedFile.id)) {
      continue
    }

    seenFileIds.add(selectedFile.id)
    selectedFiles.push(selectedFile)
  }

  return selectedFiles
}

function getSelectedSymbols(
  snapshot: CodebaseSnapshot | null,
  selectedNodeIds: string[],
) {
  if (!snapshot || selectedNodeIds.length === 0) {
    return []
  }

  return selectedNodeIds
    .map((nodeId) => snapshot.nodes[nodeId])
    .filter((node): node is ProjectNode => Boolean(node))
    .filter(isSymbolNode)
}

function getNodeSubtitle(node: ProjectNode) {
  if (node.kind === 'directory') {
    return `${node.childIds.length} children`
  }

  if (node.kind === 'file') {
    return `${node.extension || 'no ext'} · ${formatFileSize(node.size)}`
  }

  return node.symbolKind
}

function getDefaultNodeWidth(node: ProjectNode) {
  if (node.kind === 'directory') {
    return 240
  }

  if (node.kind === 'file') {
    return 224
  }

  return DEFAULT_NODE_WIDTH
}

function getDefaultNodeHeight(node: ProjectNode) {
  if (node.kind === 'directory') {
    return 68
  }

  if (node.kind === 'file') {
    return 54
  }

  return DEFAULT_NODE_HEIGHT
}

function getSymbolSubtitle(
  symbol: SymbolNode,
  snapshot: CodebaseSnapshot,
) {
  const fileNode = snapshot.nodes[symbol.fileId]
  const filePath =
    fileNode && isFileNode(fileNode) ? fileNode.path : symbol.fileId
  const lineLabel = symbol.range ? `:${symbol.range.start.line}` : ''

  return `${filePath}${lineLabel}`
}

function getEdgeColor(kind: GraphEdgeKind) {
  switch (kind) {
    case 'imports':
      return '#346f66'
    case 'calls':
      return '#b95b38'
    case 'contains':
    default:
      return '#b9af9e'
  }
}

function buildGraphSummary(
  selectedNodeId: string | null,
  edges: Edge[],
  snapshot: CodebaseSnapshot | null,
): GraphSummary {
  if (!selectedNodeId || !snapshot) {
    return {
      incoming: 0,
      outgoing: 0,
      neighbors: [],
    }
  }

  const incomingEdges = edges.filter((edge) => edge.target === selectedNodeId)
  const outgoingEdges = edges.filter((edge) => edge.source === selectedNodeId)
  const neighborIds = new Set([
    ...incomingEdges.map((edge) => edge.source),
    ...outgoingEdges.map((edge) => edge.target),
  ])

  return {
    incoming: incomingEdges.length,
    outgoing: outgoingEdges.length,
    neighbors: Array.from(neighborIds)
      .map((nodeId) => snapshot.nodes[nodeId])
      .filter((node): node is ProjectNode => Boolean(node)),
  }
}

function countVisibleLayoutNodes(
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec,
  viewMode: VisualizerViewMode,
  symbolClusterState?: SymbolClusterState,
  expandedClusterIds?: Set<string>,
) {
  const hiddenNodeIds = new Set(layout.hiddenNodeIds)

  return Object.values(snapshot.nodes).filter((node) => {
    if (hiddenNodeIds.has(node.id) || !layout.placements[node.id]) {
      return false
    }

    if (viewMode !== 'symbols') {
      return node.kind !== 'symbol'
    }

    if (!isSymbolNode(node)) {
      return false
    }

    const cluster = symbolClusterState?.clusterByNodeId[node.id]

    return !cluster || cluster.rootNodeId === node.id || expandedClusterIds?.has(cluster.id)
  }).length
}

function deriveSymbolClusterState(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  viewMode: VisualizerViewMode,
): SymbolClusterState {
  if (!snapshot || !layout || viewMode !== 'symbols') {
    return {
      clusters: [],
      clusterByNodeId: {},
      callerCounts: {},
    }
  }

  const hiddenNodeIds = new Set(layout.hiddenNodeIds)
  const visibleSymbols = Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .filter((node) => !hiddenNodeIds.has(node.id) && Boolean(layout.placements[node.id]))
    .filter((node) => CLUSTERABLE_SYMBOL_KINDS.has(node.symbolKind))
  const visibleSymbolIds = new Set(visibleSymbols.map((node) => node.id))
  const symbolById = new Map(visibleSymbols.map((node) => [node.id, node]))
  const callerSets = new Map<string, Set<string>>()

  for (const symbol of visibleSymbols) {
    callerSets.set(symbol.id, new Set())
  }

  for (const edge of snapshot.edges) {
    if (
      edge.kind !== 'calls' ||
      !visibleSymbolIds.has(edge.source) ||
      !visibleSymbolIds.has(edge.target)
    ) {
      continue
    }

    callerSets.get(edge.target)?.add(edge.source)
  }

  const callerCounts = Object.fromEntries(
    visibleSymbols.map((symbol) => [symbol.id, callerSets.get(symbol.id)?.size ?? 0]),
  )
  const ownerByNodeId = new Map<string, string>()

  for (const symbol of visibleSymbols) {
    const containmentOwner = getContainmentOwner(symbol, symbolById)

    if (containmentOwner && !isPublicSymbol(symbol)) {
      ownerByNodeId.set(symbol.id, containmentOwner.id)
      continue
    }

    const callers = Array.from(callerSets.get(symbol.id) ?? [])

    if (callers.length !== 1 || isPublicSymbol(symbol)) {
      continue
    }

    const ownerId = callers[0]
    const owner = symbolById.get(ownerId)

    if (!owner || owner.fileId !== symbol.fileId) {
      continue
    }

    ownerByNodeId.set(symbol.id, ownerId)
  }

  const membersByRoot = new Map<string, string[]>()

  for (const nodeId of ownerByNodeId.keys()) {
    const rootId = findClusterRoot(nodeId, ownerByNodeId)

    if (!rootId || rootId === nodeId) {
      continue
    }

    const members = membersByRoot.get(rootId) ?? []
    members.push(nodeId)
    membersByRoot.set(rootId, members)
  }

  const clusters: SymbolCluster[] = Array.from(membersByRoot.entries())
    .map(([rootNodeId, memberNodeIds]) => ({
      id: `cluster:${rootNodeId}`,
      rootNodeId,
      memberNodeIds: memberNodeIds.sort(),
      label: `${memberNodeIds.length} internal helpers`,
      ownerByMemberNodeId: Object.fromEntries(
        memberNodeIds
          .map((memberNodeId) => [memberNodeId, ownerByNodeId.get(memberNodeId)])
          .filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    }))
    .filter((cluster) => cluster.memberNodeIds.length > 0)
  const clusterByNodeId: Record<string, SymbolCluster | undefined> = {}

  for (const cluster of clusters) {
    clusterByNodeId[cluster.rootNodeId] = cluster

    for (const nodeId of cluster.memberNodeIds) {
      clusterByNodeId[nodeId] = cluster
    }
  }

  return {
    clusters,
    clusterByNodeId,
    callerCounts,
  }
}

function findClusterRoot(
  nodeId: string,
  ownerByNodeId: Map<string, string>,
) {
  const visited = new Set<string>()
  let currentNodeId = nodeId

  while (ownerByNodeId.has(currentNodeId)) {
    if (visited.has(currentNodeId)) {
      return null
    }

    visited.add(currentNodeId)
    currentNodeId = ownerByNodeId.get(currentNodeId) ?? currentNodeId
  }

  return currentNodeId
}

function isPublicSymbol(symbol: SymbolNode) {
  return symbol.tags.includes('entrypoint')
}

function getContainmentOwner(
  symbol: SymbolNode,
  symbolById: Map<string, SymbolNode>,
) {
  if (!symbol.parentSymbolId) {
    return null
  }

  const parentSymbol = symbolById.get(symbol.parentSymbolId)

  if (!parentSymbol || parentSymbol.fileId !== symbol.fileId) {
    return null
  }

  if (!CLUSTERABLE_SYMBOL_KINDS.has(parentSymbol.symbolKind)) {
    return null
  }

  return parentSymbol
}

function updateLayoutPlacement(
  nodeId: string,
  position: XYPosition,
  activeLayout: LayoutSpec | null,
  activeDraft: LayoutDraft | null,
  layouts: LayoutSpec[],
  draftLayouts: LayoutDraft[],
  setLayouts: (layouts: LayoutSpec[]) => void,
  setDraftLayouts: (draftLayouts: LayoutDraft[]) => void,
  snapshot: CodebaseSnapshot | null,
  viewMode: VisualizerViewMode,
) {
  if (isAnnotationNodeId(nodeId)) {
    const annotationId = getAnnotationIdFromNodeId(nodeId)

    if (activeDraft?.layout) {
      const nextDraftLayouts = draftLayouts.map((draft) => {
        if (draft.id !== activeDraft.id || !draft.layout) {
          return draft
        }

        return {
          ...draft,
          layout: {
            ...draft.layout,
            annotations: draft.layout.annotations.map((annotation) =>
              annotation.id === annotationId
                ? {
                    ...annotation,
                    x: position.x,
                    y: position.y,
                  }
                : annotation,
            ),
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        }
      })

      setDraftLayouts(nextDraftLayouts)
      return
    }

    if (!activeLayout) {
      return
    }

    const nextLayouts = layouts.map((layout) => {
      if (layout.id !== activeLayout.id) {
        return layout
      }

      return {
        ...layout,
        annotations: layout.annotations.map((annotation) =>
          annotation.id === annotationId
            ? {
                ...annotation,
                x: position.x,
                y: position.y,
              }
            : annotation,
        ),
        updatedAt: new Date().toISOString(),
      }
    })

    setLayouts(nextLayouts)
    return
  }

  if (isLayoutGroupNodeId(nodeId)) {
    const groupId = getLayoutGroupIdFromNodeId(nodeId)

    if (activeDraft?.layout) {
      const nextDraftLayouts = draftLayouts.map((draft) => {
        if (draft.id !== activeDraft.id || !draft.layout) {
          return draft
        }

        return {
          ...draft,
          layout: {
            ...draft.layout,
            placements: buildUpdatedPlacementsForMovedGroup(
              draft.layout,
              snapshot,
              viewMode,
              groupId,
              position,
            ),
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        }
      })

      setDraftLayouts(nextDraftLayouts)
      return
    }

    if (!activeLayout) {
      return
    }

    const nextLayouts = layouts.map((layout) => {
      if (layout.id !== activeLayout.id) {
        return layout
      }

      return {
        ...layout,
        placements: buildUpdatedPlacementsForMovedGroup(
          layout,
          snapshot,
          viewMode,
          groupId,
          position,
        ),
        updatedAt: new Date().toISOString(),
      }
    })

    setLayouts(nextLayouts)
    return
  }

  if (activeDraft?.layout) {
    const nextDraftLayouts = draftLayouts.map((draft) => {
      if (draft.id !== activeDraft.id || !draft.layout) {
        return draft
      }

      const currentPlacement = draft.layout.placements[nodeId]

      if (!currentPlacement) {
        return draft
      }

      const nextPlacements = buildUpdatedPlacementsForMovedNode(
        draft.layout,
        snapshot,
        viewMode,
        nodeId,
        position,
      )

      return {
        ...draft,
        layout: {
          ...draft.layout,
          placements: nextPlacements,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }
    })

    setDraftLayouts(nextDraftLayouts)
    return
  }

  if (!activeLayout) {
    return
  }

  const nextLayouts = layouts.map((layout) => {
    if (layout.id !== activeLayout.id) {
      return layout
    }

    const currentPlacement = layout.placements[nodeId]

    if (!currentPlacement) {
      return layout
    }

    const nextPlacements = buildUpdatedPlacementsForMovedNode(
      layout,
      snapshot,
      viewMode,
      nodeId,
      position,
    )

    return {
      ...layout,
      placements: nextPlacements,
      updatedAt: new Date().toISOString(),
    }
  })

  setLayouts(nextLayouts)
}

function buildUpdatedPlacementsForMovedNode(
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot | null,
  viewMode: VisualizerViewMode,
  nodeId: string,
  position: XYPosition,
) {
  const currentPlacement = layout.placements[nodeId]

  if (!currentPlacement) {
    return layout.placements
  }

  const nextPlacements: LayoutSpec['placements'] = {
    ...layout.placements,
    [nodeId]: {
      ...currentPlacement,
      x: position.x,
      y: position.y,
    },
  }

  if (!snapshot || layout.nodeScope !== 'filesystem') {
    return nextPlacements
  }

  const draggedNode = snapshot.nodes[nodeId]

  if (!draggedNode || isSymbolNode(draggedNode)) {
    return nextPlacements
  }

  const absolutePosition = getAbsoluteCanvasPositionForDraggedNode(
    layout,
    snapshot,
    viewMode,
    nodeId,
    position,
  )

  nextPlacements[nodeId] = {
    ...currentPlacement,
    x: absolutePosition.x,
    y: absolutePosition.y,
  }

  if (!isDirectoryNode(draggedNode)) {
    return nextPlacements
  }

  const deltaX = absolutePosition.x - currentPlacement.x
  const deltaY = absolutePosition.y - currentPlacement.y

  if (deltaX === 0 && deltaY === 0) {
    return nextPlacements
  }

  for (const descendantId of collectFilesystemDescendantNodeIds(snapshot, nodeId)) {
    const descendantPlacement = layout.placements[descendantId]

    if (!descendantPlacement) {
      continue
    }

    nextPlacements[descendantId] = {
      ...descendantPlacement,
      x: descendantPlacement.x + deltaX,
      y: descendantPlacement.y + deltaY,
    }
  }

  return nextPlacements
}

function buildUpdatedPlacementsForMovedGroup(
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot | null,
  viewMode: VisualizerViewMode,
  groupId: string,
  position: XYPosition,
) {
  if (!snapshot) {
    return layout.placements
  }

  const containers = buildLayoutGroupContainers(snapshot, layout, viewMode)
  const container = containers.get(groupId)

  if (!container) {
    return layout.placements
  }

  const deltaX = position.x - container.x
  const deltaY = position.y - container.y

  if (deltaX === 0 && deltaY === 0) {
    return layout.placements
  }

  const nextPlacements: LayoutSpec['placements'] = {
    ...layout.placements,
  }

  for (const nodeId of container.nodeIds) {
    const placement = layout.placements[nodeId]

    if (!placement) {
      continue
    }

    nextPlacements[nodeId] = {
      ...placement,
      x: placement.x + deltaX,
      y: placement.y + deltaY,
    }
  }

  return nextPlacements
}

function getAbsoluteCanvasPositionForDraggedNode(
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot,
  viewMode: VisualizerViewMode,
  nodeId: string,
  position: XYPosition,
) {
  const groupContainer =
    layout.strategy === 'agent'
      ? getLayoutGroupParentContainer(
          nodeId,
          buildLayoutGroupContainers(snapshot, layout, viewMode),
        )
      : null

  if (groupContainer) {
    return {
      x: groupContainer.x + position.x,
      y: groupContainer.y + position.y,
    }
  }

  const draggedNode = snapshot.nodes[nodeId]

  if (!draggedNode || isSymbolNode(draggedNode)) {
    return position
  }

  if (draggedNode.parentId && layout.placements[draggedNode.parentId]) {
    return {
      x: layout.placements[draggedNode.parentId].x + position.x,
      y: layout.placements[draggedNode.parentId].y + position.y,
    }
  }

  return position
}

function collectFilesystemDescendantNodeIds(
  snapshot: CodebaseSnapshot,
  nodeId: string,
) {
  const node = snapshot.nodes[nodeId]

  if (!node || !isDirectoryNode(node)) {
    return []
  }

  const descendantIds: string[] = []

  for (const childId of node.childIds) {
    const childNode = snapshot.nodes[childId]

    if (!childNode || isSymbolNode(childNode)) {
      continue
    }

    descendantIds.push(childId)

    if (isDirectoryNode(childNode)) {
      descendantIds.push(...collectFilesystemDescendantNodeIds(snapshot, childId))
    }
  }

  return descendantIds
}

function mergeLayoutsWithDefaults(
  layouts: LayoutSpec[],
  defaultLayouts: LayoutSpec[],
) {
  const existingLayoutById = new Map(layouts.map((layout) => [layout.id, layout]))
  const defaultLayoutIds = new Set(defaultLayouts.map((layout) => layout.id))
  const customLayouts = layouts.filter((layout) => !defaultLayoutIds.has(layout.id))

  return [
    ...defaultLayouts.map((layout) =>
      mergeDefaultLayoutWithExisting(layout, existingLayoutById.get(layout.id)),
    ),
    ...customLayouts,
  ]
}

function areLayoutListsEquivalent(
  left: LayoutSpec[],
  right: LayoutSpec[],
) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((layout, index) => {
    const rightLayout = right[index]

    return (
      layout.id === rightLayout?.id &&
      layout.updatedAt === rightLayout?.updatedAt &&
      getLayoutNodeScope(layout) === getLayoutNodeScope(rightLayout) &&
      Object.keys(layout.placements).length === Object.keys(rightLayout?.placements ?? {}).length &&
      layout.annotations.length === (rightLayout?.annotations.length ?? 0) &&
      layout.hiddenNodeIds.length === (rightLayout?.hiddenNodeIds.length ?? 0)
    )
  })
}

function areGroupPrototypeCachesEquivalent(
  left: GroupPrototypeCacheSnapshot | null,
  right: GroupPrototypeCacheSnapshot | null,
) {
  const leftRecords = left?.records ?? []
  const rightRecords = right?.records ?? []

  if (leftRecords.length !== rightRecords.length) {
    return false
  }

  return leftRecords.every((record, index) => {
    const rightRecord = rightRecords[index]

    return (
      record.layoutId === rightRecord?.layoutId &&
      record.groupId === rightRecord?.groupId &&
      record.inputHash === rightRecord?.inputHash
    )
  })
}

function mergeDefaultLayoutWithExisting(
  generatedLayout: LayoutSpec,
  existingLayout: LayoutSpec | undefined,
) {
  if (!existingLayout) {
    return generatedLayout
  }

  const mergedPlacements = { ...generatedLayout.placements }

  for (const [nodeId, placement] of Object.entries(existingLayout.placements)) {
    if (!mergedPlacements[nodeId]) {
      continue
    }

    mergedPlacements[nodeId] = {
      ...mergedPlacements[nodeId],
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
    }
  }

  return {
    ...generatedLayout,
    placements: mergedPlacements,
    hiddenNodeIds: existingLayout.hiddenNodeIds.filter((nodeId) => Boolean(mergedPlacements[nodeId])),
    annotations: existingLayout.annotations,
    updatedAt:
      layoutsDifferMeaningfully(existingLayout, generatedLayout, mergedPlacements)
        ? generatedLayout.updatedAt
        : existingLayout.updatedAt,
  }
}

function layoutsDifferMeaningfully(
  existingLayout: LayoutSpec,
  generatedLayout: LayoutSpec,
  mergedPlacements: LayoutSpec['placements'],
) {
  if (
    existingLayout.annotations.length !== generatedLayout.annotations.length ||
    existingLayout.hiddenNodeIds.length !== generatedLayout.hiddenNodeIds.length
  ) {
    return true
  }

  const existingPlacementIds = Object.keys(existingLayout.placements)
  const generatedPlacementIds = Object.keys(generatedLayout.placements)

  if (existingPlacementIds.length !== generatedPlacementIds.length) {
    return true
  }

  return generatedPlacementIds.some((nodeId) => !mergedPlacements[nodeId])
}

function getPreferredViewModeForLayout(layout: LayoutSpec) {
  return getLayoutNodeScope(layout) === 'symbols' ? 'symbols' : 'filesystem'
}

function getLayoutNodeScope(layout: LayoutSpec | null | undefined): LayoutNodeScope {
  return layout?.nodeScope ?? 'filesystem'
}

function getLayerTogglesForViewMode(
  viewMode: VisualizerViewMode,
): GraphLayerKey[] {
  return viewMode === 'symbols'
    ? ['contains', 'calls']
    : ['contains', 'imports', 'calls']
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getLayerLabel(
  layer: GraphLayerKey,
  viewMode: VisualizerViewMode,
) {
  if (layer === 'contains') {
    return viewMode === 'symbols' ? 'Contains' : 'Structure'
  }

  return layer === 'imports' ? 'Imports' : 'Calls'
}

function getAnnotationNodeId(annotationId: string) {
  return `annotation:${annotationId}`
}

function getAnnotationIdFromNodeId(nodeId: string) {
  return nodeId.slice('annotation:'.length)
}

function isAnnotationNodeId(nodeId: string) {
  return nodeId.startsWith('annotation:')
}

function getFlowEdgeData(edge: Edge) {
  return edge.data as FlowEdgeData | undefined
}

function formatFileSize(size: number) {
  if (size < 1_024) {
    return `${size} B`
  }

  if (size < 1_048_576) {
    return `${(size / 1_024).toFixed(1)} KB`
  }

  return `${(size / 1_048_576).toFixed(1)} MB`
}

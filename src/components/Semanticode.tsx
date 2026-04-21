import {
  ReactFlowProvider,
} from '@xyflow/react'
import {
  Suspense,
  useEffect,
  useCallback,
  lazy,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  isSymbolNode,
  type AgentFileOperation,
  type DockPanelId,
  type AgentSessionSummary,
  type CodebaseSnapshot,
  type DirtyFileEditSignal,
  type PreprocessedWorkspaceContext,
  type PreprocessingStatus,
  type TelemetryActivityEvent,
  type TelemetryWindow,
  type WorkspaceProfile,
  type WorkspaceArtifactSyncStatus,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import {
  AgentCollapsedLauncher,
  AgentPanelContent,
  type AgentPromptSeed,
} from './agent/AgentDrawer'
import { CanvasViewport } from './canvas/CanvasViewport'
import { DockWorkspace } from './dock/DockWorkspace'
import { SemanticodeErrorBoundary } from './SemanticodeErrorBoundary'
import { WorkspaceSidebar } from './shell/WorkspaceSidebar'
import { WorkspaceSyncModal } from './shell/WorkspaceSyncModal'
import { WorkspaceToolbar } from './shell/WorkspaceToolbar'
import {
  formatEmbeddingActionLabel,
  formatPreprocessingActionLabel,
  formatPreprocessingStatusLabel,
  formatPreprocessingStatusTitle,
  formatWorkspaceSyncTitle,
  getPreprocessingProgressPercent,
  hasWorkspaceSyncUpdates,
} from './shell/workspaceStatusFormat'
import {
  buildAgentFocusSemanticLayout,
  type AgentTouchedSymbolRecord,
  useAgentFollowController,
  useFollowAgentExecutors,
} from '../app/follow'
import { useAgentFileOperations } from '../app/useAgentFileOperations'
import {
  buildAgentDebugFeedEntries,
  useAgentEventFeed,
} from '../app/useAgentEventFeed'
import { useAutonomousRunsController } from '../app/useAutonomousRunsController'
import { useCanvasGraphController } from '../app/useCanvasGraphController'
import { useSelectionViewModel } from '../app/useSelectionViewModel'
import { useSemanticSearchController } from '../app/useSemanticSearchController'
import { useTelemetryController } from '../app/useTelemetryController'
import {
  getWorkspaceName,
  useWorkspaceChromeController,
} from '../app/useWorkspaceChromeController'
import { useWorkspaceLayoutController } from '../app/useWorkspaceLayoutController'
import {
  buildAutonomousRunScopeFromContext,
  getLayerTogglesForViewMode,
} from '../visualizer/flowModel'

const LazyInspectorPane = lazy(async () => {
  const module = await import('./inspector/InspectorPane')
  return { default: module.InspectorPane }
})

const LazyGeneralSettingsPanel = lazy(async () => {
  const module = await import('./settings/GeneralSettingsPanel')
  return { default: module.GeneralSettingsPanel }
})

const EMPTY_AGENT_FILE_OPERATIONS: AgentFileOperation[] = []
const EMPTY_AGENT_FOCUS_SYMBOLS = new Map<string, AgentTouchedSymbolRecord>()

interface ActiveChatSessionWindow {
  sessionId: string | null
  startedAtMs: number | null
}

interface SemanticodeProps {
  snapshot?: CodebaseSnapshot | null
  onAcceptDraft?: (draftId: string) => Promise<void>
  onAgentRunSettled?: () => Promise<void>
  onBuildSemanticEmbeddings?: () => void
  onLiveWorkspaceRefresh?: () => Promise<void>
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

export function Semanticode({
  snapshot,
  onAcceptDraft,
  onAgentRunSettled,
  onBuildSemanticEmbeddings,
  onLiveWorkspaceRefresh,
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
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const [layoutSuggestionText, setLayoutSuggestionText] = useState('')
  const [agentPromptSeed, setAgentPromptSeed] = useState<AgentPromptSeed | null>(null)
  const [agentFocusFallbackObservedAtMs] = useState(() => Date.now())
  const [followActiveAgent, setFollowActiveAgent] = useState(false)
  const [followDebugOpen, setFollowDebugOpen] = useState(false)
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
  const inspectorBodyRef = useRef<HTMLDivElement | null>(null)
  const selectionAutoOpenInitializedRef = useRef(false)
  const lastAutoOpenedDraftIdRef = useRef<string | null>(null)
  const effectiveSnapshot = snapshot ?? currentSnapshot
  const {
    agentComposerFocusRequestKey,
    agentDrawerOpen,
    agentDrawerTab,
    canManageProjects,
    dockLayout,
    dockPreview,
    dockWorkspaceRef,
    dockWorkspaceStyle,
    handleFocusAgentDrawerComposer,
    handleOpenAnotherWorkspace,
    handleOpenRecentProject,
    handleRemoveRecentProject,
    handlePanelMovePointerDown,
    handleSlotHandlePointerDown,
    inspectorOpen,
    isDesktopHost,
    projectsSidebarOpen,
    recentProjects,
    setAgentDrawerOpen,
    setAgentDrawerTab,
    setInspectorOpen,
    setProjectsSidebarOpen,
    setSettingsOpen,
    setSlotActivePanel,
    setThemeMode,
    setWorkspaceSyncOpen,
    setWorkspaceStateByRootDir,
    setWorkspaceViewResolvedRootDir,
    settingsOpen,
    themeMode,
    uiPreferencesHydrated,
    workspaceActionError,
    workspaceActionPending,
    workspaceStateByRootDir,
    workspaceSyncOpen,
    workspaceViewReady,
    workspaceViewResolvedRootDir,
  } = useWorkspaceChromeController({
    activeDraftId,
    activeLayoutId,
    graphLayers,
    rootDir: effectiveSnapshot?.rootDir,
    setGraphLayerVisibility,
    setViewMode,
    viewMode,
  })
  const runsSurfaceOpen = agentDrawerOpen && agentDrawerTab === 'agents'
  const {
    activeRunId,
    autonomousRuns,
    detectedTaskFile,
    handleSelectRun: selectAutonomousRun,
    handleStartAutonomousRun: startAutonomousRunFromController,
    handleStopAutonomousRun,
    hasRunningAutonomousRun,
    runActionError,
    runActionPending,
    selectedRunDetail,
    selectedRunId,
    selectedRunTimeline,
  } = useAutonomousRunsController({
    rootDir: effectiveSnapshot?.rootDir,
    runsSurfaceOpen,
  })
  const [activeChatSessionWindow, setActiveChatSessionWindow] =
    useState<ActiveChatSessionWindow>({
      sessionId: null,
      startedAtMs: null,
    })
  const handleActiveChatSessionChange = useCallback((session: AgentSessionSummary | null) => {
    setActiveChatSessionWindow((currentWindow) => {
      if (!session) {
        return currentWindow.sessionId === null
          ? currentWindow
          : {
              sessionId: null,
              startedAtMs: null,
            }
      }

      const startedAtMs = getAgentSessionStartedAtMs(session)

      return currentWindow.sessionId === session.id &&
        currentWindow.startedAtMs === startedAtMs
        ? currentWindow
        : {
            sessionId: session.id,
            startedAtMs,
          }
    })
  }, [])
  const handleChatSessionCleared = useCallback((session: AgentSessionSummary | null) => {
    setActiveChatSessionWindow({
      sessionId: session?.id ?? null,
      startedAtMs: session ? Date.now() : null,
    })
  }, [])
  const {
    activateRunTelemetry,
    enableTelemetry,
    followDirtyFileSignals,
    handleTelemetryModeChange,
    handleTelemetrySourceChange,
    handleTelemetryWindowChange,
    liveChangedFiles,
    telemetryActivityEvents,
    telemetryEnabled,
    telemetryError,
    telemetryHeatSamples,
    telemetryMode,
    telemetryObservedAt,
    telemetryOverview,
    telemetrySource,
    telemetryWindow,
  } = useTelemetryController({
    activeChatSessionId: activeChatSessionWindow.sessionId,
    activeChatWindowStartMs: activeChatSessionWindow.startedAtMs,
    followActiveAgent,
    hasRunningAutonomousRun,
    rootDir: effectiveSnapshot?.rootDir,
    runsSurfaceOpen,
    selectedRunId,
    workspaceSyncStatus,
  })
  const agentFileOperations = useAgentFileOperations({
    enabled: followActiveAgent,
  })
  const liveAgentEventFeedEntries = useAgentEventFeed()
  const allFollowFileOperations = useMemo(() => {
    const autonomousFileOperations =
      selectedRunDetail?.runId === activeRunId
        ? selectedRunDetail.fileOperations
        : EMPTY_AGENT_FILE_OPERATIONS

    if (agentFileOperations.length === 0) {
      return autonomousFileOperations.length === 0
        ? EMPTY_AGENT_FILE_OPERATIONS
        : autonomousFileOperations
    }

    if (autonomousFileOperations.length === 0) {
      return agentFileOperations
    }

    return [
      ...agentFileOperations,
      ...autonomousFileOperations,
    ]
  }, [
    activeRunId,
    agentFileOperations,
    selectedRunDetail?.fileOperations,
    selectedRunDetail?.runId,
  ])
  const followFileOperations = useMemo(
    () =>
      filterAgentFileOperationsForTelemetryWindow({
        activeSessionId: activeChatSessionWindow.sessionId,
        operations: allFollowFileOperations,
        sessionStartMs: activeChatSessionWindow.startedAtMs,
        telemetryWindow,
      }),
    [
      activeChatSessionWindow.sessionId,
      activeChatSessionWindow.startedAtMs,
      allFollowFileOperations,
      telemetryWindow,
    ],
  )
  const sessionTouchedPathSet = useMemo(
    () =>
      buildSessionTouchedPathSet({
        fileOperations: followFileOperations,
        telemetryActivityEvents,
        telemetryWindow,
      }),
    [
      followFileOperations,
      telemetryActivityEvents,
      telemetryWindow,
    ],
  )
  const scopedLiveChangedFiles = useMemo(
    () =>
      sessionTouchedPathSet
        ? liveChangedFiles.filter((path) => sessionTouchedPathSet.has(path))
        : liveChangedFiles,
    [liveChangedFiles, sessionTouchedPathSet],
  )
  const scopedFollowDirtyFileSignals = useMemo(
    () =>
      filterDirtyFileSignalsForTelemetryWindow({
        dirtyFileEditSignals: followDirtyFileSignals,
        sessionStartMs: activeChatSessionWindow.startedAtMs,
        sessionTouchedPathSet,
        telemetryWindow,
      }),
    [
      activeChatSessionWindow.startedAtMs,
      followDirtyFileSignals,
      sessionTouchedPathSet,
      telemetryWindow,
    ],
  )
  const semanticLayoutForAgentFocus = useMemo(
    () => layouts.find((layout) => layout.strategy === 'semantic') ?? null,
    [layouts],
  )
  const agentFocusSemanticResult = useMemo(
    () =>
      buildAgentFocusSemanticLayout({
        dirtyFileEditSignals: scopedFollowDirtyFileSignals,
        fileOperations: followFileOperations,
        liveChangedFiles: scopedLiveChangedFiles,
        observedAtMs: telemetryObservedAt || agentFocusFallbackObservedAtMs,
        semanticLayout: semanticLayoutForAgentFocus,
        snapshot: effectiveSnapshot ?? null,
        telemetryActivityEvents,
        telemetryWindow,
      }),
    [
      effectiveSnapshot,
      agentFocusFallbackObservedAtMs,
      followFileOperations,
      scopedFollowDirtyFileSignals,
      scopedLiveChangedFiles,
      semanticLayoutForAgentFocus,
      telemetryActivityEvents,
      telemetryObservedAt,
      telemetryWindow,
    ],
  )
  const agentFocusSymbolsByNodeId = useMemo(
    () => {
      if (!agentFocusSemanticResult?.touchedSymbols.length) {
        return EMPTY_AGENT_FOCUS_SYMBOLS
      }

      return new Map(
        agentFocusSemanticResult.touchedSymbols.map((record) => [
          record.symbolId,
          record,
        ]),
      )
    },
    [agentFocusSemanticResult],
  )

  useEffect(() => {
    if (snapshot === undefined) {
      return
    }

    setSnapshot(snapshot)
  }, [setSnapshot, snapshot])

  const setInspectorTabToFile = useCallback(() => {
    setInspectorTab('file')
  }, [setInspectorTab])
  const {
    activeDraft,
    activeLayout,
    activeLayoutSyncNote,
    compareOverlayActive,
    currentCompareSource,
    editableDraftLayout,
    editableLayout,
    handleActivateCompareOverlay,
    handleClearCompareOverlay,
    handleLayoutSelectionChange,
    layoutOptions,
    overlayNodeIdSet,
    resolvedCompareOverlay,
    resolvedScene,
    selectedLayoutValue,
  } = useWorkspaceLayoutController({
    activeDraftId,
    activeLayoutId,
    agentFocusLayout: agentFocusSemanticResult?.layout ?? null,
    baseScene,
    clearCompareOverlay,
    compareOverlay,
    draftLayouts,
    layouts,
    onClearDraftActionError: () => setDraftActionError(null),
    overlayFocusMode,
    overlayVisibility,
    setActiveDraftId,
    setActiveLayoutId,
    setBaseScene,
    setCompareOverlay,
    setDraftLayouts,
    setInspectorOpen,
    setInspectorTabToFile,
    setLayouts,
    setOverlayVisibility,
    setViewMode,
    setWorkspaceStateByRootDir,
    setWorkspaceViewResolvedRootDir,
    snapshot: effectiveSnapshot,
    uiPreferencesHydrated,
    viewMode,
    workspaceStateByRootDir,
    workspaceSyncStatus,
    workspaceViewResolvedRootDir,
  })

  useEffect(() => {
    if (!activeDraftId) {
      lastAutoOpenedDraftIdRef.current = null
      return
    }

    if (lastAutoOpenedDraftIdRef.current === activeDraftId) {
      return
    }

    lastAutoOpenedDraftIdRef.current = activeDraftId
    setInspectorOpen(true)
    setInspectorTab('agent')
  }, [activeDraftId, setInspectorOpen, setInspectorTab])

  const handleAcceptActiveDraft = useCallback(async () => {
    if (!activeDraft || !onAcceptDraft) {
      return
    }

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
  }, [activeDraft, onAcceptDraft])

  const handleRejectActiveDraft = useCallback(async () => {
    if (!activeDraft || !onRejectDraft) {
      return
    }

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
  }, [activeDraft, onRejectDraft])
  const {
    clearSemanticSearch,
    handleSemanticSearchModeChange,
    semanticGroupSearchAvailable,
    semanticSearchAvailable,
    semanticSearchEmbeddings,
    semanticSearchGroupPrototypes,
    semanticSearchHighlightActive,
    semanticSearchMatchLimit,
    semanticSearchMatchNodeIds,
    semanticSearchMode,
    semanticSearchPending,
    semanticSearchQuery,
    semanticSearchStatus,
    semanticSearchStrictness,
    setSemanticSearchMatchLimit,
    setSemanticSearchQuery,
    setSemanticSearchStrictness,
  } = useSemanticSearchController({
    preprocessedWorkspaceContext,
    resolvedScene,
    rootDir: effectiveSnapshot?.rootDir,
    viewMode,
  })
  const highlightedNodeIdSet = useMemo(() => {
    return new Set([...overlayNodeIdSet, ...semanticSearchMatchNodeIds])
  }, [overlayNodeIdSet, semanticSearchMatchNodeIds])
  useEffect(() => {
    setExpandedSymbolClusterIds([])
  }, [resolvedScene?.layoutSpec.id, setExpandedSymbolClusterIds])

  const {
    denseCanvasMode,
    edges,
    flowInstance,
    focusCanvasOnFollowTarget,
    focusCanvasOnNode,
    handleCanvasEdgeClick,
    handleCanvasMoveEnd,
    handleCanvasNodeClick,
    handleCanvasNodeDoubleClick,
    handleCanvasNodeDrag,
    handleCanvasNodeDragStop,
    nodes,
    onEdgesChange,
    onNodesChange,
    setFlowInstance,
  } = useCanvasGraphController({
    agentFocusSymbolsByNodeId,
    collapsedDirectoryIds,
    compareOverlayActive,
    draftLayouts,
    editableDraftLayout,
    editableLayout,
    expandedSymbolClusterIds,
    graphLayers,
    highlightedNodeIdSet,
    layouts,
    overlayNodeIdSet,
    resolvedCompareOverlay,
    resolvedScene,
    selectedNodeIds,
    semanticSearchHighlightActive,
    selectEdge,
    selectNode,
    setDraftLayouts,
    setInspectorOpen,
    setLayouts,
    setViewport,
    snapshot: effectiveSnapshot,
    telemetryHeatSamples,
    telemetryMode,
    telemetryObservedAt,
    telemetryWindow,
    toggleCollapsedDirectory,
    toggleSymbolCluster,
    viewMode,
    viewport,
  })
  const {
    cameraCommand: followCameraCommand,
    debugState: followDebugState,
    inspectorCommand: followInspectorCommand,
    refreshCommand: followRefreshCommand,
    acknowledgeCameraCommand,
    acknowledgeInspectorCommand,
    acknowledgeRefreshCommand,
    setRefreshStatus,
  } = useAgentFollowController({
    dirtyFileEditSignals: scopedFollowDirtyFileSignals,
    enabled: followActiveAgent,
    fileOperations: followFileOperations,
    liveChangedFiles: scopedLiveChangedFiles,
    snapshot: effectiveSnapshot,
    telemetryActivityEvents,
    telemetryEnabled,
    telemetryMode,
    viewMode,
    visibleNodes: nodes,
  })
  const {
    graphSummary,
    inspectorHeader,
    selectedEdge,
    selectedFile,
    selectedFiles,
    selectedGroupNearbySymbols,
    selectedGroupPrototype,
    selectedLayoutGroup,
    selectedNode,
    selectedNodeTelemetry,
    selectedSymbol,
    selectedSymbols,
    workingSetContext,
    workingSetSummary,
    workspaceSidebarGroups,
  } = useSelectionViewModel({
    edges,
    resolvedScene,
    selectedEdgeId,
    selectedNodeId,
    selectedNodeIds,
    semanticSearchEmbeddings,
    semanticSearchGroupPrototypes,
    snapshot: effectiveSnapshot,
    telemetryActivityEvents,
    workingSet,
  })
  const workspaceName = effectiveSnapshot
    ? getWorkspaceName(effectiveSnapshot.rootDir)
    : 'Workspace'
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
              title: formatWorkspaceSyncTitle(workspaceSyncStatus),
            }
          : null,
      }
    : null
  const visibleLayerToggles = useMemo(
    () => getLayerTogglesForViewMode(viewMode),
    [viewMode],
  )
  const agentHeatHelperText = useMemo(() => {
    if (!telemetryEnabled) {
      return 'Agent heat is off. Adjust these controls to load telemetry.'
    }

    if (telemetryError) {
      return telemetryError
    }

    if (telemetryWindow === 'session' && !activeChatSessionWindow.sessionId) {
      return 'Open the chat pane to bind agent heat to the active chat.'
    }

    if (!telemetryOverview) {
      return 'Loading agent activity…'
    }

    if (telemetryOverview.requestCount === 0) {
      if (telemetryWindow === 'run') {
        return 'No agent activity recorded for this run yet.'
      }

      if (telemetryWindow === 'session') {
        return 'No agent activity recorded for this chat yet.'
      }

      return 'No agent activity recorded in this window.'
    }

    const tokenText = `${Math.round(telemetryOverview.totalTokens)} tokens`
    const requestText = `${telemetryOverview.requestCount} request${telemetryOverview.requestCount === 1 ? '' : 's'}`
    const runText =
      telemetryOverview.activeRuns.length > 0
        ? ` · ${telemetryOverview.activeRuns.length} active run${telemetryOverview.activeRuns.length === 1 ? '' : 's'}`
        : ''

    return `${requestText} · ${tokenText}${runText}`
  }, [
    activeChatSessionWindow.sessionId,
    telemetryEnabled,
    telemetryError,
    telemetryOverview,
    telemetryWindow,
  ])
  const agentHeatSummaryText = useMemo(() => {
    if (!telemetryEnabled) {
      return 'heat off'
    }

    if (telemetryError) {
      return 'telemetry error'
    }

    if (telemetryWindow === 'session' && !activeChatSessionWindow.sessionId) {
      return 'no chat'
    }

    if (!telemetryOverview) {
      return 'loading activity'
    }

    if (telemetryOverview.requestCount === 0) {
      if (telemetryWindow === 'run') {
        return '0 req · run'
      }

      if (telemetryWindow === 'session') {
        return '0 req · chat'
      }

      return '0 req'
    }

    const requestText = `${telemetryOverview.requestCount} req`
    const tokenText = `${Math.round(telemetryOverview.totalTokens)} tok`
    const runText =
      telemetryOverview.activeRuns.length > 0
        ? ` · ${telemetryOverview.activeRuns.length} run${telemetryOverview.activeRuns.length === 1 ? '' : 's'}`
        : ''

    return `${requestText} · ${tokenText}${runText}`
  }, [
    activeChatSessionWindow.sessionId,
    telemetryEnabled,
    telemetryError,
    telemetryOverview,
    telemetryWindow,
  ])
  const agentFocusActive = resolvedScene?.kind === 'agent_focus_semantic'
  const agentFocusSummaryText = useMemo(() => {
    if (!agentFocusActive) {
      return ''
    }

    if (!semanticLayoutForAgentFocus) {
      return 'Loading semantic layout'
    }

    if (!agentFocusSemanticResult || agentFocusSemanticResult.summary.symbolCount === 0) {
      return agentFocusSemanticResult?.summary.unresolvedCount
        ? `0 symbols · ${agentFocusSemanticResult.summary.unresolvedCount} unresolved`
        : '0 symbols in window'
    }

    const { editCount, fileCount, readCount, symbolCount, unresolvedCount } =
      agentFocusSemanticResult.summary
    const editText = editCount > 0 ? ` · ${editCount} edit${editCount === 1 ? '' : 's'}` : ''
    const readText = readCount > 0 ? ` · ${readCount} read${readCount === 1 ? '' : 's'}` : ''
    const unresolvedText =
      unresolvedCount > 0
        ? ` · ${unresolvedCount} unresolved`
        : ''

    return `${symbolCount} symbol${symbolCount === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'}${editText}${readText}${unresolvedText}`
  }, [
    agentFocusActive,
    agentFocusSemanticResult,
    semanticLayoutForAgentFocus,
  ])
  const agentFocusEmptyText = useMemo(() => {
    if (!agentFocusActive) {
      return ''
    }

    if (!semanticLayoutForAgentFocus) {
      return 'Semantic symbol positions are loading.'
    }

    if (!telemetryEnabled) {
      return 'Agent heat is off. Select a window or enable follow to load agent activity.'
    }

    if (telemetryWindow === 'session' && !activeChatSessionWindow.sessionId) {
      return 'Open the chat pane to bind this layout to the active chat.'
    }

    if (agentFocusSemanticResult?.summary.unresolvedCount) {
      return 'Agent activity was found, but it did not resolve to visible semantic symbols.'
    }

    return 'No agent-touched symbols were found in the active window.'
  }, [
    agentFocusActive,
    activeChatSessionWindow.sessionId,
    agentFocusSemanticResult,
    semanticLayoutForAgentFocus,
    telemetryEnabled,
    telemetryWindow,
  ])
  const agentHeatFollowText = useMemo(() => {
    if (!followActiveAgent) {
      return 'Follow active agent off.'
    }

    if (!telemetryEnabled) {
      return 'Enable agent heat to follow activity.'
    }

    if (followDebugState.currentMode === 'idle' || !followDebugState.currentTarget) {
      return 'Waiting for visible agent activity.'
    }

    const modeLabel =
      followDebugState.currentMode === 'edit' ? 'Following edit' : 'Following activity'

    return `${modeLabel}: ${followDebugState.currentTarget.path}`
  }, [followActiveAgent, followDebugState, telemetryEnabled])
  const agentStripTrailLabel =
    followDebugState.currentTarget?.path ??
    selectedSymbol?.name ??
    selectedFile?.path ??
    workingSetSummary?.label ??
    workspaceName
  const activeAgentRun = useMemo(
    () => autonomousRuns.find((run) => run.runId === activeRunId) ?? null,
    [activeRunId, autonomousRuns],
  )
  const handleOpenAgentLauncher = useCallback(() => {
    setAgentDrawerTab('chat')
    setAgentDrawerOpen(true)
  }, [setAgentDrawerOpen, setAgentDrawerTab])
  const handleAgentPromptSeed = useCallback((value: string) => {
    setAgentDrawerTab('chat')
    setAgentDrawerOpen(true)
    setAgentPromptSeed({
      id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      value,
    })
  }, [setAgentDrawerOpen, setAgentDrawerTab])

  const handleToggleFollowDebug = useCallback(() => {
    setFollowDebugOpen((current) => !current)
  }, [])
  const handleToggleFollowActiveAgent = useCallback(() => {
    enableTelemetry()
    setFollowActiveAgent((current) => !current)
  }, [enableTelemetry])
  const handleOpenAgentEventFeed = useCallback(() => {
    setInspectorOpen(true)
    setInspectorTab('events')
  }, [setInspectorOpen, setInspectorTab])
  const agentEventFeedEntries = useMemo(
    () =>
      buildAgentDebugFeedEntries({
        agentEvents: liveAgentEventFeedEntries,
        dirtyFileEditSignals: scopedFollowDirtyFileSignals,
        fileOperations: followFileOperations,
        followDebugState,
        telemetryActivityEvents,
      }),
    [
      followDebugState,
      followFileOperations,
      liveAgentEventFeedEntries,
      scopedFollowDirtyFileSignals,
      telemetryActivityEvents,
    ],
  )
  const { followedEditDiffRequestKey, followedInspectorActivity } = useFollowAgentExecutors({
    acknowledgeCameraCommand,
    acknowledgeInspectorCommand,
    acknowledgeRefreshCommand,
    active: followActiveAgent,
    cameraCommand: followCameraCommand,
    canMoveCamera: Boolean(flowInstance),
    focusCanvasOnFollowTarget,
    inspectorCommand: followInspectorCommand,
    onLiveWorkspaceRefresh,
    refreshCommand: followRefreshCommand,
    selectFollowNode: selectNode,
    setInspectorOpen,
    setInspectorTabToFile,
    setRefreshStatus,
  })

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
      setInspectorOpen(true)
    }
  }, [selectedEdgeId, selectedNodeIds, setInspectorOpen, workspaceViewReady])

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

  async function handleStartAutonomousRun() {
    const runId = await startAutonomousRunFromController(
      buildAutonomousRunScopeFromContext(
        workingSetContext,
        activeDraft?.layout?.title ?? activeLayout?.title ?? null,
      ),
    )

    if (runId) {
      setAgentDrawerTab('agents')
      setAgentDrawerOpen(true)
      activateRunTelemetry()
    }
  }

  function handleSelectRun(runId: string) {
    selectAutonomousRun(runId)
    activateRunTelemetry()
  }

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
  const handleWorkspaceLayoutSelectionChange = useCallback((value: string) => {
    if (value === 'scene:agent-focus-semantic') {
      enableTelemetry()
    }

    handleLayoutSelectionChange(value)
  }, [enableTelemetry, handleLayoutSelectionChange])

  const handleSelectSidebarSymbol = useCallback((nodeId: string) => {
    if (!effectiveSnapshot) {
      return
    }

    selectNode(nodeId)
    setInspectorTab('file')
    setInspectorOpen(true)

    const selectedNode = effectiveSnapshot.nodes[nodeId]
    const fallbackNodeIds = selectedNode && isSymbolNode(selectedNode)
      ? [selectedNode.fileId]
      : []

    window.setTimeout(() => {
      focusCanvasOnNode({
        fallbackNodeIds,
        nodeId,
      })
    }, 0)
  }, [effectiveSnapshot, focusCanvasOnNode, selectNode, setInspectorOpen, setInspectorTab])

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

  const renderSnapshot = effectiveSnapshot

  function renderDockPanel(
    panelId: DockPanelId,
    active = true,
    dockMoveHandle: ReactNode = null,
  ) {
    if (panelId === 'outline') {
      return (
        <WorkspaceSidebar
          canManageProjects={canManageProjects}
          currentRootDir={renderSnapshot.rootDir}
          groups={workspaceSidebarGroups}
          onClose={() => setProjectsSidebarOpen(false)}
          onOpenRecentProject={(rootDir) => {
            void handleOpenRecentProject(rootDir)
          }}
          onRemoveRecentProject={(rootDir) => {
            void handleRemoveRecentProject(rootDir)
          }}
          onOpenWorkspace={() => {
            void handleOpenAnotherWorkspace()
          }}
          onSelectSymbol={handleSelectSidebarSymbol}
          open={projectsSidebarOpen}
          recentProjects={recentProjects}
          selectedNodeId={selectedNodeId}
          dockMoveHandle={dockMoveHandle}
          workspaceActionError={workspaceActionError}
          workspaceActionPending={workspaceActionPending}
        />
      )
    }

    if (panelId === 'inspector') {
      return (
        <Suspense fallback={<InspectorFallback dockMoveHandle={dockMoveHandle} header={inspectorHeader} onClose={() => setInspectorOpen(false)} />}>
          <LazyInspectorPane
            activeDraft={activeDraft}
            agentEventFeedEntries={agentEventFeedEntries}
            compareOverlayActive={compareOverlayActive}
            draftActionError={draftActionError}
            detectedPlugins={renderSnapshot.detectedPlugins ?? []}
            dockMoveHandle={dockMoveHandle}
            facetDefinitions={renderSnapshot.facetDefinitions ?? []}
            followDebugState={followDebugState}
            followedInspectorActivity={followedInspectorActivity}
            graphSummary={graphSummary}
            header={inspectorHeader}
            inspectorBodyRef={inspectorBodyRef}
            inspectorTab={inspectorTab}
            onAdoptInspectorContextAsWorkingSet={adoptSelectionAsWorkingSet}
            onAcceptDraft={onAcceptDraft ? handleAcceptActiveDraft : undefined}
            onClearCompareOverlay={handleClearCompareOverlay}
            onClearWorkingSet={clearWorkingSet}
            onClose={() => setInspectorOpen(false)}
            onOpenAgentDrawer={handleFocusAgentDrawerComposer}
            onOpenAgentSettings={() => setSettingsOpen(true)}
            onRejectDraft={onRejectDraft ? handleRejectActiveDraft : undefined}
            onSetInspectorTab={setInspectorTab}
            layoutActionsPending={layoutActionsPending}
            layoutSyncNote={activeLayoutSyncNote}
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
            scrollToDiffRequestKey={followedEditDiffRequestKey}
            themeMode={themeMode}
            workingSet={workingSet.nodeIds.length > 0 ? workingSet : null}
            workingSetContext={workingSetContext}
            workspaceProfile={workspaceProfile}
          />
        </Suspense>
      )
    }

    return (
      <AgentPanelContent
        activeRunId={activeRunId}
        activeTab={agentDrawerTab}
        autonomousRuns={autonomousRuns}
        autoFocusComposer={active}
        composerFocusRequestKey={agentComposerFocusRequestKey}
        desktopHostAvailable={isDesktopHost}
        detectedTaskFile={detectedTaskFile}
        dockMoveHandle={dockMoveHandle}
        errorMessage={runActionError}
        inspectorContext={{
          file: selectedFile,
          files: selectedFiles,
          node: selectedNode,
          symbol: selectedSymbol,
          symbols: selectedSymbols,
        }}
        layoutDraftError={layoutSuggestionError}
        layoutDraftPending={layoutSuggestionPending}
        layoutDraftPrompt={layoutSuggestionText}
        onAdoptInspectorContextAsWorkingSet={adoptSelectionAsWorkingSet}
        onActiveSessionChange={handleActiveChatSessionChange}
        onChangeTab={setAgentDrawerTab}
        onChatSessionCleared={handleChatSessionCleared}
        onClearWorkingSet={clearWorkingSet}
        onClose={() => setAgentDrawerOpen(false)}
        onLayoutDraftPromptChange={handleLayoutSuggestionChange}
        onLayoutDraftSubmit={handleLayoutSuggestionSubmit}
        onOpenSettings={() => setSettingsOpen(true)}
        onRunSettled={onAgentRunSettled}
        onSelectRun={handleSelectRun}
        onStartRun={() => {
          void handleStartAutonomousRun()
        }}
        onStopRun={(runId) => {
          void handleStopAutonomousRun(runId)
        }}
        pendingRunAction={runActionPending}
        preprocessedWorkspaceContext={preprocessedWorkspaceContext}
        promptSeed={agentPromptSeed}
        selectedRunDetail={selectedRunDetail}
        selectedRunId={selectedRunId}
        timeline={selectedRunTimeline}
        workingSet={workingSet.nodeIds.length > 0 ? workingSet : null}
        workingSetContext={workingSetContext}
        workspaceProfile={workspaceProfile}
      />
    )
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
        className={`cbv-app-shell${canManageProjects ? ' is-desktop-host' : ''}`}
      >
        <section className="cbv-shell">
          <WorkspaceToolbar
            layoutOptions={layoutOptions}
            onOpenAgentSettings={() => setSettingsOpen(true)}
            onOpenWorkspaceSync={
              workspaceSyncStatus ? () => setWorkspaceSyncOpen(true) : undefined
            }
            onSelectLayoutValue={handleWorkspaceLayoutSelectionChange}
            onToggleProjectsSidebar={
              () => setProjectsSidebarOpen((current) => !current)
            }
            preprocessingStatus={formattedPreprocessingStatus}
            projectsSidebarOpen={projectsSidebarOpen}
            selectedLayoutValue={selectedLayoutValue}
            workingSetSummary={workingSetSummary}
            workspaceName={workspaceName}
            workspaceRootDir={effectiveSnapshot.rootDir}
          />
          <div className="cbv-main-layout">
            <DockWorkspace
              center={
                <CanvasViewport
                agentFocusActive={agentFocusActive}
                agentFocusEmptyText={agentFocusEmptyText}
                agentFocusSummaryText={agentFocusSummaryText}
                agentHeatHelperText={agentHeatHelperText}
                agentHeatFollowEnabled={followActiveAgent}
                agentHeatFollowText={agentHeatFollowText}
                agentHeatDebugOpen={followDebugOpen}
                agentHeatDebugState={followDebugState}
                agentHeatMode={telemetryMode}
                agentHeatSource={telemetrySource}
                agentHeatWindow={telemetryWindow}
                compareOverlayActive={compareOverlayActive}
                compareSourceTitle={currentCompareSource?.title ?? null}
                denseCanvasMode={denseCanvasMode}
                edges={edges}
                graphLayers={graphLayers}
                nodes={nodes}
                onEdgeClick={handleCanvasEdgeClick}
                onEdgesChange={onEdgesChange}
                onInit={setFlowInstance}
                onAgentHeatModeChange={handleTelemetryModeChange}
                onOpenAgentEventFeed={handleOpenAgentEventFeed}
                onAgentHeatSourceChange={handleTelemetrySourceChange}
                onToggleAgentHeatDebug={handleToggleFollowDebug}
                onToggleAgentHeatFollow={handleToggleFollowActiveAgent}
                onAgentHeatWindowChange={handleTelemetryWindowChange}
                onActivateCompareOverlay={
                  currentCompareSource ? handleActivateCompareOverlay : undefined
                }
                onClearCompareOverlay={compareOverlayActive ? handleClearCompareOverlay : undefined}
                onMoveEnd={handleCanvasMoveEnd}
                onNodeClick={handleCanvasNodeClick}
                onNodeDoubleClick={handleCanvasNodeDoubleClick}
                onNodeDrag={handleCanvasNodeDrag}
                onNodeDragStop={handleCanvasNodeDragStop}
                onNodesChange={onNodesChange}
                onSemanticSearchChange={setSemanticSearchQuery}
                onSemanticSearchClear={clearSemanticSearch}
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
                showCompareAction={Boolean(currentCompareSource)}
                showSemanticSearch={viewMode === 'symbols' && semanticSearchAvailable}
                themeMode={themeMode}
                utilitySummaryText={agentFocusActive ? agentFocusSummaryText : agentHeatSummaryText}
                viewMode={viewMode}
                  viewport={viewport}
                  visibleLayerToggles={visibleLayerToggles}
                />
              }
              dockLayout={dockLayout}
              dockPreview={dockPreview}
              onPanelMovePointerDown={handlePanelMovePointerDown}
              onSlotActivePanelChange={setSlotActivePanel}
              onSlotHandlePointerDown={handleSlotHandlePointerDown}
              renderPanel={renderDockPanel}
              workspaceRef={dockWorkspaceRef}
              workspaceStyle={dockWorkspaceStyle}
            />
          </div>
          {!agentDrawerOpen ? (
            <AgentCollapsedLauncher
              active={Boolean(activeAgentRun)}
              onOpen={handleOpenAgentLauncher}
              onPromptSeed={handleAgentPromptSeed}
              trailLabel={agentStripTrailLabel}
            />
          ) : null}
        {settingsOpen ? (
          <div
            className="cbv-modal-backdrop"
            onClick={() => setSettingsOpen(false)}
            role="presentation"
          >
            <section
              aria-label="General settings"
              className="cbv-modal cbv-settings-modal"
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
      </section>
      </div>
      </ReactFlowProvider>
    </SemanticodeErrorBoundary>
  )
}


function getAgentSessionStartedAtMs(session: AgentSessionSummary) {
  const createdAtMs = Date.parse(session.createdAt)

  return Number.isFinite(createdAtMs) ? createdAtMs : null
}

function filterAgentFileOperationsForTelemetryWindow(input: {
  activeSessionId: string | null
  operations: AgentFileOperation[]
  sessionStartMs: number | null
  telemetryWindow: TelemetryWindow
}) {
  if (input.telemetryWindow !== 'session') {
    return input.operations
  }

  if (!input.activeSessionId) {
    return EMPTY_AGENT_FILE_OPERATIONS
  }

  const filteredOperations = input.operations.filter((operation) => {
    if (operation.sessionId !== input.activeSessionId) {
      return false
    }

    if (input.sessionStartMs === null) {
      return true
    }

    const timestampMs = Date.parse(operation.timestamp)

    return !Number.isFinite(timestampMs) || timestampMs >= input.sessionStartMs
  })

  return filteredOperations.length === input.operations.length
    ? input.operations
    : filteredOperations
}

function buildSessionTouchedPathSet(input: {
  fileOperations: AgentFileOperation[]
  telemetryActivityEvents: TelemetryActivityEvent[]
  telemetryWindow: TelemetryWindow
}) {
  if (input.telemetryWindow !== 'session') {
    return null
  }

  const pathSet = new Set<string>()

  for (const operation of input.fileOperations) {
    for (const path of getAgentFileOperationPaths(operation)) {
      pathSet.add(path)
    }
  }

  for (const event of input.telemetryActivityEvents) {
    if (event.path) {
      pathSet.add(event.path)
    }
  }

  return pathSet
}

function filterDirtyFileSignalsForTelemetryWindow(input: {
  dirtyFileEditSignals: DirtyFileEditSignal[]
  sessionStartMs: number | null
  sessionTouchedPathSet: Set<string> | null
  telemetryWindow: TelemetryWindow
}) {
  if (input.telemetryWindow !== 'session') {
    return input.dirtyFileEditSignals
  }

  return input.dirtyFileEditSignals.filter((signal) => {
    if (input.sessionStartMs !== null && signal.changedAtMs < input.sessionStartMs) {
      return false
    }

    return input.sessionTouchedPathSet
      ? input.sessionTouchedPathSet.has(signal.path)
      : false
  })
}

function getAgentFileOperationPaths(operation: AgentFileOperation) {
  return operation.paths.length > 0
    ? operation.paths
    : operation.path
      ? [operation.path]
      : []
}

function InspectorFallback({
  dockMoveHandle = null,
  header,
  onClose,
}: {
  dockMoveHandle?: ReactNode
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
        <div className="cbv-panel-header-actions">
          {dockMoveHandle}
          <button
            aria-label="Close inspector"
            className="cbv-inspector-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
      </div>
      <div className="cbv-inspector-body cbv-inspector-body--loading">
        <div aria-live="polite" className="cbv-inspector-loading" role="status">
          <span aria-hidden="true" className="cbv-inspector-loading-dot" />
          <div className="cbv-inspector-loading-copy">
            <p className="cbv-eyebrow">code view</p>
            <strong>loading selection</strong>
            <span>preparing code and agent context</span>
          </div>
        </div>
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

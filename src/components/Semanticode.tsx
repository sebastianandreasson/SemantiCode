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
} from 'react'

import {
  isSymbolNode,
  type CodebaseSnapshot,
  type PreprocessedWorkspaceContext,
  type PreprocessingStatus,
  type WorkspaceProfile,
  type WorkspaceArtifactSyncStatus,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { AgentDrawer } from './agent/AgentDrawer'
import { CanvasViewport } from './canvas/CanvasViewport'
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
import { useAgentFollowController } from '../app/useAgentFollowController'
import { useAgentFileOperations } from '../app/useAgentFileOperations'
import { useAutonomousRunsController } from '../app/useAutonomousRunsController'
import { useCanvasGraphController } from '../app/useCanvasGraphController'
import { useFollowAgentExecutors } from '../app/useFollowAgentExecutors'
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
  const followFileOperations = useMemo(() => {
    const autonomousFileOperations =
      selectedRunDetail?.runId === activeRunId
        ? selectedRunDetail.fileOperations
        : []

    return [
      ...agentFileOperations,
      ...autonomousFileOperations,
    ]
  }, [activeRunId, agentFileOperations, selectedRunDetail])

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
    dirtyFileEditSignals: followDirtyFileSignals,
    enabled: followActiveAgent,
    fileOperations: followFileOperations,
    liveChangedFiles,
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
  const agentHeatSummaryText = useMemo(() => {
    if (!telemetryEnabled) {
      return 'heat off'
    }

    if (telemetryError) {
      return 'telemetry error'
    }

    if (!telemetryOverview) {
      return 'loading activity'
    }

    if (telemetryOverview.requestCount === 0) {
      return telemetryWindow === 'run' ? '0 req · run' : '0 req'
    }

    const requestText = `${telemetryOverview.requestCount} req`
    const tokenText = `${Math.round(telemetryOverview.totalTokens)} tok`
    const runText =
      telemetryOverview.activeRuns.length > 0
        ? ` · ${telemetryOverview.activeRuns.length} run${telemetryOverview.activeRuns.length === 1 ? '' : 's'}`
        : ''

    return `${requestText} · ${tokenText}${runText}`
  }, [telemetryEnabled, telemetryError, telemetryOverview, telemetryWindow])
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

  const handleToggleFollowDebug = useCallback(() => {
    setFollowDebugOpen((current) => !current)
  }, [])
  const handleToggleFollowActiveAgent = useCallback(() => {
    enableTelemetry()
    setFollowActiveAgent((current) => !current)
  }, [enableTelemetry])
  const { followedEditDiffRequestKey } = useFollowAgentExecutors({
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
    selectFileNode: selectNode,
    setInspectorOpen,
    setInspectorTabToFile,
    setRefreshStatus,
    telemetryMode,
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
            onSelectLayoutValue={handleLayoutSelectionChange}
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
            <WorkspaceSidebar
              canManageProjects={canManageProjects}
              currentRootDir={effectiveSnapshot.rootDir}
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
              workspaceActionError={workspaceActionError}
              workspaceActionPending={workspaceActionPending}
            />

            <div
              className={`cbv-workspace${inspectorOpen ? '' : ' is-inspector-closed'}`}
              ref={workspaceRef}
              style={workspaceStyle}
            >
              <CanvasViewport
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
                  utilitySummaryText={agentHeatSummaryText}
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
                    detectedPlugins={effectiveSnapshot?.detectedPlugins ?? []}
                    facetDefinitions={effectiveSnapshot?.facetDefinitions ?? []}
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
              ) : null}
            </div>
          </div>
          <AgentDrawer
            activeRunId={activeRunId}
            activeTab={agentDrawerTab}
            autonomousRuns={autonomousRuns}
            composerFocusRequestKey={agentComposerFocusRequestKey}
            desktopHostAvailable={isDesktopHost}
            detectedTaskFile={detectedTaskFile}
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
            onChangeTab={setAgentDrawerTab}
            onClearWorkingSet={clearWorkingSet}
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
            onToggleOpen={() => setAgentDrawerOpen((current) => !current)}
            open={agentDrawerOpen}
            pendingRunAction={runActionPending}
            preprocessedWorkspaceContext={preprocessedWorkspaceContext}
            selectedRunDetail={selectedRunDetail}
            selectedRunId={selectedRunId}
            timeline={selectedRunTimeline}
            trailLabel={agentStripTrailLabel}
            workingSet={workingSet.nodeIds.length > 0 ? workingSet : null}
            workingSetContext={workingSetContext}
            workspaceProfile={workspaceProfile}
          />
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

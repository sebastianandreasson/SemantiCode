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
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
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
  type VisualizerViewMode,
  type WorkspaceProfile,
  type WorkspaceArtifactSyncStatus,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { buildStructuralLayout } from '../layouts/structuralLayout'
import { buildSymbolLayout } from '../layouts/symbolLayout'
import { buildSemanticLayout } from '../semantic/semanticLayout'
import { CodebaseAnnotationNode } from './CodebaseAnnotationNode'
import { CodebaseCanvasNode } from './CodebaseCanvasNode'
import { CodebaseSymbolNode } from './CodebaseSymbolNode'
import { getInspectorHeaderSummary } from './inspector/inspectorUtils'
import { ProjectsSidebar } from './shell/ProjectsSidebar'
import { WorkspaceSyncModal } from './shell/WorkspaceSyncModal'
import { WorkspaceToolbar } from './shell/WorkspaceToolbar'
import {
  canCompareLayoutAgainstSemantic,
  resolveCanvasScene,
  resolveLayoutCompareOverlay,
} from '../visualizer/canvasScene'

const LazyInspectorPane = lazy(async () => {
  const module = await import('./inspector/InspectorPane')
  return { default: module.InspectorPane }
})

const LazyAgentPanel = lazy(async () => {
  const module = await import('./AgentPanel')
  return { default: module.AgentPanel }
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

interface DesktopBridge {
  closeWorkspace?: () => Promise<boolean>
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
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [workspaceSyncOpen, setWorkspaceSyncOpen] = useState(false)
  const [projectsSidebarOpen, setProjectsSidebarOpen] = useState(true)
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const [layoutSuggestionText, setLayoutSuggestionText] = useState('')
  const [canvasWidthRatio, setCanvasWidthRatio] = useState(DEFAULT_CANVAS_WIDTH_RATIO)
  const [activeResizePointerId, setActiveResizePointerId] = useState<number | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [recentProjects, setRecentProjects] = useState<
    {
      name: string
      rootDir: string
      lastOpenedAt: string
    }[]
  >([])
  const [workspaceActionPending, setWorkspaceActionPending] = useState(false)
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null)
  const [desktopHostAvailable, setDesktopHostAvailable] = useState(false)
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
  const setBaseScene = useVisualizerStore((state) => state.setBaseScene)
  const setCompareOverlay = useVisualizerStore((state) => state.setCompareOverlay)
  const clearCompareOverlay = useVisualizerStore((state) => state.clearCompareOverlay)
  const setOverlayVisibility = useVisualizerStore((state) => state.setOverlayVisibility)
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
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const desktopBridge = (
    globalThis as typeof globalThis & {
      semanticodeDesktop?: DesktopBridge
    }
  ).semanticodeDesktop
  const isDesktopHost = desktopHostAvailable

  useEffect(() => {
    const updateDesktopHostAvailability = () => {
      const bridge = (
        globalThis as typeof globalThis & {
          semanticodeDesktop?: DesktopBridge
        }
      ).semanticodeDesktop

      setDesktopHostAvailable(Boolean(bridge?.isDesktop))
    }

    updateDesktopHostAvailability()
    const timeoutId = window.setTimeout(updateDesktopHostAvailability, 0)
    const intervalId = window.setInterval(updateDesktopHostAvailability, 750)

    return () => {
      window.clearTimeout(timeoutId)
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (!desktopHostAvailable || !desktopBridge?.getWorkspaceHistory) {
      return
    }

    let cancelled = false

    void desktopBridge.getWorkspaceHistory().then((history) => {
      if (cancelled) {
        return
      }

      setRecentProjects(history.recentWorkspaces)
    }).catch(() => {
      if (cancelled) {
        return
      }

      setRecentProjects([])
    })

    return () => {
      cancelled = true
    }
  }, [desktopBridge, desktopHostAvailable])

  useEffect(() => {
    if (snapshot === undefined) {
      return
    }

    setSnapshot(snapshot)
  }, [setSnapshot, snapshot])

  const effectiveSnapshot = snapshot ?? currentSnapshot

  useEffect(() => {
    if (!effectiveSnapshot) {
      setDraftLayouts([])
      setLayouts([])
      setActiveDraftId(null)
      setActiveLayoutId(null)
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

    if (!activeLayoutId && !activeDraftId) {
      setActiveLayoutId(
        viewMode === 'symbols' ? symbolLayout.id : structuralLayout.id,
      )
    }
  }, [
    activeDraftId,
    activeLayoutId,
    effectiveSnapshot,
    layouts,
    setActiveDraftId,
    setActiveLayoutId,
    setDraftLayouts,
    setLayouts,
    viewMode,
    preprocessedWorkspaceContext,
  ])

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
    )
  }, [
    expandedClusterLayouts,
    effectiveSnapshot,
    expandedClusterIds,
    graphLayers,
    resolvedScene,
    symbolClusterState,
    viewMode,
  ])

  useEffect(() => {
    if (!baseFlowModel) {
      setNodes([])
      setEdges([])
      return
    }

    const compareOverlayState = {
      active: compareOverlayActive,
      nodeIds: overlayNodeIdSet,
    }

    setNodes(
      applyFlowNodePresentation(baseFlowModel.nodes, selectedNodeIdSet, compareOverlayState),
    )
    setEdges(applyFlowEdgePresentation(baseFlowModel.edges, compareOverlayState))
  }, [
    baseFlowModel,
    compareOverlayActive,
    overlayNodeIdSet,
    selectedNodeIdSet,
    setEdges,
    setNodes,
  ])

  useEffect(() => {
    if (!baseFlowModel) {
      return
    }

    const compareOverlayState = {
      active: compareOverlayActive,
      nodeIds: overlayNodeIdSet,
    }

    setNodes((currentNodes) =>
      applyFlowNodePresentation(currentNodes, selectedNodeIdSet, compareOverlayState),
    )
    setEdges((currentEdges) =>
      applyFlowEdgePresentation(currentEdges, compareOverlayState),
    )
  }, [
    baseFlowModel,
    compareOverlayActive,
    overlayNodeIdSet,
    selectedNodeIdSet,
    setEdges,
    setNodes,
  ])

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
    selectedNodeId && effectiveSnapshot ? effectiveSnapshot.nodes[selectedNodeId] : null
  const selectedSymbol = selectedNode && isSymbolNode(selectedNode) ? selectedNode : null
  const selectedSymbols = getSelectedSymbols(effectiveSnapshot, selectedNodeIds)
  const selectedFile = getSelectedFile(effectiveSnapshot, selectedNode, files)
  const selectedFiles = getSelectedFiles(effectiveSnapshot, selectedNodeIds)
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
    selectedNode,
    selectedSymbols,
  })
  const workspaceName = effectiveSnapshot
    ? getWorkspaceName(effectiveSnapshot.rootDir)
    : 'Workspace'
  const formattedPreprocessingStatus = preprocessingStatus
      ? {
        canBuildEmbeddings: preprocessingStatus.purposeSummaryCount > 0,
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
  const visibleLayerToggles = getLayerTogglesForViewMode(viewMode)
  const inspectorWidthRatio = 1 - canvasWidthRatio

  useEffect(() => {
    if (selectedNodeIds.length > 0 || selectedEdgeId) {
      setInspectorOpen(true)
    }
  }, [selectedEdgeId, selectedNodeIds])

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
        maxZoom: 1.4,
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

  return (
    <ReactFlowProvider>
      <div
        className={`cbv-app-shell${desktopHostAvailable ? ' is-desktop-host' : ''}${projectsSidebarOpen ? ' is-projects-open' : ''}`}
      >
        <ProjectsSidebar
          currentRootDir={effectiveSnapshot.rootDir}
          desktopHostAvailable={desktopHostAvailable}
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
            isDesktopHost={isDesktopHost}
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
            onOpenAgentSettings={() => setAgentSettingsOpen(true)}
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
              isDesktopHost
                ? () => setProjectsSidebarOpen((current) => !current)
                : undefined
            }
            preprocessingStatus={formattedPreprocessingStatus}
            projectsSidebarOpen={projectsSidebarOpen}
            selectedLayoutValue={selectedLayoutValue}
            showCompareAction={Boolean(currentCompareSource)}
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
	          <section className="cbv-canvas">
	            <div className="cbv-canvas-overlays">
                <div className="cbv-canvas-layer-toggles">
	              {visibleLayerToggles.map((layer) => (
	                <LayerToggle
	                  active={graphLayers[layer]}
	                  key={layer}
	                  label={getLayerLabel(layer, viewMode)}
	                  onClick={() => toggleGraphLayer(layer)}
	                />
	              ))}
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
              minZoom={0.2}
              nodeTypes={nodeTypes}
              nodes={nodes}
              onlyRenderVisibleElements
              onInit={setFlowInstance}
              onEdgeClick={(_, edge) => {
                selectEdge(edge.id)
                setInspectorOpen(true)
              }}
              onEdgesChange={onEdgesChange}
              onMoveEnd={(_, flowViewport) => {
                setViewport(flowViewport)
              }}
              onNodeClick={(event, node) => {
                if (isAnnotationNodeId(node.id)) {
                  return
                }

                selectNode(node.id, {
                  additive: event.metaKey || event.ctrlKey || event.shiftKey,
                })
                setInspectorOpen(true)
              }}
              onNodeDoubleClick={(_, node) => {
                const cluster = symbolClusterState.clusterByNodeId[node.id]

                if (cluster && cluster.rootNodeId === node.id) {
                  toggleSymbolCluster(cluster.id)
                }
              }}
              onNodeDragStop={(_, node) => {
                updateLayoutPlacement(
                  node.id,
                  node.position,
                  editableLayout,
                  editableDraftLayout,
                  layouts,
                  draftLayouts,
                  setLayouts,
                  setDraftLayouts,
                )
              }}
              onNodesChange={onNodesChange}
            >
              <Background
                color="#d8d1c3"
                gap={24}
                size={1}
                variant={BackgroundVariant.Dots}
              />
              <Controls showInteractive={false} />
              {denseCanvasMode ? null : (
                <MiniMap
                  className="cbv-minimap"
                  maskColor="rgba(44, 35, 27, 0.16)"
                  pannable
                  zoomable
                />
              )}
            </ReactFlow>

            {onSuggestLayout ? (
              <form
                className={`cbv-layout-suggestion${layoutSuggestionPending ? ' is-pending' : ''}`}
                onSubmit={(event) => {
                  event.preventDefault()

                  if (!onSuggestLayout || layoutSuggestionPending) {
                    return
                  }

                  void onSuggestLayout(layoutSuggestionText)
                }}
              >
                <div className="cbv-layout-suggestion-shell">
                  <input
                    aria-label="Suggest layout"
                    className="cbv-layout-suggestion-input"
                    disabled={layoutSuggestionPending}
                    onChange={(event) => {
                      setLayoutSuggestionText(event.target.value)
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
                  <p className="cbv-layout-suggestion-status">
                    Generating a new layout draft…
                  </p>
                ) : layoutSuggestionError ? (
                  <p className="cbv-layout-suggestion-error">{layoutSuggestionError}</p>
                ) : null}
              </form>
            ) : null}
          </section>

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
                onClearCompareOverlay={handleClearCompareOverlay}
                onClose={() => setInspectorOpen(false)}
                onOpenAgentSettings={() => setAgentSettingsOpen(true)}
                onSetInspectorTab={setInspectorTab}
                preprocessedWorkspaceContext={preprocessedWorkspaceContext}
                resolvedCompareOverlay={resolvedCompareOverlay}
                selectedEdge={selectedEdge}
                selectedFile={selectedFile}
                selectedFiles={selectedFiles}
                selectedNode={selectedNode}
                selectedSymbol={selectedSymbol}
                selectedSymbols={selectedSymbols}
                workspaceProfile={workspaceProfile}
              />
            </Suspense>
          ) : null}
        </div>
        {agentSettingsOpen ? (
          <div
            className="cbv-modal-backdrop"
            onClick={() => setAgentSettingsOpen(false)}
            role="presentation"
          >
            <section
              aria-label="Agent settings"
              className="cbv-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="cbv-modal-header">
                <div>
                  <p className="cbv-eyebrow">Settings</p>
                  <strong>Agent Settings</strong>
                </div>
                <button
                  aria-label="Close agent settings"
                  className="cbv-inspector-close"
                  onClick={() => setAgentSettingsOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              <Suspense fallback={<AgentSettingsFallback />}>
                <LazyAgentPanel
                  desktopHostAvailable={isDesktopHost}
                  preprocessedWorkspaceContext={preprocessedWorkspaceContext}
                  settingsOnly
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
      <div className="cbv-empty">
        <h2>Loading inspector…</h2>
        <p>Preparing the code and agent tools for this selection.</p>
      </div>
    </aside>
  )
}

function AgentSettingsFallback() {
  return (
    <div className="cbv-empty">
      <h2>Loading agent settings…</h2>
      <p>Preparing the agent configuration panel.</p>
    </div>
  )
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

function buildFlowModel(
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec,
  graphLayers: Record<GraphLayerKey, boolean>,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
) {
  const hiddenNodeIds = new Set(layout.hiddenNodeIds)
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

      return node.kind !== 'symbol'
    })
    .map((node) =>
      buildFlowNode(
        node,
        layout.placements[node.id],
        snapshot,
        viewMode,
        symbolClusterState,
        expandedClusterIds,
        expandedClusterLayouts,
      ),
    )
  const nodes = [...annotationNodes, ...codeNodes]
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
) {
  let changed = false
  const nextNodes = nodes.map((node) => {
    const highlighted = compareOverlayState.nodeIds.has(node.id)
    const dimmed = compareOverlayState.active && !highlighted
    const selected = selectedNodeIds.has(node.id)
    const data =
      node.data && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : null
    const currentHighlighted = Boolean(data?.highlighted)
    const currentDimmed = Boolean(data?.dimmed)

    if (
      node.selected === selected &&
      currentHighlighted === highlighted &&
      currentDimmed === dimmed
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

function buildFlowNode(
  node: ProjectNode,
  placement: LayoutSpec['placements'][string],
  snapshot: CodebaseSnapshot,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
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

  return {
    id: node.id,
    type: 'codebaseNode',
    position: {
      x: placement.x,
      y: placement.y,
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    width: placement.width,
    height: placement.height,
    draggable: true,
    data: {
      title: node.name,
      subtitle: getNodeSubtitle(node),
      kind: node.kind,
      tags: node.tags.slice(0, 3),
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

  if (activeDraft?.layout) {
    const nextDraftLayouts = draftLayouts.map((draft) => {
      if (draft.id !== activeDraft.id || !draft.layout) {
        return draft
      }

      const currentPlacement = draft.layout.placements[nodeId]

      if (!currentPlacement) {
        return draft
      }

      return {
        ...draft,
        layout: {
          ...draft.layout,
          placements: {
            ...draft.layout.placements,
            [nodeId]: {
              ...currentPlacement,
              x: position.x,
              y: position.y,
            },
          },
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

    return {
      ...layout,
      placements: {
        ...layout.placements,
        [nodeId]: {
          ...currentPlacement,
          x: position.x,
          y: position.y,
        },
      },
      updatedAt: new Date().toISOString(),
    }
  })

  setLayouts(nextLayouts)
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

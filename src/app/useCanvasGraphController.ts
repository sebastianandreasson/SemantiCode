import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react'

import {
  isDirectoryNode,
  isFileNode,
  isSymbolNode,
  type AgentTouchedSymbolRecord,
  type AgentHeatSample,
  type CodebaseSnapshot,
  type GraphLayerVisibility,
  type LayoutDraft,
  type LayoutSpec,
  type ProjectNode,
  type TelemetryMode,
  type TelemetryWindow,
  type ViewportState,
  type VisualizerViewMode,
} from '../types'
import { getPreferredFollowSymbolIdsForFile } from './follow'
import { SEMANTIC_LAYOUT_FOOTPRINT_ZOOM } from '../semantic/semanticLayout'
import type {
  ResolvedCanvasOverlay,
  ResolvedCanvasScene,
} from '../visualizer/canvasScene'
import {
  applyDirectChildDragPreviewOffset,
  applyFlowEdgePresentation,
  applyFlowNodePresentation,
  buildExpandedClusterLayouts,
  buildFilesystemContainerLayouts,
  buildFlowModel,
  buildLayoutGroupContainerIndex,
  countVisibleLayoutNodes,
  createSymbolFootprintLookup,
  deriveSymbolClusterState,
  getFollowTargetZoom,
  isAnnotationNodeId,
  updateLayoutPlacement,
  type FlowModel,
  type FlowSymbolRuntimeMetadata,
} from '../visualizer/flowModel'

const FLOW_MODEL_VIEWPORT_ZOOM_BUCKETS = [
  [0.04, 0.035],
  [0.065, 0.055],
  [0.1, 0.085],
  [0.16, 0.13],
  [0.25, 0.2],
  [0.4, 0.32],
  [0.65, 0.52],
  [0.95, 0.8],
  [1.35, 1.1],
  [2, 1.65],
  [3, 2.45],
] as const

export interface UseCanvasGraphControllerInput {
  agentFocusSymbolsByNodeId: Map<string, AgentTouchedSymbolRecord>
  collapsedDirectoryIds: string[]
  compareOverlayActive: boolean
  draftLayouts: LayoutDraft[]
  editableDraftLayout: LayoutDraft | null
  editableLayout: LayoutSpec | null
  expandedSymbolClusterIds: string[]
  graphLayers: GraphLayerVisibility
  highlightedNodeIdSet: Set<string>
  overlayNodeIdSet: Set<string>
  resolvedCompareOverlay: ResolvedCanvasOverlay | null
  resolvedScene: ResolvedCanvasScene | null
  selectedNodeIds: string[]
  semanticSearchHighlightActive: boolean
  setDraftLayouts: (draftLayouts: LayoutDraft[]) => void
  setInspectorOpen: (open: boolean) => void
  setLayouts: (layouts: LayoutSpec[]) => void
  setViewport: (viewport: Partial<ViewportState>) => void
  snapshot: CodebaseSnapshot | null | undefined
  telemetryHeatSamples: AgentHeatSample[]
  telemetryMode: TelemetryMode
  telemetryObservedAt: number
  telemetryWindow: TelemetryWindow
  toggleCollapsedDirectory: (nodeId: string) => void
  toggleSymbolCluster: (clusterId: string) => void
  selectEdge: (edgeId: string | null) => void
  selectNode: (nodeId: string | null, options?: { additive?: boolean }) => void
  viewMode: VisualizerViewMode
  viewport: ViewportState
  layouts: LayoutSpec[]
}

export function useCanvasGraphController({
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
  snapshot,
  telemetryHeatSamples,
  telemetryMode,
  telemetryObservedAt,
  telemetryWindow,
  toggleCollapsedDirectory,
  toggleSymbolCluster,
  viewMode,
  viewport,
}: UseCanvasGraphControllerInput) {
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [followRevealState, setFollowRevealState] = useState<{
    key: string
    nodeIds: string[]
  }>({ key: '', nodeIds: [] })
  const containerDragPreviewPositionsRef = useRef(new Map<string, XYPosition>())
  const lastFittedCompareKeyRef = useRef<string | null>(null)
  const lastFittedAgentFocusKeyRef = useRef<string | null>(null)
  const snapshotOrNull = snapshot ?? null
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const followRevealKey = [
    resolvedScene?.layoutSpec.id ?? 'no-layout',
    snapshotOrNull?.generatedAt ?? 'no-snapshot',
    viewMode,
  ].join('::')
  const followRevealedNodeIds = useMemo(
    () => followRevealState.key === followRevealKey ? followRevealState.nodeIds : [],
    [followRevealKey, followRevealState.key, followRevealState.nodeIds],
  )
  const followVisibleLayout = useMemo(
    () => createFollowVisibleLayout(
      resolvedScene?.layoutSpec ?? null,
      followRevealedNodeIds,
    ),
    [followRevealedNodeIds, resolvedScene],
  )

  const symbolClusterState = useMemo(
    () =>
      deriveSymbolClusterState(
        snapshotOrNull,
        followVisibleLayout,
        viewMode,
      ),
    [followVisibleLayout, snapshotOrNull, viewMode],
  )
  const expandedClusterIds = useMemo(
    () => new Set(expandedSymbolClusterIds),
    [expandedSymbolClusterIds],
  )
  const collapsedDirectoryIdSet = useMemo(
    () => new Set(collapsedDirectoryIds),
    [collapsedDirectoryIds],
  )
  const modelViewportZoom = useMemo(
    () => getFlowModelViewportZoomBucket(viewport.zoom),
    [viewport.zoom],
  )
  const symbolFootprintViewportZoom = useMemo(
    () =>
      followVisibleLayout?.strategy === 'semantic'
        ? Math.max(modelViewportZoom, SEMANTIC_LAYOUT_FOOTPRINT_ZOOM)
        : modelViewportZoom,
    [followVisibleLayout, modelViewportZoom],
  )
  const symbolFootprints = useMemo(
    () =>
      snapshotOrNull && followVisibleLayout
        ? createSymbolFootprintLookup({
            layout: followVisibleLayout,
            snapshot: snapshotOrNull,
            viewportZoom: symbolFootprintViewportZoom,
          })
        : null,
    [followVisibleLayout, snapshotOrNull, symbolFootprintViewportZoom],
  )
  const expandedClusterLayouts = useMemo(
    () =>
      buildExpandedClusterLayouts(
        snapshotOrNull,
        followVisibleLayout,
        symbolClusterState,
        expandedClusterIds,
        symbolFootprints ?? undefined,
      ),
    [expandedClusterIds, followVisibleLayout, snapshotOrNull, symbolClusterState, symbolFootprints],
  )
  const filesystemContainerLayouts = useMemo(
    () =>
      buildFilesystemContainerLayouts(
        snapshotOrNull,
        followVisibleLayout,
        viewMode,
        collapsedDirectoryIdSet,
      ),
    [collapsedDirectoryIdSet, followVisibleLayout, snapshotOrNull, viewMode],
  )
  const layoutGroupContainerIndex = useMemo(
    () =>
      buildLayoutGroupContainerIndex(
        snapshotOrNull,
        followVisibleLayout,
        viewMode,
        {
          expandedClusterIds,
          expandedClusterLayouts,
          symbolClusterState,
          symbolFootprints: symbolFootprints ?? undefined,
          viewportZoom: modelViewportZoom,
        },
      ),
    [
      expandedClusterIds,
      expandedClusterLayouts,
      followVisibleLayout,
      modelViewportZoom,
      snapshotOrNull,
      symbolClusterState,
      symbolFootprints,
      viewMode,
    ],
  )

  const baseFlowModel = useMemo<FlowModel | null>(() => {
    if (!snapshotOrNull || !followVisibleLayout) {
      return null
    }

    return buildFlowModel(
      snapshotOrNull,
      followVisibleLayout,
      graphLayers,
      viewMode,
      symbolClusterState,
      expandedClusterIds,
      expandedClusterLayouts,
      filesystemContainerLayouts,
      layoutGroupContainerIndex,
      collapsedDirectoryIdSet,
      toggleCollapsedDirectory,
      {
        selectedNodeIds: selectedNodeIdSet,
        symbolRuntimeMetadataByNodeId: buildSymbolRuntimeMetadata(agentFocusSymbolsByNodeId),
        symbolFootprints: symbolFootprints ?? undefined,
        viewportZoom: modelViewportZoom,
      },
    )
  }, [
    collapsedDirectoryIdSet,
    agentFocusSymbolsByNodeId,
    expandedClusterIds,
    expandedClusterLayouts,
    filesystemContainerLayouts,
    followVisibleLayout,
    graphLayers,
    layoutGroupContainerIndex,
    selectedNodeIdSet,
    snapshotOrNull,
    symbolFootprints,
    symbolClusterState,
    toggleCollapsedDirectory,
    viewMode,
    modelViewportZoom,
  ])
  const telemetryHeatByNodeId = useMemo(() => {
    const recentCutoff = telemetryObservedAt - 10_000
    const activeWindowCutoff =
      typeof telemetryWindow === 'number'
        ? telemetryObservedAt - (telemetryWindow * 1000)
        : Number.NEGATIVE_INFINITY
    const nextMap = new Map<string, { pulse: boolean; weight: number }>()
    const fileIdsByPath = new Map<string, string>()
    const symbolIdsByFileId = new Map<string, string[]>()

    if (snapshotOrNull) {
      for (const node of Object.values(snapshotOrNull.nodes)) {
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
      const sampleTimestamp = new Date(sample.lastSeenAt).getTime()

      if (!Number.isFinite(sampleTimestamp) || sampleTimestamp < activeWindowCutoff) {
        continue
      }

      const pulse = sampleTimestamp >= recentCutoff
      const fileNodeId = fileIdsByPath.get(sample.path)

      if (!fileNodeId) {
        continue
      }

      const targetNodeIds =
        telemetryMode === 'symbols' && snapshotOrNull
          ? getPreferredFollowSymbolIdsForFile({
              fileId: fileNodeId,
              snapshot: snapshotOrNull,
              symbolIdsByFileId,
            })
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
  }, [
    snapshotOrNull,
    telemetryHeatSamples,
    telemetryMode,
    telemetryObservedAt,
    telemetryWindow,
  ])
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
      if (nodes.length > 0) {
        setNodes([])
      }

      if (edges.length > 0) {
        setEdges([])
      }
      return
    }

    if (!areFlowNodesEquivalent(nodes, presentedFlowModel.nodes)) {
      setNodes(presentedFlowModel.nodes)
    }

    if (!areFlowEdgesEquivalent(edges, presentedFlowModel.edges)) {
      setEdges(presentedFlowModel.edges)
    }
  }, [edges, nodes, presentedFlowModel, setEdges, setNodes])

  const visibleNodeCount = useMemo(
    () =>
      snapshotOrNull && followVisibleLayout
        ? countVisibleLayoutNodes(
            snapshotOrNull,
            followVisibleLayout,
            viewMode,
            symbolClusterState,
            expandedClusterIds,
          )
        : 0,
    [expandedClusterIds, followVisibleLayout, snapshotOrNull, symbolClusterState, viewMode],
  )
  const denseCanvasMode = viewMode === 'symbols' && visibleNodeCount > 250

  const focusCanvasOnFollowTarget = useCallback(async (input: {
    fileNodeId: string
    isEdit: boolean
    mode: TelemetryMode
    nodeIds: string[]
  }) => {
    if (!flowInstance || !snapshotOrNull) {
      return
    }

    const primaryNodeId =
      input.mode === 'symbols'
        ? input.nodeIds[0] ?? input.fileNodeId
        : input.fileNodeId
    const targetNodeIds =
      input.nodeIds.length > 0 ? input.nodeIds : [input.fileNodeId]
    const primaryNode =
      snapshotOrNull.nodes[primaryNodeId] ??
      snapshotOrNull.nodes[input.fileNodeId] ??
      null
    const desiredZoom = getFollowTargetZoom({
      isEdit: input.isEdit,
      mode: input.mode,
      node: primaryNode,
    })
    const collapsedAncestorIds = getCollapsedFilesystemAncestorIds(
      input.fileNodeId,
      snapshotOrNull,
      collapsedDirectoryIdSet,
    )
    const revealedHiddenSymbolIds =
      input.mode === 'symbols'
        ? getHiddenFollowSymbolIds(followVisibleLayout, targetNodeIds)
        : []

    if (revealedHiddenSymbolIds.length > 0) {
      setFollowRevealState((currentState) => ({
        key: followRevealKey,
        nodeIds:
          currentState.key === followRevealKey
            ? mergeUniqueIds(currentState.nodeIds, revealedHiddenSymbolIds)
            : revealedHiddenSymbolIds,
      }))
    }

    const followClusterLayout =
      input.mode === 'symbols' && followVisibleLayout
        ? createFollowVisibleLayout(followVisibleLayout, targetNodeIds)
        : null
    const followSymbolClusterState =
      followClusterLayout
        ? deriveSymbolClusterState(snapshotOrNull, followClusterLayout, viewMode)
        : symbolClusterState
    const expandedFollowClusterIds =
      input.mode === 'symbols'
        ? expandFollowSymbolClusters({
            expandedClusterIds,
            nodeIds: targetNodeIds,
            symbolClusterState: followSymbolClusterState,
            toggleSymbolCluster,
          })
        : []
    const focusTarget = () =>
      focusFlowOnNode({
        duration: input.isEdit ? 260 : 220,
        flowInstance,
        maxZoom: desiredZoom,
        nodes: flowInstance.getNodes(),
        padding: input.isEdit ? 0.14 : 0.18,
        targetNodeId: primaryNodeId,
        targetNodeIds,
      })

    if (
      collapsedAncestorIds.length > 0 ||
      revealedHiddenSymbolIds.length > 0 ||
      expandedFollowClusterIds.length > 0
    ) {
      for (const directoryId of collapsedAncestorIds) {
        toggleCollapsedDirectory(directoryId)
      }
      await waitForFollowFocusDelay(80)
      await focusTarget()
      return
    }

    await focusTarget()
  }, [
    collapsedDirectoryIdSet,
    expandedClusterIds,
    followRevealKey,
    followVisibleLayout,
    flowInstance,
    snapshotOrNull,
    symbolClusterState,
    toggleCollapsedDirectory,
    toggleSymbolCluster,
    viewMode,
  ])

  const focusCanvasOnNode = useCallback((input: {
    fallbackNodeIds?: string[]
    nodeId: string
  }) => {
    if (!flowInstance || !snapshotOrNull) {
      return
    }

    const visibleNodeIds = new Set(nodes.map((node) => node.id))
    const candidates = [input.nodeId]
    const snapshotNode = snapshotOrNull.nodes[input.nodeId]

    if (snapshotNode && isSymbolNode(snapshotNode)) {
      const cluster = symbolClusterState.clusterByNodeId[snapshotNode.id]

      if (cluster) {
        candidates.push(cluster.rootNodeId)
      }

      let parentSymbolId = snapshotNode.parentSymbolId

      while (parentSymbolId) {
        candidates.push(parentSymbolId)
        const parentSymbol = snapshotOrNull.nodes[parentSymbolId]
        parentSymbolId = parentSymbol && isSymbolNode(parentSymbol)
          ? parentSymbol.parentSymbolId
          : null
      }

      candidates.push(snapshotNode.fileId)
    }

    candidates.push(...(input.fallbackNodeIds ?? []))

    const resolveVisibleAncestor = (nodeId: string) => {
      let currentNode: ProjectNode | undefined = snapshotOrNull.nodes[nodeId]

      while (currentNode) {
        if (visibleNodeIds.has(currentNode.id)) {
          return currentNode.id
        }

        const parentId: string | null = isSymbolNode(currentNode)
          ? currentNode.parentSymbolId ?? currentNode.fileId
          : currentNode.parentId

        currentNode = parentId ? snapshotOrNull.nodes[parentId] : undefined
      }

      return null
    }

    let targetNodeId: string | null = null

    for (const candidate of candidates) {
      if (visibleNodeIds.has(candidate)) {
        targetNodeId = candidate
        break
      }

      const ancestorNodeId = resolveVisibleAncestor(candidate)

      if (ancestorNodeId) {
        targetNodeId = ancestorNodeId
        break
      }
    }

    if (!targetNodeId) {
      return
    }

    const targetNode =
      snapshotOrNull.nodes[targetNodeId] ??
      snapshotOrNull.nodes[input.nodeId] ??
      null
    const desiredZoom = getFollowTargetZoom({
      isEdit: false,
      mode: viewMode === 'symbols' ? 'symbols' : 'files',
      node: targetNode,
    })

    focusFlowOnNode({
      duration: 240,
      flowInstance,
      maxZoom: desiredZoom,
      nodes,
      padding: 0.18,
      targetNodeId,
    })
  }, [flowInstance, nodes, snapshotOrNull, symbolClusterState, viewMode])

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
    if (resolvedScene?.kind !== 'agent_focus_semantic' || !flowInstance) {
      lastFittedAgentFocusKeyRef.current = null
      return
    }

    const focusedNodeIds = [...agentFocusSymbolsByNodeId.keys()].sort()
    const focusKey = [
      resolvedScene.layoutSpec.id,
      resolvedScene.layoutSpec.updatedAt ?? 'runtime',
      focusedNodeIds.join(','),
    ].join('::')

    if (lastFittedAgentFocusKeyRef.current === focusKey || focusedNodeIds.length === 0) {
      return
    }

    const focusedNodeIdSet = new Set(focusedNodeIds)
    const nodesToFit = nodes.filter((node) => focusedNodeIdSet.has(node.id))

    if (nodesToFit.length === 0) {
      return
    }

    lastFittedAgentFocusKeyRef.current = focusKey
    window.setTimeout(() => {
      void flowInstance.fitView({
        duration: 280,
        maxZoom: 2.6,
        nodes: nodesToFit,
        padding: 0.22,
      })
    }, 0)
  }, [
    agentFocusSymbolsByNodeId,
    flowInstance,
    nodes,
    resolvedScene,
  ])

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
    [selectEdge, setInspectorOpen],
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
    [selectNode, setInspectorOpen],
  )

  const handleCanvasNodeDoubleClick = useCallback(
    (_event: unknown, node: Node) => {
      if (viewMode === 'filesystem') {
        const snapshotNode = snapshotOrNull?.nodes[node.id]

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
    [snapshotOrNull, symbolClusterState, toggleCollapsedDirectory, toggleSymbolCluster, viewMode],
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
        snapshotOrNull,
        viewMode,
        modelViewportZoom,
      )
    },
    [
      draftLayouts,
      editableDraftLayout,
      editableLayout,
      layouts,
      setDraftLayouts,
      setLayouts,
      snapshotOrNull,
      viewMode,
      modelViewportZoom,
    ],
  )

  return {
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
    symbolClusterState,
  }
}

async function focusFlowOnNode(input: {
  duration: number
  flowInstance: ReactFlowInstance<Node, Edge>
  maxZoom: number
  nodes: Node[]
  padding: number
  targetNodeId: string
  targetNodeIds?: string[]
}) {
  const bounds = input.flowInstance.getNodesBounds([input.targetNodeId])

  if (bounds.width > 0 && bounds.height > 0) {
    await input.flowInstance.setCenter(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      {
        duration: input.duration,
        zoom: input.maxZoom,
      },
    )
    return
  }

  const targetNodeIds = input.targetNodeIds ?? [input.targetNodeId]
  const nodesToFit = input.nodes.filter((node) => targetNodeIds.includes(node.id))

  if (nodesToFit.length > 0) {
    await input.flowInstance.fitView({
      duration: input.duration,
      maxZoom: input.maxZoom,
      nodes: nodesToFit,
      padding: input.padding,
    })
  }
}

function waitForFollowFocusDelay(durationMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, durationMs)
  })
}

function buildSymbolRuntimeMetadata(
  recordsByNodeId: Map<string, AgentTouchedSymbolRecord>,
): Map<string, FlowSymbolRuntimeMetadata> {
  if (recordsByNodeId.size === 0) {
    return new Map()
  }

  return new Map(
    [...recordsByNodeId.entries()].map(([nodeId, record]) => [
      nodeId,
      {
        agentFocusConfidence: record.confidence,
        agentFocusEventCount: record.eventCount,
        agentFocusIntent: record.intent,
      },
    ]),
  )
}

function getCollapsedFilesystemAncestorIds(
  nodeId: string,
  snapshot: CodebaseSnapshot,
  collapsedDirectoryIdSet: Set<string>,
) {
  const collapsedAncestorIds: string[] = []
  const currentNode = snapshot.nodes[nodeId]
  let parentId =
    currentNode && !isSymbolNode(currentNode)
      ? currentNode.parentId
      : null

  while (parentId) {
    const parentNode = snapshot.nodes[parentId]

    if (!parentNode || !isDirectoryNode(parentNode)) {
      break
    }

    if (collapsedDirectoryIdSet.has(parentId)) {
      collapsedAncestorIds.push(parentId)
    }

    parentId = parentNode.parentId
  }

  return collapsedAncestorIds.reverse()
}

export function getHiddenFollowSymbolIds(
  layout: LayoutSpec | null,
  nodeIds: string[],
) {
  if (!layout) {
    return []
  }

  const hiddenNodeIds = new Set(layout.hiddenNodeIds)

  return [...new Set(nodeIds)]
    .filter((nodeId) => hiddenNodeIds.has(nodeId) && Boolean(layout.placements[nodeId]))
}

export function createFollowVisibleLayout(
  layout: LayoutSpec | null,
  nodeIds: string[],
) {
  if (!layout) {
    return null
  }

  const revealNodeIdSet = new Set(nodeIds)
  const hiddenNodeIds = layout.hiddenNodeIds.filter((nodeId) => !revealNodeIdSet.has(nodeId))

  if (hiddenNodeIds.length === layout.hiddenNodeIds.length) {
    return layout
  }

  return {
    ...layout,
    hiddenNodeIds,
  }
}

function mergeUniqueIds(left: string[], right: string[]) {
  const mergedIds = [...left]

  for (const id of right) {
    if (!mergedIds.includes(id)) {
      mergedIds.push(id)
    }
  }

  return mergedIds
}

function expandFollowSymbolClusters(input: {
  expandedClusterIds: Set<string>
  nodeIds: string[]
  symbolClusterState: ReturnType<typeof deriveSymbolClusterState>
  toggleSymbolCluster: (clusterId: string) => void
}) {
  const clusterIds = [...new Set(input.nodeIds.flatMap((nodeId) => {
    const cluster = input.symbolClusterState.clusterByNodeId[nodeId]

    if (
      !cluster ||
      cluster.rootNodeId === nodeId ||
      input.expandedClusterIds.has(cluster.id)
    ) {
      return []
    }

    return [cluster.id]
  }))]

  for (const clusterId of clusterIds) {
    input.toggleSymbolCluster(clusterId)
  }

  return clusterIds
}

function getFlowModelViewportZoomBucket(zoom: number) {
  if (!Number.isFinite(zoom)) {
    return 1
  }

  const bucket = FLOW_MODEL_VIEWPORT_ZOOM_BUCKETS.find(([maxZoom]) => zoom <= maxZoom)

  return bucket?.[1] ?? 3.5
}

function areFlowNodesEquivalent(left: Node[], right: Node[]) {
  if (left === right) {
    return true
  }

  if (left.length !== right.length) {
    return false
  }

  return left.every((leftNode, index) => {
    const rightNode = right[index]

    return Boolean(
      rightNode &&
        leftNode.id === rightNode.id &&
        leftNode.type === rightNode.type &&
        leftNode.parentId === rightNode.parentId &&
        leftNode.selected === rightNode.selected &&
        leftNode.hidden === rightNode.hidden &&
        leftNode.draggable === rightNode.draggable &&
        leftNode.extent === rightNode.extent &&
        leftNode.height === rightNode.height &&
        leftNode.sourcePosition === rightNode.sourcePosition &&
        leftNode.targetPosition === rightNode.targetPosition &&
        leftNode.width === rightNode.width &&
        areShallowRecordsEquivalent(leftNode.position, rightNode.position) &&
        areShallowRecordsEquivalent(leftNode.data, rightNode.data) &&
        areShallowRecordsEquivalent(leftNode.style, rightNode.style),
    )
  })
}

function areFlowEdgesEquivalent(left: Edge[], right: Edge[]) {
  if (left === right) {
    return true
  }

  if (left.length !== right.length) {
    return false
  }

  return left.every((leftEdge, index) => {
    const rightEdge = right[index]

    return Boolean(
      rightEdge &&
        leftEdge.id === rightEdge.id &&
        leftEdge.type === rightEdge.type &&
        leftEdge.source === rightEdge.source &&
        leftEdge.target === rightEdge.target &&
        leftEdge.selected === rightEdge.selected &&
        leftEdge.hidden === rightEdge.hidden &&
        leftEdge.animated === rightEdge.animated &&
        leftEdge.label === rightEdge.label &&
        leftEdge.sourceHandle === rightEdge.sourceHandle &&
        leftEdge.targetHandle === rightEdge.targetHandle &&
        areShallowRecordsEquivalent(leftEdge.data, rightEdge.data) &&
        areShallowRecordsEquivalent(leftEdge.markerStart, rightEdge.markerStart) &&
        areShallowRecordsEquivalent(leftEdge.style, rightEdge.style) &&
        areShallowRecordsEquivalent(leftEdge.markerEnd, rightEdge.markerEnd),
    )
  })
}

function areShallowRecordsEquivalent(left: unknown, right: unknown) {
  if (Object.is(left, right)) {
    return true
  }

  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  return leftKeys.every((key) =>
    areShallowValuesEquivalent(leftRecord[key], rightRecord[key]),
  )
}

function areShallowValuesEquivalent(left: unknown, right: unknown) {
  if (Object.is(left, right)) {
    return true
  }

  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false
  }

  if (left.length !== right.length) {
    return false
  }

  return left.every((item, index) => Object.is(item, right[index]))
}

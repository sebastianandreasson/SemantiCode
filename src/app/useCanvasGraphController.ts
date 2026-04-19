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
import { getPreferredFollowSymbolIdsForFile } from './agentFollowModel'
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
  buildLayoutGroupContainers,
  countVisibleLayoutNodes,
  deriveSymbolClusterState,
  getFollowTargetZoom,
  isAnnotationNodeId,
  updateLayoutPlacement,
  type FlowModel,
} from '../visualizer/flowModel'

export interface UseCanvasGraphControllerInput {
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
  const containerDragPreviewPositionsRef = useRef(new Map<string, XYPosition>())
  const lastFittedCompareKeyRef = useRef<string | null>(null)
  const snapshotOrNull = snapshot ?? null
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const symbolClusterState = useMemo(
    () =>
      deriveSymbolClusterState(
        snapshotOrNull,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
      ),
    [snapshotOrNull, resolvedScene, viewMode],
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
        snapshotOrNull,
        resolvedScene?.layoutSpec ?? null,
        symbolClusterState,
        expandedClusterIds,
      ),
    [expandedClusterIds, resolvedScene, snapshotOrNull, symbolClusterState],
  )
  const filesystemContainerLayouts = useMemo(
    () =>
      buildFilesystemContainerLayouts(
        snapshotOrNull,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
        collapsedDirectoryIdSet,
      ),
    [collapsedDirectoryIdSet, resolvedScene, snapshotOrNull, viewMode],
  )
  const layoutGroupContainers = useMemo(
    () =>
      buildLayoutGroupContainers(
        snapshotOrNull,
        resolvedScene?.layoutSpec ?? null,
        viewMode,
      ),
    [resolvedScene, snapshotOrNull, viewMode],
  )
  const modelViewportZoom = useMemo(
    () => getFlowModelViewportZoomBucket(viewport.zoom),
    [viewport.zoom],
  )

  const baseFlowModel = useMemo<FlowModel | null>(() => {
    if (!snapshotOrNull || !resolvedScene) {
      return null
    }

    return buildFlowModel(
      snapshotOrNull,
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
      {
        selectedNodeIds: selectedNodeIdSet,
        viewportZoom: modelViewportZoom,
      },
    )
  }, [
    collapsedDirectoryIdSet,
    expandedClusterIds,
    expandedClusterLayouts,
    filesystemContainerLayouts,
    graphLayers,
    layoutGroupContainers,
    resolvedScene,
    selectedNodeIdSet,
    snapshotOrNull,
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
      setNodes([])
      setEdges([])
      return
    }

    setNodes(presentedFlowModel.nodes)
    setEdges(presentedFlowModel.edges)
  }, [presentedFlowModel, setEdges, setNodes])

  const visibleNodeCount = useMemo(
    () =>
      snapshotOrNull && resolvedScene
        ? countVisibleLayoutNodes(
            snapshotOrNull,
            resolvedScene.layoutSpec,
            viewMode,
            symbolClusterState,
            expandedClusterIds,
          )
        : 0,
    [expandedClusterIds, resolvedScene, snapshotOrNull, symbolClusterState, viewMode],
  )
  const denseCanvasMode = viewMode === 'symbols' && visibleNodeCount > 250

  const focusCanvasOnFollowTarget = useCallback((input: {
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
    const bounds = flowInstance.getNodesBounds([primaryNodeId])

    if (bounds.width > 0 && bounds.height > 0) {
      void flowInstance.setCenter(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        {
          duration: input.isEdit ? 260 : 220,
          zoom: desiredZoom,
        },
      )
    } else {
      const nodesToFit = nodes.filter((node) => targetNodeIds.includes(node.id))

      if (nodesToFit.length > 0) {
        void flowInstance.fitView({
          duration: input.isEdit ? 260 : 220,
          maxZoom: desiredZoom,
          nodes: nodesToFit,
          padding: input.isEdit ? 0.14 : 0.18,
        })
      }
    }
  }, [flowInstance, nodes, snapshotOrNull])

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
    const bounds = flowInstance.getNodesBounds([targetNodeId])
    const desiredZoom = getFollowTargetZoom({
      isEdit: false,
      mode: viewMode === 'symbols' ? 'symbols' : 'files',
      node: targetNode,
    })

    if (bounds.width > 0 && bounds.height > 0) {
      void flowInstance.setCenter(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        {
          duration: 240,
          zoom: desiredZoom,
        },
      )
      return
    }

    const nodesToFit = nodes.filter((node) => node.id === targetNodeId)

    if (nodesToFit.length > 0) {
      void flowInstance.fitView({
        duration: 240,
        maxZoom: desiredZoom,
        nodes: nodesToFit,
        padding: 0.18,
      })
    }
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

function getFlowModelViewportZoomBucket(zoom: number) {
  if (!Number.isFinite(zoom)) {
    return 1
  }

  if (zoom <= 0.04) {
    return 0.035
  }

  if (zoom <= 0.065) {
    return 0.055
  }

  if (zoom <= 0.1) {
    return 0.085
  }

  if (zoom <= 0.16) {
    return 0.13
  }

  if (zoom <= 0.25) {
    return 0.2
  }

  if (zoom <= 0.4) {
    return 0.32
  }

  if (zoom <= 0.65) {
    return 0.52
  }

  if (zoom <= 0.95) {
    return 0.8
  }

  if (zoom <= 1.35) {
    return 1.1
  }

  if (zoom <= 2) {
    return 1.65
  }

  if (zoom <= 3) {
    return 2.45
  }

  return 3.5
}

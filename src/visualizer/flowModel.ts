import {
  MarkerType,
  Position,
  type Edge,
  type Node,
  type XYPosition,
} from '@xyflow/react'

import {
  isApiEndpointNode,
  isDirectoryNode,
  isFileNode,
  isSymbolNode,
  type ApiEndpointNode,
  type CodebaseFile,
  type CodebaseSnapshot,
  type GraphEdgeKind,
  type GraphLayerKey,
  type LayoutDraft,
  type LayoutNodeScope,
  type LayoutSpec,
  type ProjectNode,
  type SymbolNode,
  type TelemetryMode,
  type VisualizerViewMode,
  type GroupPrototypeCacheSnapshot,
} from '../types'
import type {
  WorkspaceSidebarGroup,
  WorkspaceSidebarGroupItem,
} from '../components/shell/WorkspaceSidebar'
import {
  DEFAULT_SYMBOL_FOOTPRINT_HEIGHT,
  DEFAULT_SYMBOL_FOOTPRINT_WIDTH,
  createSymbolFootprintLookup,
  getNodeBadgeLabels,
  getSymbolLoc,
  getSymbolNodeFootprint,
  getSymbolSubtitle,
  getSymbolVisualKindClass,
  type SymbolFootprint,
  type SymbolFootprintLookup,
  type SymbolFootprintLookupOptions,
} from './symbolFootprint'

export {
  createSymbolFootprintLookup,
  formatFacetLabel,
  getSymbolVisualKindClass,
  type SymbolFootprint,
  type SymbolFootprintLookup,
  type SymbolFootprintLookupOptions,
} from './symbolFootprint'

export type FlowEdgeData = Record<string, unknown> & {
  kind: GraphEdgeKind
  count?: number
  dimmed?: boolean
  highlighted?: boolean
  impact?: 'low' | 'medium' | 'high'
}

const DEFAULT_CALL_EDGE_RENDER_LIMIT = 700
const GROUP_CONTAINER_NODE_Z_INDEX = 0
const CODE_NODE_Z_INDEX = 2
const SYMBOL_NODE_Z_INDEX = 3
const ANNOTATION_NODE_Z_INDEX = 5

export interface FlowModelOptions {
  callEdgeRenderLimit?: number
  selectedNodeIds?: Set<string>
  symbolRuntimeMetadataByNodeId?: Map<string, FlowSymbolRuntimeMetadata>
  symbolFootprints?: SymbolFootprintLookup
  viewportZoom?: number
}

export interface FlowSymbolRuntimeMetadata {
  agentFocusConfidence?: string
  agentFocusEventCount?: number
  agentFocusIntent?: 'read' | 'edit' | 'mixed'
}

export interface GraphSummary {
  incoming: number
  outgoing: number
  neighbors: ProjectNode[]
}

export interface SymbolCluster {
  id: string
  rootNodeId: string
  memberNodeIds: string[]
  label: string
  ownerByMemberNodeId: Record<string, string>
}

export interface SymbolClusterState {
  clusters: SymbolCluster[]
  clusterByNodeId: Record<string, SymbolCluster | undefined>
  callerCounts: Record<string, number>
}

export interface ExpandedClusterLayout {
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

export interface FilesystemContainerLayout {
  width: number
  height: number
  childNodeIds: string[]
}

export interface LayoutGroupContainer {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  nodeIds: string[]
  childPlacements: Record<string, LayoutGroupChildPlacement>
  titleScale?: number
}

export interface LayoutGroupChildPlacement {
  nodeId: string
  x: number
  y: number
  width: number
  height: number
  loc: number
}

export interface LayoutGroupContainerIndex {
  containersById: Map<string, LayoutGroupContainer>
  containerByNodeId: Map<string, LayoutGroupContainer>
}

export interface FlowModel {
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
const EXPANDED_CLUSTER_CHILD_MAX_WIDTH = 280
const EXPANDED_CLUSTER_CHILD_MAX_HEIGHT = 104
const EXPANDED_CLUSTER_GAP_X = 14
const EXPANDED_CLUSTER_GAP_Y = 12
const EXPANDED_CLUSTER_PADDING_X = 14
const EXPANDED_CLUSTER_PADDING_TOP = 18
const EXPANDED_CLUSTER_PADDING_BOTTOM = 14
const EXPANDED_CLUSTER_PACK_MAX_INNER_WIDTH = 1_760
const EXPANDED_CLUSTER_PACK_ASPECT_WEIGHT = 1.16
const DEFAULT_NODE_WIDTH = DEFAULT_SYMBOL_FOOTPRINT_WIDTH
const DEFAULT_NODE_HEIGHT = DEFAULT_SYMBOL_FOOTPRINT_HEIGHT
const API_ENDPOINT_NODE_WIDTH = 268
const API_ENDPOINT_NODE_HEIGHT = 96
const FILESYSTEM_CONTAINER_PADDING_RIGHT = 18
const FILESYSTEM_CONTAINER_PADDING_BOTTOM = 18
const LAYOUT_GROUP_PADDING_X = 22
const LAYOUT_GROUP_PADDING_TOP = 112
const LAYOUT_GROUP_PADDING_BOTTOM = 44
const LAYOUT_GROUP_PACK_GAP_X = 38
const LAYOUT_GROUP_PACK_GAP_Y = 34
const LAYOUT_GROUP_PACK_MIN_WIDTH = 760
const LAYOUT_GROUP_PACK_MAX_WIDTH = 3_600
const LAYOUT_GROUP_CONTAINER_GAP_X = 110
const LAYOUT_GROUP_CONTAINER_GAP_Y = 120
const LAYOUT_GROUP_CONTAINER_PACK_MIN_WIDTH = 1_200
const LAYOUT_GROUP_CONTAINER_PACK_MAX_WIDTH = 7_200
const LAYOUT_GROUP_TITLE_MAX_SCALE = 7.2
const FOLLOW_AGENT_EDIT_SYMBOL_ZOOM = 2.15
const FOLLOW_AGENT_EDIT_FILE_ZOOM = 1.55
const FOLLOW_AGENT_ACTIVITY_SYMBOL_ZOOM = 1.75
const FOLLOW_AGENT_ACTIVITY_FILE_ZOOM = 1.3
const VIRTUAL_LAYOUT_GROUP_NODE_PREFIX = '__layout_group__:'

export function collectFiles(snapshot: CodebaseSnapshot) {
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

export function buildFlowModel(
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec,
  graphLayers: Partial<Record<GraphLayerKey, boolean>>,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
  filesystemContainerLayouts: Map<string, FilesystemContainerLayout>,
  layoutGroupContainers: Map<string, LayoutGroupContainer> | LayoutGroupContainerIndex,
  collapsedDirectoryIds: Set<string>,
  toggleCollapsedDirectory: (nodeId: string) => void,
  options: FlowModelOptions = {},
) {
  const symbolFootprints =
    options.symbolFootprints ??
    createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: options.viewportZoom,
    })
  const layoutGroupContainerIndex = normalizeLayoutGroupContainerIndex(
    layoutGroupContainers,
  )
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
    zIndex: ANNOTATION_NODE_Z_INDEX,
    draggable: true,
    selectable: false,
    data: {
      label: annotation.label,
      dimmed: false,
    },
  } satisfies Node))
  const groupNodes = Array.from(layoutGroupContainerIndex.containersById.values()).map((group) => ({
    id: getLayoutGroupNodeId(group.id),
    type: 'codebaseNode',
    position: {
      x: group.x,
      y: group.y,
    },
    width: group.width,
    height: group.height,
    zIndex: GROUP_CONTAINER_NODE_Z_INDEX,
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
      groupTitleScale: group.titleScale ?? 1,
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
        if (!isSymbolViewNode(node)) {
          return false
        }

        if (isApiEndpointNode(node)) {
          return true
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
        layoutGroupContainerIndex,
        collapsedDirectoryIds,
        toggleCollapsedDirectory,
        {
          ...options,
          symbolFootprints,
        },
      ),
    )
  const nodes = orderFlowNodesForParentRendering([
    ...annotationNodes,
    ...groupNodes,
    ...codeNodes,
  ])
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
    const callEdgeRenderLimit =
      options.callEdgeRenderLimit ??
      getZoomAwareCallEdgeRenderLimit(
        options.viewportZoom ?? 1,
        options.selectedNodeIds?.size ?? 0,
      )
    const callEdges = viewMode === 'symbols'
      ? aggregateSymbolEdges(
          snapshot,
          'calls',
          visibleNodeIds,
          symbolClusterState,
          expandedClusterIds,
          options.viewportZoom ?? 1,
        )
      : aggregateFileEdges(snapshot, 'calls', options.viewportZoom ?? 1).filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )

    edges.push(
      ...prioritizeCallEdgesForRendering(
        callEdges,
        options.selectedNodeIds ?? new Set(),
        callEdgeRenderLimit,
      ),
    )
  }

  if (graphLayers.api) {
    const apiEdges = viewMode === 'symbols'
      ? getVisibleApiEdges(snapshot, visibleNodeIds)
      : getVisibleFilesystemApiEdges(snapshot, visibleNodeIds, options.viewportZoom ?? 1)

    edges.push(...apiEdges)
  }

  return { nodes, edges }
}

export function applyFlowNodePresentation(
  nodes: Node[],
  selectedNodeIds: Set<string>,
  compareOverlayState: {
    active: boolean
    nodeIds: Set<string>
  },
  telemetryHeatByNodeId: Map<string, { pulse: boolean; weight: number }>,
) {
  const heatActive = telemetryHeatByNodeId.size > 0
  let changed = false
  const nextNodes = nodes.map((node) => {
    const highlighted = compareOverlayState.nodeIds.has(node.id)
    const selected = selectedNodeIds.has(node.id)
    const heat = telemetryHeatByNodeId.get(node.id)
    const heatWeight = heat?.weight ?? 0
    const heatPulse = heat?.pulse ?? false
    const dimmed = compareOverlayState.active
      ? !highlighted
      : heatActive && heatWeight <= 0 && !selected
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

export function applyFlowEdgePresentation(
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
    const selected = Boolean(edge.selected)
    const edgePresentation = getEdgeImpactPresentation(kind, data?.count ?? 1)
    const strokeWidth = highlighted || selected
      ? 2.4
      : edgePresentation.strokeWidth
    const opacity = dimmed
      ? 0.08
      : highlighted || selected
        ? 1
        : edgePresentation.opacity
    const currentOpacity = edge.style?.opacity ?? edgePresentation.opacity
    const currentStrokeWidth =
      edge.style?.strokeWidth ?? edgePresentation.strokeWidth
    const currentImpact = data?.impact

    if (
      currentHighlighted === highlighted &&
      currentDimmed === dimmed &&
      currentImpact === edgePresentation.impact &&
      currentOpacity === opacity &&
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
            impact: edgePresentation.impact,
          }
        : edge.data,
      style: {
        ...edge.style,
        opacity,
        strokeWidth,
      },
    }
  })

  return changed ? nextEdges : edges
}

export function applyDirectChildDragPreviewOffset(
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
  layoutGroupContainerIndex: LayoutGroupContainerIndex,
  collapsedDirectoryIds: Set<string>,
  toggleCollapsedDirectory: (nodeId: string) => void,
  options: FlowModelOptions,
): Node {
  const groupParentContainer = layoutGroupContainerIndex.containerByNodeId.get(node.id) ?? null
  const groupChildPlacement = groupParentContainer?.childPlacements[node.id]

  if (isApiEndpointNode(node)) {
    const width = groupChildPlacement?.width ?? placement.width ?? API_ENDPOINT_NODE_WIDTH
    const height = groupChildPlacement?.height ?? placement.height ?? API_ENDPOINT_NODE_HEIGHT

    return {
      id: node.id,
      type: 'symbolNode',
      position: {
        x: groupChildPlacement?.x ?? placement.x,
        y: groupChildPlacement?.y ?? placement.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      width,
      height,
      zIndex: SYMBOL_NODE_Z_INDEX,
      style: {
        width,
        height,
      },
      draggable: true,
      data: {
        title: node.name,
        subtitle: getApiEndpointSubtitle(node),
        kind: 'endpoint',
        kindClass: 'endpoint',
        tags: getNodeBadgeLabels(node, snapshot),
        locScale: 1,
        contentScale: 1,
        compact: false,
        dimmed: false,
        highlighted: false,
      },
    }
  }

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
    const loc = getSymbolLoc(node)
    const sharedCallerCount = symbolClusterState.callerCounts[node.id] ?? 0
    const clusterExpanded =
      clusterSize > 0 && cluster ? expandedClusterIds.has(cluster.id) : undefined
    const symbolRuntimeMetadata = options.symbolRuntimeMetadataByNodeId?.get(node.id)
    const runtimeMetaLabels = getRuntimeSymbolMetaLabels(
      sharedCallerCount,
      clusterSize,
      clusterExpanded,
      symbolRuntimeMetadata,
    )
    const symbolDimensions =
      options.symbolFootprints?.get(node.id, {
        contained: isContainedNode,
        containedPlacement,
        extraMetaLabels: runtimeMetaLabels,
      }) ??
      getSymbolNodeFootprint(
        node,
        placement,
        {
          contained: isContainedNode,
          containedPlacement,
          extraMetaLabels: runtimeMetaLabels,
        },
        options.viewportZoom,
        snapshot,
      )
    const width =
      isContainedNode
        ? symbolDimensions.width
        : (clusterLayout?.width ?? groupChildPlacement?.width ?? symbolDimensions.width)
    const height =
      isContainedNode
        ? symbolDimensions.height
        : (clusterLayout?.height ?? groupChildPlacement?.height ?? symbolDimensions.height)

    return {
      id: node.id,
      type: 'symbolNode',
      position: {
        x: containedPlacement?.x ?? groupChildPlacement?.x ?? placement.x,
        y: containedPlacement?.y ?? groupChildPlacement?.y ?? placement.y,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      width,
      height,
      zIndex: SYMBOL_NODE_Z_INDEX,
      style: {
        width,
        height,
      },
      draggable: true,
      parentId: isContainedNode && cluster ? cluster.rootNodeId : undefined,
      extent: isContainedNode ? 'parent' : undefined,
      data: {
        title: node.name,
        subtitle: getSymbolSubtitle(node, snapshot),
        kind: node.symbolKind,
        kindClass: getSymbolVisualKindClass(node),
        tags: getNodeBadgeLabels(node, snapshot),
        loc,
        locScale: symbolDimensions.scale,
        contentScale: symbolDimensions.contentScale,
        clusterSize,
        clusterExpanded,
        sharedCallerCount,
        agentFocusConfidence: symbolRuntimeMetadata?.agentFocusConfidence,
        agentFocusEventCount: symbolRuntimeMetadata?.agentFocusEventCount,
        agentFocusIntent: symbolRuntimeMetadata?.agentFocusIntent,
        contained: isContainedNode,
        compact: symbolDimensions.compact,
        dimmed: false,
        highlighted: false,
      },
    }
  }

  const layoutGroupContainer = layoutGroupContainerIndex.containersById.get(node.id)
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
          ? (groupChildPlacement?.x ?? placement.x) - groupParentPosition.x
          : isContainedFilesystemNode && filesystemParentPlacement
          ? placement.x - filesystemParentPlacement.x
          : placement.x,
      y:
        groupParentPosition
          ? (groupChildPlacement?.y ?? placement.y) - groupParentPosition.y
          : isContainedFilesystemNode && filesystemParentPlacement
          ? placement.y - filesystemParentPlacement.y
          : placement.y,
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    width:
      groupChildPlacement?.width ??
      (isCollapsedDirectory ? placement.width ?? 240 : filesystemContainerLayout?.width) ??
      placement.width ??
      (node.kind === 'directory' ? 240 : 224),
    height:
      groupChildPlacement?.height ??
      (isCollapsedDirectory ? placement.height ?? 72 : filesystemContainerLayout?.height) ??
      placement.height ??
      (node.kind === 'directory' ? 68 : 54),
    zIndex: CODE_NODE_Z_INDEX,
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
      tags: getNodeBadgeLabels(node, snapshot),
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

function isSymbolViewNode(node: ProjectNode) {
  return isSymbolNode(node) || isApiEndpointNode(node)
}

export function buildFilesystemContainerLayouts(
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

export function buildLayoutGroupContainers(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  viewMode: VisualizerViewMode,
  options: {
    expandedClusterIds?: Set<string>
    expandedClusterLayouts?: Map<string, ExpandedClusterLayout>
    packGroups?: boolean
    symbolClusterState?: SymbolClusterState
    symbolFootprints?: SymbolFootprintLookup
    viewportZoom?: number
  } = {},
) {
  return buildLayoutGroupContainerIndex(
    snapshot,
    layout,
    viewMode,
    options,
  ).containersById
}

export function buildLayoutGroupContainerIndex(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  viewMode: VisualizerViewMode,
  options: {
    expandedClusterIds?: Set<string>
    expandedClusterLayouts?: Map<string, ExpandedClusterLayout>
    packGroups?: boolean
    symbolClusterState?: SymbolClusterState
    symbolFootprints?: SymbolFootprintLookup
    viewportZoom?: number
  } = {},
): LayoutGroupContainerIndex {
  const containersById = new Map<string, LayoutGroupContainer>()
  const containerByNodeId = new Map<string, LayoutGroupContainer>()

  if (!snapshot || !layout || layout.strategy !== 'agent') {
    return { containerByNodeId, containersById }
  }

  const hiddenNodeIds = new Set(layout.hiddenNodeIds)
  const packGroups = options.packGroups ?? viewMode === 'symbols'
  const titleScale = getLayoutGroupTitleScale(options.viewportZoom)
  const paddingTop = getLayoutGroupPaddingTop(options.viewportZoom)

  for (const group of layout.groups) {
    const rawMemberPlacements = group.nodeIds
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

        if (
          viewMode === 'symbols' &&
          isSymbolNode(node) &&
          shouldSkipGroupedSymbol(node.id, options)
        ) {
          return null
        }

        const dimensions = getGroupMemberDimensions(
          node,
          placement,
          snapshot,
          options,
        )

        return {
          nodeId,
          x: placement.x,
          y: placement.y,
          width: dimensions.width,
          height: dimensions.height,
          loc: isSymbolNode(node) ? getSymbolLoc(node) ?? 0 : 0,
        }
      })
      .filter((placement): placement is NonNullable<typeof placement> => Boolean(placement))

    if (rawMemberPlacements.length === 0) {
      continue
    }

    const memberPlacements =
      packGroups && rawMemberPlacements.length > 1
        ? packLayoutGroupMemberPlacements(rawMemberPlacements)
        : rawMemberPlacements
    const minX = Math.min(...memberPlacements.map((placement) => placement.x))
    const minY = Math.min(...memberPlacements.map((placement) => placement.y))
    const maxRight = Math.max(
      ...memberPlacements.map((placement) => placement.x + placement.width),
    )
    const maxBottom = Math.max(
      ...memberPlacements.map((placement) => placement.y + placement.height),
    )

    const container: LayoutGroupContainer = {
      id: group.id,
      title: group.title,
      x: minX - LAYOUT_GROUP_PADDING_X,
      y: minY - paddingTop,
      width: maxRight - minX + LAYOUT_GROUP_PADDING_X * 2,
      height:
        maxBottom - minY + paddingTop + LAYOUT_GROUP_PADDING_BOTTOM,
      nodeIds: memberPlacements.map((placement) => placement.nodeId),
      childPlacements: Object.fromEntries(
        memberPlacements.map((placement) => [placement.nodeId, placement]),
      ),
      titleScale,
    }

    containersById.set(group.id, container)

    for (const nodeId of container.nodeIds) {
      containerByNodeId.set(nodeId, container)
    }
  }

  const containers = Array.from(containersById.values())

  if (packGroups && containers.length > 1 && hasLayoutGroupContainerOverlap(containers)) {
    return buildPackedLayoutGroupContainerIndex(containersById)
  }

  return { containerByNodeId, containersById }
}

function normalizeLayoutGroupContainerIndex(
  input: Map<string, LayoutGroupContainer> | LayoutGroupContainerIndex,
): LayoutGroupContainerIndex {
  if ('containersById' in input && 'containerByNodeId' in input) {
    return input
  }

  const containerByNodeId = new Map<string, LayoutGroupContainer>()

  for (const container of input.values()) {
    for (const nodeId of container.nodeIds) {
      containerByNodeId.set(nodeId, container)
    }
  }

  return {
    containersById: input,
    containerByNodeId,
  }
}

function buildPackedLayoutGroupContainerIndex(
  containersById: Map<string, LayoutGroupContainer>,
): LayoutGroupContainerIndex {
  const nextContainersById = new Map<string, LayoutGroupContainer>()
  const containerByNodeId = new Map<string, LayoutGroupContainer>()
  const packedContainers = packLayoutGroupContainers(
    Array.from(containersById.values()),
  )

  for (const container of packedContainers) {
    nextContainersById.set(container.id, container)

    for (const nodeId of container.nodeIds) {
      containerByNodeId.set(nodeId, container)
    }
  }

  return {
    containerByNodeId,
    containersById: nextContainersById,
  }
}

function packLayoutGroupContainers(containers: LayoutGroupContainer[]) {
  const rawBounds = getLayoutGroupContainerBounds(containers)
  const maxContainerWidth = Math.max(
    ...containers.map((container) => container.width),
  )
  const totalArea = containers.reduce(
    (sum, container) =>
      sum +
      (container.width + LAYOUT_GROUP_CONTAINER_GAP_X) *
        (container.height + LAYOUT_GROUP_CONTAINER_GAP_Y),
    0,
  )
  const targetRowWidth = clamp(
    Math.max(rawBounds.width, Math.sqrt(totalArea) * 1.24, maxContainerWidth),
    Math.max(LAYOUT_GROUP_CONTAINER_PACK_MIN_WIDTH, maxContainerWidth),
    LAYOUT_GROUP_CONTAINER_PACK_MAX_WIDTH,
  )
  const packedContainers: LayoutGroupContainer[] = []
  let cursorX = rawBounds.x
  let cursorY = rawBounds.y
  let rowHeight = 0

  for (const container of [...containers].sort(compareLayoutGroupContainerPackOrder)) {
    if (
      cursorX > rawBounds.x &&
      cursorX + container.width > rawBounds.x + targetRowWidth
    ) {
      cursorX = rawBounds.x
      cursorY += rowHeight + LAYOUT_GROUP_CONTAINER_GAP_Y
      rowHeight = 0
    }

    packedContainers.push(shiftLayoutGroupContainer(container, cursorX, cursorY))
    cursorX += container.width + LAYOUT_GROUP_CONTAINER_GAP_X
    rowHeight = Math.max(rowHeight, container.height)
  }

  return packedContainers
}

function hasLayoutGroupContainerOverlap(containers: LayoutGroupContainer[]) {
  const activeContainers: LayoutGroupContainer[] = []

  for (const container of [...containers].sort((left, right) => left.x - right.x)) {
    for (let index = activeContainers.length - 1; index >= 0; index -= 1) {
      const activeContainer = activeContainers[index]

      if (activeContainer && activeContainer.x + activeContainer.width <= container.x) {
        activeContainers.splice(index, 1)
      }
    }

    for (const activeContainer of activeContainers) {
      if (
        activeContainer.y < container.y + container.height &&
        activeContainer.y + activeContainer.height > container.y
      ) {
        return true
      }
    }

    activeContainers.push(container)
  }

  return false
}

function compareLayoutGroupContainerPackOrder(
  left: LayoutGroupContainer,
  right: LayoutGroupContainer,
) {
  if (left.y !== right.y) {
    return left.y - right.y
  }

  if (left.x !== right.x) {
    return left.x - right.x
  }

  return left.id.localeCompare(right.id)
}

function shiftLayoutGroupContainer(
  container: LayoutGroupContainer,
  x: number,
  y: number,
): LayoutGroupContainer {
  const deltaX = x - container.x
  const deltaY = y - container.y

  if (deltaX === 0 && deltaY === 0) {
    return container
  }

  return {
    ...container,
    x,
    y,
    childPlacements: Object.fromEntries(
      Object.entries(container.childPlacements).map(([nodeId, placement]) => [
        nodeId,
        {
          ...placement,
          x: placement.x + deltaX,
          y: placement.y + deltaY,
        },
      ]),
    ),
  }
}

function getLayoutGroupContainerBounds(containers: LayoutGroupContainer[]) {
  const minX = Math.min(...containers.map((container) => container.x))
  const minY = Math.min(...containers.map((container) => container.y))
  const maxRight = Math.max(
    ...containers.map((container) => container.x + container.width),
  )
  const maxBottom = Math.max(
    ...containers.map((container) => container.y + container.height),
  )

  return {
    x: minX,
    y: minY,
    width: maxRight - minX,
    height: maxBottom - minY,
  }
}

function shouldSkipGroupedSymbol(
  nodeId: string,
  options: {
    expandedClusterIds?: Set<string>
    symbolClusterState?: SymbolClusterState
  },
) {
  const cluster = options.symbolClusterState?.clusterByNodeId[nodeId]

  return Boolean(
    cluster &&
      cluster.rootNodeId !== nodeId &&
      !options.expandedClusterIds?.has(cluster.id),
  )
}

function getGroupMemberDimensions(
  node: ProjectNode,
  placement: LayoutSpec['placements'][string],
  snapshot: CodebaseSnapshot,
  options: {
    expandedClusterIds?: Set<string>
    expandedClusterLayouts?: Map<string, ExpandedClusterLayout>
    symbolClusterState?: SymbolClusterState
    symbolFootprints?: SymbolFootprintLookup
    viewportZoom?: number
  },
) {
  if (isSymbolNode(node)) {
    const cluster = options.symbolClusterState?.clusterByNodeId[node.id]
    const clusterLayout =
      cluster &&
      cluster.rootNodeId === node.id &&
      options.expandedClusterIds?.has(cluster.id)
        ? options.expandedClusterLayouts?.get(cluster.id)
        : undefined

    if (clusterLayout) {
      return {
        width: clusterLayout.width,
        height: clusterLayout.height,
      }
    }

    const clusterSize =
      cluster && cluster.rootNodeId === node.id ? cluster.memberNodeIds.length : 0
    const clusterExpanded =
      clusterSize > 0 && cluster ? options.expandedClusterIds?.has(cluster.id) : undefined
    const footprintOptions: SymbolFootprintLookupOptions = {
      extraMetaLabels: getRuntimeSymbolMetaLabels(
        options.symbolClusterState?.callerCounts[node.id] ?? 0,
        clusterSize,
        clusterExpanded,
      ),
    }
    const footprint =
      options.symbolFootprints?.get(node.id, footprintOptions) ??
      getSymbolNodeFootprint(
        node,
        placement,
        footprintOptions,
        options.viewportZoom,
        snapshot,
      )

    return {
      width: footprint.width,
      height: footprint.height,
    }
  }

  return {
    width: placement.width ?? getDefaultNodeWidth(node),
    height: placement.height ?? getDefaultNodeHeight(node),
  }
}

function packLayoutGroupMemberPlacements(
  placements: LayoutGroupChildPlacement[],
) {
  const rawBounds = getLayoutGroupPlacementBounds(placements)
  const maxNodeWidth = Math.max(...placements.map((placement) => placement.width))
  const totalArea = placements.reduce(
    (sum, placement) =>
      sum +
      (placement.width + LAYOUT_GROUP_PACK_GAP_X) *
        (placement.height + LAYOUT_GROUP_PACK_GAP_Y),
    0,
  )
  const targetRowWidth = clamp(
    Math.max(rawBounds.width, Math.sqrt(totalArea) * 1.35, maxNodeWidth),
    Math.max(LAYOUT_GROUP_PACK_MIN_WIDTH, maxNodeWidth),
    LAYOUT_GROUP_PACK_MAX_WIDTH,
  )
  const sortedPlacements = [...placements].sort(compareLayoutGroupPackOrder)
  const packedPlacements: LayoutGroupChildPlacement[] = []
  let cursorX = rawBounds.x
  let cursorY = rawBounds.y
  let rowHeight = 0

  for (const placement of sortedPlacements) {
    if (
      cursorX > rawBounds.x &&
      cursorX + placement.width > rawBounds.x + targetRowWidth
    ) {
      cursorX = rawBounds.x
      cursorY += rowHeight + LAYOUT_GROUP_PACK_GAP_Y
      rowHeight = 0
    }

    packedPlacements.push({
      ...placement,
      x: cursorX,
      y: cursorY,
    })
    cursorX += placement.width + LAYOUT_GROUP_PACK_GAP_X
    rowHeight = Math.max(rowHeight, placement.height)
  }

  return packedPlacements
}

function compareLayoutGroupPackOrder(
  left: LayoutGroupChildPlacement,
  right: LayoutGroupChildPlacement,
) {
  if (left.y !== right.y) {
    return left.y - right.y
  }

  if (left.x !== right.x) {
    return left.x - right.x
  }

  if (left.loc !== right.loc) {
    return right.loc - left.loc
  }

  return left.nodeId.localeCompare(right.nodeId)
}

function getLayoutGroupPlacementBounds(placements: LayoutGroupChildPlacement[]) {
  const minX = Math.min(...placements.map((placement) => placement.x))
  const minY = Math.min(...placements.map((placement) => placement.y))
  const maxRight = Math.max(
    ...placements.map((placement) => placement.x + placement.width),
  )
  const maxBottom = Math.max(
    ...placements.map((placement) => placement.y + placement.height),
  )

  return {
    x: minX,
    y: minY,
    width: maxRight - minX,
    height: maxBottom - minY,
  }
}

function getLayoutGroupPaddingTop(viewportZoom = 1) {
  const titleScale = getLayoutGroupTitleScale(viewportZoom)

  return Math.round(LAYOUT_GROUP_PADDING_TOP + Math.max(0, titleScale - 1) * 12)
}

function getLayoutGroupTitleScale(viewportZoom = 1) {
  const zoom = Number.isFinite(viewportZoom) ? clamp(viewportZoom, 0.08, 4) : 1

  if (zoom >= 0.85) {
    return 1
  }

  const overviewWeight = clamp((0.85 - zoom) / 0.77, 0, 1)
  const readableScale = 1 / zoom

  return clamp(
    1 + (Math.sqrt(readableScale) * 1.82 - 1) * overviewWeight,
    1,
    LAYOUT_GROUP_TITLE_MAX_SCALE,
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function getLayoutGroupParentContainer(
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

export function getLayoutGroupNodeId(groupId: string) {
  return `${VIRTUAL_LAYOUT_GROUP_NODE_PREFIX}${groupId}`
}

export function isLayoutGroupNodeId(nodeId: string) {
  return nodeId.startsWith(VIRTUAL_LAYOUT_GROUP_NODE_PREFIX)
}

export function getLayoutGroupIdFromNodeId(nodeId: string) {
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
  const edgePresentation = getEdgeImpactPresentation(kind, data?.count ?? 1)

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
    animated: false,
    interactionWidth: kind === 'calls' || isApiEdgeKind(kind) ? 8 : 16,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke,
    },
    style: {
      opacity: edgePresentation.opacity,
      stroke,
      strokeWidth: edgePresentation.strokeWidth,
    },
  }
}

function getEdgeImpactPresentation(kind: GraphEdgeKind, count: number) {
  if (kind === 'contains') {
    return {
      impact: 'low' as const,
      opacity: 0.12,
      strokeWidth: 1,
    }
  }

  if (kind === 'imports') {
    return {
      impact: 'low' as const,
      opacity: 0.18,
      strokeWidth: 1.1,
    }
  }

  if (isApiEdgeKind(kind)) {
    const safeCount = Math.max(1, count)
    const impactScore = Math.log2(safeCount + 1)

    return {
      impact:
        safeCount >= 4 ? 'high' as const : safeCount >= 2 ? 'medium' as const : 'low' as const,
      opacity: clamp(0.18 + impactScore * 0.12, 0.2, 0.82),
      strokeWidth: clamp(1.05 + impactScore * 0.24, 1.2, 3),
    }
  }

  if (kind !== 'calls') {
    return {
      impact: 'medium' as const,
      opacity: 0.28,
      strokeWidth: 1.3,
    }
  }

  const safeCount = Math.max(1, count)
  const impactScore = Math.log2(safeCount + 1)
  const opacity = clamp(0.12 + impactScore * 0.12, 0.14, 0.78)
  const strokeWidth = clamp(0.85 + impactScore * 0.28, 1, 3)

  return {
    impact:
      safeCount >= 6 ? 'high' as const : safeCount >= 2 ? 'medium' as const : 'low' as const,
    opacity,
    strokeWidth,
  }
}

function aggregateFileEdges(
  snapshot: CodebaseSnapshot,
  kind: GraphEdgeKind,
  viewportZoom = 1,
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
        label: formatCallEdgeLabel(nextCount, viewportZoom),
      })
      continue
    }

    edges.set(
      key,
      buildFlowEdge(key, kind, sourceFileId, targetFileId, undefined, {
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
  viewportZoom = 1,
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
      label: formatCallEdgeLabel(nextCount, viewportZoom),
    })
  }

  return Array.from(edges.values()).map((edge) => {
    if (kind !== 'calls') {
      return edge
    }

    const count = getFlowEdgeData(edge)?.count ?? 1

    return {
      ...edge,
      label: formatCallEdgeLabel(count, viewportZoom),
    }
  })
}

function getVisibleApiEdges(
  snapshot: CodebaseSnapshot,
  visibleNodeIds: Set<string>,
) {
  return snapshot.edges
    .filter((edge) => isApiEdgeKind(edge.kind))
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map((edge) =>
      buildFlowEdge(
        edge.id,
        edge.kind,
        edge.source,
        edge.target,
        edge.label,
        {
          kind: edge.kind,
          count: 1,
        },
      ),
    )
}

function getVisibleFilesystemApiEdges(
  snapshot: CodebaseSnapshot,
  visibleNodeIds: Set<string>,
  viewportZoom = 1,
) {
  const edges = new Map<string, Edge>()

  for (const edge of snapshot.edges) {
    if (!isApiEdgeKind(edge.kind)) {
      continue
    }

    const sourceFileId = getFileNodeId(snapshot, edge.source) ?? edge.source
    const targetFileId = getFileNodeId(snapshot, edge.target) ?? edge.target

    if (
      !sourceFileId ||
      !targetFileId ||
      sourceFileId === targetFileId ||
      !visibleNodeIds.has(sourceFileId) ||
      !visibleNodeIds.has(targetFileId)
    ) {
      continue
    }

    const key = `${edge.kind}:${sourceFileId}->${targetFileId}`
    const existingEdge = edges.get(key)

    if (existingEdge) {
      const existingData = getFlowEdgeData(existingEdge)
      const nextCount = (existingData?.count ?? 1) + 1

      edges.set(key, {
        ...existingEdge,
        data: {
          kind: edge.kind,
          count: nextCount,
        },
        label: formatApiEdgeLabel(edge.kind, nextCount, viewportZoom),
      })
      continue
    }

    edges.set(
      key,
      buildFlowEdge(
        key,
        edge.kind,
        sourceFileId,
        targetFileId,
        edge.label,
        {
          kind: edge.kind,
          count: 1,
        },
      ),
    )
  }

  return Array.from(edges.values())
}

function isApiEdgeKind(kind: GraphEdgeKind) {
  return kind === 'api_calls' || kind === 'handles'
}

function formatApiEdgeLabel(
  kind: GraphEdgeKind,
  count: number,
  viewportZoom = 1,
) {
  if (count <= 1) {
    return undefined
  }

  if (viewportZoom < 0.32 && count < 4) {
    return undefined
  }

  return kind === 'handles' ? `${count} handlers` : `${count} requests`
}

function formatCallEdgeLabel(count: number, viewportZoom = 1) {
  if (count <= 1) {
    return undefined
  }

  if (viewportZoom < 0.22 && count < 8) {
    return undefined
  }

  if (viewportZoom < 0.38 && count < 4) {
    return undefined
  }

  return `${count} calls`
}

function getZoomAwareCallEdgeRenderLimit(
  viewportZoom: number,
  selectedNodeCount: number,
) {
  if (selectedNodeCount > 0) {
    return DEFAULT_CALL_EDGE_RENDER_LIMIT
  }

  const zoom = Number.isFinite(viewportZoom) ? viewportZoom : 1

  if (zoom <= 0.055) {
    return 120
  }

  if (zoom <= 0.085) {
    return 170
  }

  if (zoom <= 0.13) {
    return 230
  }

  if (zoom <= 0.2) {
    return 320
  }

  if (zoom <= 0.32) {
    return 460
  }

  if (zoom <= 0.52) {
    return 580
  }

  return DEFAULT_CALL_EDGE_RENDER_LIMIT
}

function prioritizeCallEdgesForRendering(
  edges: Edge[],
  selectedNodeIds: Set<string>,
  limit: number,
) {
  if (edges.length <= limit) {
    return edges
  }

  return [...edges]
    .sort((left, right) => {
      const leftSelectedRank = isEdgeConnectedToSelection(left, selectedNodeIds) ? 0 : 1
      const rightSelectedRank = isEdgeConnectedToSelection(right, selectedNodeIds) ? 0 : 1

      if (leftSelectedRank !== rightSelectedRank) {
        return leftSelectedRank - rightSelectedRank
      }

      const leftCount = getFlowEdgeData(left)?.count ?? 1
      const rightCount = getFlowEdgeData(right)?.count ?? 1

      if (leftCount !== rightCount) {
        return rightCount - leftCount
      }

      return left.id.localeCompare(right.id)
    })
    .slice(0, limit)
}

function isEdgeConnectedToSelection(edge: Edge, selectedNodeIds: Set<string>) {
  if (selectedNodeIds.size === 0) {
    return false
  }

  return selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)
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

export function buildExpandedClusterLayouts(
  snapshot: CodebaseSnapshot | null,
  layout: LayoutSpec | null,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  symbolFootprints?: SymbolFootprintLookup,
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

    const rootDimensions =
      symbolFootprints?.get(rootNode.id, {
        extraMetaLabels: getRuntimeSymbolMetaLabels(
          symbolClusterState.callerCounts[rootNode.id] ?? 0,
          cluster.memberNodeIds.length,
          true,
        ),
      }) ??
      getSymbolNodeFootprint(
        rootNode,
        rootPlacement,
        {
          extraMetaLabels: getRuntimeSymbolMetaLabels(
            symbolClusterState.callerCounts[rootNode.id] ?? 0,
            cluster.memberNodeIds.length,
            true,
          ),
        },
        1,
        snapshot,
      )
    const rootWidth = rootDimensions.width
    const rootHeight = rootDimensions.height

    const memberIds = [...cluster.memberNodeIds]

    if (memberIds.length === 0) {
      continue
    }

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

    const sizeByNodeId = new Map<string, SymbolFootprint>()

    for (const memberId of memberIds) {
      const memberNode = snapshot.nodes[memberId]

      if (!memberNode || !isSymbolNode(memberNode)) {
        continue
      }

      sizeByNodeId.set(
        memberId,
        getExpandedClusterMemberDimensions(
          memberNode,
          layout.placements[memberId],
          snapshot,
          symbolFootprints,
        ),
      )
    }

    const orderedMemberIds = getExpandedClusterMemberOrder(
      memberIds,
      cluster,
      childIdsByOwner,
      layout,
      snapshot,
    )
    const packedLayout = packExpandedClusterMembers(
      orderedMemberIds,
      sizeByNodeId,
      rootWidth,
      rootHeight,
    )

    Object.assign(childPlacements, packedLayout.childPlacements)

    layouts.set(cluster.id, {
      rootNodeId: cluster.rootNodeId,
      width: packedLayout.width,
      height: packedLayout.height,
      childPlacements,
    })
  }

  return layouts
}

function getExpandedClusterMemberDimensions(
  memberNode: SymbolNode,
  placement: LayoutSpec['placements'][string] | undefined,
  snapshot: CodebaseSnapshot,
  symbolFootprints: SymbolFootprintLookup | undefined,
): SymbolFootprint {
  const footprint =
    symbolFootprints?.get(memberNode.id, { contained: true }) ??
    getSymbolNodeFootprint(
      memberNode,
      placement,
      { contained: true },
      1,
      snapshot,
    )

  return {
    ...footprint,
    width: Math.round(
      clamp(
        footprint.width,
        EXPANDED_CLUSTER_CHILD_WIDTH,
        EXPANDED_CLUSTER_CHILD_MAX_WIDTH,
      ),
    ),
    height: Math.round(
      clamp(
        footprint.height,
        EXPANDED_CLUSTER_CHILD_HEIGHT,
        EXPANDED_CLUSTER_CHILD_MAX_HEIGHT,
      ),
    ),
    compact: true,
  }
}

function getExpandedClusterMemberOrder(
  memberIds: string[],
  cluster: SymbolCluster,
  childIdsByOwner: Map<string, string[]>,
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot,
) {
  const orderedMemberIds: string[] = []
  const visited = new Set<string>()

  const visitChildren = (ownerId: string) => {
    for (const childId of childIdsByOwner.get(ownerId) ?? []) {
      if (visited.has(childId)) {
        continue
      }

      visited.add(childId)
      orderedMemberIds.push(childId)
      visitChildren(childId)
    }
  }

  visitChildren(cluster.rootNodeId)

  for (const memberId of [...memberIds].sort((leftId, rightId) =>
    compareClusterMemberOrder(leftId, rightId, layout, snapshot),
  )) {
    if (visited.has(memberId)) {
      continue
    }

    visited.add(memberId)
    orderedMemberIds.push(memberId)
  }

  return orderedMemberIds
}

function packExpandedClusterMembers(
  memberIds: string[],
  sizeByNodeId: Map<string, SymbolFootprint>,
  rootWidth: number,
  rootHeight: number,
) {
  const rowWidthLimit = getExpandedClusterTargetInnerWidth(
    memberIds,
    sizeByNodeId,
    rootWidth,
  )
  const rows: Array<{
    height: number
    ids: string[]
    width: number
  }> = []
  let currentRow: { height: number; ids: string[]; width: number } | null = null

  for (const memberId of memberIds) {
    const memberDimensions = sizeByNodeId.get(memberId)

    if (!memberDimensions) {
      continue
    }

    const nextWidth =
      currentRow && currentRow.ids.length > 0
        ? currentRow.width + EXPANDED_CLUSTER_GAP_X + memberDimensions.width
        : memberDimensions.width

    if (
      currentRow &&
      currentRow.ids.length > 0 &&
      nextWidth > rowWidthLimit
    ) {
      rows.push(currentRow)
      currentRow = null
    }

    if (!currentRow) {
      currentRow = {
        height: memberDimensions.height,
        ids: [memberId],
        width: memberDimensions.width,
      }
      continue
    }

    currentRow.ids.push(memberId)
    currentRow.width = nextWidth
    currentRow.height = Math.max(currentRow.height, memberDimensions.height)
  }

  if (currentRow && currentRow.ids.length > 0) {
    rows.push(currentRow)
  }

  const innerWidth = Math.max(
    Math.max(0, rootWidth - EXPANDED_CLUSTER_PADDING_X * 2),
    ...rows.map((row) => row.width),
  )
  const childPlacements: ExpandedClusterLayout['childPlacements'] = {}
  let currentY = rootHeight + EXPANDED_CLUSTER_PADDING_TOP

  for (const row of rows) {
    let currentX =
      EXPANDED_CLUSTER_PADDING_X + Math.max(0, (innerWidth - row.width) / 2)

    for (const memberId of row.ids) {
      const memberDimensions = sizeByNodeId.get(memberId)

      if (!memberDimensions) {
        continue
      }

      childPlacements[memberId] = {
        x: currentX,
        y: currentY + Math.max(0, (row.height - memberDimensions.height) / 2),
        width: memberDimensions.width,
        height: memberDimensions.height,
      }
      currentX += memberDimensions.width + EXPANDED_CLUSTER_GAP_X
    }

    currentY += row.height + EXPANDED_CLUSTER_GAP_Y
  }

  const packedHeight =
    rows.length > 0 ? currentY - EXPANDED_CLUSTER_GAP_Y : rootHeight

  return {
    width: Math.max(rootWidth, innerWidth + EXPANDED_CLUSTER_PADDING_X * 2),
    height:
      rows.length > 0
        ? packedHeight + EXPANDED_CLUSTER_PADDING_BOTTOM
        : rootHeight,
    childPlacements,
  }
}

function getExpandedClusterTargetInnerWidth(
  memberIds: string[],
  sizeByNodeId: Map<string, SymbolFootprint>,
  rootWidth: number,
) {
  const memberSizes = memberIds
    .map((memberId) => sizeByNodeId.get(memberId))
    .filter((size): size is SymbolFootprint => Boolean(size))

  if (memberSizes.length === 0) {
    return Math.max(0, rootWidth - EXPANDED_CLUSTER_PADDING_X * 2)
  }

  const maxChildWidth = Math.max(...memberSizes.map((size) => size.width))
  const minInnerWidth = Math.max(
    Math.max(0, rootWidth - EXPANDED_CLUSTER_PADDING_X * 2),
    maxChildWidth,
  )
  const packedArea = memberSizes.reduce(
    (sum, size) =>
      sum +
      (size.width + EXPANDED_CLUSTER_GAP_X) *
        (size.height + EXPANDED_CLUSTER_GAP_Y),
    0,
  )
  const areaBalancedWidth =
    Math.sqrt(packedArea) * EXPANDED_CLUSTER_PACK_ASPECT_WEIGHT
  const maxInnerWidth = Math.max(
    minInnerWidth,
    EXPANDED_CLUSTER_PACK_MAX_INNER_WIDTH,
  )

  return clamp(
    Math.max(minInnerWidth, areaBalancedWidth),
    minInnerWidth,
    maxInnerWidth,
  )
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

function getRuntimeSymbolMetaLabels(
  sharedCallerCount: number,
  clusterSize: number,
  clusterExpanded: boolean | undefined,
  runtimeMetadata?: FlowSymbolRuntimeMetadata,
) {
  const labels: string[] = []

  if (runtimeMetadata?.agentFocusIntent) {
    labels.push(formatAgentFocusIntentLabel(runtimeMetadata.agentFocusIntent))
  }

  if (runtimeMetadata?.agentFocusConfidence) {
    labels.push(formatAgentFocusConfidenceLabel(runtimeMetadata.agentFocusConfidence))
  }

  if ((runtimeMetadata?.agentFocusEventCount ?? 0) > 1) {
    labels.push(`${runtimeMetadata?.agentFocusEventCount} events`)
  }

  if (sharedCallerCount > 1) {
    labels.push(`${sharedCallerCount} callers`)
  }

  if (clusterSize > 0) {
    labels.push(`${clusterSize} internal ${clusterExpanded ? 'open' : 'hidden'}`)
  }

  return labels
}

function formatAgentFocusIntentLabel(intent: NonNullable<FlowSymbolRuntimeMetadata['agentFocusIntent']>) {
  switch (intent) {
    case 'edit':
      return 'edit'
    case 'mixed':
      return 'mixed'
    case 'read':
      return 'read'
  }
}

function formatAgentFocusConfidenceLabel(confidence: string) {
  switch (confidence) {
    case 'exact_symbol':
      return 'exact'
    case 'range_overlap':
      return 'range'
    case 'dirty_file':
      return 'dirty'
    case 'file_wide':
      return 'file-wide'
    default:
      return confidence
  }
}

export function getSymbolKindRank(symbol: SymbolNode) {
  if (symbol.facets.includes('api:handler')) {
    return 0
  }

  if (symbol.facets.includes('react:component')) {
    return 1
  }

  if (symbol.facets.includes('react:hook')) {
    return 2
  }

  switch (symbol.symbolKind) {
    case 'class':
      return 3
    case 'function':
      return 4
    case 'method':
      return 5
    case 'constant':
      return 6
    case 'variable':
      return 7
    case 'module':
      return 8
    default:
      return 9
  }
}

export function buildWorkspaceSidebarGroups(input: {
  layout: LayoutSpec | null
  snapshot: CodebaseSnapshot | null
}): WorkspaceSidebarGroup[] {
  if (!input.snapshot) {
    return []
  }

  const snapshot = input.snapshot

  const visibleSymbolIds = getWorkspaceSidebarSymbolIds(snapshot, input.layout)
  const symbolNodes = visibleSymbolIds
    .map((nodeId) => snapshot.nodes[nodeId])
    .filter((node): node is ProjectNode => Boolean(node))
    .filter(isSymbolNode)

  const groups = new Map<
    string,
    {
      id: string
      label: string
      tone: string
      items: WorkspaceSidebarGroupItem[]
      locTotal: number
    }
  >()

  for (const symbol of symbolNodes) {
    const semanticGroup = getSymbolSidebarSemanticGroup(symbol)
    const metric = getSymbolSidebarMetric(symbol)
    const ownerFile = snapshot.nodes[symbol.fileId]
    const subtitle = ownerFile && isFileNode(ownerFile) ? ownerFile.path : symbol.path
    const badge = getSymbolSidebarBadge(symbol)
    const currentGroup = groups.get(semanticGroup.id) ?? {
      id: semanticGroup.id,
      items: [],
      label: semanticGroup.label,
      locTotal: 0,
      tone: semanticGroup.tone,
    }

    currentGroup.items.push({
      badge,
      id: symbol.id,
      metric,
      subtitle,
      title: symbol.name,
    })
    currentGroup.locTotal += metric ?? 0
    groups.set(semanticGroup.id, currentGroup)
  }

  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      items: group.items.sort((left, right) => {
        const metricDelta = (right.metric ?? 0) - (left.metric ?? 0)

        if (metricDelta !== 0) {
          return metricDelta
        }

        return left.title.localeCompare(right.title)
      }),
      label: group.label,
      metricLabel: `${group.items.length} · ${group.locTotal} loc`,
      tone: group.tone,
    }))
    .sort((left, right) => {
      const leftRank = getSidebarGroupRank(left.id)
      const rightRank = getSidebarGroupRank(right.id)

      if (leftRank !== rightRank) {
        return leftRank - rightRank
      }

      return left.label.localeCompare(right.label)
    })
}

function getWorkspaceSidebarSymbolIds(
  snapshot: CodebaseSnapshot,
  layout: LayoutSpec | null,
) {
  if (
    layout &&
    (layout.nodeScope === 'symbols' || layout.nodeScope === 'mixed')
  ) {
    const hiddenNodeIds = new Set(layout.hiddenNodeIds)
    const visiblePlacedSymbolIds = Object.keys(layout.placements).filter((nodeId) => {
      if (hiddenNodeIds.has(nodeId)) {
        return false
      }

      const node = snapshot.nodes[nodeId]
      return Boolean(node && isSymbolNode(node))
    })

    if (visiblePlacedSymbolIds.length > 0) {
      return visiblePlacedSymbolIds
    }
  }

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .sort((left, right) => getSymbolKindRank(left) - getSymbolKindRank(right))
    .map((node) => node.id)
}

function getSymbolSidebarSemanticGroup(symbol: SymbolNode) {
  if (symbol.facets.includes('api:handler')) {
    return {
      id: 'api:handler',
      label: 'API Handlers',
      tone: '--cbv-kind-endpoint',
    }
  }

  if (symbol.facets.includes('react:component')) {
    return {
      id: 'react:component',
      label: 'Components',
      tone: '--cbv-kind-component',
    }
  }

  if (symbol.facets.includes('react:hook')) {
    return {
      id: 'react:hook',
      label: 'Hooks',
      tone: '--cbv-kind-hook',
    }
  }

  switch (symbol.symbolKind) {
    case 'class':
      return {
        id: 'symbol:class',
        label: 'Classes',
        tone: '--cbv-kind-class',
      }
    case 'module':
      return {
        id: 'symbol:module',
        label: 'Modules',
        tone: '--cbv-kind-module',
      }
    case 'constant':
      return {
        id: 'symbol:constant',
        label: 'Constants',
        tone: '--cbv-kind-constant',
      }
    case 'variable':
      return {
        id: 'symbol:variable',
        label: 'Variables',
        tone: '--cbv-kind-variable',
      }
    case 'method':
    case 'function':
      return {
        id: 'symbol:function',
        label: 'Functions',
        tone: '--cbv-kind-function',
      }
    default:
      return {
        id: 'symbol:unknown',
        label: 'Other',
        tone: '--cbv-kind-module',
      }
  }
}

function getSidebarGroupRank(groupId: string) {
  switch (groupId) {
    case 'api:handler':
      return 0
    case 'react:component':
      return 1
    case 'react:hook':
      return 2
    case 'symbol:class':
      return 3
    case 'symbol:function':
      return 4
    case 'symbol:constant':
      return 5
    case 'symbol:variable':
      return 6
    case 'symbol:module':
      return 7
    case 'symbol:unknown':
      return 8
    default:
      return 99
  }
}

function getSymbolSidebarBadge(symbol: SymbolNode) {
  if (symbol.facets.includes('api:handler')) {
    return 'api'
  }

  if (symbol.facets.includes('react:client-component')) {
    return 'client'
  }

  if (symbol.facets.includes('react:component')) {
    return 'react'
  }

  if (symbol.facets.includes('react:hook')) {
    return 'hook'
  }

  if (symbol.symbolKind === 'method') {
    return 'method'
  }

  if (symbol.symbolKind === 'module') {
    return 'module'
  }

  if (symbol.symbolKind === 'unknown') {
    return 'other'
  }

  return null
}

function getSymbolSidebarMetric(symbol: SymbolNode) {
  if (symbol.range) {
    return Math.max(1, symbol.range.end.line - symbol.range.start.line + 1)
  }

  return symbol.signature ? Math.max(1, Math.ceil(symbol.signature.length / 18)) : 1
}

export function getFileNodeId(
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

function orderFlowNodesForParentRendering(nodes: Node[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const originalIndexById = new Map(nodes.map((node, index) => [node.id, index]))
  const depthById = new Map<string, number>()

  const getDepth = (node: Node, visited = new Set<string>()): number => {
    const existingDepth = depthById.get(node.id)

    if (existingDepth != null) {
      return existingDepth
    }

    const parentId = node.parentId

    if (!parentId || visited.has(node.id)) {
      depthById.set(node.id, 0)
      return 0
    }

    const parentNode = nodeById.get(parentId)

    if (!parentNode) {
      depthById.set(node.id, 0)
      return 0
    }

    const nextVisited = new Set(visited)
    nextVisited.add(node.id)

    const depth = getDepth(parentNode, nextVisited) + 1
    depthById.set(node.id, depth)
    return depth
  }

  return [...nodes].sort((left, right) => {
    const leftDepth = getDepth(left)
    const rightDepth = getDepth(right)

    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth
    }

    return (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0)
  })
}

function getFilesystemNodeDepth(node: ProjectNode) {
  if (node.kind === 'directory') {
    return node.depth
  }

  return isFileNode(node) && node.parentId ? node.parentId.split('/').length : 0
}

export function getSelectedFile(
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

export function getPrimaryNode(
  snapshot: CodebaseSnapshot | null,
  nodeIds: string[],
) {
  if (!snapshot || nodeIds.length === 0) {
    return null
  }

  const primaryNodeId = nodeIds[0]

  return primaryNodeId ? snapshot.nodes[primaryNodeId] ?? null : null
}

export function getPrimaryFileFromNode(
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

export function formatWorkingSetLabel(context: {
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

export function buildWorkingSetTitle(
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

export function getWorkingSetPaths(context: {
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

export function buildAutonomousRunScopeFromContext(
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

export function getSelectedFiles(
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

export function getSelectedSymbols(
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

export function getNodeSubtitle(node: ProjectNode) {
  if (node.kind === 'directory') {
    return `${node.childIds.length} children`
  }

  if (node.kind === 'file') {
    return `${node.extension || 'no ext'} · ${formatFileSize(node.size)}`
  }

  if (isApiEndpointNode(node)) {
    return getApiEndpointSubtitle(node)
  }

  return node.symbolKind
}

function getApiEndpointSubtitle(node: ApiEndpointNode) {
  const sourceLabel =
    node.source === 'merged'
      ? 'client + server'
      : node.source === 'client'
        ? 'client request'
        : node.source === 'server'
          ? 'server route'
          : node.source
  const confidence = Math.round(node.confidence * 100)

  return `${sourceLabel} · ${confidence}%`
}

export function getDefaultNodeWidth(node: ProjectNode) {
  if (isApiEndpointNode(node)) {
    return API_ENDPOINT_NODE_WIDTH
  }

  if (node.kind === 'directory') {
    return 240
  }

  if (node.kind === 'file') {
    return 224
  }

  return DEFAULT_NODE_WIDTH
}

export function getDefaultNodeHeight(node: ProjectNode) {
  if (isApiEndpointNode(node)) {
    return API_ENDPOINT_NODE_HEIGHT
  }

  if (node.kind === 'directory') {
    return 68
  }

  if (node.kind === 'file') {
    return 54
  }

  return DEFAULT_NODE_HEIGHT
}

function getEdgeColor(kind: GraphEdgeKind) {
  switch (kind) {
    case 'api_calls':
      return '#2d7f73'
    case 'handles':
      return '#7c67b1'
    case 'imports':
      return '#346f66'
    case 'calls':
      return '#b95b38'
    case 'contains':
    default:
      return '#b9af9e'
  }
}

export function buildGraphSummary(
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

export function countVisibleLayoutNodes(
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

export function deriveSymbolClusterState(
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

export function updateLayoutPlacement(
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
  viewportZoom?: number,
) {
  const updateCanvasLayout = (
    getNextLayout: (layout: LayoutSpec) => LayoutSpec | null,
  ) =>
    updateActiveLayout(
      activeLayout,
      activeDraft,
      layouts,
      draftLayouts,
      setLayouts,
      setDraftLayouts,
      getNextLayout,
    )

  if (isAnnotationNodeId(nodeId)) {
    const annotationId = getAnnotationIdFromNodeId(nodeId)

    updateCanvasLayout((layout) => ({
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
    }))
    return
  }

  if (isLayoutGroupNodeId(nodeId)) {
    const groupId = getLayoutGroupIdFromNodeId(nodeId)

    updateCanvasLayout((layout) => ({
      ...layout,
      placements: buildUpdatedPlacementsForMovedGroup(
        layout,
        snapshot,
        viewMode,
        groupId,
        position,
        viewportZoom,
      ),
    }))
    return
  }

  updateCanvasLayout((layout) =>
    layout.placements[nodeId]
      ? {
          ...layout,
          placements: buildUpdatedPlacementsForMovedNode(
            layout,
            snapshot,
            viewMode,
            nodeId,
            position,
            viewportZoom,
          ),
        }
      : null,
  )
}

function updateActiveLayout(
  activeLayout: LayoutSpec | null,
  activeDraft: LayoutDraft | null,
  layouts: LayoutSpec[],
  draftLayouts: LayoutDraft[],
  setLayouts: (layouts: LayoutSpec[]) => void,
  setDraftLayouts: (draftLayouts: LayoutDraft[]) => void,
  getNextLayout: (layout: LayoutSpec) => LayoutSpec | null,
) {
  const updatedAt = new Date().toISOString()

  if (activeDraft?.layout) {
    setDraftLayouts(draftLayouts.map((draft) => {
      if (draft.id !== activeDraft.id || !draft.layout) {
        return draft
      }

      const layout = getNextLayout(draft.layout)

      return layout
        ? { ...draft, layout: { ...layout, updatedAt }, updatedAt }
        : draft
    }))
    return
  }

  if (!activeLayout) {
    return
  }

  setLayouts(layouts.map((layout) => {
    if (layout.id !== activeLayout.id) {
      return layout
    }

    const nextLayout = getNextLayout(layout)

    return nextLayout ? { ...nextLayout, updatedAt } : layout
  }))
}

export function buildUpdatedPlacementsForMovedNode(
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot | null,
  viewMode: VisualizerViewMode,
  nodeId: string,
  position: XYPosition,
  viewportZoom?: number,
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
    viewportZoom,
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

export function buildUpdatedPlacementsForMovedGroup(
  layout: LayoutSpec,
  snapshot: CodebaseSnapshot | null,
  viewMode: VisualizerViewMode,
  groupId: string,
  position: XYPosition,
  viewportZoom?: number,
) {
  if (!snapshot) {
    return layout.placements
  }

  const containers = buildLayoutGroupContainerIndex(snapshot, layout, viewMode, {
    viewportZoom,
  })
  const container = containers.containersById.get(groupId)

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
  viewportZoom?: number,
) {
  const groupContainer =
    layout.strategy === 'agent'
      ? (buildLayoutGroupContainerIndex(
          snapshot,
          layout,
          viewMode,
          { viewportZoom },
        ).containerByNodeId.get(nodeId) ?? null)
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

export function collectFilesystemDescendantNodeIds(
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

export function mergeLayoutsWithDefaults(
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

export function areLayoutListsEquivalent(
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
      layout.description === rightLayout?.description &&
      getLayoutNodeScope(layout) === getLayoutNodeScope(rightLayout) &&
      Object.keys(layout.placements).length === Object.keys(rightLayout?.placements ?? {}).length &&
      layout.annotations.length === (rightLayout?.annotations.length ?? 0) &&
      layout.hiddenNodeIds.length === (rightLayout?.hiddenNodeIds.length ?? 0)
    )
  })
}

export function areGroupPrototypeCachesEquivalent(
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

export function mergeDefaultLayoutWithExisting(
  generatedLayout: LayoutSpec,
  existingLayout: LayoutSpec | undefined,
) {
  if (!existingLayout) {
    return generatedLayout
  }

  if (shouldRefreshGeneratedDefaultLayout(generatedLayout, existingLayout)) {
    return {
      ...generatedLayout,
      annotations: existingLayout.annotations,
      hiddenNodeIds: existingLayout.hiddenNodeIds.filter((nodeId) =>
        Boolean(generatedLayout.placements[nodeId]),
      ),
    }
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

function shouldRefreshGeneratedDefaultLayout(
  generatedLayout: LayoutSpec,
  existingLayout: LayoutSpec,
) {
  const generatedDescription = generatedLayout.description ?? ''
  const existingDescription = existingLayout.description ?? ''
  const versionMarkers = [
    'symbol-spacing-v2',
    'semantic-spacing-v2',
    'semantic-spacing-v3',
    'semantic-spacing-v4',
  ]

  return versionMarkers.some(
    (marker) =>
      generatedDescription.includes(marker) &&
      !existingDescription.includes(marker),
  )
}

export function layoutsDifferMeaningfully(
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

export function getPreferredViewModeForLayout(layout: LayoutSpec) {
  return getLayoutNodeScope(layout) === 'symbols' ? 'symbols' : 'filesystem'
}

export function getLayoutNodeScope(layout: LayoutSpec | null | undefined): LayoutNodeScope {
  return layout?.nodeScope ?? 'filesystem'
}

export function getLayerTogglesForViewMode(
  viewMode: VisualizerViewMode,
): GraphLayerKey[] {
  return viewMode === 'symbols'
    ? ['contains', 'calls', 'api']
    : ['contains', 'imports', 'calls', 'api']
}

export function getFollowTargetZoom(input: {
  isEdit: boolean
  mode: TelemetryMode
  node: ProjectNode | null
}) {
  if (input.isEdit) {
    if (input.mode === 'symbols' && input.node && isSymbolNode(input.node)) {
      return FOLLOW_AGENT_EDIT_SYMBOL_ZOOM
    }

    return FOLLOW_AGENT_EDIT_FILE_ZOOM
  }

  if (input.mode === 'symbols' && input.node && isSymbolNode(input.node)) {
    return FOLLOW_AGENT_ACTIVITY_SYMBOL_ZOOM
  }

  return FOLLOW_AGENT_ACTIVITY_FILE_ZOOM
}

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function getAnnotationNodeId(annotationId: string) {
  return `annotation:${annotationId}`
}

export function getAnnotationIdFromNodeId(nodeId: string) {
  return nodeId.slice('annotation:'.length)
}

export function isAnnotationNodeId(nodeId: string) {
  return nodeId.startsWith('annotation:')
}

export function getFlowEdgeData(edge: Edge) {
  return edge.data as FlowEdgeData | undefined
}

export function formatFileSize(size: number) {
  if (size < 1_024) {
    return `${size} B`
  }

  if (size < 1_048_576) {
    return `${(size / 1_024).toFixed(1)} KB`
  }

  return `${(size / 1_048_576).toFixed(1)} MB`
}

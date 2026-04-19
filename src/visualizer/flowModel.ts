import {
  MarkerType,
  Position,
  type Edge,
  type Node,
  type XYPosition,
} from '@xyflow/react'

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
  type SymbolNode,
  type TelemetryMode,
  type VisualizerViewMode,
  type GroupPrototypeCacheSnapshot,
} from '../types'
import type {
  WorkspaceSidebarGroup,
  WorkspaceSidebarGroupItem,
} from '../components/shell/WorkspaceSidebar'

export type FlowEdgeData = Record<string, unknown> & {
  kind: GraphEdgeKind
  count?: number
  dimmed?: boolean
  highlighted?: boolean
}

const DEFAULT_CALL_EDGE_RENDER_LIMIT = 700

export interface FlowModelOptions {
  callEdgeRenderLimit?: number
  selectedNodeIds?: Set<string>
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
}

interface NodeDimensions {
  width: number
  height: number
  compact: boolean
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
const EXPANDED_CLUSTER_GAP_X = 14
const EXPANDED_CLUSTER_GAP_Y = 12
const EXPANDED_CLUSTER_PADDING_X = 14
const EXPANDED_CLUSTER_PADDING_TOP = 18
const EXPANDED_CLUSTER_PADDING_BOTTOM = 14
const DEFAULT_NODE_WIDTH = 240
const DEFAULT_NODE_HEIGHT = 108
const COMPACT_SYMBOL_NODE_WIDTH = 164
const COMPACT_SYMBOL_NODE_HEIGHT = 74
const FILESYSTEM_CONTAINER_PADDING_RIGHT = 18
const FILESYSTEM_CONTAINER_PADDING_BOTTOM = 18
const LAYOUT_GROUP_PADDING_X = 22
const LAYOUT_GROUP_PADDING_TOP = 112
const LAYOUT_GROUP_PADDING_BOTTOM = 44
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
  graphLayers: Record<GraphLayerKey, boolean>,
  viewMode: VisualizerViewMode,
  symbolClusterState: SymbolClusterState,
  expandedClusterIds: Set<string>,
  expandedClusterLayouts: Map<string, ExpandedClusterLayout>,
  filesystemContainerLayouts: Map<string, FilesystemContainerLayout>,
  layoutGroupContainers: Map<string, LayoutGroupContainer>,
  collapsedDirectoryIds: Set<string>,
  toggleCollapsedDirectory: (nodeId: string) => void,
  options: FlowModelOptions = {},
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
    const callEdges = viewMode === 'symbols'
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
        )

    edges.push(
      ...prioritizeCallEdgesForRendering(
        callEdges,
        options.selectedNodeIds ?? new Set(),
        options.callEdgeRenderLimit ?? DEFAULT_CALL_EDGE_RENDER_LIMIT,
      ),
    )
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
        kindClass: getSymbolVisualKindClass(node),
        tags: getNodeBadgeLabels(node, snapshot),
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
    interactionWidth: kind === 'calls' ? 8 : 16,
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
        label: formatCallEdgeLabel(nextCount),
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
      label: formatCallEdgeLabel(nextCount),
    })
  }

  return Array.from(edges.values()).map((edge) => {
    if (kind !== 'calls') {
      return edge
    }

    const count = getFlowEdgeData(edge)?.count ?? 1

    return {
      ...edge,
      label: formatCallEdgeLabel(count),
    }
  })
}

function formatCallEdgeLabel(count: number) {
  return count > 1 ? `${count} calls` : undefined
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

export function getSymbolVisualKindClass(symbol: SymbolNode) {
  if (symbol.facets.includes('react:hook')) {
    return 'hook'
  }

  if (symbol.facets.includes('react:component')) {
    return 'component'
  }

  switch (symbol.symbolKind) {
    case 'class':
    case 'function':
    case 'constant':
    case 'variable':
    case 'module':
      return symbol.symbolKind
    case 'method':
      return 'function'
    default:
      return 'module'
  }
}

export function getSymbolKindRank(symbol: SymbolNode) {
  if (symbol.facets.includes('react:component')) {
    return 0
  }

  if (symbol.facets.includes('react:hook')) {
    return 1
  }

  switch (symbol.symbolKind) {
    case 'class':
      return 2
    case 'function':
      return 3
    case 'method':
      return 4
    case 'constant':
      return 5
    case 'variable':
      return 6
    case 'module':
      return 7
    default:
      return 8
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
    case 'react:component':
      return 0
    case 'react:hook':
      return 1
    case 'symbol:class':
      return 2
    case 'symbol:function':
      return 3
    case 'symbol:constant':
      return 4
    case 'symbol:variable':
      return 5
    case 'symbol:module':
      return 6
    case 'symbol:unknown':
      return 7
    default:
      return 99
  }
}

function getSymbolSidebarBadge(symbol: SymbolNode) {
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

  return node.symbolKind
}

export function getNodeBadgeLabels(
  node: ProjectNode,
  snapshot: CodebaseSnapshot,
) {
  const tagLabelById = new Map(snapshot.tags.map((tag) => [tag.id, tag.label]))
  const facetLabelById = new Map(
    snapshot.facetDefinitions.map((facetDefinition) => [facetDefinition.id, facetDefinition.label]),
  )
  const facetLabels = node.facets
    .map((facetId) => facetLabelById.get(facetId) ?? formatFacetLabel(facetId))
  const tagLabels = node.tags.map((tagId) => tagLabelById.get(tagId) ?? tagId)

  return [...facetLabels, ...tagLabels].slice(0, 3)
}

export function formatFacetLabel(facetId: string) {
  const [, rawLabel = facetId] = facetId.split(':')

  return rawLabel
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function getDefaultNodeWidth(node: ProjectNode) {
  if (node.kind === 'directory') {
    return 240
  }

  if (node.kind === 'file') {
    return 224
  }

  return DEFAULT_NODE_WIDTH
}

export function getDefaultNodeHeight(node: ProjectNode) {
  if (node.kind === 'directory') {
    return 68
  }

  if (node.kind === 'file') {
    return 54
  }

  return DEFAULT_NODE_HEIGHT
}

export function getSymbolSubtitle(
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

export function buildUpdatedPlacementsForMovedNode(
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

export function buildUpdatedPlacementsForMovedGroup(
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
    ? ['contains', 'calls']
    : ['contains', 'imports', 'calls']
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

function formatFileSize(size: number) {
  if (size < 1_024) {
    return `${size} B`
  }

  if (size < 1_048_576) {
    return `${(size / 1_024).toFixed(1)} KB`
  }

  return `${(size / 1_048_576).toFixed(1)} MB`
}

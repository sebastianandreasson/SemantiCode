import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getConnectedEdges,
  getIncomers,
  getOutgoers,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  Position,
  type XYPosition,
} from '@xyflow/react'
import { useEffect } from 'react'

import {
  isDirectoryNode,
  isFileNode,
  type CodebaseFile,
  type CodebaseSnapshot,
  type GraphEdgeKind,
  type GraphLayerKey,
  type LayoutSpec,
  type ProjectNode,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { buildStructuralLayout } from '../layouts/structuralLayout'
import { CodebaseCanvasNode } from './CodebaseCanvasNode'

interface CodebaseVisualizerProps {
  snapshot?: CodebaseSnapshot | null
}

type FlowEdgeData = Record<string, unknown> & {
  kind: GraphEdgeKind
  count?: number
}

interface GraphSummary {
  incoming: number
  outgoing: number
  neighbors: ProjectNode[]
}

const nodeTypes = {
  codebaseNode: CodebaseCanvasNode,
}

export function CodebaseVisualizer({
  snapshot,
}: CodebaseVisualizerProps) {
  const currentSnapshot = useVisualizerStore((state) => state.snapshot)
  const layouts = useVisualizerStore((state) => state.layouts)
  const activeLayoutId = useVisualizerStore((state) => state.activeLayoutId)
  const selectedNodeId = useVisualizerStore((state) => state.selection.nodeId)
  const selectedEdgeId = useVisualizerStore((state) => state.selection.edgeId)
  const inspectorTab = useVisualizerStore((state) => state.selection.inspectorTab)
  const viewport = useVisualizerStore((state) => state.viewport)
  const graphLayers = useVisualizerStore((state) => state.graphLayers)
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setLayouts = useVisualizerStore((state) => state.setLayouts)
  const setActiveLayoutId = useVisualizerStore((state) => state.setActiveLayoutId)
  const setViewport = useVisualizerStore((state) => state.setViewport)
  const selectNode = useVisualizerStore((state) => state.selectNode)
  const selectEdge = useVisualizerStore((state) => state.selectEdge)
  const setInspectorTab = useVisualizerStore((state) => state.setInspectorTab)
  const toggleGraphLayer = useVisualizerStore((state) => state.toggleGraphLayer)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  useEffect(() => {
    if (snapshot === undefined) {
      return
    }

    setSnapshot(snapshot)
  }, [setSnapshot, snapshot])

  const effectiveSnapshot = snapshot ?? currentSnapshot

  useEffect(() => {
    if (!effectiveSnapshot) {
      setLayouts([])
      setActiveLayoutId(null)
      return
    }

    const structuralLayout = buildStructuralLayout(effectiveSnapshot)

    setLayouts([structuralLayout])
    setActiveLayoutId(structuralLayout.id)
  }, [effectiveSnapshot, setActiveLayoutId, setLayouts])

  const activeLayout =
    layouts.find((layout) => layout.id === activeLayoutId) ?? layouts[0] ?? null

  useEffect(() => {
    if (!effectiveSnapshot || !activeLayout) {
      setNodes([])
      setEdges([])
      return
    }

    const flowModel = buildFlowModel(effectiveSnapshot, activeLayout, graphLayers)

    setNodes(flowModel.nodes)
    setEdges(flowModel.edges)
  }, [activeLayout, effectiveSnapshot, graphLayers, setEdges, setNodes])

  useEffect(() => {
    decorateFlowState(selectedNodeId, selectedEdgeId, setNodes, setEdges)
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes])

  const files = effectiveSnapshot ? collectFiles(effectiveSnapshot) : []
  const selectedNode =
    selectedNodeId && effectiveSnapshot ? effectiveSnapshot.nodes[selectedNodeId] : null
  const selectedFile =
    selectedNode && isFileNode(selectedNode)
      ? selectedNode
      : files.find((file) => file.id === selectedNodeId) ?? files[0] ?? null
  const selectedEdge =
    selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null
  const graphSummary = buildGraphSummary(
    selectedNodeId,
    nodes,
    edges,
    effectiveSnapshot,
  )

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
      <section className="cbv-shell">
        <header className="cbv-toolbar">
          <div>
            <p className="cbv-eyebrow">Canvas layout</p>
            <strong>{activeLayout?.title ?? 'Folder structure'}</strong>
          </div>
          <div className="cbv-toolbar-meta">
            <span>{effectiveSnapshot.totalFiles} files</span>
            <span>{countEdgesOfKind(effectiveSnapshot, 'imports')} imports</span>
            <span>{countEdgesOfKind(effectiveSnapshot, 'calls')} calls</span>
          </div>
          <div className="cbv-layer-toggles">
            <LayerToggle
              active={graphLayers.filesystem}
              label="Filesystem"
              onClick={() => toggleGraphLayer('filesystem')}
            />
            <LayerToggle
              active={graphLayers.imports}
              label="Imports"
              onClick={() => toggleGraphLayer('imports')}
            />
            <LayerToggle
              active={graphLayers.calls}
              label="Calls"
              onClick={() => toggleGraphLayer('calls')}
            />
          </div>
        </header>

        <div className="cbv-workspace">
          <section className="cbv-canvas">
            <ReactFlow
              defaultViewport={viewport}
              edges={edges}
              fitView
              minZoom={0.2}
              nodeTypes={nodeTypes}
              nodes={nodes}
              onEdgeClick={(_, edge) => {
                selectEdge(edge.id)
              }}
              onEdgesChange={onEdgesChange}
              onMoveEnd={(_, flowViewport) => {
                setViewport(flowViewport)
              }}
              onNodeClick={(_, node) => {
                selectNode(node.id)
              }}
              onNodeDragStop={(_, node) => {
                updateLayoutPlacement(node.id, node.position, activeLayout, layouts, setLayouts)
              }}
              onNodesChange={onNodesChange}
              onPaneClick={() => {
                selectNode(null)
              }}
            >
              <Background
                color="#d8d1c3"
                gap={24}
                size={1}
                variant={BackgroundVariant.Dots}
              />
              <Controls showInteractive={false} />
              <MiniMap
                className="cbv-minimap"
                maskColor="rgba(44, 35, 27, 0.16)"
                pannable
                zoomable
              />
            </ReactFlow>
          </section>

          <aside className="cbv-inspector">
            <div className="cbv-panel-header">
              <p className="cbv-eyebrow">Inspector</p>
              <strong>{selectedNode?.path ?? selectedFile?.path ?? 'Nothing selected'}</strong>
            </div>

            <div className="cbv-inspector-tabs">
              <button
                className={inspectorTab === 'file' ? 'is-active' : ''}
                onClick={() => setInspectorTab('file')}
                type="button"
              >
                File
              </button>
              <button
                className={inspectorTab === 'graph' ? 'is-active' : ''}
                onClick={() => setInspectorTab('graph')}
                type="button"
              >
                Graph
              </button>
            </div>

            {inspectorTab === 'graph' ? (
              <GraphInspector
                selectedEdge={selectedEdge}
                selectedNode={selectedNode}
                summary={graphSummary}
              />
            ) : selectedFile ? (
              <>
                <div className="cbv-preview-meta">
                  <span>{formatFileSize(selectedFile.size)}</span>
                  <span>{selectedFile.extension || 'no extension'}</span>
                  <span>{describeContentState(selectedFile)}</span>
                </div>
                <pre className="cbv-code">
                  <code>{selectedFile.content ?? '// File content unavailable.'}</code>
                </pre>
              </>
            ) : (
              <div className="cbv-empty">
                <h2>No file selected</h2>
                <p>Select a file node on the canvas to inspect its contents.</p>
              </div>
            )}
          </aside>
        </div>
      </section>
    </ReactFlowProvider>
  )
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

function GraphInspector({
  selectedEdge,
  selectedNode,
  summary,
}: {
  selectedEdge: Edge | null
  selectedNode: ProjectNode | null
  summary: GraphSummary
}) {
  return (
    <div className="cbv-graph-inspector">
      {selectedEdge ? (
        <section className="cbv-graph-card">
          <p className="cbv-eyebrow">Selected edge</p>
          <strong>{selectedEdge.label ?? getFlowEdgeData(selectedEdge)?.kind ?? 'Graph edge'}</strong>
          <p>
            {selectedEdge.source} → {selectedEdge.target}
          </p>
        </section>
      ) : null}

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Selection</p>
        <strong>{selectedNode?.path ?? 'No node selected'}</strong>
        <p>
          {summary.incoming} incoming, {summary.outgoing} outgoing, {summary.neighbors.length}{' '}
          connected nodes
        </p>
      </section>

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Neighbors</p>
        {summary.neighbors.length ? (
          <ul className="cbv-neighbor-list">
            {summary.neighbors.slice(0, 12).map((neighbor) => (
              <li key={neighbor.id}>
                <strong>{neighbor.name}</strong>
                <span>{neighbor.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No visible graph neighbors for the current layer selection.</p>
        )}
      </section>
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
) {
  const nodes = Object.values(snapshot.nodes)
    .filter((node): node is Exclude<ProjectNode, { kind: 'symbol' }> => {
      if (node.kind === 'symbol') {
        return false
      }

      if (!graphLayers.filesystem && node.kind === 'directory') {
        return false
      }

      return Boolean(layout.placements[node.id])
    })
    .map((node) => {
      const placement = layout.placements[node.id]

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
        data: {
          title: node.name,
          subtitle: getNodeSubtitle(node),
          kind: node.kind,
          tags: node.tags.slice(0, 3),
          selected: false,
          dimmed: false,
        },
      } satisfies Node
    })

  const visibleNodeIds = new Set(nodes.map((node) => node.id))
  const edges: Edge[] = []

  if (graphLayers.filesystem) {
    edges.push(
      ...snapshot.edges
        .filter((edge) => edge.kind === 'contains')
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )
        .map((edge) => buildFlowEdge(edge.id, 'contains', edge.source, edge.target)),
    )
  }

  if (graphLayers.imports) {
    edges.push(
      ...snapshot.edges
        .filter((edge) => edge.kind === 'imports')
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        )
        .map((edge) =>
          buildFlowEdge(edge.id, 'imports', edge.source, edge.target, edge.label),
        ),
    )
  }

  if (graphLayers.calls) {
    edges.push(
      ...aggregateFileEdges(snapshot, 'calls')
        .filter(
          (edge) =>
            visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
        ),
    )
  }

  return { nodes, edges }
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
    data: data ?? { kind },
    animated: kind !== 'contains',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: stroke,
    },
    style: {
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

function getNodeSubtitle(node: ProjectNode) {
  if (node.kind === 'directory') {
    return `${node.childIds.length} children`
  }

  if (node.kind === 'file') {
    return `${node.extension || 'no ext'} · ${formatFileSize(node.size)}`
  }

  return node.symbolKind
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

function decorateFlowState(
  selectedNodeId: string | null,
  selectedEdgeId: string | null,
  setNodes: ReturnType<typeof useNodesState>[1],
  setEdges: ReturnType<typeof useEdgesState>[1],
) {
  setEdges((currentEdges) => {
    const selectedNodeIds = new Set<string>()
    const relatedEdgeIds = new Set<string>()

    setNodes((currentNodes) => {
      const selectedNode =
        selectedNodeId
          ? currentNodes.find((node) => node.id === selectedNodeId) ?? null
          : null
      const selectedEdge =
        selectedEdgeId
          ? currentEdges.find((edge) => edge.id === selectedEdgeId) ?? null
          : null

      if (selectedNode) {
        selectedNodeIds.add(selectedNode.id)

        for (const edge of getConnectedEdges([selectedNode], currentEdges)) {
          relatedEdgeIds.add(edge.id)
        }

        for (const node of getIncomers(selectedNode, currentNodes, currentEdges)) {
          selectedNodeIds.add(node.id)
        }

        for (const node of getOutgoers(selectedNode, currentNodes, currentEdges)) {
          selectedNodeIds.add(node.id)
        }
      }

      if (selectedEdge) {
        relatedEdgeIds.add(selectedEdge.id)
        selectedNodeIds.add(selectedEdge.source)
        selectedNodeIds.add(selectedEdge.target)
      }

      return currentNodes.map((node) => ({
        ...node,
        data: {
          ...(node.data ?? {}),
          selected: node.id === selectedNodeId,
          dimmed:
            selectedNodeIds.size > 0 &&
            !selectedNodeIds.has(node.id),
        },
      }))
    })

    return currentEdges.map((edge) => ({
      ...edge,
      animated:
        getFlowEdgeData(edge)?.kind !== 'contains' &&
        (relatedEdgeIds.size === 0 || relatedEdgeIds.has(edge.id)),
      style: {
        ...edge.style,
        opacity:
          relatedEdgeIds.size > 0 && !relatedEdgeIds.has(edge.id) ? 0.16 : 1,
      },
      labelStyle: {
        fill: '#4f463b',
        fontSize: 11,
      },
    }))
  })
}

function buildGraphSummary(
  selectedNodeId: string | null,
  nodes: Node[],
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

  const selectedNode = nodes.find((node) => node.id === selectedNodeId)

  if (!selectedNode) {
    return {
      incoming: 0,
      outgoing: 0,
      neighbors: [],
    }
  }

  const incomers = getIncomers(selectedNode, nodes, edges)
  const outgoers = getOutgoers(selectedNode, nodes, edges)
  const neighborIds = new Set([
    ...incomers.map((node) => node.id),
    ...outgoers.map((node) => node.id),
  ])

  return {
    incoming: incomers.length,
    outgoing: outgoers.length,
    neighbors: Array.from(neighborIds)
      .map((nodeId) => snapshot.nodes[nodeId])
      .filter((node): node is ProjectNode => Boolean(node)),
  }
}

function countEdgesOfKind(
  snapshot: CodebaseSnapshot,
  kind: GraphEdgeKind,
) {
  return snapshot.edges.filter((edge) => edge.kind === kind).length
}

function updateLayoutPlacement(
  nodeId: string,
  position: XYPosition,
  activeLayout: LayoutSpec | null,
  layouts: LayoutSpec[],
  setLayouts: (layouts: LayoutSpec[]) => void,
) {
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

function describeContentState(file: CodebaseFile) {
  if (file.content) {
    return 'loaded'
  }

  switch (file.contentOmittedReason) {
    case 'binary':
      return 'binary file'
    case 'too_large':
      return 'content capped'
    case 'read_error':
      return 'read failed'
    default:
      return 'metadata only'
  }
}

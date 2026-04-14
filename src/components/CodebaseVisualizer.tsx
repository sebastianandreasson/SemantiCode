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
import { useEffect, useRef, useState } from 'react'

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
  type SourceRange,
  type SymbolNode,
  type VisualizerViewMode,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { buildStructuralLayout } from '../layouts/structuralLayout'
import { buildSymbolLayout } from '../layouts/symbolLayout'
import { CodebaseAnnotationNode } from './CodebaseAnnotationNode'
import { CodebaseCanvasNode } from './CodebaseCanvasNode'
import { CodebaseSymbolNode } from './CodebaseSymbolNode'

interface CodebaseVisualizerProps {
  snapshot?: CodebaseSnapshot | null
  onAcceptDraft?: (draftId: string) => Promise<void>
  onRejectDraft?: (draftId: string) => Promise<void>
  layoutActionsPending?: boolean
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
  annotationNode: CodebaseAnnotationNode,
  codebaseNode: CodebaseCanvasNode,
  symbolNode: CodebaseSymbolNode,
}

export function CodebaseVisualizer({
  snapshot,
  onAcceptDraft,
  onRejectDraft,
  layoutActionsPending = false,
}: CodebaseVisualizerProps) {
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const currentSnapshot = useVisualizerStore((state) => state.snapshot)
  const draftLayouts = useVisualizerStore((state) => state.draftLayouts)
  const activeDraftId = useVisualizerStore((state) => state.activeDraftId)
  const layouts = useVisualizerStore((state) => state.layouts)
  const activeLayoutId = useVisualizerStore((state) => state.activeLayoutId)
  const selectedNodeId = useVisualizerStore((state) => state.selection.nodeId)
  const selectedEdgeId = useVisualizerStore((state) => state.selection.edgeId)
  const inspectorTab = useVisualizerStore((state) => state.selection.inspectorTab)
  const viewport = useVisualizerStore((state) => state.viewport)
  const graphLayers = useVisualizerStore((state) => state.graphLayers)
  const viewMode = useVisualizerStore((state) => state.viewMode)
  const setSnapshot = useVisualizerStore((state) => state.setSnapshot)
  const setDraftLayouts = useVisualizerStore((state) => state.setDraftLayouts)
  const setActiveDraftId = useVisualizerStore((state) => state.setActiveDraftId)
  const setLayouts = useVisualizerStore((state) => state.setLayouts)
  const setActiveLayoutId = useVisualizerStore((state) => state.setActiveLayoutId)
  const setViewport = useVisualizerStore((state) => state.setViewport)
  const setViewMode = useVisualizerStore((state) => state.setViewMode)
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
      setDraftLayouts([])
      setLayouts([])
      setActiveDraftId(null)
      setActiveLayoutId(null)
      return
    }

    const structuralLayout = buildStructuralLayout(effectiveSnapshot)
    const symbolLayout = buildSymbolLayout(effectiveSnapshot)
    const nextLayouts = mergeLayoutsWithDefaults(layouts, [
      structuralLayout,
      symbolLayout,
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

  useEffect(() => {
    if (!activeLayout) {
      return
    }

    const layoutViewMode = getPreferredViewModeForLayout(activeLayout)

    if (viewMode !== layoutViewMode) {
      setViewMode(layoutViewMode)
    }
  }, [activeLayout, setViewMode, viewMode])

  useEffect(() => {
    if (!effectiveSnapshot || !activeLayout) {
      setNodes([])
      setEdges([])
      return
    }

    const flowModel = buildFlowModel(
      effectiveSnapshot,
      activeLayout,
      graphLayers,
      viewMode,
    )

    setNodes(flowModel.nodes)
    setEdges(flowModel.edges)
  }, [activeLayout, effectiveSnapshot, graphLayers, setEdges, setNodes, viewMode])

  useEffect(() => {
    decorateFlowState(selectedNodeId, selectedEdgeId, setNodes, setEdges)
  }, [selectedEdgeId, selectedNodeId, setEdges, setNodes])

  const files = effectiveSnapshot ? collectFiles(effectiveSnapshot) : []
  const selectedNode =
    selectedNodeId && effectiveSnapshot ? effectiveSnapshot.nodes[selectedNodeId] : null
  const selectedSymbol = selectedNode && isSymbolNode(selectedNode) ? selectedNode : null
  const selectedFile = getSelectedFile(effectiveSnapshot, selectedNode, files)
  const selectedEdge =
    selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null
  const graphSummary = buildGraphSummary(
    selectedNodeId,
    nodes,
    edges,
    effectiveSnapshot,
  )
  const visibleLayerToggles = getLayerTogglesForViewMode(viewMode)

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
            <strong>{activeDraft?.layout?.title ?? activeLayout?.title ?? 'Folder structure'}</strong>
            <p className="cbv-eyebrow">
              {viewMode === 'symbols' ? 'Symbol graph' : 'Filesystem canvas'}
            </p>
          </div>

          <div className="cbv-toolbar-meta">
            <span>
              {viewMode === 'symbols'
                ? `${countSymbolNodes(effectiveSnapshot)} symbols`
                : `${effectiveSnapshot.totalFiles} files`}
            </span>
            {viewMode === 'filesystem' ? (
              <span>{countEdgesOfKind(effectiveSnapshot, 'imports')} imports</span>
            ) : null}
            <span>{countEdgesOfKind(effectiveSnapshot, 'calls')} calls</span>
          </div>

          <div className="cbv-layout-controls">
            <div className="cbv-mode-switch">
              <button
                className={viewMode === 'filesystem' ? 'is-active' : ''}
                onClick={() =>
                  activateViewMode(
                    'filesystem',
                    availableDraftLayouts,
                    layouts,
                    setViewMode,
                    setActiveDraftId,
                    setActiveLayoutId,
                  )
                }
                type="button"
              >
                Filesystem
              </button>
              <button
                className={viewMode === 'symbols' ? 'is-active' : ''}
                onClick={() =>
                  activateViewMode(
                    'symbols',
                    availableDraftLayouts,
                    layouts,
                    setViewMode,
                    setActiveDraftId,
                    setActiveLayoutId,
                  )
                }
                type="button"
              >
                Symbols
              </button>
            </div>

            <label className="cbv-layout-picker">
              <span className="cbv-eyebrow">Layouts</span>
              <select
                onChange={(event) => {
                  const value = event.target.value

                  if (!value) {
                    return
                  }

                  if (value.startsWith('draft:')) {
                    const nextDraftId = value.slice('draft:'.length)
                    const nextDraft =
                      availableDraftLayouts.find((draft) => draft.id === nextDraftId) ?? null

                    setActiveDraftId(nextDraftId)
                    setDraftActionError(null)

                    if (nextDraft?.layout) {
                      setViewMode(getPreferredViewModeForLayout(nextDraft.layout))
                    }

                    return
                  }

                  const nextLayoutId = value.slice('layout:'.length)
                  const nextLayout =
                    layouts.find((layout) => layout.id === nextLayoutId) ?? null

                  setActiveDraftId(null)
                  setActiveLayoutId(nextLayoutId)
                  setDraftActionError(null)

                  if (nextLayout) {
                    setViewMode(getPreferredViewModeForLayout(nextLayout))
                  }
                }}
                value={selectedLayoutValue}
              >
                {layouts.map((layout) => (
                  <option key={layout.id} value={`layout:${layout.id}`}>
                    {layout.title}
                  </option>
                ))}
                {availableDraftLayouts.map((draft) => (
                  <option key={draft.id} value={`draft:${draft.id}`}>
                    Draft: {draft.layout?.title ?? draft.id}
                  </option>
                ))}
              </select>
            </label>

            {activeDraft ? (
              <div className="cbv-draft-actions">
                <button
                  disabled={layoutActionsPending || !onAcceptDraft}
                  onClick={async () => {
                    if (!onAcceptDraft) {
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
                  }}
                  type="button"
                >
                  Accept Draft
                </button>
                <button
                  className="is-danger"
                  disabled={layoutActionsPending || !onRejectDraft}
                  onClick={async () => {
                    if (!onRejectDraft) {
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
                  }}
                  type="button"
                >
                  Reject Draft
                </button>
              </div>
            ) : null}
          </div>

          <div className="cbv-layer-toggles">
            {visibleLayerToggles.map((layer) => (
              <LayerToggle
                active={graphLayers[layer]}
                key={layer}
                label={getLayerLabel(layer, viewMode)}
                onClick={() => toggleGraphLayer(layer)}
              />
            ))}
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
                if (isAnnotationNodeId(node.id)) {
                  return
                }

                selectNode(node.id)
              }}
              onNodeDragStop={(_, node) => {
                updateLayoutPlacement(
                  node.id,
                  node.position,
                  activeLayout,
                  activeDraft,
                  layouts,
                  draftLayouts,
                  setLayouts,
                  setDraftLayouts,
                )
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

            {activeDraft ? (
              <div className="cbv-draft-summary">
                <strong>Draft Layout</strong>
                <p>{activeDraft.proposalEnvelope.rationale}</p>
                {activeDraft.proposalEnvelope.warnings[0] ? (
                  <p className="cbv-draft-warning">
                    {activeDraft.proposalEnvelope.warnings[0]}
                  </p>
                ) : null}
                {draftActionError ? (
                  <p className="cbv-draft-error">{draftActionError}</p>
                ) : null}
              </div>
            ) : null}

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
                  {selectedSymbol ? (
                    <span>
                      {selectedSymbol.symbolKind}
                      {selectedSymbol.range ? ` · line ${selectedSymbol.range.start.line}` : ''}
                    </span>
                  ) : null}
                </div>
                <CodePreview file={selectedFile} highlightedRange={selectedSymbol?.range} />
              </>
            ) : (
              <div className="cbv-empty">
                <h2>No file selected</h2>
                <p>Select a node on the canvas to inspect its contents.</p>
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

function CodePreview({
  file,
  highlightedRange,
}: {
  file: CodebaseFile
  highlightedRange?: SourceRange
}) {
  const previewRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    if (!previewRef.current || !highlightedRange) {
      return
    }

    const targetLine = previewRef.current.querySelector(
      `[data-line="${highlightedRange.start.line}"]`,
    )

    if (targetLine instanceof HTMLElement) {
      targetLine.scrollIntoView({
        block: 'center',
      })
    }
  }, [file.id, highlightedRange])

  if (!file.content) {
    return (
      <pre className="cbv-code">
        <code>{'// File content unavailable.'}</code>
      </pre>
    )
  }

  const lines = file.content.split('\n')
  const highlightedStartLine = highlightedRange?.start.line ?? -1
  const highlightedEndLine = highlightedRange?.end.line ?? -1

  return (
    <pre className="cbv-code" ref={previewRef}>
      <code>
        {lines.map((line, index) => {
          const lineNumber = index + 1
          const isHighlighted =
            highlightedRange !== undefined &&
            lineNumber >= highlightedStartLine &&
            lineNumber <= highlightedEndLine

          return (
            <span
              className={`cbv-code-line${isHighlighted ? ' is-highlighted' : ''}`}
              data-line={lineNumber}
              key={`${file.id}:${lineNumber}`}
            >
              <span className="cbv-code-line-number">{lineNumber}</span>
              <span className="cbv-code-line-content">
                {line.length > 0 ? line : ' '}
              </span>
            </span>
          )
        })}
      </code>
    </pre>
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
        return isSymbolNode(node)
      }

      return node.kind !== 'symbol'
    })
    .map((node) => buildFlowNode(node, layout.placements[node.id], snapshot, viewMode))
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
        .map((edge) => buildFlowEdge(edge.id, 'contains', edge.source, edge.target)),
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
          buildFlowEdge(edge.id, 'imports', edge.source, edge.target, edge.label),
        ),
    )
  }

  if (graphLayers.calls) {
    edges.push(
      ...(viewMode === 'symbols'
        ? snapshot.edges
            .filter((edge) => edge.kind === 'calls')
            .filter(
              (edge) =>
                visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
            )
            .map((edge) =>
              buildFlowEdge(edge.id, 'calls', edge.source, edge.target, edge.label),
            )
        : aggregateFileEdges(snapshot, 'calls').filter(
            (edge) =>
              visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
          )),
    )
  }

  return { nodes, edges }
}

function buildFlowNode(
  node: ProjectNode,
  placement: LayoutSpec['placements'][string],
  snapshot: CodebaseSnapshot,
  viewMode: VisualizerViewMode,
): Node {
  if (viewMode === 'symbols' && isSymbolNode(node)) {
    return {
      id: node.id,
      type: 'symbolNode',
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
        subtitle: getSymbolSubtitle(node, snapshot),
        kind: node.symbolKind,
        tags: node.tags.slice(0, 3),
        selected: false,
        dimmed: false,
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
    data: {
      title: node.name,
      subtitle: getNodeSubtitle(node),
      kind: node.kind,
      tags: node.tags.slice(0, 3),
      selected: false,
      dimmed: false,
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
          selected: isAnnotationNodeId(node.id) ? false : node.id === selectedNodeId,
          dimmed:
            isAnnotationNodeId(node.id)
              ? false
              : selectedNodeIds.size > 0 &&
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

function countSymbolNodes(snapshot: CodebaseSnapshot) {
  return Object.values(snapshot.nodes).filter(isSymbolNode).length
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
  const defaultLayoutIds = new Set(defaultLayouts.map((layout) => layout.id))
  const customLayouts = layouts.filter((layout) => !defaultLayoutIds.has(layout.id))

  return [...defaultLayouts, ...customLayouts]
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
      getLayoutNodeScope(layout) === getLayoutNodeScope(rightLayout)
    )
  })
}

function activateViewMode(
  nextViewMode: VisualizerViewMode,
  draftLayouts: LayoutDraft[],
  layouts: LayoutSpec[],
  setViewMode: (viewMode: VisualizerViewMode) => void,
  setActiveDraftId: (draftId: string | null) => void,
  setActiveLayoutId: (layoutId: string | null) => void,
) {
  setViewMode(nextViewMode)

  const matchingDraft = draftLayouts.find(
    (draft) =>
      draft.layout &&
      getPreferredViewModeForLayout(draft.layout) === nextViewMode,
  )

  if (matchingDraft) {
    setActiveDraftId(matchingDraft.id)
    return
  }

  const matchingLayout = layouts.find(
    (layout) => getPreferredViewModeForLayout(layout) === nextViewMode,
  )

  setActiveDraftId(null)
  setActiveLayoutId(matchingLayout?.id ?? null)
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

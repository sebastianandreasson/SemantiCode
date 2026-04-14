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
  type XYPosition,
} from '@xyflow/react'
import {
  useEffect,
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
  type SourceRange,
  type SymbolNode,
  type VisualizerViewMode,
} from '../types'
import { useVisualizerStore } from '../store/visualizerStore'
import { buildStructuralLayout } from '../layouts/structuralLayout'
import { buildSymbolLayout } from '../layouts/symbolLayout'
import { CodebaseAnnotationNode } from './CodebaseAnnotationNode'
import { AgentPanel } from './AgentPanel'
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
  isDesktop?: boolean
  openWorkspaceDialog?: () => Promise<boolean>
}

export function CodebaseVisualizer({
  snapshot,
  onAcceptDraft,
  onRejectDraft,
  layoutActionsPending = false,
}: CodebaseVisualizerProps) {
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const [canvasWidthRatio, setCanvasWidthRatio] = useState(DEFAULT_CANVAS_WIDTH_RATIO)
  const [activeResizePointerId, setActiveResizePointerId] = useState<number | null>(null)
  const [workspaceActionPending, setWorkspaceActionPending] = useState(false)
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null)
  const [desktopHostAvailable, setDesktopHostAvailable] = useState(false)
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
  const desktopBridge = (
    globalThis as typeof globalThis & {
      codebaseVisualizerDesktop?: DesktopBridge
    }
  ).codebaseVisualizerDesktop
  const isDesktopHost = desktopHostAvailable

  useEffect(() => {
    const updateDesktopHostAvailability = () => {
      const bridge = (
        globalThis as typeof globalThis & {
          codebaseVisualizerDesktop?: DesktopBridge
        }
      ).codebaseVisualizerDesktop

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
    setExpandedSymbolClusterIds([])
  }, [activeLayout?.id, setExpandedSymbolClusterIds])

  const symbolClusterState = useMemo(
    () => deriveSymbolClusterState(effectiveSnapshot, activeLayout, viewMode),
    [activeLayout, effectiveSnapshot, viewMode],
  )
  const expandedClusterIds = useMemo(
    () => new Set(expandedSymbolClusterIds),
    [expandedSymbolClusterIds],
  )
  const expandedClusterLayouts = useMemo(
    () =>
      buildExpandedClusterLayouts(
        effectiveSnapshot,
        activeLayout,
        symbolClusterState,
        expandedClusterIds,
      ),
    [activeLayout, effectiveSnapshot, expandedClusterIds, symbolClusterState],
  )

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
        symbolClusterState,
        expandedClusterIds,
        expandedClusterLayouts,
      )

    setNodes(flowModel.nodes)
    setEdges(flowModel.edges)
  }, [
    activeLayout,
    expandedClusterLayouts,
    effectiveSnapshot,
    expandedClusterIds,
    graphLayers,
    setEdges,
    setNodes,
    symbolClusterState,
    viewMode,
  ])

  const visibleNodeCount = useMemo(
    () =>
      effectiveSnapshot && activeLayout
        ? countVisibleLayoutNodes(
            effectiveSnapshot,
            activeLayout,
            viewMode,
            symbolClusterState,
            expandedClusterIds,
          )
        : 0,
    [activeLayout, effectiveSnapshot, expandedClusterIds, symbolClusterState, viewMode],
  )
  const denseCanvasMode = viewMode === 'symbols' && visibleNodeCount > 250
  const files = useMemo(
    () => (effectiveSnapshot ? collectFiles(effectiveSnapshot) : []),
    [effectiveSnapshot],
  )
  const selectedNode =
    selectedNodeId && effectiveSnapshot ? effectiveSnapshot.nodes[selectedNodeId] : null
  const selectedSymbol = selectedNode && isSymbolNode(selectedNode) ? selectedNode : null
  const selectedFile = getSelectedFile(effectiveSnapshot, selectedNode, files)
  const selectedEdge =
    selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null
  const graphSummary = buildGraphSummary(
    selectedNodeId,
    edges,
    effectiveSnapshot,
  )
  const workspaceName = effectiveSnapshot
    ? getWorkspaceName(effectiveSnapshot.rootDir)
    : 'Workspace'
  const visibleLayerToggles = getLayerTogglesForViewMode(viewMode)
  const inspectorWidthRatio = 1 - canvasWidthRatio

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
      await desktopBridge.openWorkspaceDialog()
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
          <div className="cbv-workspace-summary">
            <div>
              <strong>{workspaceName}</strong>
              <p className="cbv-eyebrow">{effectiveSnapshot.rootDir}</p>
            </div>
            {isDesktopHost ? (
              <div className="cbv-workspace-actions">
                <button
                  disabled={workspaceActionPending}
                  onClick={() => {
                    void handleOpenAnotherWorkspace()
                  }}
                  type="button"
                >
                  Open Another
                </button>
                <button
                  className="is-secondary"
                  disabled={workspaceActionPending}
                  onClick={() => {
                    void handleCloseWorkspace()
                  }}
                  type="button"
                >
                  Close
                </button>
              </div>
            ) : null}
            {workspaceActionError ? (
              <p className="cbv-workspace-error">{workspaceActionError}</p>
            ) : null}
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

	        <div
            className="cbv-workspace"
            ref={workspaceRef}
            style={{
              '--cbv-canvas-width': `${(canvasWidthRatio * 100).toFixed(2)}%`,
              '--cbv-inspector-width': `${(inspectorWidthRatio * 100).toFixed(2)}%`,
            } as CSSProperties}
          >
	          <section className="cbv-canvas">
	            {viewMode === 'symbols' ? (
	              <div className="cbv-canvas-legend">
	                <SymbolKindLegend />
	              </div>
	            ) : null}
	            <ReactFlow
              defaultViewport={viewport}
              edges={edges}
              fitView
              minZoom={0.2}
              nodeTypes={nodeTypes}
              nodes={nodes}
              onlyRenderVisibleElements
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
              {denseCanvasMode ? null : (
                <MiniMap
                  className="cbv-minimap"
                  maskColor="rgba(44, 35, 27, 0.16)"
                  pannable
                  zoomable
                />
              )}
            </ReactFlow>
          </section>

          <button
            aria-label="Resize canvas and inspector"
            className="cbv-workspace-resize-handle"
            onPointerDown={handleResizePointerDown}
            type="button"
          >
            <span />
          </button>

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
                className={inspectorTab === 'agent' ? 'is-active' : ''}
                onClick={() => setInspectorTab('agent')}
                type="button"
              >
                Agent
              </button>
              <button
                className={inspectorTab === 'graph' ? 'is-active' : ''}
                onClick={() => setInspectorTab('graph')}
                type="button"
              >
                Graph
              </button>
            </div>

            {inspectorTab === 'agent' ? (
              <AgentPanel desktopHostAvailable={isDesktopHost} />
            ) : inspectorTab === 'graph' ? (
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

function getWorkspaceName(rootDir: string) {
  const normalizedRootDir = rootDir.replace(/[\\/]+$/, '')
  const segments = normalizedRootDir.split(/[\\/]/)
  return segments[segments.length - 1] || rootDir
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
      draggable: !isContainedNode,
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

function countEdgesOfKind(
  snapshot: CodebaseSnapshot,
  kind: GraphEdgeKind,
) {
  return snapshot.edges.filter((edge) => edge.kind === kind).length
}

function countSymbolNodes(snapshot: CodebaseSnapshot) {
  return Object.values(snapshot.nodes).filter(isSymbolNode).length
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

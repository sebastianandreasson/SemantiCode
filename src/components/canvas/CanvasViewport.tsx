import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react'
import { memo, useState } from 'react'

import { CodebaseAnnotationNode } from '../CodebaseAnnotationNode'
import { CodebaseCanvasNode } from '../CodebaseCanvasNode'
import { CodebaseSymbolNode } from '../CodebaseSymbolNode'
import type { SemanticSearchMode } from '../../app/useSemanticSearchController'
import type { ThemeMode } from '../../app/themeBootstrap'
import type {
  FollowDebugState,
  GraphLayerKey,
  TelemetryMode,
  TelemetrySource,
  TelemetryWindow,
  VisualizerViewMode,
} from '../../types'

const SEMANTIC_SEARCH_MIN_LIMIT = 1
const SEMANTIC_SEARCH_MAX_LIMIT = 60

const nodeTypes = {
  annotationNode: CodebaseAnnotationNode,
  codebaseNode: CodebaseCanvasNode,
  symbolNode: CodebaseSymbolNode,
}

const SYMBOL_LEGEND_ITEMS = [
  { label: 'Component', kindClass: 'component' },
  { label: 'Hook', kindClass: 'hook' },
  { label: 'Class', kindClass: 'class' },
  { label: 'Function', kindClass: 'function' },
  { label: 'Constant', kindClass: 'constant' },
  { label: 'Variable', kindClass: 'variable' },
] as const

interface CanvasViewportProps {
  agentHeatDebugOpen: boolean
  agentHeatDebugState: FollowDebugState
  agentHeatHelperText: string
  agentHeatFollowEnabled: boolean
  agentHeatFollowText: string
  agentHeatMode: TelemetryMode
  agentHeatSource: TelemetrySource
  agentHeatWindow: TelemetryWindow
  compareOverlayActive: boolean
  compareSourceTitle: string | null
  denseCanvasMode: boolean
  edges: Edge[]
  graphLayers: Record<GraphLayerKey, boolean>
  nodes: Node[]
  onEdgeClick: (_event: unknown, edge: Edge) => void
  onEdgesChange: ReturnType<typeof useEdgesState<Edge>>[2]
  onInit: (instance: ReactFlowInstance<Node, Edge>) => void
  onAgentHeatModeChange: (mode: TelemetryMode) => void
  onAgentHeatSourceChange: (source: TelemetrySource) => void
  onToggleAgentHeatDebug: () => void
  onToggleAgentHeatFollow: () => void
  onAgentHeatWindowChange: (window: TelemetryWindow) => void
  onActivateCompareOverlay?: () => void
  onClearCompareOverlay?: () => void
  onMoveEnd: (_event: MouseEvent | TouchEvent | null, flowViewport: { x: number; y: number; zoom: number }) => void
  onNodeClick: (
    event: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
    node: Node,
  ) => void
  onNodeDoubleClick: (_event: unknown, node: Node) => void
  onNodeDrag: (_event: unknown, node: Node) => void
  onNodeDragStop: (_event: unknown, node: Node) => void
  onNodesChange: ReturnType<typeof useNodesState<Node>>[2]
  onSemanticSearchChange: (value: string) => void
  onSemanticSearchClear: () => void
  onSemanticSearchLimitChange: (value: number) => void
  onSemanticSearchModeChange: (mode: SemanticSearchMode) => void
  onSemanticSearchStrictnessChange: (value: number) => void
  onToggleLayer: (layer: GraphLayerKey) => void
  semanticSearchAvailable: boolean
  semanticSearchGroupSearchAvailable: boolean
  semanticSearchHelperText: string
  semanticSearchLimit: number
  semanticSearchMode: SemanticSearchMode
  semanticSearchPending: boolean
  semanticSearchQuery: string
  semanticSearchResultCount: number
  semanticSearchStrictness: number
  showCompareAction: boolean
  showSemanticSearch: boolean
  themeMode: ThemeMode
  utilitySummaryText: string
  viewMode: VisualizerViewMode
  viewport: { x: number; y: number; zoom: number }
  visibleLayerToggles: GraphLayerKey[]
}

export const CanvasViewport = memo(function CanvasViewport({
  agentHeatDebugOpen,
  agentHeatDebugState,
  agentHeatHelperText,
  agentHeatFollowEnabled,
  agentHeatFollowText,
  agentHeatMode,
  agentHeatSource,
  agentHeatWindow,
  compareOverlayActive,
  compareSourceTitle,
  denseCanvasMode,
  edges,
  graphLayers,
  nodes,
  onEdgeClick,
  onEdgesChange,
  onInit,
  onAgentHeatModeChange,
  onAgentHeatSourceChange,
  onToggleAgentHeatDebug,
  onToggleAgentHeatFollow,
  onAgentHeatWindowChange,
  onActivateCompareOverlay,
  onClearCompareOverlay,
  onMoveEnd,
  onNodeClick,
  onNodeDoubleClick,
  onNodeDrag,
  onNodeDragStop,
  onNodesChange,
  onSemanticSearchChange,
  onSemanticSearchClear,
  onSemanticSearchLimitChange,
  onSemanticSearchModeChange,
  onSemanticSearchStrictnessChange,
  onToggleLayer,
  semanticSearchAvailable,
  semanticSearchGroupSearchAvailable,
  semanticSearchHelperText,
  semanticSearchLimit,
  semanticSearchMode,
  semanticSearchPending,
  semanticSearchQuery,
  semanticSearchResultCount,
  semanticSearchStrictness,
  showCompareAction,
  showSemanticSearch,
  themeMode,
  utilitySummaryText,
  viewMode,
  viewport,
  visibleLayerToggles,
}: CanvasViewportProps) {
  const [utilityPaletteOpen, setUtilityPaletteOpen] = useState(false)
  const canvasDotColor = themeMode === 'dark' ? '#4f5f74' : '#d8d1c3'
  const minimapMaskColor =
    themeMode === 'dark' ? 'rgba(7, 9, 12, 0.42)' : 'rgba(44, 35, 27, 0.16)'
  const minimapBgColor = themeMode === 'dark' ? '#1b2028' : '#f7f1e5'
  const minimapNodeColor = (node: Node) => {
    const data =
      node.data && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : null

    if (node.type === 'annotationNode') {
      return themeMode === 'dark' ? '#5c6573' : '#c7bda9'
    }

    if (data?.groupContainer) {
      return themeMode === 'dark' ? '#5a5249' : '#cab790'
    }

    if (data?.container) {
      return themeMode === 'dark' ? '#4a5667' : '#d2c5b2'
    }

    if (node.type === 'symbolNode') {
      return themeMode === 'dark' ? '#57a395' : '#8fb7ac'
    }

    return themeMode === 'dark' ? '#667487' : '#b7ac9e'
  }

  return (
    <section className="cbv-canvas">
      <div className="cbv-canvas-overlays">
        <div className="cbv-canvas-utility-stack">
          <div className="cbv-canvas-legend-anchor">
            <SymbolKindLegend />
          </div>
          <div className="cbv-canvas-utility-anchor">
          <button
            aria-expanded={utilityPaletteOpen}
            className={`cbv-canvas-utility-trigger${utilityPaletteOpen ? ' is-open' : ''}`}
            onClick={() => setUtilityPaletteOpen((current) => !current)}
            title={utilitySummaryText}
            type="button"
          >
            <span className="cbv-eyebrow">canvas</span>
            <strong>{utilitySummaryText}</strong>
            <span className="cbv-canvas-utility-trigger-meta">
              {utilityPaletteOpen ? 'hide tools' : 'tools'}
            </span>
          </button>
          {utilityPaletteOpen ? (
            <div className="cbv-canvas-utility-popover">
              {showCompareAction ? (
                <section className="cbv-canvas-utility-section">
                  <div className="cbv-canvas-utility-section-header">
                    <p className="cbv-eyebrow">Compare</p>
                    {compareSourceTitle ? <span>{compareSourceTitle}</span> : null}
                  </div>
                  <div className="cbv-canvas-utility-compare">
                    <button
                      className={`cbv-toolbar-button${compareOverlayActive ? ' is-active' : ''}`}
                      onClick={onActivateCompareOverlay}
                      type="button"
                    >
                      {compareOverlayActive ? 'Comparing semantic view' : 'Compare semantic view'}
                    </button>
                    {compareOverlayActive && onClearCompareOverlay ? (
                      <button
                        className="cbv-toolbar-button is-secondary"
                        onClick={onClearCompareOverlay}
                        type="button"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}
              <section className="cbv-canvas-utility-section">
                <div className="cbv-canvas-utility-section-header">
                  <p className="cbv-eyebrow">Agent Heat</p>
                  <span>{agentHeatHelperText}</span>
                </div>
                <div className="cbv-agent-heat-panel">
                  <div className="cbv-agent-heat-controls">
                    <label>
                      <span>Source</span>
                      <select
                        onChange={(event) => {
                          onAgentHeatSourceChange(event.target.value as TelemetrySource)
                        }}
                        value={agentHeatSource}
                      >
                        <option value="all">All</option>
                        <option value="autonomous">Autonomous</option>
                        <option value="interactive">Interactive</option>
                      </select>
                    </label>
                    <label>
                      <span>Window</span>
                      <select
                        onChange={(event) => {
                          onAgentHeatWindowChange(parseTelemetryWindow(event.target.value))
                        }}
                        value={String(agentHeatWindow)}
                      >
                        <option value="30">30s</option>
                        <option value="60">60s</option>
                        <option value="120">2m</option>
                        <option value="run">Run</option>
                        <option value="workspace">Workspace</option>
                      </select>
                    </label>
                    <label>
                      <span>Mode</span>
                      <select
                        onChange={(event) => {
                          onAgentHeatModeChange(event.target.value as TelemetryMode)
                        }}
                        value={agentHeatMode}
                      >
                        <option value="files">Files</option>
                        <option value="symbols">Symbols</option>
                      </select>
                    </label>
                  </div>
                  <button
                    aria-pressed={agentHeatFollowEnabled}
                    className={`cbv-agent-heat-follow-toggle${agentHeatFollowEnabled ? ' is-active' : ''}`}
                    onClick={onToggleAgentHeatFollow}
                    type="button"
                  >
                    {agentHeatFollowEnabled ? 'Following active agent' : 'Follow active agent'}
                  </button>
                  <p className="cbv-agent-heat-follow-meta">{agentHeatFollowText}</p>
                  <button
                    aria-expanded={agentHeatDebugOpen}
                    className="cbv-agent-heat-debug-toggle"
                    onClick={onToggleAgentHeatDebug}
                    type="button"
                  >
                    {agentHeatDebugOpen ? 'Hide follow debug' : 'Show follow debug'}
                  </button>
                  {agentHeatDebugOpen ? (
                    <div className="cbv-agent-heat-debug">
                      <p>
                        <strong>Mode:</strong> {agentHeatDebugState.currentMode}
                      </p>
                      <p>
                        <strong>Event:</strong>{' '}
                        {agentHeatDebugState.latestEvent
                          ? formatFollowDebugEvent(agentHeatDebugState.latestEvent)
                          : 'None'}
                      </p>
                      <p>
                        <strong>Target:</strong>{' '}
                        {agentHeatDebugState.currentTarget
                          ? formatFollowDebugTarget(agentHeatDebugState.currentTarget)
                          : 'None'}
                      </p>
                      <p>
                        <strong>Queue:</strong> {agentHeatDebugState.queueLength}
                      </p>
                      <p>
                        <strong>Camera lock:</strong>{' '}
                        {agentHeatDebugState.cameraLockActive
                          ? formatFollowCameraLock(agentHeatDebugState.cameraLockUntilMs)
                          : 'Inactive'}
                      </p>
                      <p>
                        <strong>Refresh:</strong>{' '}
                        {agentHeatDebugState.refreshInFlight
                          ? 'In flight'
                          : agentHeatDebugState.refreshPending
                            ? 'Pending'
                            : 'Idle'}
                      </p>
                    </div>
                  ) : null}
                </div>
              </section>
              {showSemanticSearch ? (
                <section className="cbv-canvas-utility-section">
                  <div className="cbv-canvas-utility-section-header">
                    <p className="cbv-eyebrow">Semantic Search</p>
                    <span>{semanticSearchHelperText}</span>
                  </div>
                  <form
                    className={`cbv-semantic-search${semanticSearchPending ? ' is-pending' : ''}${semanticSearchAvailable ? '' : ' is-disabled'}`}
                    onSubmit={(event) => event.preventDefault()}
                  >
                    <div className="cbv-semantic-search-mode-toggle" role="tablist" aria-label="Semantic search mode">
                      <button
                        aria-pressed={semanticSearchMode === 'symbols'}
                        className={`cbv-semantic-search-mode${semanticSearchMode === 'symbols' ? ' is-active' : ''}`}
                        onClick={() => onSemanticSearchModeChange('symbols')}
                        type="button"
                      >
                        Symbols
                      </button>
                      <button
                        aria-pressed={semanticSearchMode === 'groups'}
                        className={`cbv-semantic-search-mode${semanticSearchMode === 'groups' ? ' is-active' : ''}`}
                        disabled={!semanticSearchGroupSearchAvailable}
                        onClick={() => onSemanticSearchModeChange('groups')}
                        type="button"
                      >
                        Folders
                      </button>
                    </div>
                    <div className="cbv-semantic-search-shell">
                      <input
                        aria-label="Search semantic projection"
                        className="cbv-semantic-search-input"
                        disabled={!semanticSearchAvailable}
                        onChange={(event) => {
                          onSemanticSearchChange(event.target.value)
                        }}
                        placeholder={
                          semanticSearchAvailable
                            ? semanticSearchMode === 'groups'
                              ? 'Search semantic folders'
                              : 'Search semantic symbols'
                            : 'Build embeddings to search'
                        }
                        value={semanticSearchQuery}
                      />
                      {semanticSearchQuery ? (
                        <button
                          aria-label="Clear semantic search"
                          className="cbv-semantic-search-clear"
                          onClick={onSemanticSearchClear}
                          type="button"
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <div className="cbv-semantic-search-controls">
                      <label className="cbv-semantic-search-slider">
                        <span>Matches</span>
                        <strong>{semanticSearchLimit}</strong>
                        <input
                          disabled={!semanticSearchAvailable}
                          max={SEMANTIC_SEARCH_MAX_LIMIT}
                          min={SEMANTIC_SEARCH_MIN_LIMIT}
                          onChange={(event) => {
                            onSemanticSearchLimitChange(Number(event.target.value))
                          }}
                          type="range"
                          value={semanticSearchLimit}
                        />
                      </label>
                      <label className="cbv-semantic-search-slider">
                        <span>Proximity</span>
                        <strong>{semanticSearchStrictness}</strong>
                        <input
                          disabled={!semanticSearchAvailable}
                          max={100}
                          min={0}
                          onChange={(event) => {
                            onSemanticSearchStrictnessChange(Number(event.target.value))
                          }}
                          type="range"
                          value={semanticSearchStrictness}
                        />
                      </label>
                    </div>
                    <p
                      className={`cbv-semantic-search-meta${semanticSearchResultCount > 0 ? ' has-results' : ''}${!semanticSearchAvailable ? ' is-disabled' : ''}`}
                    >
                      {semanticSearchHelperText}
                    </p>
                  </form>
                </section>
              ) : null}
              <section className="cbv-canvas-utility-section">
                <div className="cbv-canvas-utility-section-header">
                  <p className="cbv-eyebrow">Layers</p>
                  <span>{viewMode}</span>
                </div>
                <div className="cbv-canvas-layer-toggles">
                  {visibleLayerToggles.map((layer) => (
                    <LayerToggle
                      active={graphLayers[layer]}
                      key={layer}
                      label={getLayerLabel(layer, viewMode)}
                      onClick={() => onToggleLayer(layer)}
                    />
                  ))}
                </div>
              </section>
            </div>
          ) : null}
          </div>
        </div>
      </div>
      <ReactFlow
        defaultViewport={viewport}
        edges={edges}
        fitView
        maxZoom={4}
        minZoom={0.03}
        nodeTypes={nodeTypes}
        nodes={nodes}
        onlyRenderVisibleElements
        onEdgeClick={onEdgeClick}
        onEdgesChange={onEdgesChange}
        onInit={onInit}
        onMoveEnd={onMoveEnd}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={onNodesChange}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={canvasDotColor} gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls showInteractive={false} />
        {denseCanvasMode ? null : (
          <MiniMap
            bgColor={minimapBgColor}
            className="cbv-minimap"
            maskColor={minimapMaskColor}
            nodeColor={minimapNodeColor}
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </section>
  )
})

function parseTelemetryWindow(value: string): TelemetryWindow {
  if (value === '30') {
    return 30
  }

  if (value === '120') {
    return 120
  }

  if (value === 'run') {
    return 'run'
  }

  if (value === 'workspace') {
    return 'workspace'
  }

  return 60
}

function formatFollowDebugEvent(event: FollowDebugState['latestEvent']) {
  if (!event) {
    return 'None'
  }

  if ('path' in event) {
    return `${event.type} · ${event.path}`
  }

  if (event.type === 'view_changed') {
    return `${event.type} · ${event.mode}`
  }

  return event.type
}

function formatFollowDebugTarget(target: FollowDebugState['currentTarget']) {
  if (!target) {
    return 'None'
  }

  return `${target.kind} · ${target.path} · ${target.confidence}`
}

function formatFollowCameraLock(cameraLockUntilMs: number) {
  const remainingMs = Math.max(0, cameraLockUntilMs - Date.now())
  return remainingMs > 0 ? `${(remainingMs / 1000).toFixed(1)}s` : 'Inactive'
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

function getLayerLabel(
  layer: GraphLayerKey,
  viewMode: VisualizerViewMode,
) {
  if (layer === 'contains') {
    return viewMode === 'symbols' ? 'Contains' : 'Structure'
  }

  return layer === 'imports' ? 'Imports' : 'Calls'
}

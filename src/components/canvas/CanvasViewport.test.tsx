import type { ComponentProps, ReactNode } from 'react'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasViewport } from './CanvasViewport'

type CanvasViewportProps = ComponentProps<typeof CanvasViewport>

const reactFlowMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}))

vi.mock('@xyflow/react', async () => {
  const react = await vi.importActual<typeof import('react')>('react')
  const createElement = react.createElement

  return {
    Background: () => createElement('div', { 'data-testid': 'background' }),
    BackgroundVariant: { Dots: 'dots' },
    Controls: () => createElement('div', { 'data-testid': 'controls' }),
    MiniMap: () => createElement('div', { 'data-testid': 'minimap' }),
    ReactFlow: (props: { children?: ReactNode } & Record<string, unknown>) => {
      reactFlowMock.props.push(props)

      return createElement('div', { 'data-testid': 'react-flow' }, props.children)
    },
    useEdgesState: () => [[], () => undefined, () => undefined],
    useNodesState: () => [[], () => undefined, () => undefined],
  }
})

describe('CanvasViewport', () => {
  beforeEach(() => {
    reactFlowMock.props.length = 0
  })

  it('does not let React Flow raise selected folder containers above their contents', () => {
    renderCanvasViewport()

    expect(reactFlowMock.props[0]?.elevateNodesOnSelect).toBe(false)
  })

  it('disables React Flow viewport culling when rendering nested nodes', () => {
    renderCanvasViewport({
      nodes: [
        {
          data: {},
          id: 'symbol:parent',
          position: { x: 0, y: 0 },
        },
        {
          data: {},
          id: 'symbol:child',
          parentId: 'symbol:parent',
          position: { x: 16, y: 72 },
        },
      ],
    })

    expect(reactFlowMock.props[0]?.onlyRenderVisibleElements).toBe(false)
  })
})

function renderCanvasViewport(overrides: Partial<CanvasViewportProps> = {}) {
  return render(
    <CanvasViewport
      {...DEFAULT_CANVAS_VIEWPORT_PROPS}
      {...overrides}
    />,
  )
}

const noop = () => undefined

const DEFAULT_CANVAS_VIEWPORT_PROPS = {
  agentFocusActive: false,
  agentFocusEmptyText: '',
  agentFocusSummaryText: '',
  agentHeatDebugOpen: false,
  agentHeatDebugState: {
    cameraLockActive: false,
    cameraLockUntilMs: 0,
    currentMode: 'idle',
    currentTarget: null,
    latestEvent: null,
    queueLength: 0,
    refreshInFlight: false,
    refreshPending: false,
  },
  agentHeatFollowEnabled: false,
  agentHeatFollowText: '',
  agentHeatHelperText: '',
  agentHeatMode: 'files',
  agentHeatSource: 'all',
  agentHeatWindow: 60,
  compareOverlayActive: false,
  compareSourceTitle: null,
  denseCanvasMode: true,
  edges: [],
  graphLayers: { calls: false, contains: false, imports: false },
  nodes: [],
  onActivateCompareOverlay: noop,
  onAgentHeatModeChange: noop,
  onAgentHeatSourceChange: noop,
  onAgentHeatWindowChange: noop,
  onClearCompareOverlay: noop,
  onEdgeClick: noop,
  onEdgesChange: noop,
  onInit: noop,
  onMoveEnd: noop,
  onNodeClick: noop,
  onNodeDoubleClick: noop,
  onNodeDrag: noop,
  onNodeDragStop: noop,
  onNodesChange: noop,
  onOpenAgentEventFeed: noop,
  onSemanticSearchChange: noop,
  onSemanticSearchClear: noop,
  onSemanticSearchLimitChange: noop,
  onSemanticSearchModeChange: noop,
  onSemanticSearchStrictnessChange: noop,
  onToggleAgentHeatDebug: noop,
  onToggleAgentHeatFollow: noop,
  onToggleLayer: noop,
  semanticSearchAvailable: false,
  semanticSearchGroupSearchAvailable: false,
  semanticSearchHelperText: '',
  semanticSearchLimit: 10,
  semanticSearchMode: 'symbols',
  semanticSearchPending: false,
  semanticSearchQuery: '',
  semanticSearchResultCount: 0,
  semanticSearchStrictness: 50,
  showCompareAction: false,
  showSemanticSearch: false,
  themeMode: 'dark',
  utilitySummaryText: '',
  viewMode: 'symbols',
  viewport: { x: 0, y: 0, zoom: 1 },
  visibleLayerToggles: [],
} satisfies CanvasViewportProps

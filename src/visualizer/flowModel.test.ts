import type { Edge, Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'

import type {
  CodebaseSnapshot,
  LayoutSpec,
  SymbolKind,
  SymbolNode,
} from '../types'
import {
  applyFlowEdgePresentation,
  applyFlowNodePresentation,
  buildExpandedClusterLayouts,
  buildLayoutGroupContainerIndex,
  buildFlowModel,
  buildUpdatedPlacementsForMovedNode,
  buildWorkspaceSidebarGroups,
  createSymbolFootprintLookup,
  deriveSymbolClusterState,
  getLayoutGroupNodeId,
  mergeDefaultLayoutWithExisting,
  type SymbolClusterState,
} from './flowModel'

describe('flowModel extracted helpers', () => {
  it('groups the workspace outline by semantic facets before core symbol kinds', () => {
    const snapshot = buildSnapshot([
      symbol('api', 'upload_files', 'api:handler', 'function', 1, 24),
      symbol('component', 'Dashboard', 'react:component', 'function', 1, 40),
      symbol('hook', 'useTodos', 'react:hook', 'function', 1, 12),
      symbol('class', 'TodoStore', null, 'class', 1, 18),
      symbol('smallComponent', 'Badge', 'react:component', 'function', 1, 8),
    ])
    const layout = buildSymbolLayout(['api', 'component', 'hook', 'class', 'smallComponent'])

    const groups = buildWorkspaceSidebarGroups({ layout, snapshot })

    expect(groups.map((group) => group.id)).toEqual([
      'api:handler',
      'react:component',
      'react:hook',
      'symbol:class',
    ])
    expect(groups[0]?.label).toBe('API Handlers')
    expect(groups[0]?.items[0]).toMatchObject({
      badge: 'api',
      title: 'upload_files',
    })
    expect(groups[1]?.items.map((item) => item.title)).toEqual(['Dashboard', 'Badge'])
    expect(groups[1]?.items.map((item) => item.metric)).toEqual([40, 8])
    expect(groups[1]?.items[0]?.badge).toBe('react')
  })

  it('applies selected, compare, heat, and dimming presentation to flow nodes', () => {
    const nodes: Node[] = [
      { id: 'hot', position: { x: 0, y: 0 }, data: {} },
      { id: 'selected', position: { x: 0, y: 0 }, data: {} },
      { id: 'cold', position: { x: 0, y: 0 }, data: {} },
    ]

    const presented = applyFlowNodePresentation(
      nodes,
      new Set(['selected']),
      {
        active: true,
        nodeIds: new Set(['hot']),
      },
      new Map([['hot', { pulse: true, weight: 0.75 }]]),
    )

    expect(presented[0]?.data).toMatchObject({
      dimmed: false,
      heatPulse: true,
      heatWeight: 0.75,
      highlighted: true,
    })
    expect(presented[1]?.selected).toBe(true)
    expect(presented[1]?.data).toMatchObject({ dimmed: true, highlighted: false })
    expect(presented[2]?.data).toMatchObject({ dimmed: true, highlighted: false })
  })

  it('dims non-highlighted edges and promotes highlighted compare edges', () => {
    const edges: Edge[] = [
      {
        id: 'selected-edge',
        source: 'a',
        target: 'b',
        data: { kind: 'calls' },
      },
      {
        id: 'dimmed-edge',
        source: 'a',
        target: 'c',
        data: { kind: 'imports' },
      },
    ]

    const presented = applyFlowEdgePresentation(edges, {
      active: true,
      nodeIds: new Set(['a', 'b']),
    })

    expect(presented[0]?.data).toMatchObject({ highlighted: true, dimmed: false })
    expect(presented[0]?.style).toMatchObject({ opacity: 1, strokeWidth: 2.4 })
    expect(presented[1]?.data).toMatchObject({ highlighted: false, dimmed: true })
    expect(presented[1]?.style).toMatchObject({ opacity: 0.08 })
  })

  it('reduces low-impact edge opacity while promoting aggregated call edges', () => {
    const edges: Edge[] = [
      {
        id: 'low-call',
        source: 'a',
        target: 'b',
        data: { count: 1, kind: 'calls' },
      },
      {
        id: 'high-call',
        source: 'a',
        target: 'c',
        data: { count: 10, kind: 'calls' },
      },
      {
        id: 'contains',
        source: 'a',
        target: 'd',
        data: { kind: 'contains' },
      },
    ]

    const presented = applyFlowEdgePresentation(edges, {
      active: false,
      nodeIds: new Set(),
    })

    expect(presented[0]?.data).toMatchObject({ impact: 'low' })
    expect(presented[1]?.data).toMatchObject({ impact: 'high' })
    expect(presented[2]?.data).toMatchObject({ impact: 'low' })
    expect(Number(presented[0]?.style?.opacity)).toBeLessThan(
      Number(presented[1]?.style?.opacity),
    )
    expect(Number(presented[2]?.style?.opacity)).toBeLessThan(
      Number(presented[0]?.style?.opacity),
    )
  })

  it('renders fewer call edges and fewer labels in far overview zoom', () => {
    const symbols = Array.from({ length: 180 }, (_, index) =>
      symbol(`symbol${index}`, `symbol${index}`, null, 'function', index + 1, index + 2),
    )
    const snapshot = buildSnapshot(symbols)
    snapshot.edges = symbols.slice(1).map((target, index) => ({
      id: `call:${index}`,
      kind: 'calls',
      source: symbols[0]?.id ?? '',
      target: target.id,
    }))
    const layout = buildSymbolLayout(symbols.map((item) => item.id))
    const buildModel = (viewportZoom: number) =>
      buildFlowModel(
        snapshot,
        layout,
        { contains: false, imports: false, calls: true },
        'symbols',
        emptySymbolClusterState(),
        new Set<string>(),
        new Map(),
        new Map(),
        new Map(),
        new Set<string>(),
        () => {},
        { viewportZoom },
      )

    const overview = buildModel(0.055)
    const detail = buildModel(0.8)

    expect(overview.edges.length).toBeLessThan(detail.edges.length)
    expect(overview.edges.length).toBe(120)
    expect(detail.edges.length).toBe(snapshot.edges.length)
    expect(overview.edges.every((edge) => !edge.label)).toBe(true)
  })

  it('suppresses low-count call labels until the graph is zoomed in', () => {
    const snapshot = buildSnapshot([
      symbol('source', 'source', null, 'function', 1, 3),
      symbol('target', 'target', null, 'function', 5, 7),
    ])
    snapshot.edges = Array.from({ length: 3 }, (_, index) => ({
      id: `call:${index}`,
      kind: 'calls',
      source: 'source',
      target: 'target',
    }))
    const layout = buildSymbolLayout(['source', 'target'])
    const buildModel = (viewportZoom: number) =>
      buildFlowModel(
        snapshot,
        layout,
        { contains: false, imports: false, calls: true },
        'symbols',
        emptySymbolClusterState(),
        new Set<string>(),
        new Map(),
        new Map(),
        new Map(),
        new Set<string>(),
        () => {},
        { viewportZoom },
      )

    expect(buildModel(0.13).edges[0]?.label).toBeUndefined()
    expect(buildModel(0.8).edges[0]?.label).toBe('3 calls')
  })

  it('moves filesystem directory descendants with the dragged directory', () => {
    const snapshot = buildFilesystemSnapshot()
    const layout: LayoutSpec = {
      id: 'filesystem',
      title: 'Filesystem',
      strategy: 'structural',
      nodeScope: 'filesystem',
      placements: {
        dir: { nodeId: 'dir', x: 0, y: 0 },
        file: { nodeId: 'file', x: 20, y: 30 },
      },
      groups: [],
      lanes: [],
      annotations: [],
      hiddenNodeIds: [],
    }

    const placements = buildUpdatedPlacementsForMovedNode(
      layout,
      snapshot,
      'filesystem',
      'dir',
      { x: 10, y: 15 },
    )

    expect(placements.dir).toMatchObject({ x: 10, y: 15 })
    expect(placements.file).toMatchObject({ x: 30, y: 45 })
  })

  it('scales symbol node dimensions based on LOC', () => {
    const snapshot = buildSnapshot([
      symbol('small', 'smallHelper', null, 'function', 1, 4),
      symbol('large', 'largeWorkflow', null, 'function', 1, 120),
    ])
    const layout = buildSymbolLayout(['small', 'large'])

    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      { callerCounts: {}, clusterByNodeId: {}, clusters: [] },
      new Set(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      () => {},
    )
    const small = model.nodes.find((node) => node.id === 'small')
    const large = model.nodes.find((node) => node.id === 'large')

    expect(small?.width).toBeLessThan(large?.width ?? 0)
    expect(small?.height).toBeLessThan(large?.height ?? 0)
    expect(large?.data).toMatchObject({ loc: 120 })
  })

  it('amplifies LOC scaling when zoomed out and damps it when zoomed in', () => {
    const snapshot = buildSnapshot([
      symbol('large', 'largeWorkflow', null, 'function', 1, 160),
    ])
    const layout = buildSymbolLayout(['large'])
    const buildModel = (viewportZoom: number) =>
      buildFlowModel(
        snapshot,
        layout,
        { contains: false, imports: false, calls: false },
        'symbols',
        emptySymbolClusterState(),
        new Set<string>(),
        new Map(),
        new Map(),
        new Map(),
        new Set<string>(),
        () => {},
        { viewportZoom },
      )
    const zoomedOut = buildModel(0.18)
    const zoomedIn = buildModel(2.6)
    const zoomedOutNode = zoomedOut.nodes.find((node) => node.id === 'large')
    const zoomedInNode = zoomedIn.nodes.find((node) => node.id === 'large')

    expect(zoomedOutNode?.width).toBeGreaterThan(zoomedInNode?.width ?? 0)
    expect(zoomedOutNode?.height).toBeGreaterThan(zoomedInNode?.height ?? 0)
    expect(getLocScale(zoomedOutNode)).toBeGreaterThan(getLocScale(zoomedInNode))
    expect(getContentScale(zoomedOutNode)).toBeGreaterThan(
      getContentScale(zoomedInNode),
    )
    expect(getContentScale(zoomedOutNode)).toBeGreaterThan(4)
  })

  it('keeps scaled symbol nodes wide enough for long names', () => {
    const snapshot = buildSnapshot([
      symbol(
        'large',
        'processExtremelyLargeWorkspaceTelemetryActivityBatch',
        null,
        'function',
        1,
        180,
      ),
    ])
    const layout = buildSymbolLayout(['large'])

    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      new Map(),
      new Set<string>(),
      () => {},
      { viewportZoom: 0.25 },
    )
    const large = model.nodes.find((node) => node.id === 'large')

    expect(large?.width).toBeGreaterThan(800)
    expect(large?.data).toMatchObject({
      title: 'processExtremelyLargeWorkspaceTelemetryActivityBatch',
    })
  })

  it('keeps large clustered symbols tall enough for runtime badges', () => {
    const symbols = [
      symbol('large', 'SkyTestBridge', null, 'function', 1, 155),
      symbol('child', 'childBridgePart', null, 'function', 20, 24),
    ]
    const snapshot = buildSnapshot(symbols)
    const layout = buildSymbolLayout(symbols.map((item) => item.id))

    const baseline = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      new Map(),
      new Set<string>(),
      () => {},
      { viewportZoom: 0.25 },
    )
    const clustered = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      {
        callerCounts: { large: 2 },
        clusterByNodeId: {
          child: {
            id: 'cluster:large',
            label: 'SkyTestBridge internals',
            memberNodeIds: ['large', 'child'],
            ownerByMemberNodeId: { child: 'large', large: 'large' },
            rootNodeId: 'large',
          },
          large: {
            id: 'cluster:large',
            label: 'SkyTestBridge internals',
            memberNodeIds: ['large', 'child'],
            ownerByMemberNodeId: { child: 'large', large: 'large' },
            rootNodeId: 'large',
          },
        },
        clusters: [
          {
            id: 'cluster:large',
            label: 'SkyTestBridge internals',
            memberNodeIds: ['large', 'child'],
            ownerByMemberNodeId: { child: 'large', large: 'large' },
            rootNodeId: 'large',
          },
        ],
      },
      new Set<string>(),
      new Map(),
      new Map(),
      new Map(),
      new Set<string>(),
      () => {},
      { viewportZoom: 0.25 },
    )

    const baselineLarge = baseline.nodes.find((node) => node.id === 'large')
    const clusteredLarge = clustered.nodes.find((node) => node.id === 'large')

    expect(clusteredLarge?.height).toBeGreaterThan(baselineLarge?.height ?? 0)
    expect(clusteredLarge?.data).toMatchObject({
      clusterSize: 2,
      sharedCallerCount: 2,
    })
  })

  it('orders expanded cluster parents before child symbols for React Flow nesting', () => {
    const root = symbol('zRoot', 'RootWorkflow', null, 'function', 1, 80)
    const child = {
      ...symbol('aChild', 'buildStep', null, 'function', 10, 16),
      parentSymbolId: root.id,
    }
    const snapshot = buildSnapshot([child, root])
    const layout = buildSymbolLayout([child.id, root.id])
    const symbolClusterState = deriveSymbolClusterState(snapshot, layout, 'symbols')
    const expandedClusterIds = new Set(['cluster:zRoot'])
    const expandedClusterLayouts = buildExpandedClusterLayouts(
      snapshot,
      layout,
      symbolClusterState,
      expandedClusterIds,
    )

    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      symbolClusterState,
      expandedClusterIds,
      expandedClusterLayouts,
      new Map(),
      new Map(),
      new Set<string>(),
      () => {},
    )
    const rootIndex = model.nodes.findIndex((node) => node.id === root.id)
    const childIndex = model.nodes.findIndex((node) => node.id === child.id)

    expect(model.nodes[childIndex]?.parentId).toBe(root.id)
    expect(rootIndex).toBeGreaterThanOrEqual(0)
    expect(childIndex).toBeGreaterThan(rootIndex)
  })

  it('packs large expanded clusters into wrapped internal rows', () => {
    const root = symbol('root', 'ManagementPlansPage', 'react:component', 'function', 1, 464)
    const internals = Array.from({ length: 100 }, (_, index) => ({
      ...symbol(
        `internal${String(index).padStart(3, '0')}`,
        `internalHelper${index}`,
        null,
        'function',
        500 + index * 4,
        502 + index * 4,
      ),
      parentSymbolId: root.id,
    }))
    const snapshot = buildSnapshot([root, ...internals])
    const layout = buildSymbolLayout([root.id, ...internals.map((item) => item.id)])
    const symbolClusterState = deriveSymbolClusterState(snapshot, layout, 'symbols')
    const expandedClusterLayouts = buildExpandedClusterLayouts(
      snapshot,
      layout,
      symbolClusterState,
      new Set(['cluster:root']),
    )
    const clusterLayout = expandedClusterLayouts.get('cluster:root')

    expect(clusterLayout).toBeDefined()
    expect(Object.keys(clusterLayout?.childPlacements ?? {})).toHaveLength(100)
    expect(clusterLayout?.width).toBeLessThan(2_000)

    const placements = Object.values(clusterLayout?.childPlacements ?? {})
    const rowCount = new Set(placements.map((placement) => Math.round(placement.y))).size
    const childRightEdge = Math.max(
      ...placements.map((placement) => placement.x + placement.width),
    )
    const childBottomEdge = Math.max(
      ...placements.map((placement) => placement.y + placement.height),
    )

    expect(rowCount).toBeGreaterThan(1)
    expect(childRightEdge).toBeLessThanOrEqual(clusterLayout?.width ?? 0)
    expect(childBottomEdge).toBeLessThanOrEqual(clusterLayout?.height ?? 0)
  })

  it('does not promote tiny constants to large-symbol size when zoomed out', () => {
    const snapshot = buildSnapshot([
      symbol('tinyConstant', 'MAX_RETRIES', null, 'constant', 1, 1),
      symbol('largeWorkflow', 'largeWorkflow', null, 'function', 1, 180),
    ])
    const layout = buildSymbolLayout(['tinyConstant', 'largeWorkflow'])

    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      new Map(),
      new Set<string>(),
      () => {},
      { viewportZoom: 0.18 },
    )
    const tinyConstant = model.nodes.find((node) => node.id === 'tinyConstant')
    const largeWorkflow = model.nodes.find((node) => node.id === 'largeWorkflow')

    expect(tinyConstant?.width).toBeLessThan((largeWorkflow?.width ?? 0) * 0.5)
    expect(tinyConstant?.height).toBeLessThan((largeWorkflow?.height ?? 0) * 0.5)
    expect(getContentScale(tinyConstant)).toBeLessThan(1.2)
    expect(getContentScale(largeWorkflow)).toBeGreaterThan(4)
  })

  it('keeps high-LOC symbols contained in footprint-aware custom groups', () => {
    const snapshot = buildSnapshot([
      symbol('large', 'largeWorkflow', null, 'function', 1, 900),
      symbol('small', 'smallHelper', null, 'function', 1, 3),
    ])
    const layout = buildAgentGroupLayout(['large', 'small'], {
      large: { x: 0, y: 0 },
      small: { x: 120, y: 40 },
    })
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.25,
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints },
    )
    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      groupIndex,
      new Set<string>(),
      () => {},
      { symbolFootprints, viewportZoom: 0.25 },
    )
    const groupNode = model.nodes.find((node) => node.id === getLayoutGroupNodeId('group:logic'))
    const largeNode = model.nodes.find((node) => node.id === 'large')

    expect(groupNode).toBeDefined()
    expect(largeNode).toBeDefined()
    expect(isContainedBy(largeNode, groupNode)).toBe(true)
  })

  it('keeps selected custom group containers layered below their symbols', () => {
    const snapshot = buildSnapshot([
      symbol('large', 'largeWorkflow', null, 'function', 1, 900),
      symbol('small', 'smallHelper', null, 'function', 1, 3),
    ])
    const layout = buildAgentGroupLayout(['large', 'small'], {
      large: { x: 0, y: 0 },
      small: { x: 120, y: 40 },
    })
    const groupIndex = buildLayoutGroupContainerIndex(snapshot, layout, 'symbols')
    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      groupIndex,
      new Set<string>(),
      () => {},
    )
    const groupNodeId = getLayoutGroupNodeId('group:logic')
    const presented = applyFlowNodePresentation(
      model.nodes,
      new Set([groupNodeId]),
      { active: false, nodeIds: new Set() },
      new Map(),
    )
    const groupNode = presented.find((node) => node.id === groupNodeId)
    const memberNodes = presented.filter((node) => node.id === 'large' || node.id === 'small')

    expect(groupNode?.selected).toBe(true)
    expect(memberNodes.length).toBe(2)
    expect(memberNodes.every((node) => (node.zIndex ?? 0) > (groupNode?.zIndex ?? 0))).toBe(true)
  })

  it('packs custom group members by final footprint without overlaps', () => {
    const snapshot = buildSnapshot([
      symbol('tiny', 'tinyHelper', null, 'function', 1, 1),
      symbol('medium', 'mediumWorkflow', null, 'function', 1, 100),
      symbol('huge', 'hugeWorkflow', null, 'function', 1, 900),
    ])
    const layout = buildAgentGroupLayout(['tiny', 'medium', 'huge'], {
      tiny: { x: 0, y: 0 },
      medium: { x: 8, y: 0 },
      huge: { x: 16, y: 0 },
    })
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.25,
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints },
    )
    const group = groupIndex.containersById.get('group:logic')
    const childPlacements = Object.values(group?.childPlacements ?? {})

    expect(childPlacements.length).toBe(3)
    expect(hasAnyIntersection(childPlacements)).toBe(false)
  })

  it('packs grown custom group containers without folder overlap', () => {
    const snapshot = buildSnapshot([
      symbol('a1', 'alphaOneWorkflow', null, 'function', 1, 900),
      symbol('a2', 'alphaTwoWorkflow', null, 'function', 1, 100),
      symbol('b1', 'betaOneWorkflow', null, 'function', 1, 900),
      symbol('b2', 'betaTwoWorkflow', null, 'function', 1, 100),
    ])
    const layout = buildAgentLayout(
      {
        a1: { x: 0, y: 0 },
        a2: { x: 20, y: 20 },
        b1: { x: 120, y: 30 },
        b2: { x: 140, y: 40 },
      },
      [
        { id: 'group:alpha', nodeIds: ['a1', 'a2'], title: 'Alpha' },
        { id: 'group:beta', nodeIds: ['b1', 'b2'], title: 'Beta' },
      ],
    )
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.18,
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints, viewportZoom: 0.18 },
    )
    const containers = Array.from(groupIndex.containersById.values())

    expect(containers.length).toBe(2)
    expect(hasAnyIntersection(containers)).toBe(false)

    for (const container of containers) {
      for (const childPlacement of Object.values(container.childPlacements)) {
        expect(isPlacementContainedBy(childPlacement, container)).toBe(true)
      }
    }
  })

  it('promotes custom group titles at overview zoom', () => {
    const snapshot = buildSnapshot([
      symbol('grouped', 'groupedWorkflow', null, 'function', 1, 120),
    ])
    const layout = buildAgentGroupLayout(['grouped'], {
      grouped: { x: 0, y: 0 },
    })
    const detailIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { viewportZoom: 1.1 },
    )
    const overviewIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { viewportZoom: 0.13 },
    )
    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      overviewIndex,
      new Set<string>(),
      () => {},
      { viewportZoom: 0.13 },
    )
    const groupNode = model.nodes.find((node) => node.id === getLayoutGroupNodeId('group:logic'))
    const groupData = groupNode?.data as { groupTitleScale?: number } | undefined

    expect(detailIndex.containersById.get('group:logic')?.titleScale).toBe(1)
    expect(overviewIndex.containersById.get('group:logic')?.titleScale).toBeGreaterThan(4)
    expect(groupData?.groupTitleScale).toBeGreaterThan(4)
    expect(groupData?.groupTitleScale).toBeLessThanOrEqual(7.2)
  })

  it('keeps ungrouped symbol placements unchanged when packing groups', () => {
    const snapshot = buildSnapshot([
      symbol('grouped', 'groupedWorkflow', null, 'function', 1, 120),
      symbol('ungrouped', 'ungroupedWorkflow', null, 'function', 1, 90),
    ])
    const layout = buildAgentGroupLayout(['grouped'], {
      grouped: { x: 0, y: 0 },
      ungrouped: { x: 1_234, y: 456 },
    })
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.25,
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints },
    )
    const model = buildFlowModel(
      snapshot,
      layout,
      { contains: false, imports: false, calls: false },
      'symbols',
      emptySymbolClusterState(),
      new Set<string>(),
      new Map(),
      new Map(),
      groupIndex,
      new Set<string>(),
      () => {},
      { symbolFootprints, viewportZoom: 0.25 },
    )
    const ungrouped = model.nodes.find((node) => node.id === 'ungrouped')

    expect(ungrouped?.position).toEqual({ x: 1_234, y: 456 })
  })

  it('indexes group membership and reuses cached footprints across model builds', () => {
    const snapshot = buildSnapshot([
      symbol('a', 'alphaWorkflow', null, 'function', 1, 100),
      symbol('b', 'betaWorkflow', null, 'function', 1, 200),
      symbol('c', 'gammaWorkflow', null, 'function', 1, 300),
      symbol('d', 'ungroupedWorkflow', null, 'function', 1, 400),
    ])
    const layout = buildAgentGroupLayout(['a', 'b', 'c'], {
      a: { x: 0, y: 0 },
      b: { x: 20, y: 0 },
      c: { x: 40, y: 0 },
      d: { x: 2_000, y: 0 },
    })
    const computedSymbolIds: string[] = []
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.25,
      onCompute: (symbolId) => {
        computedSymbolIds.push(symbolId)
      },
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints },
    )

    expect(groupIndex.containerByNodeId.get('a')?.id).toBe('group:logic')
    expect(groupIndex.containerByNodeId.get('d')).toBeUndefined()

    const buildModel = () =>
      buildFlowModel(
        snapshot,
        layout,
        { contains: false, imports: false, calls: false },
        'symbols',
        emptySymbolClusterState(),
        new Set<string>(),
        new Map(),
        new Map(),
        groupIndex,
        new Set<string>(),
        () => {},
        { symbolFootprints, viewportZoom: 0.25 },
      )

    buildModel()
    buildModel()

    expect(symbolFootprints.getComputedCount()).toBe(4)
    expect(new Set(computedSymbolIds)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('packs 5,000 grouped symbols without intra-group intersections', () => {
    const symbols = Array.from({ length: 5_000 }, (_, index) =>
      symbol(
        `symbol${index}`,
        `symbol${index}`,
        null,
        index % 9 === 0 ? 'constant' : 'function',
        1,
        1 + (index % 17 === 0 ? 900 : index % 7 === 0 ? 100 : 5),
      ),
    )
    const snapshot = buildSnapshot(symbols)
    const placements = Object.fromEntries(
      symbols.map((item, index) => [
        item.id,
        {
          x: (index % 10) * 8,
          y: Math.floor(index / 10) * 8,
        },
      ]),
    )
    const groups = Array.from({ length: 50 }, (_, groupIndex) => ({
      id: `group:${groupIndex}`,
      nodeIds: symbols
        .slice(groupIndex * 100, groupIndex * 100 + 100)
        .map((item) => item.id),
      title: `Group ${groupIndex}`,
    }))
    const layout = buildAgentLayout(placements, groups)
    const symbolFootprints = createSymbolFootprintLookup({
      layout,
      snapshot,
      viewportZoom: 0.25,
    })
    const groupIndex = buildLayoutGroupContainerIndex(
      snapshot,
      layout,
      'symbols',
      { symbolFootprints },
    )

    expect(groupIndex.containersById.size).toBe(50)
    expect(symbolFootprints.getComputedCount()).toBe(5_000)

    for (const group of groupIndex.containersById.values()) {
      expect(hasAnyIntersection(Object.values(group.childPlacements))).toBe(false)
    }
  })

  it('refreshes old built-in default layout coordinates when spacing versions change', () => {
    const generated = {
      ...buildSymbolLayout(['symbol']),
      description: 'Default symbol-only layout. symbol-spacing-v2',
      placements: {
        symbol: { nodeId: 'symbol', x: 480, y: 320 },
      },
    }
    const existing = {
      ...buildSymbolLayout(['symbol']),
      annotations: [{ id: 'note', label: 'Keep note', x: 10, y: 20 }],
      description: 'Default symbol-only layout.',
      placements: {
        symbol: { nodeId: 'symbol', x: 12, y: 16 },
      },
    }

    const merged = mergeDefaultLayoutWithExisting(generated, existing)

    expect(merged.placements.symbol).toMatchObject({ x: 480, y: 320 })
    expect(merged.annotations).toEqual(existing.annotations)
  })
})

function emptySymbolClusterState(): SymbolClusterState {
  return { callerCounts: {}, clusterByNodeId: {}, clusters: [] }
}

function getLocScale(node: Node | undefined): number {
  return Number((node?.data as { locScale?: number } | undefined)?.locScale ?? 0)
}

function getContentScale(node: Node | undefined): number {
  return Number(
    (node?.data as { contentScale?: number } | undefined)?.contentScale ?? 0,
  )
}

function symbol(
  id: string,
  name: string,
  facet: string | null,
  symbolKind: SymbolKind,
  startLine: number,
  endLine: number,
): SymbolNode {
  return {
    facets: facet ? [facet] : [],
    fileId: 'file',
    id,
    kind: 'symbol',
    name,
    parentSymbolId: null,
    path: `src/app.ts#${name}`,
    range: {
      end: { column: 1, line: endLine },
      start: { column: 1, line: startLine },
    },
    symbolKind,
    tags: [],
  }
}

function buildSnapshot(symbols: SymbolNode[]): CodebaseSnapshot {
  return {
    detectedPlugins: [],
    edges: [],
    entryFileIds: ['file'],
    facetDefinitions: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    nodes: {
      file: {
        content: null,
        extension: '.ts',
        facets: [],
        id: 'file',
        kind: 'file',
        name: 'app.ts',
        parentId: null,
        path: 'src/app.ts',
        size: 100,
        tags: [],
      },
      ...Object.fromEntries(symbols.map((node) => [node.id, node])),
    },
    rootDir: '/repo',
    rootIds: ['file'],
    schemaVersion: 2,
    tags: [],
    totalFiles: 1,
  }
}

function buildSymbolLayout(nodeIds: string[]): LayoutSpec {
  return {
    annotations: [],
    groups: [],
    hiddenNodeIds: [],
    id: 'symbols',
    lanes: [],
    nodeScope: 'symbols',
    placements: Object.fromEntries(
      nodeIds.map((nodeId, index) => [
        nodeId,
        { nodeId, x: index * 100, y: 0 },
      ]),
    ),
    strategy: 'structural',
    title: 'Symbols',
  }
}

function buildAgentGroupLayout(
  groupedNodeIds: string[],
  placements: Record<string, { x: number; y: number; width?: number; height?: number }>,
): LayoutSpec {
  return buildAgentLayout(placements, [
    {
      id: 'group:logic',
      nodeIds: groupedNodeIds,
      title: 'Logic',
    },
  ])
}

function buildAgentLayout(
  placements: Record<string, { x: number; y: number; width?: number; height?: number }>,
  groups: LayoutSpec['groups'],
): LayoutSpec {
  return {
    annotations: [],
    groups,
    hiddenNodeIds: [],
    id: 'agent',
    lanes: [],
    nodeScope: 'symbols',
    placements: Object.fromEntries(
      Object.entries(placements).map(([nodeId, placement]) => [
        nodeId,
        { nodeId, ...placement },
      ]),
    ),
    strategy: 'agent',
    title: 'Agent layout',
  }
}

function isContainedBy(node: Node | undefined, container: Node | undefined) {
  if (!node || !container || node.width == null || node.height == null) {
    return false
  }

  return (
    node.position.x >= container.position.x &&
    node.position.y >= container.position.y &&
    node.position.x + node.width <= container.position.x + (container.width ?? 0) &&
    node.position.y + node.height <= container.position.y + (container.height ?? 0)
  )
}

function isPlacementContainedBy(
  placement: { x: number; y: number; width: number; height: number },
  container: { x: number; y: number; width: number; height: number },
) {
  return (
    placement.x >= container.x &&
    placement.y >= container.y &&
    placement.x + placement.width <= container.x + container.width &&
    placement.y + placement.height <= container.y + container.height
  )
}

function hasAnyIntersection(
  placements: Array<{ x: number; y: number; width: number; height: number }>,
) {
  for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
    const left = placements[leftIndex]

    if (!left) {
      continue
    }

    for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
      const right = placements[rightIndex]

      if (right && intersects(left, right)) {
        return true
      }
    }
  }

  return false
}

function intersects(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  )
}

function buildFilesystemSnapshot(): CodebaseSnapshot {
  return {
    detectedPlugins: [],
    edges: [],
    entryFileIds: ['file'],
    facetDefinitions: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
    nodes: {
      dir: {
        childIds: ['file'],
        depth: 0,
        facets: [],
        id: 'dir',
        kind: 'directory',
        name: 'src',
        parentId: null,
        path: 'src',
        tags: [],
      },
      file: {
        content: null,
        extension: '.ts',
        facets: [],
        id: 'file',
        kind: 'file',
        name: 'app.ts',
        parentId: 'dir',
        path: 'src/app.ts',
        size: 100,
        tags: [],
      },
    },
    rootDir: '/repo',
    rootIds: ['dir'],
    schemaVersion: 2,
    tags: [],
    totalFiles: 1,
  }
}

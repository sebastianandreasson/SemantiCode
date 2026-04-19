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
  buildFlowModel,
  buildUpdatedPlacementsForMovedNode,
  buildWorkspaceSidebarGroups,
  mergeDefaultLayoutWithExisting,
  type SymbolClusterState,
} from './flowModel'

describe('flowModel extracted helpers', () => {
  it('groups the workspace outline by semantic facets before core symbol kinds', () => {
    const snapshot = buildSnapshot([
      symbol('component', 'Dashboard', 'react:component', 'function', 1, 40),
      symbol('hook', 'useTodos', 'react:hook', 'function', 1, 12),
      symbol('class', 'TodoStore', null, 'class', 1, 18),
      symbol('smallComponent', 'Badge', 'react:component', 'function', 1, 8),
    ])
    const layout = buildSymbolLayout(['component', 'hook', 'class', 'smallComponent'])

    const groups = buildWorkspaceSidebarGroups({ layout, snapshot })

    expect(groups.map((group) => group.id)).toEqual([
      'react:component',
      'react:hook',
      'symbol:class',
    ])
    expect(groups[0]?.items.map((item) => item.title)).toEqual(['Dashboard', 'Badge'])
    expect(groups[0]?.items.map((item) => item.metric)).toEqual([40, 8])
    expect(groups[0]?.items[0]?.badge).toBe('react')
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

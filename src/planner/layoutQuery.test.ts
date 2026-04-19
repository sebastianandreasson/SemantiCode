import { describe, expect, it } from 'vitest'

import type { ProjectSnapshot, SymbolNode } from '../schema/snapshot'
import { createLayoutQuerySession } from './layoutQuery'
import { materializeHybridLayoutProposal } from './hybridLayout'

describe('layout query-first planner', () => {
  it('filters nodes by facet, kind, path, LOC, and degree', async () => {
    const snapshot = buildSnapshot([
      symbol('component', 'Dashboard', 'src/app/Dashboard.tsx', ['react:component'], 1, 80),
      symbol('hook', 'useTodos', 'src/app/useTodos.ts', ['react:hook'], 1, 18),
      symbol('utility', 'formatTodo', 'src/lib/formatTodo.ts', [], 1, 8),
    ])
    snapshot.edges.push({
      id: 'call:dashboard-hook',
      kind: 'calls',
      source: 'symbol:component',
      target: 'symbol:hook',
    })
    const session = createLayoutQuerySession('test', {
      executionPath: 'native_tools',
      nodeScope: 'symbols',
      prompt: 'React layout',
      rootDir: '/repo',
      snapshot,
    })

    const result = await session.execute({
      args: {
        facet: 'react:component',
        kind: 'symbol',
        locMin: 40,
        pathPrefix: 'src/app',
      },
      operation: 'findNodes',
    })

    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({
      total: 1,
      nodes: [
        {
          id: 'symbol:component',
          loc: 80,
          path: 'src/app/Dashboard.tsx',
        },
      ],
    })
  })

  it('returns bounded neighborhoods by direction and edge kind', async () => {
    const snapshot = buildSnapshot([
      symbol('component', 'Dashboard', 'src/app/Dashboard.tsx', ['react:component'], 1, 80),
      symbol('hook', 'useTodos', 'src/app/useTodos.ts', ['react:hook'], 1, 18),
      symbol('utility', 'formatTodo', 'src/lib/formatTodo.ts', [], 1, 8),
    ])
    snapshot.edges.push(
      {
        id: 'call:dashboard-hook',
        kind: 'calls',
        source: 'symbol:component',
        target: 'symbol:hook',
      },
      {
        id: 'import:hook-util',
        kind: 'imports',
        source: 'symbol:hook',
        target: 'symbol:utility',
      },
    )
    const session = createLayoutQuerySession('test', {
      executionPath: 'native_tools',
      nodeScope: 'symbols',
      prompt: 'React layout',
      rootDir: '/repo',
      snapshot,
    })

    const result = await session.execute({
      args: {
        depth: 2,
        direction: 'outgoing',
        edgeKinds: ['calls'],
        seedNodeIds: ['symbol:component'],
      },
      operation: 'getNeighborhood',
    })

    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({
      edges: [{ id: 'call:dashboard-hook' }],
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: 'symbol:component' }),
        expect.objectContaining({ id: 'symbol:hook' }),
      ]),
    })
  })

  it('enforces the serialized query output budget', async () => {
    const snapshot = buildSnapshot(
      Array.from({ length: 230 }, (_, index) =>
        symbol(
          `large-${index}`,
          `Large${index}`,
          `src/${'nested/'.repeat(80)}Large${index}.ts`,
          [],
          1,
          2,
        ),
      ),
    )
    const session = createLayoutQuerySession('test', {
      executionPath: 'native_tools',
      nodeScope: 'symbols',
      prompt: 'Large layout',
      rootDir: '/repo',
      snapshot,
    })

    const result = await session.execute({
      args: {
        kind: 'symbol',
        limit: 200,
      },
      operation: 'findNodes',
    })

    expect(result.ok).toBe(false)
    expect(result.budgetExhausted).toBe(true)
  })

  it('materializes selector-based hybrid proposals into valid layout envelopes', () => {
    const snapshot = buildSnapshot([
      symbol('component', 'Dashboard', 'src/app/Dashboard.tsx', ['react:component'], 1, 80),
      symbol('hook', 'useTodos', 'src/app/useTodos.ts', ['react:hook'], 1, 18),
      symbol('utility', 'formatTodo', 'src/lib/formatTodo.ts', [], 1, 8),
    ])

    const result = materializeHybridLayoutProposal({
      prompt: 'Group React symbols',
      proposal: {
        anchors: [{ nodeId: 'symbol:component', x: 100, y: 200 }],
        groups: [
          {
            id: 'components',
            selector: { facet: 'react:component' },
            title: 'Components',
          },
          {
            id: 'hooks',
            selector: { facet: 'react:hook' },
            title: 'Hooks',
          },
        ],
        nodeScope: 'symbols',
        title: 'React symbols',
        visibility: {
          include: [{ facet: ['react:component', 'react:hook'] }],
        },
      },
      rootDir: '/repo',
      snapshot,
    })

    expect(result.validation.valid).toBe(true)
    expect(result.envelope.proposal.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'symbol:component', x: 100, y: 200 }),
        expect.objectContaining({ nodeId: 'symbol:hook' }),
      ]),
    )
    expect(result.envelope.proposal.hiddenNodeIds).toEqual(['symbol:utility'])
    expect(result.envelope.proposal.groups).toEqual([
      expect.objectContaining({ id: 'components', nodeIds: ['symbol:component'] }),
      expect.objectContaining({ id: 'hooks', nodeIds: ['symbol:hook'] }),
    ])
  })
})

function buildSnapshot(symbols: SymbolNode[]): ProjectSnapshot {
  const nodes = Object.fromEntries(symbols.map((node) => [node.id, node]))

  return {
    detectedPlugins: [],
    edges: [],
    entryFileIds: [],
    facetDefinitions: [
      {
        category: 'framework',
        description: 'React component',
        id: 'react:component',
        label: 'React component',
      },
      {
        category: 'framework',
        description: 'React hook',
        id: 'react:hook',
        label: 'React hook',
      },
    ],
    generatedAt: '2026-04-19T00:00:00.000Z',
    nodes,
    rootDir: '/repo',
    rootIds: [],
    schemaVersion: 2,
    tags: [],
    totalFiles: 3,
  }
}

function symbol(
  id: string,
  name: string,
  path: string,
  facets: string[],
  startLine: number,
  endLine: number,
): SymbolNode {
  return {
    facets,
    fileId: `file:${path}`,
    id: `symbol:${id}`,
    kind: 'symbol',
    name,
    parentSymbolId: null,
    path,
    range: {
      end: { column: 1, line: endLine },
      start: { column: 1, line: startLine },
    },
    symbolKind: name.startsWith('use') ? 'function' : 'function',
    tags: [],
  }
}

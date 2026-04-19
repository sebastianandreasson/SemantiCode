import { describe, expect, it } from 'vitest'

import { buildSymbolLayout } from './symbolLayout'
import type { ProjectSnapshot, SymbolNode } from '../types'

describe('buildSymbolLayout', () => {
  it('allocates more vertical space around high-LOC connected symbols', () => {
    const snapshot = buildSnapshot([
      symbol('large', 'largeWorkflow', 1, 220),
      symbol('small', 'smallHelper', 230, 235),
    ])

    snapshot.edges.push({
      id: 'edge:large-small',
      kind: 'calls',
      source: 'large',
      target: 'small',
    })

    const layout = buildSymbolLayout(snapshot)
    const large = layout.placements.large
    const small = layout.placements.small

    expect(large).toBeDefined()
    expect(small).toBeDefined()
    expect(Math.abs((small?.y ?? 0) - (large?.y ?? 0))).toBeGreaterThan(420)
    expect(layout.description).toContain('symbol-spacing-v2')
  })
})

function symbol(
  id: string,
  name: string,
  startLine: number,
  endLine: number,
): SymbolNode {
  return {
    facets: [],
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
    symbolKind: 'function',
    tags: [],
  }
}

function buildSnapshot(symbols: SymbolNode[]): ProjectSnapshot {
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

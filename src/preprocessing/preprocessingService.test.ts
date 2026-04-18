import { beforeEach, describe, expect, it } from 'vitest'

import { clearPreprocessedWorkspaceContext } from './preprocessingCache'
import { preprocessWorkspaceSnapshot } from './preprocessingService'
import type { ProjectSnapshot } from '../schema/snapshot'

describe('preprocessWorkspaceSnapshot', () => {
  beforeEach(() => {
    clearPreprocessedWorkspaceContext()
  })

  it('reuses unchanged purpose summaries across snapshots in the same workspace', () => {
    const initialSnapshot = createSnapshot({
      generatedAt: '2026-04-15T12:00:00.000Z',
      content: [
        'export function alpha() {',
        '  const value = 1',
        '  const next = value + 1',
        '  const output = next - 1',
        '  const finalValue = output',
        '  return finalValue',
        '}',
        '',
        'export function beta() {',
        '  const value = 2',
        '  const next = value + 1',
        '  const output = next - 1',
        '  const finalValue = output',
        '  return finalValue',
        '}',
      ].join('\n'),
    })
    const initialContext = preprocessWorkspaceSnapshot(initialSnapshot)

    const nextSnapshot = createSnapshot({
      generatedAt: '2026-04-15T12:05:00.000Z',
      content: [
        'export function alpha() {',
        '  const value = 1',
        '  const next = value + 1',
        '  const output = next - 1',
        '  const finalValue = output',
        '  return finalValue',
        '}',
        '',
        'export function beta() {',
        '  const value = 3',
        '  const next = value + 1',
        '  const output = next - 1',
        '  const finalValue = output',
        '  return finalValue',
        '}',
      ].join('\n'),
    })
    const nextContext = preprocessWorkspaceSnapshot(nextSnapshot)

    const initialAlphaSummary = initialContext.purposeSummaries.find((summary) => summary.symbolId === 'symbol:alpha')
    const initialBetaSummary = initialContext.purposeSummaries.find((summary) => summary.symbolId === 'symbol:beta')
    const nextAlphaSummary = nextContext.purposeSummaries.find((summary) => summary.symbolId === 'symbol:alpha')
    const nextBetaSummary = nextContext.purposeSummaries.find((summary) => summary.symbolId === 'symbol:beta')

    expect(initialAlphaSummary).toBeDefined()
    expect(initialBetaSummary).toBeDefined()
    expect(nextAlphaSummary).toBe(initialAlphaSummary)
    expect(nextBetaSummary).not.toBe(initialBetaSummary)
    expect(nextAlphaSummary?.sourceHash).toBe(initialAlphaSummary?.sourceHash)
    expect(nextBetaSummary?.sourceHash).not.toBe(initialBetaSummary?.sourceHash)
  })
})

function createSnapshot(input: {
  generatedAt: string
  content: string
}): ProjectSnapshot {
  return {
    schemaVersion: 2,
    rootDir: '/tmp/example-workspace',
    generatedAt: input.generatedAt,
    totalFiles: 1,
    rootIds: ['file:module'],
    entryFileIds: ['file:module'],
    nodes: {
      'file:module': {
        id: 'file:module',
        kind: 'file',
        path: 'src/module.ts',
        name: 'module.ts',
        language: 'typescript',
        extension: '.ts',
        size: input.content.length,
        content: input.content,
        tags: [],
        facets: [],
        parentId: null,
      },
      'symbol:alpha': {
        id: 'symbol:alpha',
        kind: 'symbol',
        fileId: 'file:module',
        path: 'alpha',
        name: 'alpha',
        tags: [],
        facets: [],
        symbolKind: 'function',
        language: 'typescript',
        visibility: 'public',
        signature: 'function alpha(): number',
        parentSymbolId: null,
        range: {
          start: { line: 1, column: 1 },
          end: { line: 6, column: 1 },
        },
      },
      'symbol:beta': {
        id: 'symbol:beta',
        kind: 'symbol',
        fileId: 'file:module',
        path: 'beta',
        name: 'beta',
        tags: [],
        facets: [],
        symbolKind: 'function',
        language: 'typescript',
        visibility: 'public',
        signature: 'function beta(): number',
        parentSymbolId: null,
        range: {
          start: { line: 8, column: 1 },
          end: { line: 13, column: 1 },
        },
      },
    },
    edges: [],
    tags: [],
    facetDefinitions: [],
    detectedPlugins: [],
  }
}

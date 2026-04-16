import { describe, expect, it } from 'vitest'

import { buildSemanticLayout } from './semanticLayout'
import type { PreprocessedWorkspaceContext, ProjectSnapshot } from '../types'

describe('buildSemanticLayout', () => {
  it('falls back to a coherent TF-IDF set when cached embeddings are only partially available', () => {
    const snapshot = createSnapshot()
    const context: PreprocessedWorkspaceContext = {
      snapshotId: 'snapshot:test',
      isComplete: false,
      semanticEmbeddingModelId: 'nomic-ai/nomic-embed-text-v1.5',
      semanticEmbeddings: [
        {
          symbolId: 'symbol:alpha',
          modelId: 'nomic-ai/nomic-embed-text-v1.5',
          dimensions: 3,
          textHash: 'alpha-hash',
          values: [0.1, 0.2, 0.3],
          generatedAt: '2026-04-16T00:00:00.000Z',
        },
      ],
      workspaceProfile: {
        rootDir: '/tmp/repo',
        generatedAt: '2026-04-16T00:00:00.000Z',
        totalFiles: 1,
        totalSymbols: 2,
        languages: ['typescript'],
        topDirectories: ['src'],
        entryFiles: ['src/module.ts'],
        notableTags: [],
        summary: 'Example repo',
      },
      purposeSummaries: [
        {
          symbolId: 'symbol:alpha',
          fileId: 'file:module',
          path: 'alpha',
          language: 'typescript',
          symbolKind: 'function',
          generator: 'llm',
          summary: 'Alpha summary',
          domainHints: [],
          sideEffects: [],
          embeddingText: 'Alpha embedding text',
          sourceHash: 'alpha-source',
          generatedAt: '2026-04-16T00:00:00.000Z',
        },
        {
          symbolId: 'symbol:beta',
          fileId: 'file:module',
          path: 'beta',
          language: 'typescript',
          symbolKind: 'function',
          generator: 'llm',
          summary: 'Beta summary',
          domainHints: [],
          sideEffects: [],
          embeddingText: 'Beta embedding text',
          sourceHash: 'beta-source',
          generatedAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    }

    const layout = buildSemanticLayout(snapshot, context)

    expect(layout.placements['symbol:alpha']).toBeDefined()
    expect(layout.placements['symbol:beta']).toBeDefined()
    expect(layout.hiddenNodeIds).not.toContain('symbol:alpha')
    expect(layout.hiddenNodeIds).not.toContain('symbol:beta')
  })
})

function createSnapshot(): ProjectSnapshot {
  const content = [
    'export function alpha() {',
    '  return 1',
    '}',
    '',
    'export function beta() {',
    '  return 2',
    '}',
  ].join('\n')

  return {
    schemaVersion: 1,
    rootDir: '/tmp/repo',
    generatedAt: '2026-04-16T00:00:00.000Z',
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
        size: content.length,
        content,
        tags: [],
        parentId: null,
      },
      'symbol:alpha': {
        id: 'symbol:alpha',
        kind: 'symbol',
        fileId: 'file:module',
        path: 'alpha',
        name: 'alpha',
        tags: [],
        symbolKind: 'function',
        language: 'typescript',
        visibility: 'public',
        signature: 'function alpha(): number',
        parentSymbolId: null,
        range: {
          start: { line: 1, column: 1 },
          end: { line: 3, column: 1 },
        },
      },
      'symbol:beta': {
        id: 'symbol:beta',
        kind: 'symbol',
        fileId: 'file:module',
        path: 'beta',
        name: 'beta',
        tags: [],
        symbolKind: 'function',
        language: 'typescript',
        visibility: 'public',
        signature: 'function beta(): number',
        parentSymbolId: null,
        range: {
          start: { line: 5, column: 1 },
          end: { line: 7, column: 1 },
        },
      },
    },
    edges: [],
    tags: [],
  }
}

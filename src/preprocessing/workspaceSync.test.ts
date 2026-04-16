import { describe, expect, it } from 'vitest'

import { analyzeWorkspaceArtifactSync } from './workspaceSync'
import type {
  LayoutDraft,
  LayoutSpec,
  PreprocessedWorkspaceContext,
  ProjectSnapshot,
} from '../types'

describe('analyzeWorkspaceArtifactSync', () => {
  it('marks stale summaries, embeddings, and layouts from current repo diff', () => {
    const snapshot = createSnapshot(
      [
        'export function alpha() {',
        '  const a = 1',
        '  const b = a + 1',
        '  const c = b + 1',
        '  const d = c - 1',
        '  return d',
        '}',
        '',
        'export function beta() {',
        '  const a = 4',
        '  const b = a + 1',
        '  const c = b + 1',
        '  const d = c - 1',
        '  return d',
        '}',
      ].join('\n'),
    )

    const context: PreprocessedWorkspaceContext = {
      snapshotId: 'snapshot:test',
      isComplete: true,
      semanticEmbeddingModelId: 'nomic-ai/nomic-embed-text-v1.5',
      semanticEmbeddings: [
        {
          symbolId: 'symbol:alpha',
          modelId: 'nomic-ai/nomic-embed-text-v1.5',
          dimensions: 3,
          textHash: 'old-alpha-hash',
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
          summary: 'Old alpha summary',
          domainHints: [],
          sideEffects: [],
          embeddingText: 'Old alpha embedding text',
          sourceHash: 'old-source-hash',
          generatedAt: '2026-04-16T00:00:00.000Z',
        },
      ],
    }

    const layout: LayoutSpec = {
      id: 'layout:feature',
      title: 'Feature flow',
      strategy: 'agent',
      nodeScope: 'symbols',
      placements: {
        'symbol:alpha': { nodeId: 'symbol:alpha', x: 10, y: 10 },
        'symbol:missing': { nodeId: 'symbol:missing', x: 20, y: 20 },
      },
      groups: [],
      lanes: [],
      annotations: [],
      hiddenNodeIds: [],
    }

    const draft: LayoutDraft = {
      id: 'draft:feature',
      source: 'agent',
      status: 'draft',
      prompt: 'Build feature layout',
      proposalEnvelope: {
        proposal: {
          title: 'Draft feature flow',
          strategy: 'agent',
          placements: [],
          groups: [],
          lanes: [],
          annotations: [],
          hiddenNodeIds: [],
        },
        rationale: 'feature',
        warnings: [],
        ambiguities: [],
        confidence: 0.8,
      },
      layout,
      validation: {
        valid: true,
        issues: [],
      },
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
    }

    const result = analyzeWorkspaceArtifactSync({
      snapshot,
      preprocessedWorkspaceContext: context,
      layouts: [layout],
      draftLayouts: [draft],
      git: {
        isGitRepo: true,
        branch: 'main',
        head: 'abc1234',
        changedFiles: ['src/module.ts'],
        stagedFiles: [],
        unstagedFiles: ['src/module.ts'],
        untrackedFiles: [],
      },
    })

    expect(result.summaries.state).toBe('outdated')
    expect(result.summaries.staleSymbolIds).toContain('symbol:alpha')
    expect(result.summaries.staleSymbolIds).toContain('symbol:beta')

    expect(result.embeddings.state).toBe('outdated')
    expect(result.embeddings.staleSymbolIds).toContain('symbol:alpha')
    expect(result.embeddings.staleSymbolIds).toContain('symbol:beta')

    expect(result.layouts[0]).toMatchObject({
      state: 'outdated',
      staleCount: 1,
      missingCount: 1,
    })
    expect(result.drafts[0]).toMatchObject({
      state: 'outdated',
      staleCount: 1,
      missingCount: 1,
    })
  })
})

function createSnapshot(content: string): ProjectSnapshot {
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
          end: { line: 7, column: 1 },
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
          start: { line: 9, column: 1 },
          end: { line: 15, column: 1 },
        },
      },
    },
    edges: [],
    tags: [],
  }
}

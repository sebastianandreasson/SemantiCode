import { act } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { Semanticode } from './Semanticode'
import { visualizerStore } from '../store/visualizerStore'
import type {
  LayoutDraft,
  PreprocessedWorkspaceContext,
  PreprocessingStatus,
  ProjectSnapshot,
  WorkspaceProfile,
} from '../types'

const snapshot: ProjectSnapshot = {
  schemaVersion: 1,
  rootDir: '/tmp/repo',
  generatedAt: '2026-04-16T00:00:00.000Z',
  totalFiles: 1,
  rootIds: ['dir:src'],
  entryFileIds: ['file:feature'],
  nodes: {
    'dir:src': {
      id: 'dir:src',
      kind: 'directory',
      name: 'src',
      path: 'src',
      tags: [],
      parentId: null,
      childIds: ['file:feature'],
      depth: 0,
    },
    'file:feature': {
      id: 'file:feature',
      kind: 'file',
      name: 'feature.ts',
      path: 'src/feature.ts',
      tags: [],
      parentId: 'dir:src',
      extension: '.ts',
      size: 120,
      content: 'export function FeatureEntry() {}\nexport function FeatureHelper() {}',
      language: 'typescript',
    },
    'symbol:entry': {
      id: 'symbol:entry',
      kind: 'symbol',
      name: 'FeatureEntry',
      path: 'src/feature.ts:FeatureEntry',
      tags: [],
      fileId: 'file:feature',
      parentSymbolId: null,
      language: 'typescript',
      symbolKind: 'function',
    },
    'symbol:helper': {
      id: 'symbol:helper',
      kind: 'symbol',
      name: 'FeatureHelper',
      path: 'src/feature.ts:FeatureHelper',
      tags: [],
      fileId: 'file:feature',
      parentSymbolId: null,
      language: 'typescript',
      symbolKind: 'function',
    },
  },
  edges: [],
  tags: [],
}

const featureDraft: LayoutDraft = {
  id: 'draft:feature',
  source: 'agent',
  status: 'draft',
  prompt: 'Build feature layout',
  proposalEnvelope: {
    proposal: {
      title: 'Feature flow',
      strategy: 'agent',
      placements: [],
      groups: [],
      lanes: [],
      annotations: [],
      hiddenNodeIds: [],
    },
    rationale: 'Feature grouping',
    warnings: [],
    ambiguities: [],
    confidence: 0.85,
  },
  layout: {
    id: 'layout:draft-feature',
    title: 'Feature flow',
    strategy: 'agent',
    nodeScope: 'symbols',
    placements: {
      'symbol:entry': { nodeId: 'symbol:entry', x: 24, y: 24 },
    },
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: [],
  },
  validation: {
    valid: true,
    issues: [],
  },
  createdAt: '2026-04-16T00:00:00.000Z',
  updatedAt: '2026-04-16T00:00:00.000Z',
}

const workspaceProfile: WorkspaceProfile = {
  rootDir: '/tmp/repo',
  generatedAt: '2026-04-16T00:00:00.000Z',
  totalFiles: 1,
  totalSymbols: 2,
  languages: ['typescript'],
  topDirectories: ['src'],
  entryFiles: ['src/feature.ts'],
  notableTags: [],
  summary: 'Small test repository.',
}

const preprocessedWorkspaceContext: PreprocessedWorkspaceContext = {
  snapshotId: 'test-snapshot',
  isComplete: true,
  semanticEmbeddingModelId: null,
  semanticEmbeddings: [],
  workspaceProfile,
  purposeSummaries: [
    {
      symbolId: 'symbol:entry',
      fileId: 'file:feature',
      path: 'src/feature.ts:FeatureEntry',
      language: 'typescript',
      symbolKind: 'function',
      generator: 'llm',
      summary: 'Entry point for the feature.',
      domainHints: ['feature'],
      sideEffects: [],
      embeddingText: 'Entry point for the feature.',
      sourceHash: 'hash-entry',
      generatedAt: '2026-04-16T00:00:00.000Z',
    },
    {
      symbolId: 'symbol:helper',
      fileId: 'file:feature',
      path: 'src/feature.ts:FeatureHelper',
      language: 'typescript',
      symbolKind: 'function',
      generator: 'llm',
      summary: 'Helper for the feature.',
      domainHints: ['feature'],
      sideEffects: [],
      embeddingText: 'Helper for the feature.',
      sourceHash: 'hash-helper',
      generatedAt: '2026-04-16T00:00:00.000Z',
    },
  ],
}

const preprocessingStatus: PreprocessingStatus = {
  activity: null,
  runState: 'ready',
  updatedAt: '2026-04-16T00:00:00.000Z',
  purposeSummaryCount: 2,
  semanticEmbeddingCount: 0,
  lastError: null,
  processedSymbols: 2,
  snapshotId: 'test-snapshot',
  totalSymbols: 2,
}

describe('Semanticode semantic compare overlay', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & {
      ResizeObserver?: new (callback: ResizeObserverCallback) => ResizeObserver
    }).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as new (callback: ResizeObserverCallback) => ResizeObserver
    HTMLElement.prototype.scrollTo = () => undefined

    act(() => {
      visualizerStore.getState().reset()
      visualizerStore.getState().setDraftLayouts([featureDraft])
      visualizerStore.getState().setActiveDraftId(featureDraft.id)
      visualizerStore.getState().setViewMode('symbols')
    })
  })

  it('highlights draft symbols inside semantic view and dims non-members', async () => {
    const user = userEvent.setup()

    render(
      <Semanticode
        preprocessedWorkspaceContext={preprocessedWorkspaceContext}
        preprocessingStatus={preprocessingStatus}
        snapshot={snapshot}
        workspaceProfile={workspaceProfile}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Compare in Semantic View' })).not.toBeNull()
    })

    await user.click(screen.getByRole('button', { name: 'Compare in Semantic View' }))

    await waitFor(() => {
      expect(screen.getByText('Semantic Compare')).not.toBeNull()
    })

    const entryNode = screen.getByText('FeatureEntry').closest('.cbv-node')
    const helperNode = screen.getByText('FeatureHelper').closest('.cbv-node')

    expect(entryNode?.className).toContain('is-compare-highlighted')
    expect(helperNode?.className).toContain('is-dimmed')
  })
})

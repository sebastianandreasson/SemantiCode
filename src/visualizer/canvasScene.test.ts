import { describe, expect, it } from 'vitest'

import {
  canCompareLayoutAgainstSemantic,
  resolveCanvasScene,
  resolveLayoutCompareOverlay,
} from './canvasScene'
import type { LayoutDraft, LayoutSpec, ProjectSnapshot } from '../types'

const snapshot: ProjectSnapshot = {
  schemaVersion: 2,
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
      facets: [],
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
      facets: [],
      parentId: 'dir:src',
      extension: '.ts',
      size: 120,
      content: 'export function feature() {}',
      language: 'typescript',
    },
    'symbol:entry': {
      id: 'symbol:entry',
      kind: 'symbol',
      name: 'FeatureEntry',
      path: 'src/feature.ts:FeatureEntry',
      tags: [],
      facets: [],
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
      facets: [],
      fileId: 'file:feature',
      parentSymbolId: null,
      language: 'typescript',
      symbolKind: 'function',
    },
    'symbol:missing': {
      id: 'symbol:missing',
      kind: 'symbol',
      name: 'MissingSymbol',
      path: 'src/feature.ts:MissingSymbol',
      tags: [],
      facets: [],
      fileId: 'file:feature',
      parentSymbolId: null,
      language: 'typescript',
      symbolKind: 'function',
    },
  },
  edges: [],
  tags: [],
  facetDefinitions: [],
  detectedPlugins: [],
}

const semanticLayout: LayoutSpec = {
  id: 'layout:semantic:/tmp/repo',
  title: 'Semantic symbols',
  strategy: 'semantic',
  nodeScope: 'symbols',
  placements: {
    'symbol:entry': { nodeId: 'symbol:entry', x: 0, y: 0 },
    'symbol:helper': { nodeId: 'symbol:helper', x: 220, y: 0 },
  },
  groups: [],
  lanes: [],
  annotations: [],
  hiddenNodeIds: [],
}

const featureLayout: LayoutSpec = {
  id: 'layout:feature',
  title: 'Feature flow',
  strategy: 'agent',
  nodeScope: 'symbols',
  placements: {
    'symbol:entry': { nodeId: 'symbol:entry', x: 10, y: 20 },
    'symbol:missing': { nodeId: 'symbol:missing', x: 300, y: 30 },
  },
  groups: [
    {
      id: 'group:feature',
      title: 'Feature group',
      nodeIds: ['symbol:entry', 'symbol:missing'],
    },
  ],
  lanes: [
    {
      id: 'lane:feature',
      title: 'Feature lane',
      order: 0,
      nodeIds: ['symbol:entry', 'symbol:missing'],
    },
  ],
  annotations: [],
  hiddenNodeIds: [],
}

const draftLayout: LayoutDraft = {
  id: 'draft:feature',
  source: 'agent',
  status: 'draft',
  prompt: 'Build a feature layout.',
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
    confidence: 0.9,
  },
  layout: featureLayout,
  validation: {
    valid: true,
    issues: [],
  },
  createdAt: '2026-04-16T00:00:00.000Z',
  updatedAt: '2026-04-16T00:00:00.000Z',
}

describe('canvas scene resolution', () => {
  it('resolves semantic projection as a dedicated scene', () => {
    const scene = resolveCanvasScene({
      activeLayout: featureLayout,
      baseScene: { kind: 'semantic_projection' },
      layouts: [featureLayout, semanticLayout],
    })

    expect(scene).toEqual({
      kind: 'semantic_projection',
      nodeScope: 'symbols',
      layoutSpec: semanticLayout,
    })
  })

  it('derives overlay membership and missing nodes from a draft source', () => {
    const scene = resolveCanvasScene({
      activeLayout: featureLayout,
      baseScene: { kind: 'semantic_projection' },
      layouts: [featureLayout, semanticLayout],
    })
    const overlay = resolveLayoutCompareOverlay({
      snapshot,
      compareOverlay: {
        kind: 'layout_compare',
        sourceType: 'draft',
        sourceId: 'draft:feature',
      },
      draftLayouts: [draftLayout],
      layouts: [featureLayout, semanticLayout],
      scene,
    })

    expect(overlay?.nodeIds).toEqual(['symbol:entry'])
    expect(overlay?.missingNodeIds).toEqual(['symbol:missing'])
    expect(overlay?.groupTitles).toEqual(['Feature group'])
    expect(overlay?.laneTitles).toEqual(['Feature lane'])
  })

  it('only allows non-semantic symbol layouts as compare sources', () => {
    expect(canCompareLayoutAgainstSemantic(featureLayout)).toBe(true)
    expect(canCompareLayoutAgainstSemantic(semanticLayout)).toBe(false)
  })
})

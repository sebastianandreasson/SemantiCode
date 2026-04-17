import { describe, expect, it } from 'vitest'

import {
  buildGroupPrototypeRecords,
  rankNearbySymbolsForGroupPrototype,
  rankGroupPrototypeMatches,
} from './groupPrototypes'

describe('groupPrototypes', () => {
  it('builds centroids only for groups with enough embedded symbols', () => {
    const prototypes = buildGroupPrototypeRecords(
      {
        id: 'layout:agent:test',
        title: 'Gameplay loop',
        strategy: 'agent',
        nodeScope: 'symbols',
        placements: {},
        groups: [
          {
            id: 'setup',
            title: 'Setup',
            nodeIds: ['symbol:start', 'symbol:init'],
          },
          {
            id: 'tiny',
            title: 'Tiny',
            nodeIds: ['symbol:alone'],
          },
        ],
        lanes: [],
        annotations: [],
        hiddenNodeIds: [],
      },
      [
        createEmbedding('symbol:start', 'model:a', [1, 0, 0]),
        createEmbedding('symbol:init', 'model:a', [0.5, 0.5, 0]),
        createEmbedding('symbol:alone', 'model:a', [0, 1, 0]),
      ],
    )

    expect(prototypes).toHaveLength(1)
    expect(prototypes[0]).toEqual(
      expect.objectContaining({
        groupId: 'setup',
        usableMemberCount: 2,
        usableMemberNodeIds: ['symbol:start', 'symbol:init'],
      }),
    )
    expect(prototypes[0]?.values).toEqual([0.75, 0.25, 0])
  })

  it('ranks groups by cosine similarity to the query vector', () => {
    const matches = rankGroupPrototypeMatches({
      queryValues: [1, 0, 0],
      prototypes: [
        {
          groupId: 'setup',
          groupTitle: 'Setup',
          memberNodeIds: ['symbol:start', 'symbol:init'],
          usableMemberNodeIds: ['symbol:start', 'symbol:init'],
          usableMemberCount: 2,
          modelId: 'model:a',
          dimensions: 3,
          values: [0.9, 0.1, 0],
          cohesionScore: 0.9,
        },
        {
          groupId: 'combat',
          groupTitle: 'Combat',
          memberNodeIds: ['symbol:encounter', 'symbol:reward'],
          usableMemberNodeIds: ['symbol:encounter', 'symbol:reward'],
          usableMemberCount: 2,
          modelId: 'model:a',
          dimensions: 3,
          values: [0.1, 0.9, 0],
          cohesionScore: 0.9,
        },
      ],
      limit: 1,
    })

    expect(matches).toEqual([
      expect.objectContaining({
        groupId: 'setup',
      }),
    ])
  })

  it('suggests nearby non-member symbols for a group prototype', () => {
    const matches = rankNearbySymbolsForGroupPrototype({
      prototype: {
        groupId: 'setup',
        groupTitle: 'Setup',
        memberNodeIds: ['symbol:start', 'symbol:init'],
        usableMemberNodeIds: ['symbol:start', 'symbol:init'],
        usableMemberCount: 2,
        modelId: 'model:a',
        dimensions: 3,
        values: [0.8, 0.2, 0],
        cohesionScore: 0.9,
      },
      embeddings: [
        createEmbedding('symbol:start', 'model:a', [1, 0, 0]),
        createEmbedding('symbol:init', 'model:a', [0.6, 0.4, 0]),
        createEmbedding('symbol:route', 'model:a', [0.85, 0.15, 0]),
        createEmbedding('symbol:combat', 'model:a', [0, 1, 0]),
      ],
      limit: 1,
    })

    expect(matches).toEqual([
      expect.objectContaining({
        symbolId: 'symbol:route',
      }),
    ])
  })
})

function createEmbedding(symbolId: string, modelId: string, values: number[]) {
  return {
    symbolId,
    modelId,
    values,
    dimensions: values.length,
    textHash: `${symbolId}:hash`,
    generatedAt: '2026-04-17T00:00:00.000Z',
  }
}

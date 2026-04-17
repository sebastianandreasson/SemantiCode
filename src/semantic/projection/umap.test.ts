import { describe, expect, it } from 'vitest'

import { projectSemanticEmbeddings } from './umap'

describe('projectSemanticEmbeddings', () => {
  it('falls back cleanly for three vectors', () => {
    const projection = projectSemanticEmbeddings({
      seed: 7,
      vectors: [
        {
          symbolId: 'symbol:a',
          modelId: 'test-model',
          dimensions: 3,
          textHash: 'hash-a',
          values: [1, 0, 0],
          generatedAt: '2026-04-17T00:00:00.000Z',
        },
        {
          symbolId: 'symbol:b',
          modelId: 'test-model',
          dimensions: 3,
          textHash: 'hash-b',
          values: [0, 1, 0],
          generatedAt: '2026-04-17T00:00:00.000Z',
        },
        {
          symbolId: 'symbol:c',
          modelId: 'test-model',
          dimensions: 3,
          textHash: 'hash-c',
          values: [0, 0, 1],
          generatedAt: '2026-04-17T00:00:00.000Z',
        },
      ],
    })

    expect(projection.points).toHaveLength(3)
    expect(projection.symbolIds).toEqual(['symbol:a', 'symbol:b', 'symbol:c'])
    expect(projection.points.map((point) => point.symbolId)).toEqual([
      'symbol:a',
      'symbol:b',
      'symbol:c',
    ])
  })
})

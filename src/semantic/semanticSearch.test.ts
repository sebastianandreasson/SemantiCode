import { describe, expect, it } from 'vitest'

import {
  filterSemanticSearchMatches,
  filterSearchableSemanticEmbeddings,
  rankSemanticSearchMatches,
} from './semanticSearch'

describe('semanticSearch', () => {
  it('ranks matches by cosine similarity and respects the limit', () => {
    const matches = rankSemanticSearchMatches({
      queryValues: [1, 0, 0],
      embeddings: [
        createEmbedding('symbol:alpha', 'model:a', [1, 0, 0]),
        createEmbedding('symbol:beta', 'model:a', [0.6, 0.4, 0]),
        createEmbedding('symbol:gamma', 'model:a', [0, 1, 0]),
      ],
      limit: 2,
    })

    expect(matches).toEqual([
      expect.objectContaining({ symbolId: 'symbol:alpha' }),
      expect.objectContaining({ symbolId: 'symbol:beta' }),
    ])
  })

  it('keeps only the dominant coherent embedding set for searching', () => {
    const embeddings = filterSearchableSemanticEmbeddings(
      [
        createEmbedding('symbol:alpha', 'model:a', [1, 0]),
        createEmbedding('symbol:beta', 'model:a', [0, 1]),
        createEmbedding('symbol:gamma', 'model:b', [1, 0, 0]),
      ],
      new Set(['symbol:alpha', 'symbol:beta', 'symbol:gamma']),
    )

    expect(embeddings.map((embedding) => embedding.symbolId)).toEqual([
      'symbol:alpha',
      'symbol:beta',
    ])
  })

  it('filters ranked matches by strictness threshold before applying the limit', () => {
    const matches = filterSemanticSearchMatches(
      [
        { symbolId: 'symbol:alpha', score: 0.92 },
        { symbolId: 'symbol:beta', score: 0.77 },
        { symbolId: 'symbol:gamma', score: 0.54 },
        { symbolId: 'symbol:delta', score: 0.31 },
      ],
      {
        limit: 3,
        strictness: 60,
      },
    )

    expect(matches.map((match) => match.symbolId)).toEqual([
      'symbol:alpha',
      'symbol:beta',
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
    generatedAt: '2026-04-16T00:00:00.000Z',
  }
}

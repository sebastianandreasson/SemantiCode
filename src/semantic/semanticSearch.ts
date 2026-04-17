import type { SemanticEmbeddingVectorRecord } from './types'
import type { GroupPrototypeSearchMatch } from './groups/groupPrototypes'

export interface SemanticSearchMatch {
  symbolId: string
  score: number
}

export type SemanticSearchResult =
  | SemanticSearchMatch
  | GroupPrototypeSearchMatch

export function rankSemanticSearchMatches(input: {
  embeddings: SemanticEmbeddingVectorRecord[]
  limit?: number
  queryValues: number[]
}) {
  const { embeddings, queryValues } = input
  const limit = Math.max(1, input.limit ?? 24)

  if (queryValues.length === 0) {
    return []
  }

  const queryMagnitude = vectorMagnitude(queryValues)

  if (queryMagnitude === 0) {
    return []
  }

  const matches: SemanticSearchMatch[] = []

  for (const embedding of embeddings) {
    if (embedding.values.length !== queryValues.length) {
      continue
    }

    const score = cosineSimilarity(queryValues, embedding.values, queryMagnitude)

    if (!Number.isFinite(score)) {
      continue
    }

    matches.push({
      symbolId: embedding.symbolId,
      score,
    })
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, limit)
}

export function filterSemanticSearchMatches<T extends SemanticSearchResult>(
  matches: T[],
  input: {
    limit: number
    strictness: number
  },
): T[] {
  if (matches.length === 0) {
    return []
  }

  const limit = Math.max(1, input.limit)
  const strictness = Math.max(0, Math.min(100, input.strictness))
  const maxScore = matches[0]?.score ?? 0
  const minScore = matches[matches.length - 1]?.score ?? maxScore
  const threshold =
    strictness === 0
      ? minScore - Number.EPSILON
      : minScore + (maxScore - minScore) * (strictness / 100)

  return matches.filter((match) => match.score >= threshold).slice(0, limit)
}

export function filterSearchableSemanticEmbeddings(
  embeddings: SemanticEmbeddingVectorRecord[],
  symbolIds: Set<string>,
) {
  const modelCounts = new Map<string, number>()
  const dimensionsByModel = new Map<string, number>()

  for (const embedding of embeddings) {
    if (!symbolIds.has(embedding.symbolId) || embedding.values.length === 0) {
      continue
    }

    const expectedDimensions = dimensionsByModel.get(embedding.modelId)

    if (expectedDimensions == null) {
      dimensionsByModel.set(embedding.modelId, embedding.dimensions)
    } else if (expectedDimensions !== embedding.dimensions) {
      continue
    }

    modelCounts.set(embedding.modelId, (modelCounts.get(embedding.modelId) ?? 0) + 1)
  }

  const primaryModelId = [...modelCounts.entries()].sort((left, right) => {
    return right[1] - left[1]
  })[0]?.[0]

  if (!primaryModelId) {
    return []
  }

  const primaryDimensions = dimensionsByModel.get(primaryModelId)

  return embeddings.filter((embedding) => {
    return (
      embedding.modelId === primaryModelId &&
      embedding.dimensions === primaryDimensions &&
      embedding.values.length === primaryDimensions &&
      symbolIds.has(embedding.symbolId)
    )
  })
}

function cosineSimilarity(left: number[], right: number[], leftMagnitude: number) {
  const rightMagnitude = vectorMagnitude(right)

  if (rightMagnitude === 0) {
    return Number.NEGATIVE_INFINITY
  }

  let dot = 0

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
  }

  return dot / (leftMagnitude * rightMagnitude)
}

function vectorMagnitude(values: number[]) {
  let total = 0

  for (const value of values) {
    total += value * value
  }

  return Math.sqrt(total)
}

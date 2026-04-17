import type { LayoutSpec } from '../../schema/layout'
import type { SemanticEmbeddingVectorRecord } from '../types'

export interface GroupPrototypeRecord {
  groupId: string
  groupTitle: string
  memberNodeIds: string[]
  usableMemberNodeIds: string[]
  usableMemberCount: number
  modelId: string
  dimensions: number
  values: number[]
  cohesionScore: number | null
}

export interface GroupPrototypeSearchMatch {
  groupId: string
  groupTitle: string
  memberNodeIds: string[]
  score: number
}

export interface NearbyGroupPrototypeSymbolMatch {
  symbolId: string
  score: number
}

export function buildGroupPrototypeRecords(
  layout: LayoutSpec | null,
  embeddings: SemanticEmbeddingVectorRecord[],
) {
  if (!layout || layout.groups.length === 0 || embeddings.length === 0) {
    return []
  }

  const embeddingsBySymbolId = new Map(
    embeddings.map((embedding) => [embedding.symbolId, embedding]),
  )
  const prototypes: GroupPrototypeRecord[] = []

  for (const group of layout.groups) {
    const memberEmbeddings = group.nodeIds
      .map((nodeId) => embeddingsBySymbolId.get(nodeId) ?? null)
      .filter(
        (embedding): embedding is SemanticEmbeddingVectorRecord => Boolean(embedding),
      )

    if (memberEmbeddings.length < 2) {
      continue
    }

    const dimensions = memberEmbeddings[0]?.dimensions ?? 0
    const modelId = memberEmbeddings[0]?.modelId ?? ''

    if (!dimensions || !modelId) {
      continue
    }

    const coherentMemberEmbeddings = memberEmbeddings.filter((embedding) => {
      return embedding.modelId === modelId && embedding.dimensions === dimensions
    })

    if (coherentMemberEmbeddings.length < 2) {
      continue
    }

    const values = averageVectors(
      coherentMemberEmbeddings.map((embedding) => embedding.values),
      dimensions,
    )

    prototypes.push({
      groupId: group.id,
      groupTitle: group.title,
      memberNodeIds: group.nodeIds,
      usableMemberNodeIds: coherentMemberEmbeddings.map((embedding) => embedding.symbolId),
      usableMemberCount: coherentMemberEmbeddings.length,
      modelId,
      dimensions,
      values,
      cohesionScore: calculateCohesionScore(
        coherentMemberEmbeddings.map((embedding) => embedding.values),
        values,
      ),
    })
  }

  return prototypes
}

export function rankGroupPrototypeMatches(input: {
  prototypes: GroupPrototypeRecord[]
  queryValues: number[]
  limit?: number
}) {
  const { prototypes, queryValues } = input
  const limit = Math.max(1, input.limit ?? 24)

  if (queryValues.length === 0) {
    return []
  }

  const queryMagnitude = vectorMagnitude(queryValues)

  if (queryMagnitude === 0) {
    return []
  }

  const matches: GroupPrototypeSearchMatch[] = []

  for (const prototype of prototypes) {
    if (prototype.values.length !== queryValues.length) {
      continue
    }

    const score = cosineSimilarity(queryValues, prototype.values, queryMagnitude)

    if (!Number.isFinite(score)) {
      continue
    }

    matches.push({
      groupId: prototype.groupId,
      groupTitle: prototype.groupTitle,
      memberNodeIds: prototype.memberNodeIds,
      score,
    })
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, limit)
}

export function rankNearbySymbolsForGroupPrototype(input: {
  prototype: GroupPrototypeRecord | null
  embeddings: SemanticEmbeddingVectorRecord[]
  limit?: number
}) {
  const { prototype, embeddings } = input
  const limit = Math.max(1, input.limit ?? 8)

  if (!prototype || prototype.values.length === 0) {
    return []
  }

  const prototypeMagnitude = vectorMagnitude(prototype.values)

  if (prototypeMagnitude === 0) {
    return []
  }

  const excludedNodeIds = new Set(prototype.memberNodeIds)
  const matches: NearbyGroupPrototypeSymbolMatch[] = []

  for (const embedding of embeddings) {
    if (
      excludedNodeIds.has(embedding.symbolId) ||
      embedding.modelId !== prototype.modelId ||
      embedding.dimensions !== prototype.dimensions ||
      embedding.values.length !== prototype.dimensions
    ) {
      continue
    }

    const score = cosineSimilarity(prototype.values, embedding.values, prototypeMagnitude)

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

function averageVectors(vectors: number[][], dimensions: number) {
  const sums = new Array<number>(dimensions).fill(0)

  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) {
      sums[index] += vector[index] ?? 0
    }
  }

  return sums.map((value) => value / vectors.length)
}

function calculateCohesionScore(vectors: number[][], centroid: number[]) {
  if (vectors.length === 0) {
    return null
  }

  const centroidMagnitude = vectorMagnitude(centroid)

  if (centroidMagnitude === 0) {
    return null
  }

  let total = 0

  for (const vector of vectors) {
    total += cosineSimilarity(vector, centroid, vectorMagnitude(vector))
  }

  return total / vectors.length
}

function cosineSimilarity(left: number[], right: number[], leftMagnitude: number) {
  const rightMagnitude = vectorMagnitude(right)

  if (leftMagnitude === 0 || rightMagnitude === 0) {
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

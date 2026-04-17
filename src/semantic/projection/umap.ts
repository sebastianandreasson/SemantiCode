import { UMAP } from 'umap-js'

import type {
  SemanticProjectionPoint,
  SemanticProjectionRecord,
  SemanticUmapInput,
} from '../types'

const PROJECTION_WIDTH = 3200
const PROJECTION_HEIGHT = 2200

export function projectSemanticEmbeddings(
  input: SemanticUmapInput,
): SemanticProjectionRecord {
  const vectors = input.vectors.filter((vector) => vector.values.length > 0)

  if (vectors.length === 0) {
    return {
      id: `semantic-projection:${input.seed}:0`,
      modelId: input.vectors[0]?.modelId ?? 'unknown',
      symbolIds: [],
      points: [],
      seed: input.seed,
      generatedAt: new Date().toISOString(),
    }
  }

  const points =
    vectors.length <= 3
      ? normalizeProjection(projectSmallVectorSet(vectors))
      : normalizeProjection(projectWithUmapOrFallback(vectors, input.seed))

  return {
    id: `semantic-projection:${input.seed}:${vectors[0]?.modelId ?? 'unknown'}:${vectors.length}`,
    modelId: vectors[0]?.modelId ?? 'unknown',
    symbolIds: vectors.map((vector) => vector.symbolId),
    points,
    seed: input.seed,
    generatedAt: new Date().toISOString(),
  }
}

function projectWithUmapOrFallback(
  input: SemanticUmapInput['vectors'],
  seed: number,
) {
  try {
    return projectWithUmap(input, seed)
  } catch {
    return projectSmallVectorSet(input)
  }
}

function projectWithUmap(input: SemanticUmapInput['vectors'], seed: number) {
  const random = createSeededRandom(seed)
  const nNeighbors = Math.min(20, Math.max(2, input.length - 1))
  const umap = new UMAP({
    nComponents: 2,
    nEpochs: 350,
    nNeighbors,
    minDist: 0.12,
    spread: 1.35,
    distanceFn: cosineDistance,
    random,
  })
  const embedding = umap.fit(input.map((vector) => vector.values))

  return input.map((vector, index): SemanticProjectionPoint => ({
    symbolId: vector.symbolId,
    x: embedding[index]?.[0] ?? 0,
    y: embedding[index]?.[1] ?? 0,
  }))
}

function projectSmallVectorSet(
  input: SemanticUmapInput['vectors'],
): SemanticProjectionPoint[] {
  if (input.length === 1) {
    return [
      {
        symbolId: input[0].symbolId,
        x: 0,
        y: 0,
      },
    ]
  }

  return input.map((vector, index) => ({
    symbolId: vector.symbolId,
    x: index,
    y: 0,
  }))
}

function createSeededRandom(seed: number) {
  let value = seed >>> 0

  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0xffffffff
  }
}

function cosineDistance(left: number[], right: number[]) {
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0))
  const rightMagnitude = Math.sqrt(
    right.reduce((sum, value) => sum + value * value, 0),
  )

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 1
  }

  let dotProduct = 0

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += left[index] * (right[index] ?? 0)
  }

  const similarity = dotProduct / (leftMagnitude * rightMagnitude)

  return 1 - Math.max(-1, Math.min(1, similarity))
}

function normalizeProjection(points: SemanticProjectionPoint[]) {
  if (points.length === 0) {
    return points
  }

  const xValues = points.map((point) => point.x)
  const yValues = points.map((point) => point.y)
  const minX = Math.min(...xValues)
  const maxX = Math.max(...xValues)
  const minY = Math.min(...yValues)
  const maxY = Math.max(...yValues)
  const xRange = Math.max(1e-6, maxX - minX)
  const yRange = Math.max(1e-6, maxY - minY)

  return points.map((point) => ({
    symbolId: point.symbolId,
    x: ((point.x - minX) / xRange) * PROJECTION_WIDTH,
    y: ((point.y - minY) / yRange) * PROJECTION_HEIGHT,
  }))
}

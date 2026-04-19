import type { LayoutSpec } from '../../schema/layout'
import type {
  SemanticProjectionPoint,
  SemanticProjectionRecord,
  SemanticRefinementInput,
} from '../types'

const CLUSTER_SHELF_WIDTH = 6200
const CLUSTER_GAP_X = 340
const CLUSTER_GAP_Y = 260

export function refineSemanticLayout(
  projection: SemanticProjectionRecord,
  input: SemanticRefinementInput,
): LayoutSpec {
  if (projection.points.length === 0) {
    return input.baseLayout
  }

  const placements = { ...input.baseLayout.placements }
  const clusters = clusterProjectionPoints(projection.points, input.minimumSpacing)
  let cursorX = 0
  let cursorY = 0
  let currentRowHeight = 0

  for (const cluster of clusters) {
    const packedCluster = packCluster(
      cluster,
      input.minimumSpacing,
      input.nodeFootprints ?? {},
    )

    if (cursorX > 0 && cursorX + packedCluster.width > CLUSTER_SHELF_WIDTH) {
      cursorX = 0
      cursorY += currentRowHeight + CLUSTER_GAP_Y
      currentRowHeight = 0
    }

    for (const point of packedCluster.points) {
      const placement = placements[point.symbolId]

      if (!placement) {
        continue
      }

      placements[point.symbolId] = {
        ...placement,
        x: cursorX + point.x,
        y: cursorY + point.y,
      }
    }

    cursorX += packedCluster.width + CLUSTER_GAP_X
    currentRowHeight = Math.max(currentRowHeight, packedCluster.height)
  }

  return {
    ...input.baseLayout,
    placements,
    updatedAt: input.baseLayout.updatedAt,
  }
}

function clusterProjectionPoints(
  points: SemanticProjectionPoint[],
  minimumSpacing: number,
) {
  const remaining = new Set(points.map((point) => point.symbolId))
  const pointById = new Map(points.map((point) => [point.symbolId, point]))
  const threshold = minimumSpacing * 2.8
  const clusters: SemanticProjectionPoint[][] = []

  while (remaining.size > 0) {
    const startId = Array.from(remaining)[0]

    if (!startId) {
      break
    }

    const cluster: SemanticProjectionPoint[] = []
    const queue = [startId]
    remaining.delete(startId)

    while (queue.length > 0) {
      const currentId = queue.shift()

      if (!currentId) {
        continue
      }

      const currentPoint = pointById.get(currentId)

      if (!currentPoint) {
        continue
      }

      cluster.push(currentPoint)

      for (const candidateId of Array.from(remaining)) {
        const candidatePoint = pointById.get(candidateId)

        if (!candidatePoint) {
          continue
        }

        if (distanceBetweenPoints(currentPoint, candidatePoint) > threshold) {
          continue
        }

        remaining.delete(candidateId)
        queue.push(candidateId)
      }
    }

    clusters.push(cluster)
  }

  return clusters.sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length
    }

    return getClusterSortKey(left).localeCompare(getClusterSortKey(right))
  })
}

function packCluster(
  cluster: SemanticProjectionPoint[],
  minimumSpacing: number,
  nodeFootprints: NonNullable<SemanticRefinementInput['nodeFootprints']>,
) {
  const innerSpacing = Math.round(minimumSpacing * 0.58)
  const padding = minimumSpacing
  const occupancy = new Set<string>()
  const normalizedPoints = normalizeClusterPoints(cluster)

  if (normalizedPoints.length === 1) {
    const footprint = getNodeFootprint(
      normalizedPoints[0].symbolId,
      nodeFootprints,
      minimumSpacing,
    )

    return {
      width: padding * 2 + footprint.width,
      height: padding * 2 + footprint.height,
      points: [
        {
          symbolId: normalizedPoints[0].symbolId,
          x: padding,
          y: padding,
        },
      ],
    }
  }

  const targetColumns = Math.max(2, Math.ceil(Math.sqrt(normalizedPoints.length)))
  const packedCells = normalizedPoints.map((point) => {
    const desiredColumn = Math.round(point.x * (targetColumns - 1))
    const desiredRow = Math.round(
      point.y *
        Math.max(1, Math.ceil(normalizedPoints.length / targetColumns) - 1),
    )
    const cell = findNearestFreeCell(desiredColumn, desiredRow, occupancy)

    occupancy.add(`${cell.column}:${cell.row}`)

    return {
      symbolId: point.symbolId,
      row: cell.row,
      column: cell.column,
      footprint: getNodeFootprint(point.symbolId, nodeFootprints, minimumSpacing),
    }
  })

  const maxColumn = Math.max(...packedCells.map((point) => point.column))
  const maxRow = Math.max(...packedCells.map((point) => point.row))
  const columnWidths = Array.from({ length: maxColumn + 1 }, () => minimumSpacing)
  const rowHeights = Array.from({ length: maxRow + 1 }, () => minimumSpacing)

  for (const point of packedCells) {
    columnWidths[point.column] = Math.max(
      columnWidths[point.column] ?? minimumSpacing,
      point.footprint.width,
    )
    rowHeights[point.row] = Math.max(
      rowHeights[point.row] ?? minimumSpacing,
      point.footprint.height,
    )
  }

  const columnOffsets = buildOffsets(columnWidths, padding, innerSpacing)
  const rowOffsets = buildOffsets(rowHeights, padding, innerSpacing)

  return {
    width: padding * 2 + sum(columnWidths) + Math.max(0, maxColumn) * innerSpacing,
    height: padding * 2 + sum(rowHeights) + Math.max(0, maxRow) * innerSpacing,
    points: packedCells.map(({ column, footprint, row, symbolId }) => ({
      symbolId,
      x:
        columnOffsets[column] +
        Math.max(0, ((columnWidths[column] ?? 0) - footprint.width) / 2),
      y:
        rowOffsets[row] +
        Math.max(0, ((rowHeights[row] ?? 0) - footprint.height) / 2),
    })),
  }
}

function getNodeFootprint(
  symbolId: string,
  nodeFootprints: NonNullable<SemanticRefinementInput['nodeFootprints']>,
  minimumSpacing: number,
) {
  return nodeFootprints[symbolId] ?? {
    height: minimumSpacing,
    width: minimumSpacing,
  }
}

function buildOffsets(sizes: number[], padding: number, gap: number) {
  let cursor = padding

  return sizes.map((size) => {
    const offset = cursor
    cursor += size + gap
    return offset
  })
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function normalizeClusterPoints(cluster: SemanticProjectionPoint[]) {
  const xValues = cluster.map((point) => point.x)
  const yValues = cluster.map((point) => point.y)
  const minX = Math.min(...xValues)
  const maxX = Math.max(...xValues)
  const minY = Math.min(...yValues)
  const maxY = Math.max(...yValues)
  const xRange = Math.max(1e-6, maxX - minX)
  const yRange = Math.max(1e-6, maxY - minY)

  return [...cluster]
    .sort((left, right) => {
      if (left.y !== right.y) {
        return left.y - right.y
      }

      if (left.x !== right.x) {
        return left.x - right.x
      }

      return left.symbolId.localeCompare(right.symbolId)
    })
    .map((point) => ({
      symbolId: point.symbolId,
      x: (point.x - minX) / xRange,
      y: (point.y - minY) / yRange,
    }))
}

function findNearestFreeCell(
  desiredColumn: number,
  desiredRow: number,
  occupancy: Set<string>,
) {
  if (!occupancy.has(`${desiredColumn}:${desiredRow}`)) {
    return {
      column: desiredColumn,
      row: desiredRow,
    }
  }

  for (let radius = 1; radius < 32; radius += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      for (let columnOffset = -radius; columnOffset <= radius; columnOffset += 1) {
        const column = Math.max(0, desiredColumn + columnOffset)
        const row = Math.max(0, desiredRow + rowOffset)
        const key = `${column}:${row}`

        if (!occupancy.has(key)) {
          return { column, row }
        }
      }
    }
  }

  return {
    column: desiredColumn,
    row: desiredRow,
  }
}

function distanceBetweenPoints(
  left: SemanticProjectionPoint,
  right: SemanticProjectionPoint,
) {
  const deltaX = left.x - right.x
  const deltaY = left.y - right.y
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY)
}

function getClusterSortKey(cluster: SemanticProjectionPoint[]) {
  const centroid = cluster.reduce(
    (sum, point) => ({
      x: sum.x + point.x,
      y: sum.y + point.y,
    }),
    { x: 0, y: 0 },
  )
  const normalizedX = centroid.x / cluster.length
  const normalizedY = centroid.y / cluster.length

  return `${normalizedY.toFixed(2)}:${normalizedX.toFixed(2)}`
}

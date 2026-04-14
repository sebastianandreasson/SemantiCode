import type { LayoutNodePlacement, LayoutSpec, ProjectSnapshot } from '../types'

const DIRECTORY_NODE_WIDTH = 240
const FILE_NODE_WIDTH = 224
const DIRECTORY_NODE_HEIGHT = 68
const FILE_NODE_HEIGHT = 54
const COLUMN_WIDTH = 280
const ROW_HEIGHT = 94

export function buildStructuralLayout(snapshot: ProjectSnapshot): LayoutSpec {
  const placements: Record<string, LayoutNodePlacement> = {}
  let rowIndex = 0

  for (const rootId of snapshot.rootIds) {
    rowIndex = placeNode(snapshot, rootId, placements, 0, rowIndex)
    rowIndex += 1
  }

  return {
    id: `layout:structural:${snapshot.rootDir}`,
    title: 'Folder structure',
    strategy: 'structural',
    description: 'Default filesystem layout mapped directly from the project tree.',
    placements,
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: Object.values(snapshot.nodes)
      .filter((node) => node.kind === 'symbol')
      .map((node) => node.id),
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  }
}

function placeNode(
  snapshot: ProjectSnapshot,
  nodeId: string,
  placements: Record<string, LayoutNodePlacement>,
  depth: number,
  rowIndex: number,
): number {
  const node = snapshot.nodes[nodeId]

  if (!node || node.kind === 'symbol') {
    return rowIndex
  }

  placements[node.id] = {
    nodeId: node.id,
    x: depth * COLUMN_WIDTH,
    y: rowIndex * ROW_HEIGHT,
    width:
      node.kind === 'directory' ? DIRECTORY_NODE_WIDTH : FILE_NODE_WIDTH,
    height:
      node.kind === 'directory' ? DIRECTORY_NODE_HEIGHT : FILE_NODE_HEIGHT,
  }

  let nextRowIndex = rowIndex + 1

  if (node.kind !== 'directory') {
    return nextRowIndex
  }

  for (const childId of node.childIds) {
    nextRowIndex = placeNode(
      snapshot,
      childId,
      placements,
      depth + 1,
      nextRowIndex,
    )
  }

  return nextRowIndex
}

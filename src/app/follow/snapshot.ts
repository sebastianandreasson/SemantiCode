import {
  isFileNode,
  isSymbolNode,
  type ProjectSnapshot,
  type SymbolNode,
} from '../../schema/snapshot'
import type { FollowIndexes } from './types'

export function buildFollowIndexes(snapshot: ProjectSnapshot | null): FollowIndexes | null {
  if (!snapshot) {
    return null
  }

  const fileIdsByPath = new Map<string, string>()
  const symbolIdsByFileId = new Map<string, string[]>()

  for (const node of Object.values(snapshot.nodes)) {
    if (isFileNode(node)) {
      fileIdsByPath.set(node.path, node.id)
      continue
    }

    if (isSymbolNode(node)) {
      const currentSymbolIds = symbolIdsByFileId.get(node.fileId) ?? []
      currentSymbolIds.push(node.id)
      symbolIdsByFileId.set(node.fileId, currentSymbolIds)
    }
  }

  return {
    fileIdsByPath,
    symbolIdsByFileId,
  }
}

export function countSnapshotSymbols(snapshot: ProjectSnapshot | null) {
  if (!snapshot) {
    return 0
  }

  return Object.values(snapshot.nodes).filter(isSymbolNode).length
}

export function buildSnapshotSignature(snapshot: ProjectSnapshot | null) {
  if (!snapshot) {
    return null
  }

  return [
    snapshot.rootDir,
    snapshot.generatedAt,
    Object.keys(snapshot.nodes).length,
    snapshot.edges.length,
  ].join('::')
}

export function getPreferredFollowSymbolIdsForFile(input: {
  fileId: string
  snapshot: ProjectSnapshot
  symbolIdsByFileId: Map<string, string[]>
}) {
  const symbolIds = input.symbolIdsByFileId.get(input.fileId) ?? []
  const symbols = symbolIds
    .map((symbolId) => input.snapshot.nodes[symbolId])
    .filter(isSymbolNode)

  if (symbols.length === 0) {
    return []
  }

  const preferredSymbols = symbols.filter(isPreferredFollowSymbolNode)
  const candidates = preferredSymbols.length > 0 ? preferredSymbols : symbols

  return [...candidates]
    .sort(compareSymbolsForFollow)
    .map((symbol) => symbol.id)
}

function isPreferredFollowSymbolNode(symbol: SymbolNode) {
  const normalizedName = symbol.name.trim().toLowerCase()

  if (
    normalizedName.length === 0 ||
    normalizedName === 'anon' ||
    normalizedName === 'anonymous' ||
    normalizedName === 'global'
  ) {
    return false
  }

  return symbol.symbolKind !== 'unknown' && symbol.symbolKind !== 'module'
}

function compareSymbolsForFollow(left: SymbolNode, right: SymbolNode) {
  const leftPreferred = isPreferredFollowSymbolNode(left) ? 0 : 1
  const rightPreferred = isPreferredFollowSymbolNode(right) ? 0 : 1

  if (leftPreferred !== rightPreferred) {
    return leftPreferred - rightPreferred
  }

  const leftKindRank = getFollowSymbolKindRank(left)
  const rightKindRank = getFollowSymbolKindRank(right)

  if (leftKindRank !== rightKindRank) {
    return leftKindRank - rightKindRank
  }

  const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
  const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }

  return left.id.localeCompare(right.id)
}

function getFollowSymbolKindRank(symbol: SymbolNode) {
  switch (symbol.symbolKind) {
    case 'class':
      return 0
    case 'function':
      return 1
    case 'method':
      return 2
    case 'constant':
      return 3
    case 'variable':
      return 4
    default:
      return 99
  }
}

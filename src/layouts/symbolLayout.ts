import type {
  GraphEdge,
  LayoutNodePlacement,
  LayoutSpec,
  ProjectSnapshot,
  SymbolKind,
  SymbolNode,
} from '../types'

const SYMBOL_NODE_WIDTH = 248
const SYMBOL_NODE_HEIGHT = 82
const COMPONENT_COLUMN_WIDTH = 320
const COMPONENT_ROW_HEIGHT = 106
const ISOLATED_GRID_COLUMN_WIDTH = 276
const ISOLATED_GRID_ROW_HEIGHT = 100
const ISOLATED_GRID_COLUMNS = 3

const SUPPORTED_SYMBOL_KINDS = new Set<SymbolKind>([
  'class',
  'function',
  'method',
  'constant',
  'variable',
])

const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = {
  class: 0,
  function: 1,
  method: 2,
  constant: 3,
  variable: 4,
  module: 5,
  unknown: 6,
}

export function buildSymbolLayout(snapshot: ProjectSnapshot): LayoutSpec {
  const placements: Record<string, LayoutNodePlacement> = {}
  const symbols = Object.values(snapshot.nodes).filter(isSupportedSymbolNode)
  const adjacency = buildSymbolAdjacency(symbols, snapshot.edges)
  const components = collectComponents(symbols, adjacency)
  const connectedComponents = components.filter((component) => component.length > 1)
  const isolatedSymbols = components
    .filter((component) => component.length === 1)
    .flat()
    .sort(compareSymbols)

  connectedComponents
    .sort((left, right) => compareComponents(left, right, adjacency))
    .forEach((component, componentIndex) => {
      const sortedComponent = [...component].sort((left, right) =>
        compareSymbolsByDegree(left, right, adjacency),
      )

      sortedComponent.forEach((symbol, rowIndex) => {
        placements[symbol.id] = {
          nodeId: symbol.id,
          x: componentIndex * COMPONENT_COLUMN_WIDTH,
          y: rowIndex * COMPONENT_ROW_HEIGHT,
          width: SYMBOL_NODE_WIDTH,
          height: SYMBOL_NODE_HEIGHT,
        }
      })
    })

  const isolatedBaseX = connectedComponents.length * COMPONENT_COLUMN_WIDTH

  isolatedSymbols.forEach((symbol, index) => {
    placements[symbol.id] = {
      nodeId: symbol.id,
      x: isolatedBaseX + (index % ISOLATED_GRID_COLUMNS) * ISOLATED_GRID_COLUMN_WIDTH,
      y: Math.floor(index / ISOLATED_GRID_COLUMNS) * ISOLATED_GRID_ROW_HEIGHT,
      width: SYMBOL_NODE_WIDTH,
      height: SYMBOL_NODE_HEIGHT,
    }
  })

  return {
    id: `layout:symbols:${snapshot.rootDir}`,
    title: 'Code symbols',
    strategy: 'structural',
    nodeScope: 'symbols',
    description: 'Default symbol-only layout grouped by connected symbol components.',
    placements,
    groups: [],
    lanes: [],
    annotations: [],
    hiddenNodeIds: Object.values(snapshot.nodes)
      .filter((node) => !isSupportedSymbolNode(node))
      .map((node) => node.id),
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  }
}

function buildSymbolAdjacency(
  symbols: SymbolNode[],
  edges: GraphEdge[],
) {
  const symbolIds = new Set(symbols.map((symbol) => symbol.id))
  const adjacency = new Map<string, Set<string>>()

  for (const symbol of symbols) {
    adjacency.set(symbol.id, new Set())
  }

  for (const edge of edges) {
    if (edge.kind !== 'calls' && edge.kind !== 'contains') {
      continue
    }

    if (!symbolIds.has(edge.source) || !symbolIds.has(edge.target)) {
      continue
    }

    adjacency.get(edge.source)?.add(edge.target)
    adjacency.get(edge.target)?.add(edge.source)
  }

  return adjacency
}

function collectComponents(
  symbols: SymbolNode[],
  adjacency: Map<string, Set<string>>,
) {
  const remaining = new Set(symbols.map((symbol) => symbol.id))
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const components: SymbolNode[][] = []

  while (remaining.size > 0) {
    const startId = Array.from(remaining).sort()[0]

    if (!startId) {
      break
    }

    const component: SymbolNode[] = []
    const stack = [startId]
    remaining.delete(startId)

    while (stack.length > 0) {
      const currentId = stack.pop()

      if (!currentId) {
        continue
      }

      const currentSymbol = symbolById.get(currentId)

      if (currentSymbol) {
        component.push(currentSymbol)
      }

      const neighbors = Array.from(adjacency.get(currentId) ?? []).sort()

      for (const neighborId of neighbors) {
        if (!remaining.has(neighborId)) {
          continue
        }

        remaining.delete(neighborId)
        stack.push(neighborId)
      }
    }

    components.push(component.sort(compareSymbols))
  }

  return components
}

function compareComponents(
  left: SymbolNode[],
  right: SymbolNode[],
  adjacency: Map<string, Set<string>>,
) {
  if (left.length !== right.length) {
    return right.length - left.length
  }

  const leftDegree = sumComponentDegree(left, adjacency)
  const rightDegree = sumComponentDegree(right, adjacency)

  if (leftDegree !== rightDegree) {
    return rightDegree - leftDegree
  }

  return compareSymbols(left[0], right[0])
}

function sumComponentDegree(
  component: SymbolNode[],
  adjacency: Map<string, Set<string>>,
) {
  return component.reduce(
    (sum, symbol) => sum + (adjacency.get(symbol.id)?.size ?? 0),
    0,
  )
}

function compareSymbolsByDegree(
  left: SymbolNode,
  right: SymbolNode,
  adjacency: Map<string, Set<string>>,
) {
  const leftDegree = adjacency.get(left.id)?.size ?? 0
  const rightDegree = adjacency.get(right.id)?.size ?? 0

  if (leftDegree !== rightDegree) {
    return rightDegree - leftDegree
  }

  return compareSymbols(left, right)
}

function compareSymbols(left: SymbolNode, right: SymbolNode) {
  const leftKindOrder = SYMBOL_KIND_ORDER[left.symbolKind] ?? Number.MAX_SAFE_INTEGER
  const rightKindOrder = SYMBOL_KIND_ORDER[right.symbolKind] ?? Number.MAX_SAFE_INTEGER

  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder - rightKindOrder
  }

  if (left.path !== right.path) {
    return left.path.localeCompare(right.path)
  }

  const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
  const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

  if (leftLine !== rightLine) {
    return leftLine - rightLine
  }

  const leftColumn = left.range?.start.column ?? Number.MAX_SAFE_INTEGER
  const rightColumn = right.range?.start.column ?? Number.MAX_SAFE_INTEGER

  if (leftColumn !== rightColumn) {
    return leftColumn - rightColumn
  }

  return left.id.localeCompare(right.id)
}

function isSupportedSymbolNode(
  node: ProjectSnapshot['nodes'][string],
): node is SymbolNode {
  return node.kind === 'symbol' && SUPPORTED_SYMBOL_KINDS.has(node.symbolKind)
}

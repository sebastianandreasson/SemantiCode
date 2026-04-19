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
const COMPONENT_GAP_X = 220
const COMPONENT_GAP_Y = 82
const ISOLATED_GAP_X = 130
const ISOLATED_GAP_Y = 96
const ISOLATED_SHELF_WIDTH = 4_400
const MIN_SYMBOL_SLOT_WIDTH = 340
const MAX_SYMBOL_SLOT_WIDTH = 1_560
const MIN_SYMBOL_SLOT_HEIGHT = 150
const MAX_SYMBOL_SLOT_HEIGHT = 860
const SYMBOL_LAYOUT_COORDINATE_VERSION = 'symbol-spacing-v2'

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

  let componentCursorX = 0

  connectedComponents
    .sort((left, right) => compareComponents(left, right, adjacency))
    .forEach((component) => {
      const sortedComponent = [...component].sort((left, right) =>
        compareSymbolsByDegree(left, right, adjacency),
      )
      const componentSlots = sortedComponent.map(getSymbolLayoutSlot)
      const componentWidth = Math.max(
        ...componentSlots.map((slot) => slot.width),
        MIN_SYMBOL_SLOT_WIDTH,
      )
      let componentCursorY = 0

      sortedComponent.forEach((symbol, rowIndex) => {
        const slot = componentSlots[rowIndex] ?? getSymbolLayoutSlot(symbol)
        placements[symbol.id] = {
          nodeId: symbol.id,
          x: componentCursorX,
          y: componentCursorY,
          width: SYMBOL_NODE_WIDTH,
          height: SYMBOL_NODE_HEIGHT,
        }

        componentCursorY += slot.height + COMPONENT_GAP_Y
      })

      componentCursorX += componentWidth + COMPONENT_GAP_X
    })

  const isolatedBaseX = componentCursorX
  const isolatedMaxX = isolatedBaseX + ISOLATED_SHELF_WIDTH
  let isolatedCursorX = isolatedBaseX
  let isolatedCursorY = 0
  let isolatedRowHeight = 0

  isolatedSymbols.forEach((symbol) => {
    const slot = getSymbolLayoutSlot(symbol)

    if (
      isolatedCursorX > isolatedBaseX &&
      isolatedCursorX + slot.width > isolatedMaxX
    ) {
      isolatedCursorX = isolatedBaseX
      isolatedCursorY += isolatedRowHeight + ISOLATED_GAP_Y
      isolatedRowHeight = 0
    }

    placements[symbol.id] = {
      nodeId: symbol.id,
      x: isolatedCursorX,
      y: isolatedCursorY,
      width: SYMBOL_NODE_WIDTH,
      height: SYMBOL_NODE_HEIGHT,
    }

    isolatedCursorX += slot.width + ISOLATED_GAP_X
    isolatedRowHeight = Math.max(isolatedRowHeight, slot.height)
  })

  return {
    id: `layout:symbols:${snapshot.rootDir}`,
    title: 'Code symbols',
    strategy: 'structural',
    nodeScope: 'symbols',
    description: `Default symbol-only layout grouped by connected symbol components. ${SYMBOL_LAYOUT_COORDINATE_VERSION}`,
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

function getSymbolLayoutSlot(symbol: SymbolNode) {
  const loc = getSymbolLoc(symbol)
  const logLoc = Math.log10(loc + 1)
  const highLocWeight = Math.max(0, Math.min(1, (logLoc - 2.1) / 0.9))
  const locScale = Math.max(
    1,
    Math.min(
      5.4,
      1 +
        Math.pow(logLoc, 1.45) * 0.58 +
        Math.pow(highLocWeight, 1.35) * 1.55,
    ),
  )

  return {
    width: Math.round(
      Math.max(
        MIN_SYMBOL_SLOT_WIDTH,
        Math.min(MAX_SYMBOL_SLOT_WIDTH, SYMBOL_NODE_WIDTH * locScale + 96),
      ),
    ),
    height: Math.round(
      Math.max(
        MIN_SYMBOL_SLOT_HEIGHT,
        Math.min(MAX_SYMBOL_SLOT_HEIGHT, SYMBOL_NODE_HEIGHT * locScale + 170),
      ),
    ),
  }
}

function getSymbolLoc(symbol: SymbolNode) {
  if (!symbol.range) {
    return 1
  }

  return Math.max(1, symbol.range.end.line - symbol.range.start.line + 1)
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

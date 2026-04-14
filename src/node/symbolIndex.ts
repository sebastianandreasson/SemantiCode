import type { SourceRange, SymbolNode } from '../types'

export interface SymbolIndex {
  byId: Record<string, SymbolNode>
  byFile: Map<string, SymbolNode[]>
  byRangeKey: Map<string, SymbolNode>
}

export function createEmptySymbolIndex(): SymbolIndex {
  return {
    byId: {},
    byFile: new Map<string, SymbolNode[]>(),
    byRangeKey: new Map<string, SymbolNode>(),
  }
}

export function registerSymbolNodes(
  symbols: SymbolNode[],
  index: SymbolIndex,
) {
  for (const symbolNode of symbols) {
    index.byId[symbolNode.id] = symbolNode
    index.byRangeKey.set(getRangeKey(symbolNode.fileId, symbolNode.range), symbolNode)

    const fileSymbols = index.byFile.get(symbolNode.fileId) ?? []
    fileSymbols.push(symbolNode)
    index.byFile.set(symbolNode.fileId, fileSymbols)
  }
}

export function getSymbolByRange(
  index: SymbolIndex,
  fileId: string,
  range: SourceRange | undefined,
) {
  return index.byRangeKey.get(getRangeKey(fileId, range))
}

function getRangeKey(fileId: string, range: SourceRange | undefined) {
  if (!range) {
    return `${fileId}:unknown`
  }

  return `${fileId}:${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`
}

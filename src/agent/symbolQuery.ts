import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

import type { LayoutSelector } from '../schema/layoutSuggestion'
import {
  isFileNode,
  isSymbolNode,
  type FileNode,
  type GraphEdge,
  type GraphEdgeKind,
  type ProjectNode,
  type ProjectSnapshot,
  type SourceLocation,
  type SourceRange,
  type SymbolNode,
} from '../schema/snapshot'

export const DEFAULT_SYMBOL_QUERY_LIMIT = 50
export const MAX_SYMBOL_QUERY_LIMIT = 200
export const MAX_SYMBOL_NEIGHBORHOOD_DEPTH = 2
export const MAX_SYMBOL_QUERY_OUTPUT_CHARS = 120_000
export const DEFAULT_FILE_WINDOW_LINES = 80
export const MAX_FILE_WINDOW_LINES = 240
export const DEFAULT_SYMBOL_SLICE_LINES = 120
export const MAX_SYMBOL_CONTEXT_LINES = 40
export const MAX_SYMBOL_SLICE_LINES = 260
export const MAX_SYMBOL_TEXT_CHARS = 60_000
export const DEFAULT_SYMBOL_OUTLINE_NESTED_LIMIT = 30
export const MAX_SYMBOL_OUTLINE_NESTED_LIMIT = 80
export const DEFAULT_SYMBOL_OUTLINE_PREVIEW_LINES = 30
export const MAX_SYMBOL_OUTLINE_PREVIEW_LINES = 80

export type SymbolQueryOperation =
  | 'findSymbols'
  | 'getSymbolOutline'
  | 'getSymbolNeighborhood'
  | 'getSymbolWorkspaceSummary'
  | 'readFileWindow'
  | 'readSymbolSlice'
  | 'replaceFileWindow'
  | 'replaceSymbolRange'

export type SymbolQuerySortBy = 'degree' | 'kind' | 'loc' | 'name' | 'path'
export type SymbolQuerySortDirection = 'asc' | 'desc'

export interface SymbolQueryCommand {
  args?: Record<string, unknown>
  operation: SymbolQueryOperation
}

export interface SymbolQuerySessionInput {
  fileWriter?: (filePath: string, content: string) => Promise<void>
  rootDir: string
  snapshotInvalidator?: () => Promise<void> | void
  snapshotProvider: () => Promise<ProjectSnapshot>
}

export interface SymbolQuerySessionResult {
  budgetExhausted?: boolean
  ok: boolean
  result?: unknown
  warning?: string
}

interface SymbolQueryStatsDelta {
  returnedEdgeCount?: number
  returnedNodeCount?: number
  truncatedResultCount?: number
}

interface SymbolQueryStats {
  returnedEdgeCount: number
  returnedNodeCount: number
  toolCallCount: number
  truncatedResultCount: number
}

export class SymbolQuerySession {
  private readonly input: SymbolQuerySessionInput
  private readonly stats: SymbolQueryStats = {
    returnedEdgeCount: 0,
    returnedNodeCount: 0,
    toolCallCount: 0,
    truncatedResultCount: 0,
  }

  constructor(input: SymbolQuerySessionInput) {
    this.input = input
  }

  getStats() {
    return { ...this.stats }
  }

  async execute(command: SymbolQueryCommand): Promise<SymbolQuerySessionResult> {
    this.stats.toolCallCount += 1

    try {
      const snapshot = await this.input.snapshotProvider()

      switch (command.operation) {
        case 'getSymbolWorkspaceSummary':
          return this.prepareResult(this.getSymbolWorkspaceSummary(snapshot))
        case 'findSymbols':
          return this.findSymbols(snapshot, command.args ?? {})
        case 'getSymbolOutline':
          return this.getSymbolOutline(snapshot, command.args ?? {})
        case 'getSymbolNeighborhood':
          return this.getSymbolNeighborhood(snapshot, command.args ?? {})
        case 'readSymbolSlice':
          return this.readSymbolSlice(snapshot, command.args ?? {})
        case 'readFileWindow':
          return this.readFileWindow(snapshot, command.args ?? {})
        case 'replaceFileWindow':
          return this.replaceFileWindow(snapshot, command.args ?? {})
        case 'replaceSymbolRange':
          return this.replaceSymbolRange(snapshot, command.args ?? {})
        default:
          return {
            ok: false,
            warning: `Unknown symbol query operation: ${(command as SymbolQueryCommand).operation}`,
          }
      }
    } catch (error) {
      return {
        ok: false,
        warning: error instanceof Error ? error.message : 'Symbol query failed.',
      }
    }
  }

  private getSymbolWorkspaceSummary(snapshot: ProjectSnapshot) {
    const nodes = Object.values(snapshot.nodes)
    const files = nodes.filter(isFileNode)
    const symbols = nodes.filter(isSymbolNode)
    const edgeCounts = countBy(snapshot.edges, (edge) => edge.kind)
    const locs = symbols
      .map(getSymbolLoc)
      .filter((loc): loc is number => loc !== undefined)
      .sort((left, right) => left - right)

    return {
      availableFacets: snapshot.facetDefinitions,
      capabilities: {
        calls: Boolean(edgeCounts.calls),
        imports: Boolean(edgeCounts.imports),
        symbols: symbols.length > 0,
      },
      countsByFacet: topEntries(countStrings(symbols.flatMap((symbol) => symbol.facets)), 30),
      countsByLanguage: topEntries(countStrings(symbols.map((symbol) => symbol.language ?? 'unknown')), 20),
      countsBySymbolKind: countBy(symbols, (symbol) => symbol.symbolKind),
      countsByTag: topEntries(countStrings(symbols.flatMap((symbol) => symbol.tags)), 30),
      edgeCounts,
      entryFileIds: snapshot.entryFileIds,
      rootDir: this.input.rootDir,
      symbolLoc: {
        average: locs.length
          ? Number((locs.reduce((total, loc) => total + loc, 0) / locs.length).toFixed(1))
          : 0,
        p50: percentile(locs, 0.5),
        p90: percentile(locs, 0.9),
      },
      topDirectories: topEntries(
        countStrings(
          symbols
            .map((symbol) => getTopDirectory(getSymbolFilePath(snapshot, symbol) ?? symbol.path))
            .filter((directory): directory is string => Boolean(directory)),
        ),
        20,
      ),
      totalEdges: snapshot.edges.length,
      totalFiles: files.length,
      totalNodes: nodes.length,
      totalSymbols: symbols.length,
    }
  }

  private findSymbols(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    const selector = parseSelector(args.selector ?? args)
    const limit = clampLimit(args.limit)
    const sortBy = parseSymbolSortBy(args.sortBy)
    const sortDirection = parseSortDirection(args.sortDirection ?? args.direction)
    const degreeByNodeId = buildDegreeMap(snapshot.edges)
    const matchedSymbols = this.matchSymbols(snapshot, selector, degreeByNodeId)
      .sort((left, right) =>
        compareSymbolsWithSort({
          degreeByNodeId,
          left,
          right,
          snapshot,
          sortBy,
          sortDirection,
        }),
      )
    const symbols = matchedSymbols
      .slice(0, limit)
      .map((symbol) => toSymbolRef(snapshot, symbol, degreeByNodeId.get(symbol.id) ?? 0))
    const truncated = matchedSymbols.length > symbols.length

    return this.prepareResult({
      limit,
      sortBy,
      sortDirection,
      symbols,
      symbolNodeIds: symbols.map((symbol) => symbol.id),
      total: matchedSymbols.length,
      truncated,
    }, {
      returnedNodeCount: symbols.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private getSymbolNeighborhood(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    const seedSymbolIds = parseStringArray(
      args.seedSymbolIds ??
      args.symbolNodeIds ??
      args.symbolIds ??
      args.nodeIds,
    )
    const edgeKinds = parseStringArray(args.edgeKinds) as GraphEdgeKind[]
    const direction = parseDirection(args.direction)
    const limit = clampLimit(args.limit)
    const maxDepth = Math.min(
      MAX_SYMBOL_NEIGHBORHOOD_DEPTH,
      Math.max(1, Number(args.depth ?? 1)),
    )
    const degreeByNodeId = buildDegreeMap(snapshot.edges)
    const edgeByNodeId = buildEdgeIndex(snapshot.edges)
    const edgeById = new Map(snapshot.edges.map((edge) => [edge.id, edge]))
    const visited = new Set<string>()
    const edgeIds = new Set<string>()
    const queue = seedSymbolIds
      .filter((nodeId) => isSymbolNode(snapshot.nodes[nodeId]))
      .map((nodeId) => ({ depth: 0, nodeId }))

    for (const seedSymbolId of seedSymbolIds) {
      if (isSymbolNode(snapshot.nodes[seedSymbolId])) {
        visited.add(seedSymbolId)
      }
    }

    while (queue.length > 0 && visited.size < limit) {
      const current = queue.shift()

      if (!current || current.depth >= maxDepth) {
        continue
      }

      for (const edge of edgeByNodeId.get(current.nodeId) ?? []) {
        if (edgeKinds.length > 0 && !edgeKinds.includes(edge.kind)) {
          continue
        }

        const isOutgoing = edge.source === current.nodeId
        const isIncoming = edge.target === current.nodeId

        if (direction === 'incoming' && !isIncoming) {
          continue
        }

        if (direction === 'outgoing' && !isOutgoing) {
          continue
        }

        const nextNodeId = isOutgoing ? edge.target : edge.source

        edgeIds.add(edge.id)

        if (!visited.has(nextNodeId)) {
          visited.add(nextNodeId)
          queue.push({ depth: current.depth + 1, nodeId: nextNodeId })
        }

        if (visited.size >= limit) {
          break
        }
      }
    }

    const nodes = [...visited]
      .map((nodeId) => snapshot.nodes[nodeId])
      .filter((node): node is ProjectNode => Boolean(node))
      .sort((left, right) => compareQueryNodes(snapshot, degreeByNodeId, left, right))
      .map((node) => toNodeRef(snapshot, node, degreeByNodeId.get(node.id) ?? 0))
    const edges = [...edgeIds]
      .map((edgeId) => edgeById.get(edgeId))
      .filter((edge): edge is GraphEdge => Boolean(edge))
      .map(toEdgeRef)
    const truncated = visited.size >= limit

    return this.prepareResult({
      depth: maxDepth,
      edges,
      nodes,
      seedSymbolIds,
      symbolNodeIds: nodes
        .filter((node) => node.kind === 'symbol')
        .map((node) => node.id),
      truncated,
    }, {
      returnedEdgeCount: edges.length,
      returnedNodeCount: nodes.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private getSymbolOutline(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    const degreeByNodeId = buildDegreeMap(snapshot.edges)
    const symbols = resolveSymbols(snapshot, args, this.input.rootDir, degreeByNodeId)

    if (symbols.length === 0) {
      return {
        ok: false,
        warning:
          'A valid symbolId, symbolNodeIds, nodeIds, symbolPath, path, filePath, or symbol selector is required.',
      }
    }

    const limit = clampLimit(args.limit ?? symbols.length)
    const nestedLimit = clampInteger(
      args.nestedLimit ?? DEFAULT_SYMBOL_OUTLINE_NESTED_LIMIT,
      0,
      MAX_SYMBOL_OUTLINE_NESTED_LIMIT,
    )
    const previewLines = clampInteger(
      args.previewLines ?? DEFAULT_SYMBOL_OUTLINE_PREVIEW_LINES,
      0,
      MAX_SYMBOL_OUTLINE_PREVIEW_LINES,
    )
    const outlines = symbols
      .slice(0, limit)
      .map((symbol) =>
        toSymbolOutline({
          degreeByNodeId,
          nestedLimit,
          previewLines,
          snapshot,
          symbol,
        }),
      )
    const truncated = symbols.length > outlines.length

    return this.prepareResult({
      outlines,
      symbolNodeIds: outlines.map((outline) => outline.symbol.id),
      total: symbols.length,
      truncated,
    }, {
      returnedNodeCount: outlines.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private readSymbolSlice(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    const symbol = resolveSymbol(snapshot, args, this.input.rootDir)

    if (!symbol) {
      return {
        ok: false,
        warning: 'A valid symbolId, symbolNodeId, nodeId, symbolPath, path, or filePath is required.',
      }
    }

    if (!symbol.range) {
      return {
        ok: false,
        warning: `Symbol ${symbol.id} does not have a source range.`,
      }
    }

    const file = snapshot.nodes[symbol.fileId]

    if (!file || !isFileNode(file)) {
      return {
        ok: false,
        warning: `Symbol ${symbol.id} points to missing file ${symbol.fileId}.`,
      }
    }

    if (!file.content) {
      return {
        ok: false,
        warning: `File content is unavailable for ${file.path}.`,
      }
    }

    const beforeLines = clampInteger(
      args.beforeLines ?? args.contextBeforeLines ?? 0,
      0,
      MAX_SYMBOL_CONTEXT_LINES,
    )
    const afterLines = clampInteger(
      args.afterLines ?? args.contextAfterLines ?? 0,
      0,
      MAX_SYMBOL_CONTEXT_LINES,
    )
    const maxLines = clampInteger(args.maxLines ?? DEFAULT_SYMBOL_SLICE_LINES, 1, MAX_SYMBOL_SLICE_LINES)
    const lines = splitLines(file.content)
    const exactStartLine = clampInteger(symbol.range.start.line, 1, lines.length)
    const exactEndLine = clampInteger(symbol.range.end.line, exactStartLine, lines.length)
    const requestedStartLine = getRequestedSymbolStartLine(args, exactStartLine, exactEndLine)
    const requestedEndLine = getRequestedSymbolEndLine(args, requestedStartLine, exactEndLine)
    const contextStartLine = Math.max(1, requestedStartLine - beforeLines)
    const requestedContextEndLine = Math.min(lines.length, requestedEndLine + afterLines)
    const contextEndLine = Math.min(requestedContextEndLine, contextStartLine + maxLines - 1)
    const text = lines.slice(contextStartLine - 1, contextEndLine).join('\n')
    const truncatedText = truncateText(text)
    const hasMoreBefore = contextStartLine > exactStartLine
    const hasMoreAfter = contextEndLine < exactEndLine
    const truncated =
      hasMoreBefore ||
      hasMoreAfter ||
      requestedContextEndLine > contextEndLine ||
      truncatedText.length < text.length

    return this.prepareResult({
      contextRange: {
        end: { column: 1, line: contextEndLine },
        start: { column: 1, line: contextStartLine },
      },
      exactRange: symbol.range,
      file: toFileRef(file),
      lineCount: contextEndLine - contextStartLine + 1,
      maxLines,
      nextRelativeStartLine: hasMoreAfter ? contextEndLine - exactStartLine + 2 : undefined,
      nextStartLine: hasMoreAfter ? contextEndLine + 1 : undefined,
      hasMoreAfter,
      hasMoreBefore,
      sliceHash: hashText(lines.slice(exactStartLine - 1, exactEndLine).join('\n')),
      symbol: toSymbolRef(snapshot, symbol, getNodeDegree(snapshot.edges, symbol.id)),
      symbolNodeIds: [symbol.id],
      text: truncatedText,
      truncated,
    }, {
      returnedNodeCount: 1,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private readFileWindow(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

    if (!reason) {
      return {
        ok: false,
        warning: 'readFileWindow requires a reason explaining why symbol slices are insufficient.',
      }
    }

    const file = resolveFile(snapshot, args, this.input.rootDir)

    if (!file) {
      return {
        ok: false,
        warning: 'A valid path, filePath, or fileId is required.',
      }
    }

    if (!file.content) {
      return {
        ok: false,
        warning: `File content is unavailable for ${file.path}.`,
      }
    }

    const lines = splitLines(file.content)
    const maxLines = clampInteger(args.maxLines ?? DEFAULT_FILE_WINDOW_LINES, 1, MAX_FILE_WINDOW_LINES)
    const startLine = clampInteger(args.startLine ?? args.line ?? 1, 1, Math.max(1, lines.length))
    const requestedEndLine = args.endLine ?? args.toLine
    const endLine = requestedEndLine === undefined
      ? Math.min(lines.length, startLine + maxLines - 1)
      : Math.min(
          lines.length,
          clampInteger(requestedEndLine, startLine, startLine + maxLines - 1),
        )
    const text = lines.slice(startLine - 1, endLine).join('\n')
    const truncatedText = truncateText(text)
    const requestedLineCount = requestedEndLine === undefined
      ? maxLines
      : Number(requestedEndLine) - startLine + 1
    const truncated =
      requestedLineCount > maxLines ||
      truncatedText.length < text.length

    return this.prepareResult({
      file: toFileRef(file),
      lineCount: endLine - startLine + 1,
      range: {
        end: { column: 1, line: endLine },
        start: { column: 1, line: startLine },
      },
      reason,
      text: truncatedText,
      totalLines: lines.length,
      truncated,
      windowHash: hashText(text),
    }, {
      returnedNodeCount: 1,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private async replaceFileWindow(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    if (!this.input.fileWriter) {
      return {
        ok: false,
        warning: 'replaceFileWindow is unavailable because no file writer is configured.',
      }
    }

    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

    if (!reason) {
      return {
        ok: false,
        warning: 'replaceFileWindow requires a reason explaining why symbol replacement is insufficient.',
      }
    }

    const expectedWindowHash = getStringArg(args, 'expectedWindowHash') ??
      getStringArg(args, 'windowHash')

    if (!expectedWindowHash) {
      return {
        ok: false,
        warning: 'replaceFileWindow requires expectedWindowHash from a current readFileWindow result.',
      }
    }

    const replacementText = getStringArgAllowEmpty(args, 'replacementText') ??
      getStringArgAllowEmpty(args, 'text')

    if (replacementText === null) {
      return {
        ok: false,
        warning: 'replaceFileWindow requires replacementText.',
      }
    }

    const startLineArg = args.startLine ?? args.line
    const endLineArg = args.endLine ?? args.toLine

    if (startLineArg === undefined || endLineArg === undefined) {
      return {
        ok: false,
        warning: 'replaceFileWindow requires startLine and endLine from a current readFileWindow result.',
      }
    }

    const file = resolveFile(snapshot, args, this.input.rootDir)

    if (!file) {
      return {
        ok: false,
        warning: 'A valid path, filePath, or fileId is required.',
      }
    }

    if (!file.content) {
      return {
        ok: false,
        warning: `File content is unavailable for ${file.path}.`,
      }
    }

    const lines = splitLines(file.content)
    const startLine = clampInteger(startLineArg, 1, Math.max(1, lines.length))
    const endLine = clampInteger(
      endLineArg,
      startLine,
      Math.min(lines.length, startLine + MAX_FILE_WINDOW_LINES - 1),
    )
    const currentText = lines.slice(startLine - 1, endLine).join('\n')
    const currentWindowHash = hashText(currentText)

    if (currentWindowHash !== expectedWindowHash) {
      return {
        ok: false,
        warning:
          `File window ${file.path}:${startLine}-${endLine} changed since it was read. Re-read the window and retry with the current windowHash.`,
        result: {
          currentWindowHash,
          expectedWindowHash,
        },
      }
    }

    const nextLines = [
      ...lines.slice(0, startLine - 1),
      ...splitReplacementLines(replacementText),
      ...lines.slice(endLine),
    ]
    const nextContent = nextLines.join('\n')

    await this.input.fileWriter(file.path, nextContent)
    await this.input.snapshotInvalidator?.()

    return this.prepareResult({
      file: toFileRef({
        ...file,
        content: nextContent,
        size: nextContent.length,
      }),
      previousWindowHash: currentWindowHash,
      reason,
      replacedRange: {
        end: { column: 1, line: endLine },
        start: { column: 1, line: startLine },
      },
      replacementHash: hashText(replacementText),
      replacementLineCount: splitReplacementLines(replacementText).length,
    }, {
      returnedNodeCount: 1,
    })
  }

  private async replaceSymbolRange(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
    if (!this.input.fileWriter) {
      return {
        ok: false,
        warning: 'replaceSymbolRange is unavailable because no file writer is configured.',
      }
    }

    const symbol = resolveSymbol(snapshot, args, this.input.rootDir)

    if (!symbol) {
      return {
        ok: false,
        warning: 'A valid symbolId, symbolNodeId, nodeId, symbolPath, path, or filePath is required.',
      }
    }

    if (!symbol.range) {
      return {
        ok: false,
        warning: `Symbol ${symbol.id} does not have a source range.`,
      }
    }

    const expectedSliceHash = getStringArg(args, 'expectedSliceHash') ??
      getStringArg(args, 'sliceHash')

    if (!expectedSliceHash) {
      return {
        ok: false,
        warning: 'replaceSymbolRange requires expectedSliceHash from a current readSymbolSlice result.',
      }
    }

    const replacementText = getStringArgAllowEmpty(args, 'replacementText') ??
      getStringArgAllowEmpty(args, 'text')

    if (replacementText === null) {
      return {
        ok: false,
        warning: 'replaceSymbolRange requires replacementText.',
      }
    }

    const file = snapshot.nodes[symbol.fileId]

    if (!file || !isFileNode(file)) {
      return {
        ok: false,
        warning: `Symbol ${symbol.id} points to missing file ${symbol.fileId}.`,
      }
    }

    if (!file.content) {
      return {
        ok: false,
        warning: `File content is unavailable for ${file.path}.`,
      }
    }

    const lines = splitLines(file.content)
    const exactStartLine = clampInteger(symbol.range.start.line, 1, lines.length)
    const exactEndLine = clampInteger(symbol.range.end.line, exactStartLine, lines.length)
    const currentText = lines.slice(exactStartLine - 1, exactEndLine).join('\n')
    const currentSliceHash = hashText(currentText)

    if (currentSliceHash !== expectedSliceHash) {
      return {
        ok: false,
        warning:
          `Symbol ${symbol.id} changed since it was read. Re-read the symbol and retry with the current sliceHash.`,
        result: {
          currentSliceHash,
          expectedSliceHash,
          symbolNodeIds: [symbol.id],
        },
      }
    }

    const nextLines = [
      ...lines.slice(0, exactStartLine - 1),
      ...splitReplacementLines(replacementText),
      ...lines.slice(exactEndLine),
    ]
    const nextContent = nextLines.join('\n')

    await this.input.fileWriter(file.path, nextContent)
    await this.input.snapshotInvalidator?.()

    return this.prepareResult({
      file: toFileRef({
        ...file,
        content: nextContent,
        size: nextContent.length,
      }),
      previousSliceHash: currentSliceHash,
      replacementHash: hashText(replacementText),
      replacedRange: symbol.range,
      replacementLineCount: splitReplacementLines(replacementText).length,
      symbol: toSymbolRef(snapshot, symbol, getNodeDegree(snapshot.edges, symbol.id)),
      symbolNodeIds: [symbol.id],
    }, {
      returnedNodeCount: 1,
    })
  }

  private matchSymbols(
    snapshot: ProjectSnapshot,
    selector: LayoutSelector,
    degreeByNodeId: Map<string, number>,
  ) {
    return Object.values(snapshot.nodes)
      .filter(isSymbolNode)
      .filter((symbol) =>
        matchSymbolSelector(snapshot, selector, symbol, degreeByNodeId.get(symbol.id) ?? 0),
      )
  }

  private prepareResult(
    result: unknown,
    statsDelta?: SymbolQueryStatsDelta,
  ): SymbolQuerySessionResult {
    const serialized = JSON.stringify(result)

    if (serialized.length > MAX_SYMBOL_QUERY_OUTPUT_CHARS) {
      this.stats.truncatedResultCount += 1
      return {
        budgetExhausted: true,
        ok: false,
        warning:
          'Symbol query output budget exhausted. Narrow the query with stricter filters, a lower limit, or a smaller line window.',
      }
    }

    this.applyStatsDelta(statsDelta)

    return {
      ok: true,
      result,
    }
  }

  private applyStatsDelta(statsDelta?: SymbolQueryStatsDelta) {
    if (!statsDelta) {
      return
    }

    this.stats.returnedEdgeCount += statsDelta.returnedEdgeCount ?? 0
    this.stats.returnedNodeCount += statsDelta.returnedNodeCount ?? 0
    this.stats.truncatedResultCount += statsDelta.truncatedResultCount ?? 0
  }
}

export function createSymbolQuerySession(input: SymbolQuerySessionInput) {
  return new SymbolQuerySession(input)
}

function parseSelector(value: unknown): LayoutSelector {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return value as LayoutSelector
}

function parseStringArray(value: unknown): string[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }

  return typeof value === 'string' ? [value] : []
}

function parseDirection(value: unknown): 'both' | 'incoming' | 'outgoing' {
  return value === 'incoming' || value === 'outgoing' ? value : 'both'
}

function parseSymbolSortBy(value: unknown): SymbolQuerySortBy {
  return value === 'degree' ||
    value === 'kind' ||
    value === 'loc' ||
    value === 'name' ||
    value === 'path'
    ? value
    : 'degree'
}

function parseSortDirection(value: unknown): SymbolQuerySortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

function getRequestedSymbolStartLine(
  args: Record<string, unknown>,
  exactStartLine: number,
  exactEndLine: number,
) {
  const relativeStartLine =
    getNumberArg(args, 'relativeStartLine') ??
    getNumberArg(args, 'offsetLine')

  if (relativeStartLine !== null) {
    return clampInteger(exactStartLine + relativeStartLine - 1, exactStartLine, exactEndLine)
  }

  const absoluteStartLine =
    getNumberArg(args, 'startLine') ??
    getNumberArg(args, 'line')

  return absoluteStartLine === null
    ? exactStartLine
    : clampInteger(absoluteStartLine, exactStartLine, exactEndLine)
}

function getRequestedSymbolEndLine(
  args: Record<string, unknown>,
  requestedStartLine: number,
  exactEndLine: number,
) {
  const relativeEndLine = getNumberArg(args, 'relativeEndLine')

  if (relativeEndLine !== null) {
    return clampInteger(relativeEndLine + requestedStartLine - 1, requestedStartLine, exactEndLine)
  }

  const absoluteEndLine =
    getNumberArg(args, 'endLine') ??
    getNumberArg(args, 'toLine')

  return absoluteEndLine === null
    ? exactEndLine
    : clampInteger(absoluteEndLine, requestedStartLine, exactEndLine)
}

function clampLimit(value: unknown, defaultLimit = DEFAULT_SYMBOL_QUERY_LIMIT) {
  return clampInteger(value ?? defaultLimit, 1, MAX_SYMBOL_QUERY_LIMIT)
}

function clampInteger(value: unknown, min: number, max: number) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return min
  }

  return Math.max(min, Math.min(max, Math.floor(numericValue)))
}

function matchSymbolSelector(
  snapshot: ProjectSnapshot,
  selector: LayoutSelector,
  symbol: SymbolNode,
  degree: number,
) {
  if (selector.nodeIds?.length && !selector.nodeIds.includes(symbol.id)) {
    return false
  }

  if (!matchesStringOrArray(selector.kind, symbol.kind)) {
    return false
  }

  if (!matchesStringOrArray(selector.symbolKind, symbol.symbolKind)) {
    return false
  }

  if (selector.facet && !matchesAny(selector.facet, symbol.facets)) {
    return false
  }

  if (selector.tag && !matchesAny(selector.tag, symbol.tags)) {
    return false
  }

  if (selector.pathPrefix && !symbol.path.startsWith(selector.pathPrefix)) {
    const filePath = getSymbolFilePath(snapshot, symbol)
    if (!filePath?.startsWith(selector.pathPrefix)) {
      return false
    }
  }

  if (selector.pathContains && !symbol.path.includes(selector.pathContains)) {
    const filePath = getSymbolFilePath(snapshot, symbol)
    if (!filePath?.includes(selector.pathContains)) {
      return false
    }
  }

  if (
    selector.nameContains &&
    !symbol.name.toLowerCase().includes(selector.nameContains.toLowerCase())
  ) {
    return false
  }

  if (selector.nameRegex) {
    try {
      if (!new RegExp(selector.nameRegex).test(symbol.name)) {
        return false
      }
    } catch {
      return false
    }
  }

  const loc = getSymbolLoc(symbol) ?? 0

  if (selector.locMin !== undefined && loc < selector.locMin) {
    return false
  }

  if (selector.locMax !== undefined && loc > selector.locMax) {
    return false
  }

  if (selector.degreeMin !== undefined && degree < selector.degreeMin) {
    return false
  }

  if (selector.degreeMax !== undefined && degree > selector.degreeMax) {
    return false
  }

  return true
}

function matchesStringOrArray<T extends string>(
  expected: T | T[] | undefined,
  actual: T,
) {
  if (!expected) {
    return true
  }

  return Array.isArray(expected) ? expected.includes(actual) : expected === actual
}

function matchesAny(expected: string | string[], actual: string[]) {
  const expectedValues = Array.isArray(expected) ? expected : [expected]

  return expectedValues.some((value) => actual.includes(value))
}

function toSymbolRef(snapshot: ProjectSnapshot, symbol: SymbolNode, degree: number) {
  const file = snapshot.nodes[symbol.fileId]

  return {
    degree,
    facets: symbol.facets,
    fileId: symbol.fileId,
    filePath: file?.path ?? stripSymbolPathSuffix(symbol.path),
    id: symbol.id,
    kind: symbol.kind,
    language: symbol.language,
    loc: getSymbolLoc(symbol),
    name: symbol.name,
    path: symbol.path,
    range: symbol.range,
    signature: symbol.signature,
    symbolKind: symbol.symbolKind,
    tags: symbol.tags,
    visibility: symbol.visibility,
  }
}

function toNodeRef(snapshot: ProjectSnapshot, node: ProjectNode, degree: number) {
  if (isSymbolNode(node)) {
    return toSymbolRef(snapshot, node, degree)
  }

  if (isFileNode(node)) {
    return {
      degree,
      extension: node.extension,
      facets: node.facets,
      id: node.id,
      kind: node.kind,
      language: node.language,
      loc: getFileLoc(node),
      name: node.name,
      path: node.path,
      size: node.size,
      tags: node.tags,
    }
  }

  return {
    degree,
    facets: node.facets,
    id: node.id,
    kind: node.kind,
    name: node.name,
    path: node.path,
    tags: node.tags,
  }
}

function toFileRef(file: FileNode) {
  return {
    extension: file.extension,
    id: file.id,
    language: file.language,
    name: file.name,
    path: file.path,
    size: file.size,
  }
}

function toEdgeRef(edge: GraphEdge) {
  return {
    id: edge.id,
    inferred: edge.inferred,
    kind: edge.kind,
    label: edge.label,
    source: edge.source,
    target: edge.target,
  }
}

function toSymbolOutline(input: {
  degreeByNodeId: Map<string, number>
  nestedLimit: number
  previewLines: number
  snapshot: ProjectSnapshot
  symbol: SymbolNode
}) {
  const file = input.snapshot.nodes[input.symbol.fileId]
  const nestedSymbols = getNestedSymbols(input.snapshot, input.symbol)
  const returnedNestedSymbols = nestedSymbols
    .slice(0, input.nestedLimit)
    .map((symbol) =>
      toSymbolRef(input.snapshot, symbol, input.degreeByNodeId.get(symbol.id) ?? 0),
    )

  return {
    edgeCounts: getSymbolEdgeCounts(input.snapshot.edges, input.symbol.id),
    file: file && isFileNode(file) ? toFileRef(file) : undefined,
    loc: getSymbolLoc(input.symbol),
    nestedSymbolCount: nestedSymbols.length,
    nestedSymbols: returnedNestedSymbols,
    nestedSymbolsTruncated: nestedSymbols.length > returnedNestedSymbols.length,
    sourcePreview:
      file && isFileNode(file)
        ? getSymbolSourcePreview(file, input.symbol, input.previewLines)
        : null,
    symbol: toSymbolRef(
      input.snapshot,
      input.symbol,
      input.degreeByNodeId.get(input.symbol.id) ?? 0,
    ),
  }
}

function getNestedSymbols(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const containerRange = symbol.range

  if (!containerRange) {
    return []
  }

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .filter((candidate) => {
      if (!candidate.range) {
        return false
      }

      return candidate.id !== symbol.id &&
        candidate.fileId === symbol.fileId &&
        isRangeContained(candidate.range, containerRange)
    })
    .sort(compareSymbolsByStartLine)
}

function getSymbolSourcePreview(file: FileNode, symbol: SymbolNode, previewLines: number) {
  if (!file.content || !symbol.range || previewLines <= 0) {
    return null
  }

  const lines = splitLines(file.content)
  const startLine = clampInteger(symbol.range.start.line, 1, lines.length)
  const endLine = clampInteger(symbol.range.end.line, startLine, lines.length)
  const previewEndLine = Math.min(endLine, startLine + previewLines - 1)

  return {
    hasMoreAfter: previewEndLine < endLine,
    lineCount: previewEndLine - startLine + 1,
    nextRelativeStartLine: previewEndLine < endLine ? previewEndLine - startLine + 2 : undefined,
    nextStartLine: previewEndLine < endLine ? previewEndLine + 1 : undefined,
    range: {
      end: { column: 1, line: previewEndLine },
      start: { column: 1, line: startLine },
    },
    text: lines.slice(startLine - 1, previewEndLine).join('\n'),
    totalSymbolLines: endLine - startLine + 1,
  }
}

function getSymbolEdgeCounts(edges: GraphEdge[], symbolId: string) {
  const incoming: Record<string, number> = {}
  const outgoing: Record<string, number> = {}

  for (const edge of edges) {
    if (edge.target === symbolId) {
      incoming[edge.kind] = (incoming[edge.kind] ?? 0) + 1
    }

    if (edge.source === symbolId) {
      outgoing[edge.kind] = (outgoing[edge.kind] ?? 0) + 1
    }
  }

  return { incoming, outgoing }
}

function resolveSymbols(
  snapshot: ProjectSnapshot,
  args: Record<string, unknown>,
  rootDir: string,
  degreeByNodeId: Map<string, number>,
) {
  const symbolIds = parseStringArray(
    args.symbolIds ??
    args.symbolNodeIds ??
    args.nodeIds,
  )
  const symbolsById = symbolIds
    .map((symbolId) => snapshot.nodes[symbolId])
    .filter(isSymbolNode)

  if (symbolsById.length > 0) {
    return symbolsById
  }

  const symbol = resolveExactSymbol(snapshot, args)

  if (symbol) {
    return [symbol]
  }

  const filePath =
    getStringArg(args, 'path') ??
    getStringArg(args, 'filePath') ??
    getStringArg(args, 'filepath')
  const fileSymbols = filePath
    ? resolveSymbolsByFilePath(snapshot, filePath, rootDir, degreeByNodeId)
    : []

  if (fileSymbols.length > 0) {
    return fileSymbols
  }

  if (!hasSymbolSelectorArgs(args)) {
    return []
  }

  const selector = parseSelector(args.selector ?? args)

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .filter((candidate) =>
      matchSymbolSelector(
        snapshot,
        selector,
        candidate,
        degreeByNodeId.get(candidate.id) ?? 0,
      ),
    )
    .sort((left, right) => compareSymbols(snapshot, degreeByNodeId, left, right))
}

function resolveSymbol(
  snapshot: ProjectSnapshot,
  args: Record<string, unknown>,
  rootDir: string,
) {
  const exactSymbol = resolveExactSymbol(snapshot, args)

  if (exactSymbol) {
    return exactSymbol
  }

  const symbolPath =
    getStringArg(args, 'symbolPath') ??
    getStringArg(args, 'path') ??
    getStringArg(args, 'filePath') ??
    getStringArg(args, 'filepath')

  if (!symbolPath) {
    return null
  }

  const degreeByNodeId = buildDegreeMap(snapshot.edges)

  return resolveSymbolsByFilePath(snapshot, symbolPath, rootDir, degreeByNodeId)[0] ?? null
}

function resolveExactSymbol(snapshot: ProjectSnapshot, args: Record<string, unknown>) {
  const symbolId =
    getStringArg(args, 'symbolId') ??
    getStringArg(args, 'symbolNodeId') ??
    getStringArg(args, 'nodeId')

  if (symbolId && isSymbolNode(snapshot.nodes[symbolId])) {
    return snapshot.nodes[symbolId] as SymbolNode
  }

  const symbolPath =
    getStringArg(args, 'symbolPath') ??
    getStringArg(args, 'path') ??
    getStringArg(args, 'filePath') ??
    getStringArg(args, 'filepath')

  if (!symbolPath) {
    return null
  }

  const exactSymbol = Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .find((symbol) => symbol.path === symbolPath)

  if (exactSymbol) {
    return exactSymbol
  }

  return null
}

function resolveSymbolsByFilePath(
  snapshot: ProjectSnapshot,
  value: string,
  rootDir: string,
  degreeByNodeId: Map<string, number>,
) {
  const normalizedPath = normalizeSnapshotPath(value, rootDir)

  if (!normalizedPath) {
    return []
  }

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .filter((symbol) => {
      const filePath = getSymbolFilePath(snapshot, symbol) ?? symbol.fileId

      return filePath === normalizedPath ||
        symbol.fileId === normalizedPath ||
        stripSymbolPathSuffix(symbol.path) === normalizedPath
    })
    .sort((left, right) => compareSymbolsByLocThenRank(snapshot, degreeByNodeId, left, right))
}

function resolveFile(
  snapshot: ProjectSnapshot,
  args: Record<string, unknown>,
  rootDir: string,
) {
  const fileId = getStringArg(args, 'fileId') ?? getStringArg(args, 'nodeId')

  if (fileId && isFileNode(snapshot.nodes[fileId])) {
    return snapshot.nodes[fileId] as FileNode
  }

  const rawPath =
    getStringArg(args, 'path') ??
    getStringArg(args, 'filePath') ??
    getStringArg(args, 'filepath')
  const normalizedPath = rawPath ? normalizeSnapshotPath(rawPath, rootDir) : ''

  if (!normalizedPath) {
    return null
  }

  return Object.values(snapshot.nodes)
    .filter(isFileNode)
    .find((file) => file.path === normalizedPath || file.id === normalizedPath) ?? null
}

function getStringArg(args: Record<string, unknown>, key: string) {
  const value = args[key]

  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getStringArgAllowEmpty(args: Record<string, unknown>, key: string) {
  const value = args[key]

  return typeof value === 'string' ? value : null
}

function getNumberArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  const numberValue = Number(value)

  return Number.isFinite(numberValue) ? numberValue : null
}

function hasSymbolSelectorArgs(args: Record<string, unknown>) {
  const selector = args.selector

  if (selector && typeof selector === 'object') {
    return Object.keys(selector).length > 0
  }

  return [
    'degreeMax',
    'degreeMin',
    'facet',
    'kind',
    'locMax',
    'locMin',
    'nameContains',
    'nameRegex',
    'pathContains',
    'pathPrefix',
    'symbolKind',
    'tag',
  ].some((key) => args[key] !== undefined)
}

function normalizeSnapshotPath(value: string, rootDir: string) {
  let normalized = stripSymbolPathSuffix(cleanPathToken(value))

  if (isAbsolute(normalized)) {
    const relativePath = relative(rootDir, normalized)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      normalized = relativePath
    }
  }

  normalized = normalized.replace(/\\/g, '/')

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  return normalized
}

function stripSymbolPathSuffix(value: string) {
  const hashIndex = value.indexOf('#')

  return hashIndex > 0 ? value.slice(0, hashIndex) : value
}

function cleanPathToken(value: string) {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^[([{<]+/g, '')
    .replace(/[)\]},;>]+$/g, '')
    .trim()
}

function buildDegreeMap(edges: GraphEdge[]) {
  const degreeByNodeId = new Map<string, number>()

  for (const edge of edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1)
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1)
  }

  return degreeByNodeId
}

function buildEdgeIndex(edges: GraphEdge[]) {
  const edgeByNodeId = new Map<string, GraphEdge[]>()

  for (const edge of edges) {
    const sourceEdges = edgeByNodeId.get(edge.source) ?? []
    sourceEdges.push(edge)
    edgeByNodeId.set(edge.source, sourceEdges)

    const targetEdges = edgeByNodeId.get(edge.target) ?? []
    targetEdges.push(edge)
    edgeByNodeId.set(edge.target, targetEdges)
  }

  return edgeByNodeId
}

function getNodeDegree(edges: GraphEdge[], nodeId: string) {
  return edges.reduce(
    (degree, edge) =>
      edge.source === nodeId || edge.target === nodeId ? degree + 1 : degree,
    0,
  )
}

function compareSymbols(
  snapshot: ProjectSnapshot,
  degreeByNodeId: Map<string, number>,
  left: SymbolNode,
  right: SymbolNode,
) {
  const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0)

  if (degreeDelta !== 0) {
    return degreeDelta
  }

  const kindDelta = getSymbolKindRank(left) - getSymbolKindRank(right)

  if (kindDelta !== 0) {
    return kindDelta
  }

  const pathDelta =
    (getSymbolFilePath(snapshot, left) ?? left.path)
      .localeCompare(getSymbolFilePath(snapshot, right) ?? right.path)

  if (pathDelta !== 0) {
    return pathDelta
  }

  return left.name.localeCompare(right.name)
}

function compareSymbolsWithSort(input: {
  degreeByNodeId: Map<string, number>
  left: SymbolNode
  right: SymbolNode
  snapshot: ProjectSnapshot
  sortBy: SymbolQuerySortBy
  sortDirection: SymbolQuerySortDirection
}) {
  const direction = input.sortDirection === 'asc' ? 1 : -1
  const primaryDelta = compareSymbolSortValue(input)

  if (primaryDelta !== 0) {
    return direction * primaryDelta
  }

  return compareSymbols(input.snapshot, input.degreeByNodeId, input.left, input.right)
}

function compareSymbolSortValue(input: {
  degreeByNodeId: Map<string, number>
  left: SymbolNode
  right: SymbolNode
  snapshot: ProjectSnapshot
  sortBy: SymbolQuerySortBy
}) {
  switch (input.sortBy) {
    case 'degree':
      return (input.degreeByNodeId.get(input.left.id) ?? 0) -
        (input.degreeByNodeId.get(input.right.id) ?? 0)
    case 'kind':
      return getSymbolKindRank(input.left) - getSymbolKindRank(input.right)
    case 'loc':
      return (getSymbolLoc(input.left) ?? 0) - (getSymbolLoc(input.right) ?? 0)
    case 'name':
      return input.left.name.localeCompare(input.right.name)
    case 'path':
      return (getSymbolFilePath(input.snapshot, input.left) ?? input.left.path)
        .localeCompare(getSymbolFilePath(input.snapshot, input.right) ?? input.right.path)
  }
}

function compareSymbolsByLocThenRank(
  snapshot: ProjectSnapshot,
  degreeByNodeId: Map<string, number>,
  left: SymbolNode,
  right: SymbolNode,
) {
  const locDelta = (getSymbolLoc(right) ?? 0) - (getSymbolLoc(left) ?? 0)

  return locDelta || compareSymbols(snapshot, degreeByNodeId, left, right)
}

function compareSymbolsByStartLine(left: SymbolNode, right: SymbolNode) {
  const lineDelta = (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0)

  if (lineDelta !== 0) {
    return lineDelta
  }

  const columnDelta = (left.range?.start.column ?? 0) - (right.range?.start.column ?? 0)

  if (columnDelta !== 0) {
    return columnDelta
  }

  return left.name.localeCompare(right.name)
}

function isRangeContained(candidate: SourceRange, container: SourceRange) {
  return compareSourceLocations(candidate.start, container.start) >= 0 &&
    compareSourceLocations(candidate.end, container.end) <= 0
}

function compareSourceLocations(
  left: SourceLocation,
  right: SourceLocation,
) {
  return left.line === right.line
    ? left.column - right.column
    : left.line - right.line
}

function compareQueryNodes(
  snapshot: ProjectSnapshot,
  degreeByNodeId: Map<string, number>,
  left: ProjectNode,
  right: ProjectNode,
) {
  if (isSymbolNode(left) && isSymbolNode(right)) {
    return compareSymbols(snapshot, degreeByNodeId, left, right)
  }

  if (left.kind !== right.kind) {
    return getNodeKindRank(left) - getNodeKindRank(right)
  }

  const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0)

  if (degreeDelta !== 0) {
    return degreeDelta
  }

  return left.path.localeCompare(right.path)
}

function getNodeKindRank(node: ProjectNode) {
  if (node.kind === 'symbol') {
    return 0
  }

  if (node.kind === 'file') {
    return 1
  }

  return 2
}

function getSymbolKindRank(symbol: SymbolNode) {
  switch (symbol.symbolKind) {
    case 'class':
      return 0
    case 'function':
    case 'method':
      return 1
    case 'module':
      return 2
    case 'constant':
    case 'variable':
      return 3
    case 'unknown':
      return 4
  }
}

function getSymbolFilePath(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const file = snapshot.nodes[symbol.fileId]

  return file?.path
}

function getSymbolLoc(symbol: SymbolNode) {
  if (!symbol.range) {
    return undefined
  }

  return Math.max(1, symbol.range.end.line - symbol.range.start.line + 1)
}

function getFileLoc(file: FileNode) {
  return file.content ? splitLines(file.content).length : 1
}

function splitLines(value: string) {
  return value.split(/\r?\n/)
}

function splitReplacementLines(value: string) {
  return value.replace(/\r\n/g, '\n').split('\n')
}

function truncateText(value: string) {
  return value.length > MAX_SYMBOL_TEXT_CHARS
    ? value.slice(0, MAX_SYMBOL_TEXT_CHARS)
    : value
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function countBy<T>(values: T[], getValue: (value: T) => string) {
  const counts: Record<string, number> = {}

  for (const value of values) {
    const key = getValue(value)
    counts[key] = (counts[key] ?? 0) + 1
  }

  return counts
}

function countStrings(values: string[]) {
  const counts: Record<string, number> = {}

  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }

  return counts
}

function topEntries(counts: Record<string, number>, limit: number) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([id, count]) => ({ count, id }))
}

function getTopDirectory(pathValue: string) {
  const [topDirectory] = pathValue.split('/')

  return topDirectory && topDirectory !== pathValue ? topDirectory : '.'
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) {
    return 0
  }

  const index = Math.min(values.length - 1, Math.floor((values.length - 1) * quantile))

  return values[index]
}

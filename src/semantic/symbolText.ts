import {
  isFileNode,
  isSymbolNode,
  type ProjectSnapshot,
  type SymbolNode,
} from '../schema/snapshot'
import type { SemanticSymbolTextRecord } from './types'

const MAX_CONTENT_LENGTH = 1200

export function buildSemanticSymbolTextRecords(
  snapshot: ProjectSnapshot,
): SemanticSymbolTextRecord[] {
  const generatedAt = new Date().toISOString()

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .sort(compareSymbolsForEmbedding)
    .map((symbol) => buildSemanticSymbolTextRecord(snapshot, symbol, generatedAt))
}

export function buildSemanticSymbolTextRecord(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
  generatedAt: string = new Date().toISOString(),
): SemanticSymbolTextRecord {
  const text = buildSemanticSymbolText(snapshot, symbol)

  return {
    symbolId: symbol.id,
    fileId: symbol.fileId,
    path: symbol.path,
    language: symbol.language,
    symbolKind: symbol.symbolKind,
    text,
    textHash: hashSemanticText(text),
    generatedAt,
  }
}

export function buildSemanticSymbolText(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
) {
  const fileNode = snapshot.nodes[symbol.fileId]
  const filePath = fileNode && isFileNode(fileNode) ? fileNode.path : symbol.fileId
  const excerpt = getSymbolExcerpt(snapshot, symbol)

  const lines = [
    `path: ${filePath}`,
    `symbol_path: ${symbol.path}`,
    `kind: ${symbol.symbolKind}`,
    `name: ${symbol.name}`,
  ]

  if (symbol.language) {
    lines.push(`language: ${symbol.language}`)
  }

  if (symbol.visibility && symbol.visibility !== 'unknown') {
    lines.push(`visibility: ${symbol.visibility}`)
  }

  if (symbol.facets.length > 0) {
    lines.push(`facets: ${symbol.facets.join(', ')}`)
  }

  if (symbol.signature) {
    lines.push(`signature: ${symbol.signature}`)
  }

  if (symbol.range) {
    lines.push(
      `range: ${symbol.range.start.line}:${symbol.range.start.column}-${symbol.range.end.line}:${symbol.range.end.column}`,
    )
  }

  if (excerpt) {
    lines.push('code:')
    lines.push(excerpt)
  }

  return lines.join('\n')
}

export function hashSemanticText(text: string) {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

function getSymbolExcerpt(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const fileNode = snapshot.nodes[symbol.fileId]

  if (!fileNode || !isFileNode(fileNode) || !fileNode.content || !symbol.range) {
    return ''
  }

  const lines = fileNode.content.split(/\r?\n/)
  const startLine = Math.max(1, symbol.range.start.line)
  const endLine = Math.max(startLine, symbol.range.end.line)
  const selectedLines = lines.slice(startLine - 1, endLine)
  const excerpt = selectedLines.join('\n').trim()

  if (!excerpt) {
    return ''
  }

  return excerpt.length > MAX_CONTENT_LENGTH
    ? `${excerpt.slice(0, MAX_CONTENT_LENGTH).trimEnd()}\n…`
    : excerpt
}

function compareSymbolsForEmbedding(left: SymbolNode, right: SymbolNode) {
  const leftPath = `${left.path}:${left.range?.start.line ?? 0}:${left.range?.start.column ?? 0}`
  const rightPath = `${right.path}:${right.range?.start.line ?? 0}:${right.range?.start.column ?? 0}`
  return leftPath.localeCompare(rightPath)
}

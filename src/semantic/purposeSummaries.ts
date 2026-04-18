import {
  isFileNode,
  isSymbolNode,
  type ProjectSnapshot,
  type SymbolNode,
} from '../schema/snapshot'
import {
  buildSemanticSymbolText,
  buildSemanticSymbolTextRecord,
} from './symbolText'
import type { SemanticPurposeSummaryRecord } from './types'

export interface SemanticPurposeSummaryModelOutput {
  domainHints?: string[]
  sideEffects?: string[]
  summary: string
}

const MAX_COMMENT_LINES = 6

const VERB_PHRASE_BY_PREFIX: Record<string, string> = {
  get: 'retrieves',
  load: 'loads',
  fetch: 'fetches',
  create: 'creates',
  build: 'builds',
  map: 'maps',
  parse: 'parses',
  format: 'formats',
  render: 'renders',
  use: 'coordinates',
  handle: 'handles',
  submit: 'submits',
  validate: 'validates',
  select: 'selects',
  read: 'reads',
  write: 'writes',
  save: 'saves',
  update: 'updates',
  remove: 'removes',
  delete: 'deletes',
  open: 'opens',
  close: 'closes',
  login: 'authenticates',
  logout: 'ends the session for',
  route: 'routes',
}

export function buildSemanticPurposeSummaryRecords(
  snapshot: ProjectSnapshot,
): SemanticPurposeSummaryRecord[] {
  const generatedAt = new Date().toISOString()

  return Object.values(snapshot.nodes)
    .filter(isSymbolNode)
    .sort(compareSymbolsForPurpose)
    .map((symbol) => buildSemanticPurposeSummaryRecord(snapshot, symbol, generatedAt))
}

export function buildSemanticPurposeSummaryRecord(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
  generatedAt: string = new Date().toISOString(),
): SemanticPurposeSummaryRecord {
  const sourceTextRecord = buildSemanticSymbolTextRecord(snapshot, symbol, generatedAt)
  const summary = deriveHeuristicPurposeSummary(snapshot, symbol)
  const domainHints = deriveDomainHints(snapshot, symbol)
  const sideEffects = deriveSideEffects(snapshot, symbol)
  const embeddingText = buildPurposeEmbeddingText({
    summary,
    domainHints,
    sideEffects,
    symbol,
    snapshot,
  })

  return {
    symbolId: symbol.id,
    fileId: symbol.fileId,
    path: symbol.path,
    language: symbol.language,
    symbolKind: symbol.symbolKind,
    generator: 'heuristic',
    summary,
    domainHints,
    sideEffects,
    embeddingText,
    sourceHash: sourceTextRecord.textHash,
    generatedAt,
  }
}

export function buildSemanticPurposeSummaryPrompt(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
) {
  const sourceText = buildSemanticSymbolText(snapshot, symbol)

  return [
    'Summarize the semantic purpose of this code symbol for embedding-based clustering.',
    'Focus on what it does, what role it plays, and what side effects or data domains it touches.',
    'Avoid repeating exact code unless necessary.',
    'Return JSON only with this exact shape:',
    '{"summary":"...","domainHints":["..."],"sideEffects":["..."]}',
    'Keep "summary" to one or two compact sentences.',
    'Use short domain hint labels and side effect labels.',
    '',
    sourceText,
  ].join('\n')
}

export function buildSemanticPurposeSummaryRecordFromModelOutput(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
  output: SemanticPurposeSummaryModelOutput,
  generatedAt: string = new Date().toISOString(),
): SemanticPurposeSummaryRecord {
  const sourceTextRecord = buildSemanticSymbolTextRecord(snapshot, symbol, generatedAt)
  const summary = output.summary.trim()
  const domainHints = uniqueStrings(output.domainHints ?? []).slice(0, 8)
  const sideEffects = uniqueStrings(output.sideEffects ?? []).slice(0, 8)
  const embeddingText = buildPurposeEmbeddingText({
    summary,
    domainHints,
    sideEffects,
    symbol,
    snapshot,
  })

  return {
    symbolId: symbol.id,
    fileId: symbol.fileId,
    path: symbol.path,
    language: symbol.language,
    symbolKind: symbol.symbolKind,
    generator: 'llm',
    summary,
    domainHints,
    sideEffects,
    embeddingText,
    sourceHash: sourceTextRecord.textHash,
    generatedAt,
  }
}

export function parseSemanticPurposeSummaryResponse(
  text: string,
): SemanticPurposeSummaryModelOutput {
  const normalizedText = extractJsonObject(stripCodeFence(text.trim()))
  const parsed = JSON.parse(normalizedText) as Partial<SemanticPurposeSummaryModelOutput>
  const summary = parsed.summary?.trim()

  if (!summary) {
    throw new Error('The preprocessing response did not include a summary.')
  }

  return {
    summary,
    domainHints: Array.isArray(parsed.domainHints)
      ? parsed.domainHints.filter((value): value is string => typeof value === 'string')
      : [],
    sideEffects: Array.isArray(parsed.sideEffects)
      ? parsed.sideEffects.filter((value): value is string => typeof value === 'string')
      : [],
  }
}

function extractJsonObject(text: string) {
  const startIndex = text.indexOf('{')
  const endIndex = text.lastIndexOf('}')

  if (startIndex >= 0 && endIndex > startIndex) {
    return text.slice(startIndex, endIndex + 1)
  }

  return text
}

function deriveHeuristicPurposeSummary(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
) {
  const commentSummary = getLeadingCommentSummary(snapshot, symbol)

  if (commentSummary) {
    return commentSummary
  }

  const nameTokens = splitIdentifier(symbol.name)
  const verb = VERB_PHRASE_BY_PREFIX[nameTokens[0] ?? '']
  const nounPhrase = buildNounPhrase(nameTokens.slice(verb ? 1 : 0))
  const contextPhrase = buildContextPhrase(snapshot, symbol)

  switch (symbol.symbolKind) {
    case 'class':
      return nounPhrase
        ? `Represents ${nounPhrase}${contextPhrase ? ` for ${contextPhrase}` : ''}.`
        : `Represents a class${contextPhrase ? ` for ${contextPhrase}` : ''}.`
    case 'constant':
      return nounPhrase
        ? `Defines configuration or shared data for ${nounPhrase}${contextPhrase ? ` in ${contextPhrase}` : ''}.`
        : `Defines shared configuration or data${contextPhrase ? ` in ${contextPhrase}` : ''}.`
    case 'variable':
      return nounPhrase
        ? `Stores state or derived data for ${nounPhrase}${contextPhrase ? ` in ${contextPhrase}` : ''}.`
        : `Stores state or derived data${contextPhrase ? ` in ${contextPhrase}` : ''}.`
    default:
      if (verb && nounPhrase) {
        return `This ${symbol.symbolKind} ${verb} ${nounPhrase}${contextPhrase ? ` for ${contextPhrase}` : ''}.`
      }

      if (nounPhrase) {
        return `This ${symbol.symbolKind} handles ${nounPhrase}${contextPhrase ? ` for ${contextPhrase}` : ''}.`
      }

      return `This ${symbol.symbolKind} handles part of ${contextPhrase || 'the application flow'}.`
  }
}

function deriveDomainHints(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
) {
  const fileNode = snapshot.nodes[symbol.fileId]
  const filePath = fileNode && isFileNode(fileNode) ? fileNode.path : symbol.fileId
  const pathSegments = filePath
    .split(/[\\/]/)
    .flatMap((segment) => splitIdentifier(segment.replace(/\.[^.]+$/, '')))
    .filter((token) => token.length > 2)
  const symbolSegments = splitIdentifier(symbol.name).filter((token) => token.length > 2)

  return uniqueStrings([...pathSegments.slice(-4), ...symbolSegments.slice(0, 4)]).slice(0, 6)
}

function deriveSideEffects(
  snapshot: ProjectSnapshot,
  symbol: SymbolNode,
) {
  const excerpt = getSymbolExcerpt(snapshot, symbol).toLowerCase()
  const sideEffects: string[] = []

  if (!excerpt) {
    return sideEffects
  }

  if (excerpt.includes('fetch(') || excerpt.includes('pb.') || excerpt.includes('axios')) {
    sideEffects.push('network_io')
  }

  if (excerpt.includes('localstorage') || excerpt.includes('sessionstorage') || excerpt.includes('cookie')) {
    sideEffects.push('persistence')
  }

  if (excerpt.includes('setstate') || excerpt.includes('atom(') || excerpt.includes('dispatch(')) {
    sideEffects.push('state_updates')
  }

  if (excerpt.includes('navigate(') || excerpt.includes('router') || excerpt.includes('route')) {
    sideEffects.push('routing')
  }

  if (excerpt.includes('<') || excerpt.includes('return (') || excerpt.includes('jsx')) {
    sideEffects.push('ui_rendering')
  }

  return uniqueStrings(sideEffects)
}

function buildPurposeEmbeddingText(input: {
  summary: string
  domainHints: string[]
  sideEffects: string[]
  symbol: SymbolNode
  snapshot: ProjectSnapshot
}) {
  const fileNode = input.snapshot.nodes[input.symbol.fileId]
  const filePath = fileNode && isFileNode(fileNode) ? fileNode.path : input.symbol.fileId

  return [
    `purpose: ${input.summary}`,
    `kind: ${input.symbol.symbolKind}`,
    `symbol: ${input.symbol.name}`,
    `path_context: ${filePath}`,
    input.symbol.facets.length > 0 ? `facets: ${input.symbol.facets.join(', ')}` : '',
    input.domainHints.length > 0 ? `domains: ${input.domainHints.join(', ')}` : '',
    input.sideEffects.length > 0 ? `side_effects: ${input.sideEffects.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function getLeadingCommentSummary(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const fileNode = snapshot.nodes[symbol.fileId]

  if (!fileNode || !isFileNode(fileNode) || !fileNode.content || !symbol.range) {
    return ''
  }

  const lines = fileNode.content.split(/\r?\n/)
  let lineIndex = Math.max(0, symbol.range.start.line - 2)
  const collected: string[] = []

  while (lineIndex >= 0 && collected.length < MAX_COMMENT_LINES) {
    const line = lines[lineIndex]?.trim() ?? ''

    if (!line) {
      if (collected.length > 0) {
        break
      }

      lineIndex -= 1
      continue
    }

    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('*/')) {
      collected.unshift(line.replace(/^\/\//, '').replace(/^\/\*/, '').replace(/^\*/, '').replace(/\*\/$/, '').trim())
      lineIndex -= 1
      continue
    }

    break
  }

  return collected.join(' ').trim()
}

function getSymbolExcerpt(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const fileNode = snapshot.nodes[symbol.fileId]

  if (!fileNode || !isFileNode(fileNode) || !fileNode.content || !symbol.range) {
    return ''
  }

  const lines = fileNode.content.split(/\r?\n/)
  const startLine = Math.max(1, symbol.range.start.line)
  const endLine = Math.min(lines.length, Math.max(startLine, symbol.range.end.line))

  return lines.slice(startLine - 1, endLine).join('\n')
}

function splitIdentifier(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_/.:\\-]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function buildNounPhrase(tokens: string[]) {
  if (tokens.length === 0) {
    return ''
  }

  return tokens.join(' ')
}

function buildContextPhrase(snapshot: ProjectSnapshot, symbol: SymbolNode) {
  const fileNode = snapshot.nodes[symbol.fileId]
  const filePath = fileNode && isFileNode(fileNode) ? fileNode.path : symbol.fileId
  const pathTokens = filePath
    .split(/[\\/]/)
    .slice(-3)
    .flatMap((segment) => splitIdentifier(segment.replace(/\.[^.]+$/, '')))
    .filter((token) => token.length > 2)

  return uniqueStrings(pathTokens).join(' ')
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function stripCodeFence(value: string) {
  if (!value.startsWith('```')) {
    return value
  }

  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function compareSymbolsForPurpose(left: SymbolNode, right: SymbolNode) {
  const leftPath = `${left.path}:${left.range?.start.line ?? 0}:${left.range?.start.column ?? 0}`
  const rightPath = `${right.path}:${right.range?.start.line ?? 0}:${right.range?.start.column ?? 0}`
  return leftPath.localeCompare(rightPath)
}

import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { ToolDefinition } from '@mariozechner/pi-coding-agent'

import {
  createSymbolQuerySession,
  type SymbolQueryOperation,
  type SymbolQuerySessionInput,
} from '../../agent/symbolQuery'
import { readProjectSnapshot } from '../../node/readProjectSnapshot'
import { clearProjectSnapshotMemoryCache } from '../../node/projectSnapshotCache'

export const SEMANTICODE_SYMBOL_TOOL_NAMES = [
  'getSymbolWorkspaceSummary',
  'findSymbols',
  'getSymbolOutline',
  'getSymbolNeighborhood',
  'readSymbolSlice',
  'replaceSymbolRange',
  'readFileWindow',
  'replaceFileWindow',
] as const satisfies readonly SymbolQueryOperation[]

const SYMBOL_TOOL_GUIDELINES = [
  'Use Semanticode symbol tools before broad file reads when exploring source code.',
  'For top-N symbol requests, pass the requested limit and an explicit sortBy value such as loc, degree, name, path, or kind.',
  'For descriptions of large or multiple symbols, call getSymbolOutline first, then page through readSymbolSlice with startLine or relativeStartLine only when details are needed.',
  'For edits inside one symbol, call readSymbolSlice first and then replaceSymbolRange with the returned sliceHash as expectedSliceHash.',
  'Prefer readSymbolSlice for implementation bodies; use readFileWindow and replaceFileWindow only for imports, module headers, configs, tests, multi-symbol edits, or non-symbol code, and include the required reason.',
]

const SYMBOL_TOOL_SPECS: Record<
  SymbolQueryOperation,
  {
    description: string
    promptSnippet: string
  }
> = {
  findSymbols: {
    description:
      'Find compact symbol references using filters like symbolKind, facet, tag, pathPrefix, pathContains, nameContains, nameRegex, LOC range, degree range, limit, sortBy, and sortDirection. For top symbols by LOC, use { "sortBy": "loc", "sortDirection": "desc", "limit": N }.',
    promptSnippet:
      'Find compact symbol references by filters, limit, and sorting. For top N by LOC use sortBy="loc", sortDirection="desc", limit=N.',
  },
  getSymbolNeighborhood: {
    description:
      'Expand a bounded graph neighborhood from seedSymbolIds using optional edgeKinds, direction, depth, and limit.',
    promptSnippet:
      'Expand callers, callees, imports, contains, references, or other graph edges around seed symbol IDs.',
  },
  getSymbolOutline: {
    description:
      'Return compact outlines for one or more symbols using symbolId, symbolIds, nodeIds, symbolPath, path, filePath, or selector filters. Includes metadata, edge counts, nested symbols, and a short source preview without reading the whole body.',
    promptSnippet:
      'Outline large symbols before reading them. Accepts symbolIds/symbolNodeIds/nodeIds or path/filePath plus optional previewLines and nestedLimit.',
  },
  getSymbolWorkspaceSummary: {
    description:
      'Get compact symbol counts, languages, facets/tags, graph capabilities, edge counts, entry files, and top directories.',
    promptSnippet:
      'Get compact workspace symbol counts, languages, facets, tags, graph capabilities, and top directories.',
  },
  readFileWindow: {
    description:
      'Read a bounded line window from a file path or fileId when symbol slices are insufficient. The reason argument is required.',
    promptSnippet:
      'Read a bounded file line window as a fallback for imports, module headers, configs, tests, multi-symbol edits, or non-symbol code. Always pass reason.',
  },
  readSymbolSlice: {
    description:
      'Read a bounded source slice for a symbolId/symbolNodeId/nodeId/symbolPath/path/filePath. Supports maxLines, beforeLines, afterLines, startLine, endLine, relativeStartLine, and relativeEndLine for paging large symbols.',
    promptSnippet:
      'Read a bounded source slice for a symbol. If the result has hasMoreAfter, call again with nextStartLine or nextRelativeStartLine.',
  },
  replaceSymbolRange: {
    description:
      'Replace the current whole-line source range for one symbol. Requires symbolId/symbolNodeId/nodeId/symbolPath/path/filePath, expectedSliceHash from readSymbolSlice, and replacementText. Rejects stale edits when the current slice hash differs.',
    promptSnippet:
      'Edit one symbol by replacing its source range. First readSymbolSlice, then pass expectedSliceHash and replacementText.',
  },
  replaceFileWindow: {
    description:
      'Replace a bounded file line window when a change cannot be represented as one symbol, such as imports, module headers, configs, tests, or multi-symbol edits. Requires path/filePath, startLine, endLine, reason, expectedWindowHash from readFileWindow, and replacementText.',
    promptSnippet:
      'Edit a bounded non-symbol file window. First readFileWindow, then pass startLine, endLine, reason, expectedWindowHash, and replacementText.',
  },
}

export function createSymbolQueryToolDefinitions(
  rootDir: string,
  snapshotProvider: SymbolQuerySessionInput['snapshotProvider'] = () =>
    readProjectSnapshot({
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
      rootDir,
    }),
  fileWriter: SymbolQuerySessionInput['fileWriter'] = (filePath, content) =>
    writeWorkspaceFile(rootDir, filePath, content),
  snapshotInvalidator: SymbolQuerySessionInput['snapshotInvalidator'] = () =>
    clearProjectSnapshotMemoryCache(rootDir),
): ToolDefinition[] {
  const querySession = createSymbolQuerySession({
    fileWriter,
    rootDir,
    snapshotInvalidator,
    snapshotProvider,
  })

  return SEMANTICODE_SYMBOL_TOOL_NAMES.map((operation) =>
    createSymbolQueryToolDefinition(operation, querySession),
  )
}

function createSymbolQueryToolDefinition(
  operation: SymbolQueryOperation,
  querySession: ReturnType<typeof createSymbolQuerySession>,
): ToolDefinition {
  const spec = SYMBOL_TOOL_SPECS[operation]

  return {
    description: spec.description,
    execute: async (_toolCallId, params) => {
      const result = await querySession.execute({
        args: normalizeSymbolToolArgs(operation, params),
        operation,
      })

      return {
        content: [
          {
            text: JSON.stringify(result),
            type: 'text',
          },
        ],
        details: result,
      }
    },
    label: operation,
    name: operation,
    parameters: {
      additionalProperties: true,
      properties: {
        args: {
          additionalProperties: true,
          type: 'object',
        },
      },
      type: 'object',
    } as never,
    promptGuidelines: SYMBOL_TOOL_GUIDELINES,
    promptSnippet: spec.promptSnippet,
  }
}

function normalizeSymbolToolArgs(
  operation: SymbolQueryOperation,
  params: unknown,
): Record<string, unknown> {
  const unwrappedParams = unwrapArgsParam(params)
  const objectParams = parseObjectParams(unwrappedParams)

  if (objectParams) {
    return normalizeObjectArgs(operation, objectParams)
  }

  if (Array.isArray(unwrappedParams)) {
    return normalizeArrayArgs(operation, unwrappedParams)
  }

  if (typeof unwrappedParams === 'string') {
    return normalizeStringArgs(operation, unwrappedParams)
  }

  return {}
}

function normalizeObjectArgs(
  operation: SymbolQueryOperation,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const query =
    getStringParam(params, 'query') ??
    getStringParam(params, 'path') ??
    getStringParam(params, 'filePath')

  if (!query) {
    return params
  }

  switch (operation) {
    case 'findSymbols':
      return { ...normalizeFindSymbolsStringArgs(query), ...params }
    case 'getSymbolOutline':
    case 'readSymbolSlice':
    case 'replaceSymbolRange':
      return { ...normalizeSymbolTargetStringArgs(query), ...params }
    case 'readFileWindow':
    case 'replaceFileWindow':
      return { path: query, ...params }
    default:
      return params
  }
}

function unwrapArgsParam(params: unknown) {
  if (!isRecord(params) || !('args' in params)) {
    return params
  }

  return params.args
}

function parseObjectParams(params: unknown): Record<string, unknown> | null {
  if (isRecord(params)) {
    return params
  }

  if (typeof params !== 'string') {
    return null
  }

  const trimmed = params.trim()

  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown

      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  return parseKeyValueArgs(trimmed)
}

function parseKeyValueArgs(value: string): Record<string, unknown> | null {
  const tokens = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const entries: Array<[string, unknown]> = []
  const positional: string[] = []

  for (const token of tokens) {
    const separatorIndex = token.indexOf('=')

    if (separatorIndex <= 0) {
      positional.push(String(coerceTokenValue(token)))
      continue
    }

    entries.push([
      token.slice(0, separatorIndex),
      coerceTokenValue(token.slice(separatorIndex + 1)),
    ])
  }

  if (positional.length > 0 && entries.length > 0) {
    entries.unshift(['query', positional.join(' ')])
  }

  return entries.length > 0 ? Object.fromEntries(entries) : null
}

function coerceTokenValue(value: string) {
  const unquoted = value.replace(/^["']|["']$/g, '')

  if (unquoted === 'true') {
    return true
  }

  if (unquoted === 'false') {
    return false
  }

  const numericValue = Number(unquoted)

  return Number.isFinite(numericValue) && unquoted !== '' ? numericValue : unquoted
}

function normalizeArrayArgs(
  operation: SymbolQueryOperation,
  params: unknown[],
): Record<string, unknown> {
  const stringParams = params.filter((param): param is string => typeof param === 'string')

  switch (operation) {
    case 'findSymbols':
      return { nodeIds: stringParams }
    case 'getSymbolOutline':
      return { symbolIds: stringParams }
    case 'getSymbolNeighborhood':
      return { seedSymbolIds: stringParams }
    case 'readFileWindow':
    case 'replaceFileWindow':
      return { path: stringParams[0] }
    case 'readSymbolSlice':
    case 'replaceSymbolRange':
      return { symbolId: stringParams[0] }
    case 'getSymbolWorkspaceSummary':
      return {}
  }
}

function normalizeStringArgs(
  operation: SymbolQueryOperation,
  value: string,
): Record<string, unknown> {
  const trimmed = value.trim()

  if (!trimmed) {
    return {}
  }

  switch (operation) {
    case 'findSymbols':
      return normalizeFindSymbolsStringArgs(trimmed)
    case 'getSymbolOutline':
      return normalizeSymbolTargetStringArgs(trimmed)
    case 'getSymbolNeighborhood':
      return { seedSymbolIds: [trimmed] }
    case 'readFileWindow':
    case 'replaceFileWindow':
      return { path: trimmed }
    case 'readSymbolSlice':
    case 'replaceSymbolRange':
      return normalizeSymbolTargetStringArgs(trimmed)
    case 'getSymbolWorkspaceSummary':
      return {}
  }
}

function normalizeSymbolTargetStringArgs(value: string): Record<string, unknown> {
  if (value.startsWith('symbol:')) {
    return { symbolId: value }
  }

  return looksLikePath(value)
    ? { path: value }
    : { symbolPath: value }
}

function normalizeFindSymbolsStringArgs(value: string): Record<string, unknown> {
  if (value.startsWith('symbol:')) {
    return { nodeIds: [value] }
  }

  return looksLikePath(value)
    ? { pathContains: value }
    : { nameContains: value }
}

function looksLikePath(value: string) {
  return value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    /\.[a-z0-9]+(?:[#:@].*)?$/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringParam(params: Record<string, unknown>, key: string) {
  const value = params[key]

  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function writeWorkspaceFile(rootDir: string, filePath: string, content: string) {
  const targetPath = resolve(rootDir, filePath)
  const relativePath = relative(rootDir, targetPath)

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Refusing to write outside workspace root: ${filePath}`)
  }

  await writeFile(targetPath, content, 'utf8')
}

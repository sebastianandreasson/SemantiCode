import { isAbsolute, relative } from 'node:path'

import type {
  AgentFileOperation,
  AgentFileOperationConfidence,
  AgentFileOperationKind,
  AgentFileOperationSource,
  AgentFileOperationStatus,
  AgentMessage,
  AgentToolInvocation,
} from '../../schema/agent'

const MAX_OPERATION_PATHS = 12

const DIRECT_READ_MARKERS = [
  'cat',
  'find',
  'grep',
  'list',
  'ls',
  'open',
  'read',
  'search',
  'view',
]

const DIRECT_WRITE_MARKERS = [
  'apply',
  'create',
  'edit',
  'insert',
  'modify',
  'patch',
  'replace',
  'save',
  'write',
]

const DIRECT_DELETE_MARKERS = [
  'delete',
  'remove',
  'rm',
  'unlink',
]

const DIRECT_RENAME_MARKERS = [
  'move',
  'mv',
  'rename',
]

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'exec',
  'exec_command',
  'shell',
  'terminal',
])

export function createFileOperationsFromToolInvocation(input: {
  invocation: AgentToolInvocation
  sessionId: string
  source?: AgentFileOperationSource
  status?: AgentFileOperationStatus
  timestamp?: string
  workspaceRootDir?: string
}): AgentFileOperation[] {
  const status = input.status ?? getInvocationStatus(input.invocation)
  const timestamp = input.timestamp ?? getInvocationTimestamp(input.invocation, status)
  const source = input.source ?? 'agent-tool'
  const shellCommand = getShellCommand(input.invocation.args)
  const isShellTool = isShellToolName(input.invocation.toolName)
  const pathSet = new Set<string>()

  for (const pathValue of input.invocation.paths ?? []) {
    addNormalizedPath(pathSet, pathValue, input.workspaceRootDir)
  }

  collectPathLikeValues(input.invocation.args, pathSet, input.workspaceRootDir)

  const parsedResultPreview = parseJsonPreview(input.invocation.resultPreview)
  if (parsedResultPreview !== undefined) {
    collectPathLikeValues(parsedResultPreview, pathSet, input.workspaceRootDir)
  }

  if (isShellTool && shellCommand) {
    for (const pathValue of extractShellPathTokens(shellCommand)) {
      addNormalizedPath(pathSet, pathValue, input.workspaceRootDir)
    }
  }

  const paths = [...pathSet].slice(0, MAX_OPERATION_PATHS)
  const classification = isShellTool
    ? classifyShellInvocation(shellCommand)
    : classifyDirectInvocation(input.invocation.toolName, input.invocation.args, paths)

  if (paths.length === 0) {
    if (isShellTool && shellCommand) {
      return [
        createOperation({
          confidence: classification.confidence,
          invocation: input.invocation,
          kind: 'shell_command',
          path: undefined,
          paths: [],
          sessionId: input.sessionId,
          source,
          status,
          timestamp,
        }),
      ]
    }

    return []
  }

  return paths.map((pathValue, index) =>
    createOperation({
      confidence: classification.confidence,
      invocation: input.invocation,
      kind: classification.kind,
      path: pathValue,
      pathIndex: index,
      paths,
      sessionId: input.sessionId,
      source,
      status,
      timestamp,
    }),
  )
}

export function createFileOperationsFromAgentMessage(input: {
  message: AgentMessage
  sessionId: string
  source?: AgentFileOperationSource
  workspaceRootDir?: string
}): AgentFileOperation[] {
  if (input.message.role !== 'assistant') {
    return []
  }

  const pathSet = new Set<string>()

  for (const block of input.message.blocks) {
    if (block.kind === 'text') {
      collectMessagePathReferences(block.text, pathSet, input.workspaceRootDir)
    }
  }

  const paths = [...pathSet].slice(0, MAX_OPERATION_PATHS)
  const timestamp = input.message.createdAt
  const source = input.source ?? 'assistant-message'
  const status: AgentFileOperationStatus = input.message.isStreaming
    ? 'running'
    : 'completed'
  const invocation: AgentToolInvocation = {
    args: { messageId: input.message.id },
    endedAt: status === 'completed' ? timestamp : undefined,
    startedAt: timestamp,
    toolCallId: `message:${input.message.id}`,
    toolName: 'assistant_message',
  }

  return paths.map((pathValue, index) =>
    createOperation({
      confidence: 'fallback',
      invocation,
      kind: 'file_read',
      path: pathValue,
      pathIndex: index,
      paths,
      sessionId: input.sessionId,
      source,
      status,
      timestamp,
    }),
  )
}

export function isFileChangingOperationKind(kind: AgentFileOperationKind) {
  return (
    kind === 'file_changed' ||
    kind === 'file_delete' ||
    kind === 'file_rename' ||
    kind === 'file_write'
  )
}

function createOperation(input: {
  confidence: AgentFileOperationConfidence
  invocation: AgentToolInvocation
  kind: AgentFileOperationKind
  path?: string
  pathIndex?: number
  paths: string[]
  sessionId: string
  source: AgentFileOperationSource
  status: AgentFileOperationStatus
  timestamp: string
}): AgentFileOperation {
  return {
    confidence: input.confidence,
    id: buildOperationId({
      invocation: input.invocation,
      kind: input.kind,
      path: input.path,
      pathIndex: input.pathIndex ?? 0,
      sessionId: input.sessionId,
    }),
    kind: input.kind,
    path: input.path,
    paths: input.paths,
    resultPreview: input.invocation.resultPreview,
    sessionId: input.sessionId,
    source: input.source,
    status: input.status,
    timestamp: input.timestamp,
    toolCallId: input.invocation.toolCallId,
    toolName: input.invocation.toolName,
  }
}

function classifyDirectInvocation(
  toolName: string,
  args: unknown,
  paths: string[],
): {
  confidence: AgentFileOperationConfidence
  kind: AgentFileOperationKind
} {
  const normalizedText = [
    normalizeClassifyingText(toolName),
    ...getActionTerms(args).map(normalizeClassifyingText),
  ].filter(Boolean).join(' ')

  if (containsAnyMarker(normalizedText, DIRECT_RENAME_MARKERS)) {
    return { confidence: 'exact', kind: 'file_rename' }
  }

  if (containsAnyMarker(normalizedText, DIRECT_DELETE_MARKERS)) {
    return { confidence: 'exact', kind: 'file_delete' }
  }

  if (containsAnyMarker(normalizedText, DIRECT_WRITE_MARKERS)) {
    return { confidence: 'exact', kind: 'file_write' }
  }

  if (containsAnyMarker(normalizedText, DIRECT_READ_MARKERS)) {
    return { confidence: 'exact', kind: 'file_read' }
  }

  return {
    confidence: paths.length > 0 ? 'fallback' : 'inferred',
    kind: paths.length > 0 ? 'file_changed' : 'shell_command',
  }
}

function classifyShellInvocation(command: string): {
  confidence: AgentFileOperationConfidence
  kind: AgentFileOperationKind
} {
  const normalizedCommand = ` ${command.trim().toLowerCase()} `

  if (/\s(mv|rename)\s/.test(normalizedCommand)) {
    return { confidence: 'inferred', kind: 'file_rename' }
  }

  if (/\s(rm|unlink|delete)\s/.test(normalizedCommand)) {
    return { confidence: 'inferred', kind: 'file_delete' }
  }

  if (
    /\bapply_patch\b/.test(normalizedCommand) ||
    /\bsed\s+-[a-z]*i[a-z]*\b/.test(normalizedCommand) ||
    /\bperl\s+-[a-z]*i[a-z]*\b/.test(normalizedCommand) ||
    /\btee\s+/.test(normalizedCommand) ||
    /(^|[\s;&|])>>?\s*[^\s&|]+/.test(normalizedCommand) ||
    /\b(touch|truncate)\s+/.test(normalizedCommand)
  ) {
    return { confidence: 'inferred', kind: 'file_write' }
  }

  if (
    /\b(cat|find|grep|head|less|ls|more|nl|rg|sed|tail)\b/.test(normalizedCommand) ||
    /\bgit\s+(diff|show)\b/.test(normalizedCommand)
  ) {
    return { confidence: 'inferred', kind: 'file_read' }
  }

  return { confidence: 'inferred', kind: 'shell_command' }
}

function getInvocationStatus(invocation: AgentToolInvocation): AgentFileOperationStatus {
  if (!invocation.endedAt) {
    return 'running'
  }

  return invocation.isError ? 'error' : 'completed'
}

function getInvocationTimestamp(
  invocation: AgentToolInvocation,
  status: AgentFileOperationStatus,
) {
  if (status === 'running') {
    return invocation.startedAt
  }

  return invocation.endedAt ?? invocation.startedAt
}

function buildOperationId(input: {
  invocation: AgentToolInvocation
  kind: AgentFileOperationKind
  path?: string
  pathIndex: number
  sessionId: string
}) {
  return [
    'agent-file-operation',
    input.sessionId,
    input.invocation.toolCallId,
    input.kind,
    String(input.pathIndex),
    input.path ?? 'no-path',
  ].map(encodeIdPart).join(':')
}

function encodeIdPart(value: string) {
  return encodeURIComponent(value)
}

function collectPathLikeValues(
  value: unknown,
  output: Set<string>,
  workspaceRootDir?: string,
) {
  if (!value || output.size >= MAX_OPERATION_PATHS) {
    return
  }

  if (typeof value === 'string') {
    if (looksPathLike(value, true)) {
      addNormalizedPath(output, value, workspaceRootDir)
    }
    return
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPathLikeValues(entry, output, workspaceRootDir)
    }
    return
  }

  if (typeof value !== 'object') {
    return
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (keyLooksPathLike(key)) {
      collectPathLikeValues(entry, output, workspaceRootDir)
      continue
    }

    if (entry && typeof entry === 'object') {
      collectPathLikeValues(entry, output, workspaceRootDir)
    }
  }
}

function collectMessagePathReferences(
  text: string,
  output: Set<string>,
  workspaceRootDir?: string,
) {
  if (!text || output.size >= MAX_OPERATION_PATHS) {
    return
  }

  const markdownLinkPattern = /\[([^\]]+)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const match of text.matchAll(markdownLinkPattern)) {
    addNormalizedPath(output, match[1], workspaceRootDir)
    addNormalizedPath(output, match[2], workspaceRootDir)
  }

  const inlineCodePattern = /`([^`\n]+)`/g
  for (const match of text.matchAll(inlineCodePattern)) {
    addNormalizedPath(output, match[1], workspaceRootDir)
  }

  const plainPathPattern =
    /(?:^|[\s([{"'=])((?:~?\/|\.{1,2}\/|[\w@~.-]+[\\/])[\w@~./\\ -]*\.[A-Za-z0-9][\w.-]*)(?=$|[\s)\]},:;"'])/g
  for (const match of text.matchAll(plainPathPattern)) {
    addNormalizedPath(output, match[1], workspaceRootDir)
  }
}

function keyLooksPathLike(key: string) {
  const normalizedKey = key.trim().toLowerCase()

  return (
    normalizedKey === 'file' ||
    normalizedKey === 'files' ||
    normalizedKey === 'filename' ||
    normalizedKey === 'filenames' ||
    normalizedKey === 'filepath' ||
    normalizedKey === 'filepaths' ||
    normalizedKey === 'file_path' ||
    normalizedKey === 'file_paths' ||
    normalizedKey === 'path' ||
    normalizedKey === 'paths' ||
    normalizedKey.endsWith('_path') ||
    normalizedKey.endsWith('path')
  )
}

function addNormalizedPath(
  output: Set<string>,
  value: string,
  workspaceRootDir?: string,
) {
  const normalizedPath = normalizeOperationPath(value, workspaceRootDir)

  if (normalizedPath) {
    output.add(normalizedPath)
  }
}

function normalizeOperationPath(value: string, workspaceRootDir?: string) {
  let normalized = cleanPathToken(value)

  normalized = stripLineSuffix(normalized)

  if (!normalized || !looksPathLike(normalized, true)) {
    return null
  }

  if (workspaceRootDir && isAbsolute(normalized)) {
    const relativePath = relative(workspaceRootDir, normalized)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      normalized = relativePath
    }
  }

  normalized = normalized.replace(/\\/g, '/')

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  if (!normalized || normalized === '.' || normalized === '/') {
    return null
  }

  return normalized
}

function cleanPathToken(value: string) {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^[([{<]+/g, '')
    .replace(/[)\]},;>]+$/g, '')
    .replace(/^>>?/, '')
    .trim()
}

function stripLineSuffix(value: string) {
  return value.replace(/:(\d+)(?::\d+)?$/g, '')
}

function looksPathLike(value: string, allowBareFile: boolean) {
  const normalized = value.trim()

  if (
    !normalized ||
    normalized.length > 360 ||
    normalized.startsWith('-') ||
    /^[a-z]+:\/\//i.test(normalized)
  ) {
    return false
  }

  return (
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    /^[\w@~.-]+[\\/][\w@~./\\ -]+$/.test(normalized) ||
    (allowBareFile && /^[\w@~.-]+\.[\w.-]+$/.test(normalized))
  )
}

function getShellCommand(args: unknown) {
  if (typeof args === 'string') {
    return args.trim()
  }

  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return ''
  }

  for (const key of ['cmd', 'command', 'script']) {
    const entry = (args as Record<string, unknown>)[key]
    if (typeof entry === 'string' && entry.trim()) {
      return entry.trim()
    }
  }

  return ''
}

function extractShellPathTokens(command: string) {
  const values = new Set<string>()
  const tokens = command.match(/"([^"\\]|\\.)*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? []

  for (const token of tokens) {
    const cleanedToken = cleanPathToken(token)

    if (looksPathLike(cleanedToken, true)) {
      values.add(cleanedToken)
    }
  }

  return [...values]
}

function isShellToolName(toolName: string) {
  return SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase())
}

function getActionTerms(args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return []
  }

  return ['action', 'command', 'cmd', 'kind', 'mode', 'operation']
    .map((key) => (args as Record<string, unknown>)[key])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function normalizeClassifyingText(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')
}

function containsAnyMarker(value: string, markers: string[]) {
  return markers.some((marker) => new RegExp(`(^|\\s)${marker}(\\s|$)`).test(value))
}

function parseJsonPreview(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

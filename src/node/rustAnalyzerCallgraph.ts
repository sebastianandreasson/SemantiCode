import { execFile, spawn } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type { GraphEdge, ProjectSnapshot, SymbolNode } from '../types'

import { getSymbolByRange, getSymbolsForFile, type SymbolIndex } from './symbolIndex'

const execFileAsync = promisify(execFile)

const RUST_ANALYZER_PROBE_CANDIDATES: Array<{
  command: string
  args: string[]
}> = [
  { command: 'rust-analyzer', args: [] },
  { command: 'rustup', args: ['run', 'stable', 'rust-analyzer'] },
]

const CALLABLE_SYMBOL_KINDS = new Set<SymbolNode['symbolKind']>(['function', 'method'])
const REQUEST_TIMEOUT_MS = 20_000

interface LspPosition {
  line: number
  character: number
}

interface LspRange {
  start: LspPosition
  end: LspPosition
}

interface CallHierarchyItem {
  name: string
  kind: number
  uri: string
  range: LspRange
  selectionRange: LspRange
}

interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem
  fromRanges: LspRange[]
}

let rustAnalyzerProbePromise:
  | Promise<{ command: string; args: string[] } | null>
  | null = null

export async function buildRustCallGraph(
  snapshot: ProjectSnapshot,
  symbolIndex: SymbolIndex,
) {
  const rustAnalyzer = await detectRustAnalyzer()

  if (!rustAnalyzer) {
    return {
      edges: [],
    }
  }

  const rustSymbols = Object.values(snapshot.nodes).filter(
    (node): node is SymbolNode =>
      node.kind === 'symbol' &&
      node.language === 'rust' &&
      CALLABLE_SYMBOL_KINDS.has(node.symbolKind) &&
      Boolean(node.range),
  )

  if (rustSymbols.length === 0) {
    return {
      edges: [],
    }
  }

  let client: RustAnalyzerLspClient | null = null

  try {
    client = await RustAnalyzerLspClient.start(snapshot.rootDir, rustAnalyzer)
    const edges: GraphEdge[] = []

    for (const sourceSymbol of rustSymbols) {
      const preparedItems = await client.prepareCallHierarchy(
        toFileUri(snapshot, sourceSymbol.fileId),
        {
          line: (sourceSymbol.range?.start.line ?? 1) - 1,
          character: sourceSymbol.range?.start.column ?? 0,
        },
      )

      if (!preparedItems?.length) {
        continue
      }

      for (const preparedItem of preparedItems) {
        const normalizedSourceSymbol =
          matchCallHierarchyItemToSymbol(preparedItem, snapshot, symbolIndex) ?? sourceSymbol

        if (!normalizedSourceSymbol) {
          continue
        }

        const outgoingCalls = await client.outgoingCalls(preparedItem)

        for (const outgoingCall of outgoingCalls ?? []) {
          const targetSymbol = matchCallHierarchyItemToSymbol(
            outgoingCall.to,
            snapshot,
            symbolIndex,
          )

          if (!targetSymbol || targetSymbol.id === normalizedSourceSymbol.id) {
            continue
          }

          edges.push({
            id: `calls:${normalizedSourceSymbol.id}->${targetSymbol.id}:rust-analyzer`,
            kind: 'calls',
            source: normalizedSourceSymbol.id,
            target: targetSymbol.id,
            inferred: true,
            metadata: {
              analyzer: 'rust-analyzer',
            },
          })
        }
      }
    }

    return {
      edges: dedupeEdges(edges),
    }
  } catch {
    return {
      edges: [],
    }
  } finally {
    await client?.dispose()
  }
}

async function detectRustAnalyzer() {
  if (!rustAnalyzerProbePromise) {
    rustAnalyzerProbePromise = (async () => {
      for (const candidate of RUST_ANALYZER_PROBE_CANDIDATES) {
        try {
          await execFileAsync(candidate.command, [...candidate.args, '--version'], {
            maxBuffer: 1024 * 1024,
          })
          return candidate
        } catch {
          continue
        }
      }

      return null
    })()
  }

  return rustAnalyzerProbePromise
}

function toFileUri(snapshot: ProjectSnapshot, fileId: string) {
  return pathToFileURL(resolve(snapshot.rootDir, fileId)).toString()
}

function matchCallHierarchyItemToSymbol(
  item: CallHierarchyItem,
  snapshot: ProjectSnapshot,
  symbolIndex: SymbolIndex,
) {
  const fileId = getFileIdFromUri(item.uri, snapshot)

  if (!fileId) {
    return null
  }

  const exactRangeMatch = getSymbolByRange(symbolIndex, fileId, {
    start: {
      line: item.range.start.line + 1,
      column: item.range.start.character,
    },
    end: {
      line: item.range.end.line + 1,
      column: item.range.end.character,
    },
  })

  if (exactRangeMatch && CALLABLE_SYMBOL_KINDS.has(exactRangeMatch.symbolKind)) {
    return exactRangeMatch
  }

  const selectionLine = item.selectionRange.start.line + 1
  const selectionColumn = item.selectionRange.start.character
  const candidates = getSymbolsForFile(symbolIndex, fileId).filter(
    (symbolNode) =>
      CALLABLE_SYMBOL_KINDS.has(symbolNode.symbolKind) &&
      symbolNode.name === item.name &&
      containsPosition(symbolNode, selectionLine, selectionColumn),
  )

  if (candidates.length === 1) {
    return candidates[0]
  }

  if (candidates.length > 1) {
    return [...candidates].sort(compareSymbolsByRangeSize)[0]
  }

  const fallbackByName = getSymbolsForFile(symbolIndex, fileId).filter(
    (symbolNode) =>
      CALLABLE_SYMBOL_KINDS.has(symbolNode.symbolKind) && symbolNode.name === item.name,
  )

  if (fallbackByName.length === 1) {
    return fallbackByName[0]
  }

  if (fallbackByName.length > 1) {
    return [...fallbackByName].sort(compareSymbolsByRangeSize)[0]
  }

  return null
}

function getFileIdFromUri(uri: string, snapshot: ProjectSnapshot) {
  const absoluteFilePath = fileURLToPath(uri)
  const relativePath = relative(snapshot.rootDir, absoluteFilePath)
  const normalizedRelativePath = relativePath.split('\\').join('/')

  if (
    normalizedRelativePath === '' ||
    normalizedRelativePath === '.' ||
    normalizedRelativePath.startsWith('..') ||
    normalizedRelativePath.startsWith('../')
  ) {
    return null
  }

  return normalizedRelativePath
}

function containsPosition(symbolNode: SymbolNode, line: number, column: number) {
  const range = symbolNode.range

  if (!range) {
    return false
  }

  if (line < range.start.line || line > range.end.line) {
    return false
  }

  if (line === range.start.line && column < range.start.column) {
    return false
  }

  if (line === range.end.line && column > range.end.column) {
    return false
  }

  return true
}

function compareSymbolsByRangeSize(left: SymbolNode, right: SymbolNode) {
  const leftSize =
    (left.range?.end.line ?? 0) * 10_000 +
    (left.range?.end.column ?? 0) -
    ((left.range?.start.line ?? 0) * 10_000 + (left.range?.start.column ?? 0))
  const rightSize =
    (right.range?.end.line ?? 0) * 10_000 +
    (right.range?.end.column ?? 0) -
    ((right.range?.start.line ?? 0) * 10_000 + (right.range?.start.column ?? 0))

  if (leftSize !== rightSize) {
    return leftSize - rightSize
  }

  return left.id.localeCompare(right.id)
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map<string, GraphEdge>()

  for (const edge of edges) {
    uniqueEdges.set(edge.id, edge)
  }

  return [...uniqueEdges.values()]
}

class RustAnalyzerLspClient {
  private nextRequestId = 1
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (reason?: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly process
  private readonly stderrChunks: string[] = []
  private buffer = ''

  private constructor(
    rootDir: string,
    executable: { command: string; args: string[] },
  ) {
    this.process = spawn(executable.command, executable.args, {
      cwd: rootDir,
      stdio: 'pipe',
    })

    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      this.readMessages()
    })

    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => {
      this.stderrChunks.push(chunk)
    })

    this.process.on('exit', () => {
      for (const [id, pendingRequest] of this.pendingRequests) {
        clearTimeout(pendingRequest.timer)
        pendingRequest.reject(new Error(`rust-analyzer exited before request ${id} completed`))
      }
      this.pendingRequests.clear()
    })
  }

  static async start(
    rootDir: string,
    executable: { command: string; args: string[] },
  ) {
    const client = new RustAnalyzerLspClient(rootDir, executable)

    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(rootDir).toString(),
      capabilities: {
        textDocument: {
          callHierarchy: {
            dynamicRegistration: false,
          },
        },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(rootDir).toString(),
          name: rootDir.split('/').filter(Boolean).at(-1) ?? rootDir,
        },
      ],
    })

    client.notify('initialized', {})
    return client
  }

  async prepareCallHierarchy(uri: string, position: LspPosition) {
    const result = await this.request('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position,
    })

    return (result as CallHierarchyItem[] | null) ?? []
  }

  async outgoingCalls(item: CallHierarchyItem) {
    const result = await this.request('callHierarchy/outgoingCalls', {
      item,
    })

    return (result as CallHierarchyOutgoingCall[] | null) ?? []
  }

  async dispose() {
    try {
      await this.request('shutdown', null)
    } catch {
      // Ignore shutdown failures during cleanup.
    }

    try {
      this.notify('exit', null)
    } finally {
      this.process.kill()
    }
  }

  private request(method: string, params: unknown) {
    const id = this.nextRequestId++
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`rust-analyzer request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
      })
      this.writeMessage(payload)
    })
  }

  private notify(method: string, params: unknown) {
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  private writeMessage(payload: unknown) {
    const json = JSON.stringify(payload)
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`)
  }

  private readMessages() {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')

      if (headerEnd === -1) {
        return
      }

      const header = this.buffer.slice(0, headerEnd)
      const contentLengthMatch = header.match(/Content-Length: (\d+)/i)

      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = Number(contentLengthMatch[1])
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength

      if (this.buffer.length < messageEnd) {
        return
      }

      const messageText = this.buffer.slice(messageStart, messageEnd)
      this.buffer = this.buffer.slice(messageEnd)

      try {
        const message = JSON.parse(messageText) as {
          id?: number
          result?: unknown
          error?: { message?: string }
        }

        if (typeof message.id !== 'number') {
          continue
        }

        const pendingRequest = this.pendingRequests.get(message.id)

        if (!pendingRequest) {
          continue
        }

        clearTimeout(pendingRequest.timer)
        this.pendingRequests.delete(message.id)

        if (message.error) {
          pendingRequest.reject(
            new Error(
              message.error.message ??
                `rust-analyzer request failed${this.stderrChunks.length ? `: ${this.stderrChunks.join('')}` : ''}`,
            ),
          )
          continue
        }

        pendingRequest.resolve(message.result)
      } catch {
        continue
      }
    }
  }
}

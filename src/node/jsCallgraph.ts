import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import ts from 'typescript'

import type { GraphEdge, ProjectSnapshot, SourceRange, SymbolNode } from '../types'

import {
  getSymbolByRange,
  getSymbolsForFile,
  registerSymbolNodes,
  type SymbolIndex,
} from './symbolIndex'

const require = createRequire(import.meta.url)

type JsCallgraphModule = {
  setArgs: (args: Record<string, unknown>) => void
  setFiles: (files: string[]) => void
  setConsoleOutput: (enabled: boolean) => void
  build: () => JsCallgraphEdge[] | undefined
}

interface JsCallgraphEndpoint {
  label: string
  file: string
  start: {
    row: number | null
    column: number | null
  }
  end: {
    row: number | null
    column: number | null
  }
}

interface JsCallgraphEdge {
  source: JsCallgraphEndpoint
  target: JsCallgraphEndpoint
}

export async function buildJsCallGraph(
  snapshot: ProjectSnapshot,
  symbolIndex: SymbolIndex,
) {
  const callgraph = loadCallgraphModule()
  const supportedFiles = Object.values(snapshot.nodes)
    .filter((node): node is Extract<typeof node, { kind: 'file' }> => node.kind === 'file')
    .filter((fileNode) =>
      ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(fileNode.extension),
    )
    .filter((fileNode) => !isDeclarationFile(fileNode.path))
    .filter(
      (fileNode) =>
        !fileNode.tags.includes('config') &&
        !fileNode.tags.includes('asset') &&
        !fileNode.tags.includes('generated'),
    )
    .filter((fileNode) => fileNode.content)

  if (supportedFiles.length === 0) {
    return {
      symbolNodes: {},
      edges: [],
    }
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'semanticode-callgraph-'))

  try {
    const compiledFileMap = await createCompiledWorkspace(tempRoot, supportedFiles)

    const result = runCallgraph(callgraph, [...compiledFileMap.keys()])
    const symbolNodes: Record<string, SymbolNode> = {}
    const edges: GraphEdge[] = []

    for (const [index, edge] of result.entries()) {
      const sourceSymbol = ensureSymbolNode(
        edge.source,
        snapshot,
        symbolIndex,
        compiledFileMap,
      )
      const targetSymbol = ensureSymbolNode(
        edge.target,
        snapshot,
        symbolIndex,
        compiledFileMap,
      )

      if (!sourceSymbol || !targetSymbol) {
        continue
      }

      symbolNodes[sourceSymbol.id] = sourceSymbol
      symbolNodes[targetSymbol.id] = targetSymbol

      edges.push({
        id: `calls:${sourceSymbol.id}->${targetSymbol.id}:${index}`,
        kind: 'calls',
        source: sourceSymbol.id,
        target: targetSymbol.id,
        inferred: true,
        metadata: {
          analyzer: 'js-callgraph',
        },
      })
    }

    registerSymbolNodes(Object.values(symbolNodes), symbolIndex)

    return {
      symbolNodes,
      edges,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function ensureSymbolNode(
  endpoint: JsCallgraphEndpoint,
  snapshot: ProjectSnapshot,
  symbolIndex: SymbolIndex,
  compiledFileMap: Map<string, string>,
) {
  if (endpoint.file === 'Native') {
    return null
  }

  const compiledFilePath = normalizePath(resolve(endpoint.file))
  const fileId = compiledFileMap.get(compiledFilePath)

  if (!fileId) {
    return null
  }

  const fileNode = snapshot.nodes[fileId]

  if (!fileNode || fileNode.kind !== 'file') {
    return null
  }

  const range = toSourceRange(endpoint)
  const existingSymbol =
    getSymbolByRange(symbolIndex, fileNode.id, range) ??
    getSymbolByName(symbolIndex, fileNode.id, endpoint.label)

  if (existingSymbol) {
    return existingSymbol
  }

  const row = endpoint.start.row ?? 0
  const column = endpoint.start.column ?? 0
  const rangeId = range
    ? `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`
    : 'unknown'

  const symbolNode: SymbolNode = {
    id: `symbol:${fileNode.id}:${endpoint.label}:${rangeId}`,
    kind: 'symbol',
    name: endpoint.label,
    path: `${fileNode.path}#${endpoint.label}@${row}:${column}`,
    tags: [],
    fileId: fileNode.id,
    parentSymbolId: null,
    symbolKind: endpoint.label === 'global' ? 'module' : 'unknown',
    signature: endpoint.label,
    range,
  }

  return symbolNode
}

function toSourceRange(endpoint: JsCallgraphEndpoint): SourceRange | undefined {
  if (
    endpoint.start.row == null ||
    endpoint.start.column == null ||
    endpoint.end.row == null ||
    endpoint.end.column == null
  ) {
    return undefined
  }

  return {
    start: {
      line: endpoint.start.row,
      column: endpoint.start.column,
    },
    end: {
      line: endpoint.end.row,
      column: endpoint.end.column,
    },
  }
}

function getSymbolByName(
  symbolIndex: SymbolIndex,
  fileId: string,
  label: string,
) {
  if (!label || label === 'global' || label === 'anon') {
    return null
  }

  const matchingSymbols = getSymbolsForFile(symbolIndex, fileId).filter(
    (symbolNode) =>
      symbolNode.name === label &&
      symbolNode.symbolKind !== 'unknown' &&
      symbolNode.symbolKind !== 'module',
  )

  if (matchingSymbols.length === 0) {
    return null
  }

  if (matchingSymbols.length === 1) {
    return matchingSymbols[0]
  }

  return [...matchingSymbols].sort((left, right) => {
    const leftParentDepth = countParentDepth(left, symbolIndex)
    const rightParentDepth = countParentDepth(right, symbolIndex)

    if (leftParentDepth !== rightParentDepth) {
      return leftParentDepth - rightParentDepth
    }

    const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
    const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

    if (leftLine !== rightLine) {
      return leftLine - rightLine
    }

    return left.id.localeCompare(right.id)
  })[0]
}

function countParentDepth(symbolNode: SymbolNode, symbolIndex: SymbolIndex) {
  let depth = 0
  let currentParentId = symbolNode.parentSymbolId

  while (currentParentId) {
    depth += 1
    currentParentId = symbolIndex.byId[currentParentId]?.parentSymbolId ?? null
  }

  return depth
}

function loadCallgraphModule(): JsCallgraphModule {
  return require('@persper/js-callgraph') as JsCallgraphModule
}

async function createCompiledWorkspace(
  tempRoot: string,
  fileNodes: Array<Extract<ProjectSnapshot['nodes'][string], { kind: 'file' }>>,
) {
  const compiledFileMap = new Map<string, string>()

  for (const fileNode of fileNodes) {
    if (!fileNode.content) {
      continue
    }

    const outputRelativePath = replaceExtensionWithJs(fileNode.path)
    const outputPath = join(tempRoot, outputRelativePath)
    const transpiledContent = transpileForCallgraph(fileNode.path, fileNode.content)

    if (transpiledContent == null) {
      continue
    }

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, transpiledContent, 'utf8')
    compiledFileMap.set(normalizePath(resolve(outputPath)), fileNode.id)
  }

  return compiledFileMap
}

function transpileForCallgraph(path: string, source: string) {
  try {
    const result = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        allowJs: true,
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      reportDiagnostics: false,
    })

    return result.outputText
  } catch (error) {
    console.warn(
      `[semanticode] Skipping JS/TS callgraph transpile for "${path}".`,
      error,
    )
    return null
  }
}

function replaceExtensionWithJs(pathValue: string) {
  return pathValue.replace(/\.[^.]+$/, '.js')
}

function isDeclarationFile(pathValue: string) {
  return /\.[dD]\.[cm]?[jt]sx?$/.test(pathValue)
}

function runCallgraph(callgraph: JsCallgraphModule, files: string[]) {
  const originalLog = console.log
  const originalWarn = console.warn

  try {
    console.log = () => {}
    console.warn = () => {}
    callgraph.setArgs({
      cg: true,
      strategy: 'ONESHOT',
      output: null,
    })
    callgraph.setFiles(files)
    callgraph.setConsoleOutput(false)
    return callgraph.build() ?? []
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
}

function normalizePath(pathValue: string) {
  return pathValue.split('\\').join('/')
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import ts from 'typescript'

import type { GraphEdge, ProjectSnapshot, SourceRange, SymbolNode } from '../types'

import {
  getSymbolByRange,
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

  const tempRoot = await mkdtemp(join(tmpdir(), 'codebase-visualizer-callgraph-'))

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
  const existingSymbol = getSymbolByRange(symbolIndex, fileNode.id, range)

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

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, transpiledContent, 'utf8')
    compiledFileMap.set(normalizePath(resolve(outputPath)), fileNode.id)
  }

  return compiledFileMap
}

function transpileForCallgraph(path: string, source: string) {
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES5,
    },
    reportDiagnostics: false,
  })

  return result.outputText
}

function replaceExtensionWithJs(pathValue: string) {
  return pathValue.replace(/\.[^.]+$/, '.js')
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

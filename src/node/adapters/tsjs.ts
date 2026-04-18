import { dirname, extname, resolve } from 'node:path'

import ts from 'typescript'

import type {
  LanguageAdapter,
  LanguageAdapterInput,
  LanguageAdapterResult,
} from '../../schema/analysis'
import type { AnalysisFact } from '../../schema/projectPlugin'
import type {
  FileNode,
  GraphEdge,
  ProjectSnapshot,
  SourceRange,
  SymbolKind,
  SymbolNode,
} from '../../schema/snapshot'

import { buildJsCallGraph } from '../jsCallgraph'
import { createEmptySymbolIndex, registerSymbolNodes } from '../symbolIndex'

const IMPORTABLE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
])

const ENTRYPOINT_BASENAMES = new Set([
  'main.ts',
  'main.tsx',
  'main.js',
  'main.jsx',
  'index.tsx',
  'index.jsx',
  'server.ts',
  'server.js',
])

interface MutableSnapshotContext {
  edges: GraphEdge[]
  nodes: ProjectSnapshot['nodes']
}

interface ExtractedSymbolContext {
  astNode:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.MethodDeclaration
    | ts.VariableDeclaration
  symbolNode: SymbolNode
}

export function createTsJsLanguageAdapter(): LanguageAdapter {
  return {
    id: 'ts-js',
    displayName: 'TypeScript / JavaScript',
    supports: {
      symbols: true,
      imports: true,
      calls: true,
    },
    matches(fileNode) {
      return IMPORTABLE_EXTENSIONS.has(extname(fileNode.path).toLowerCase())
    },
    async analyze({
      snapshot,
      fileNodes,
      options,
    }: LanguageAdapterInput): Promise<LanguageAdapterResult> {
      const context: MutableSnapshotContext = {
        edges: [],
        nodes: { ...snapshot.nodes },
      }

      for (const fileNode of fileNodes) {
        context.nodes[fileNode.id] = {
          ...fileNode,
          language: getFileLanguage(fileNode.path),
        }
      }

      const symbolIndex =
        options.analyzeSymbols === false
          ? createEmptySymbolIndex()
          : extractSymbols(fileNodes, context)
      const facts = extractAnalysisFacts(fileNodes, context.nodes)
      const entryFileIds = detectEntrypoints(fileNodes, context.nodes)

      if (options.analyzeImports !== false) {
        context.edges.push(...extractImportEdges(snapshot, fileNodes))
      }

      const analysisSnapshot: ProjectSnapshot = {
        ...snapshot,
        entryFileIds,
        nodes: context.nodes,
        edges: [...snapshot.edges, ...context.edges],
      }

      if (options.analyzeCalls) {
        const callGraph = await buildJsCallGraph(analysisSnapshot, symbolIndex)
        context.edges.push(...callGraph.edges)

        for (const symbolNode of Object.values(callGraph.symbolNodes)) {
          context.nodes[symbolNode.id] = symbolNode
        }
      }

      return {
        nodes: context.nodes,
        edges: dedupeEdges(context.edges),
        entryFileIds,
        facts,
      }
    },
  }
}

function detectEntrypoints(
  fileNodes: FileNode[],
  nodes: ProjectSnapshot['nodes'],
) {
  const entryFileIds = fileNodes
    .filter((fileNode) => {
      if (ENTRYPOINT_BASENAMES.has(fileNode.name)) {
        return true
      }

      return fileNode.path.startsWith('src/') && ENTRYPOINT_BASENAMES.has(fileNode.name)
    })
    .map((fileNode) => fileNode.id)

  for (const fileId of entryFileIds) {
    const node = nodes[fileId]

    if (!node || node.kind !== 'file') {
      continue
    }

    nodes[fileId] = {
      ...node,
      tags: Array.from(new Set([...node.tags, 'entrypoint'])),
    }
  }

  return entryFileIds
}

function extractImportEdges(
  snapshot: ProjectSnapshot,
  fileNodes: FileNode[],
) {
  const fileIdByAbsolutePath = new Map<string, string>()

  for (const fileNode of fileNodes) {
    fileIdByAbsolutePath.set(resolve(snapshot.rootDir, fileNode.path), fileNode.id)
  }

  const edges: GraphEdge[] = []

  for (const fileNode of fileNodes) {
    if (!fileNode.content) {
      continue
    }

    const sourceFile = ts.createSourceFile(
      fileNode.path,
      fileNode.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(fileNode.path),
    )

    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      const targetFileId = resolveImportTarget(
        fileNode,
        specifier,
        snapshot,
        fileIdByAbsolutePath,
      )

      if (!targetFileId) {
        continue
      }

      edges.push({
        id: `imports:${fileNode.id}->${targetFileId}:${specifier}`,
        kind: 'imports',
        source: fileNode.id,
        target: targetFileId,
        label: specifier,
      })
    }
  }

  return dedupeEdges(edges)
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers: string[] = []

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier

      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text)
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return specifiers
}

function resolveImportTarget(
  sourceFile: FileNode,
  specifier: string,
  snapshot: ProjectSnapshot,
  fileIdByAbsolutePath: Map<string, string>,
) {
  if (!specifier.startsWith('.')) {
    return null
  }

  const absoluteSpecifier = resolve(
    snapshot.rootDir,
    dirname(sourceFile.path),
    specifier,
  )

  for (const candidate of buildImportCandidates(absoluteSpecifier)) {
    const fileId = fileIdByAbsolutePath.get(candidate)

    if (fileId) {
      return fileId
    }
  }

  return null
}

function buildImportCandidates(absoluteSpecifier: string) {
  const candidates = [absoluteSpecifier]

  if (extname(absoluteSpecifier)) {
    return candidates
  }

  for (const extension of IMPORTABLE_EXTENSIONS) {
    candidates.push(`${absoluteSpecifier}${extension}`)
    candidates.push(resolve(absoluteSpecifier, `index${extension}`))
  }

  return candidates
}

function extractSymbols(fileNodes: FileNode[], context: MutableSnapshotContext) {
  const symbolIndex = createEmptySymbolIndex()

  for (const fileNode of fileNodes) {
    if (!fileNode.content) {
      continue
    }

    const sourceFile = ts.createSourceFile(
      fileNode.path,
      fileNode.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(fileNode.path),
    )

    const fileSymbols: SymbolNode[] = []

    collectSymbolsFromNode(
      sourceFile,
      sourceFile,
      fileNode,
      fileSymbols,
      context,
      null,
    )

    if (fileSymbols.length > 0) {
      registerSymbolNodes(fileSymbols, symbolIndex)
    }
  }

  return symbolIndex
}

function extractAnalysisFacts(
  fileNodes: FileNode[],
  nodes: ProjectSnapshot['nodes'],
) {
  const facts: AnalysisFact[] = []

  for (const fileNode of fileNodes) {
    if (!fileNode.content) {
      continue
    }

    const sourceFile = ts.createSourceFile(
      fileNode.path,
      fileNode.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(fileNode.path),
    )
    const fileSymbolContexts = collectExtractedSymbolContexts(fileNode, sourceFile, nodes)
    let fileContainsJsx = false

    for (const statement of sourceFile.statements) {
      if (
        ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) &&
        statement.expression.text === 'use client'
      ) {
        facts.push(createFact(fileNode.path, 'file_directive', fileNode.id, {
          value: statement.expression.text,
        }))
      }
    }

    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      const packageName = normalizePackageName(specifier)

      if (!packageName) {
        continue
      }

      facts.push(createFact(fileNode.path, 'imports_package', fileNode.id, { packageName }))
    }

    function visit(node: ts.Node) {
      if (
        ts.isJsxElement(node) ||
        ts.isJsxFragment(node) ||
        ts.isJsxSelfClosingElement(node)
      ) {
        fileContainsJsx = true
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    if (fileContainsJsx) {
      facts.push(createFact(fileNode.path, 'contains_jsx', fileNode.id))
    }

    for (const symbolContext of fileSymbolContexts) {
      if (isExportedSymbolDeclaration(symbolContext.astNode)) {
        facts.push(createFact(fileNode.path, 'symbol_exported', symbolContext.symbolNode.id))
      }

      if (symbolReturnsJsx(symbolContext.astNode)) {
        facts.push(createFact(fileNode.path, 'symbol_returns_jsx', symbolContext.symbolNode.id))
      }

      for (const hookName of collectCalledHooks(symbolContext.astNode)) {
        facts.push(createFact(fileNode.path, 'symbol_calls_hook', symbolContext.symbolNode.id, {
          hookName,
        }))
      }
    }
  }

  return dedupeFacts(facts)
}

function collectExtractedSymbolContexts(
  fileNode: FileNode,
  sourceFile: ts.SourceFile,
  nodes: ProjectSnapshot['nodes'],
) {
  const result: ExtractedSymbolContext[] = []

  function visit(node: ts.Node) {
    const symbolMetadata = getSymbolMetadata(node, sourceFile)

    if (symbolMetadata) {
      const symbolNodeId = createSymbolNode(
        fileNode,
        symbolMetadata.name,
        symbolMetadata.kind,
        symbolMetadata.range,
        null,
      ).id
      const symbolNode = nodes[symbolNodeId]

      if (symbolNode && symbolNode.kind === 'symbol') {
        result.push({
          astNode: node as ExtractedSymbolContext['astNode'],
          symbolNode,
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return result
}

function collectSymbolsFromNode(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  fileNode: FileNode,
  fileSymbols: SymbolNode[],
  context: MutableSnapshotContext,
  parentSymbolId: string | null,
) {
  const symbolMetadata = getSymbolMetadata(node, sourceFile)
  let currentParentSymbolId = parentSymbolId

  if (symbolMetadata) {
    const symbolNode = createSymbolNode(
      fileNode,
      symbolMetadata.name,
      symbolMetadata.kind,
      symbolMetadata.range,
      parentSymbolId,
    )

    fileSymbols.push(symbolNode)
    context.nodes[symbolNode.id] = symbolNode
    context.edges.push({
      id: `contains:${parentSymbolId ?? fileNode.id}->${symbolNode.id}`,
      kind: 'contains',
      source: parentSymbolId ?? fileNode.id,
      target: symbolNode.id,
    })
    currentParentSymbolId = symbolNode.id
  }

  ts.forEachChild(node, (child) => {
    collectSymbolsFromNode(
      child,
      sourceFile,
      fileNode,
      fileSymbols,
      context,
      currentParentSymbolId,
    )
  })
}

function getSymbolMetadata(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { name: string; kind: SymbolKind; range: SourceRange } | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      kind: 'function',
      range: getSourceRange(node, sourceFile),
    }
  }

  if (ts.isClassDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      kind: 'class',
      range: getSourceRange(node, sourceFile),
    }
  }

  if (
    ts.isMethodDeclaration(node) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return {
      name: node.name.text,
      kind: 'method',
      range: getSourceRange(node, sourceFile),
    }
  }

  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return {
      name: node.name.text,
      kind: 'function',
      range: getSourceRange(node, sourceFile),
    }
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return {
      name: node.name.text,
      kind: isConstDeclaration(node) ? 'constant' : 'variable',
      range: getSourceRange(node, sourceFile),
    }
  }

  return null
}

function createSymbolNode(
  fileNode: FileNode,
  name: string,
  kind: SymbolKind,
  range: SourceRange,
  parentSymbolId: string | null,
): SymbolNode {
  const rangeId = `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`

  return {
    id: `symbol:${fileNode.id}:${name}:${rangeId}`,
    kind: 'symbol',
    name,
    path: `${fileNode.path}#${name}@${range.start.line}:${range.start.column}`,
    tags: [],
    facets: [],
    fileId: fileNode.id,
    parentSymbolId,
    language: getFileLanguage(fileNode.path),
    symbolKind: kind,
    nativeSymbolKind: kind,
    visibility: 'unknown',
    signature: name,
    range,
  }
}

function getSourceRange(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd())

  return {
    start: {
      line: start.line + 1,
      column: start.character,
    },
    end: {
      line: end.line + 1,
      column: end.character,
    },
  }
}

function isConstDeclaration(node: ts.VariableDeclaration) {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  )
}

function getScriptKind(path: string) {
  if (path.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }

  if (path.endsWith('.ts')) {
    return ts.ScriptKind.TS
  }

  if (path.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }

  return ts.ScriptKind.JS
}

function getFileLanguage(path: string) {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) {
    return 'typescript'
  }

  return 'javascript'
}

function normalizePackageName(specifier: string) {
  if (specifier.startsWith('.')) {
    return null
  }

  if (specifier.startsWith('@')) {
    const scopedSegments = specifier.split('/')
    return scopedSegments.slice(0, 2).join('/')
  }

  return specifier.split('/')[0] ?? null
}

function createFact(
  path: string,
  kind: string,
  subjectId: string,
  data?: AnalysisFact['data'],
): AnalysisFact {
  return {
    id: `${kind}:${subjectId}:${JSON.stringify(data ?? {})}`,
    namespace: 'ts-js',
    kind,
    subjectId,
    path,
    data,
  }
}

function dedupeFacts(facts: AnalysisFact[]) {
  const uniqueFacts = new Map(facts.map((fact) => [fact.id, fact]))
  return [...uniqueFacts.values()]
}

function isExportedSymbolDeclaration(node: ts.Node) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined

  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return true
  }

  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent
    const variableStatement = declarationList.parent
    const variableModifiers =
      ts.isVariableStatement(variableStatement) ? ts.getModifiers(variableStatement) : undefined

    return Boolean(
      variableModifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    )
  }

  return false
}

function symbolReturnsJsx(
  node:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.MethodDeclaration
    | ts.VariableDeclaration,
) {
  if (ts.isClassDeclaration(node)) {
    return false
  }

  const functionLike =
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ? node.initializer
      : node

  if (
    ts.isArrowFunction(functionLike) &&
    !ts.isBlock(functionLike.body) &&
    (
      ts.isJsxElement(functionLike.body) ||
      ts.isJsxFragment(functionLike.body) ||
      ts.isJsxSelfClosingElement(functionLike.body)
    )
  ) {
    return true
  }

  let returnsJsx = false

  function visit(child: ts.Node) {
    if (
      ts.isReturnStatement(child) &&
      child.expression &&
      (
        ts.isJsxElement(child.expression) ||
        ts.isJsxFragment(child.expression) ||
        ts.isJsxSelfClosingElement(child.expression)
      )
    ) {
      returnsJsx = true
      return
    }

    if (!returnsJsx) {
      ts.forEachChild(child, visit)
    }
  }

  ts.forEachChild(functionLike, visit)

  return returnsJsx
}

function collectCalledHooks(
  node:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.MethodDeclaration
    | ts.VariableDeclaration,
) {
  const hookNames = new Set<string>()

  function visit(child: ts.Node) {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      /^use[A-Z0-9]/.test(child.expression.text)
    ) {
      hookNames.add(child.expression.text)
    }

    ts.forEachChild(child, visit)
  }

  ts.forEachChild(node, visit)

  return [...hookNames]
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map<string, GraphEdge>()

  for (const edge of edges) {
    uniqueEdges.set(edge.id, edge)
  }

  return [...uniqueEdges.values()]
}

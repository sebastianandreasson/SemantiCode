import { basename, dirname, extname, resolve } from 'node:path'

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

interface ImportBinding {
  kind: 'default' | 'named' | 'namespace'
  localName: string
  importedName: string | null
  targetFileId: string
}

interface AstCallResolutionContext {
  importBindingsByFile: Map<string, Map<string, ImportBinding>>
  symbolsByFile: Map<string, SymbolNode[]>
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
        const astCallEdges = extractAstCallEdges(snapshot, fileNodes, context.nodes)
        context.edges.push(...astCallEdges)

        const callGraph = await buildJsCallGraph(analysisSnapshot, symbolIndex)
        const astCallRelations = new Set(
          astCallEdges.map((edge) => `${edge.source}->${edge.target}`),
        )
        context.edges.push(
          ...callGraph.edges.filter(
            (edge) => !astCallRelations.has(`${edge.source}->${edge.target}`),
          ),
        )

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

function extractAstCallEdges(
  snapshot: ProjectSnapshot,
  fileNodes: FileNode[],
  nodes: ProjectSnapshot['nodes'],
) {
  const fileIdByAbsolutePath = new Map<string, string>()

  for (const fileNode of fileNodes) {
    fileIdByAbsolutePath.set(resolve(snapshot.rootDir, fileNode.path), fileNode.id)
  }

  const resolutionContext: AstCallResolutionContext = {
    importBindingsByFile: collectImportBindings(
      snapshot,
      fileNodes,
      fileIdByAbsolutePath,
    ),
    symbolsByFile: collectSymbolsByFile(nodes),
  }
  const edgesById = new Map<string, GraphEdge>()

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
    const symbolContexts = collectExtractedSymbolContexts(fileNode, sourceFile, nodes)

    for (const symbolContext of symbolContexts) {
      const traversalRoot = getCallTraversalRoot(symbolContext.astNode)

      if (!traversalRoot) {
        continue
      }

      collectAstCallsFromSymbol({
        edgesById,
        fileNode,
        resolutionContext,
        sourceFile,
        sourceSymbol: symbolContext.symbolNode,
        traversalRoot,
      })
    }
  }

  return [...edgesById.values()]
}

function collectImportBindings(
  snapshot: ProjectSnapshot,
  fileNodes: FileNode[],
  fileIdByAbsolutePath: Map<string, string>,
) {
  const bindingsByFile = new Map<string, Map<string, ImportBinding>>()

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
    const fileBindings = new Map<string, ImportBinding>()

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier

        if (!ts.isStringLiteral(moduleSpecifier)) {
          continue
        }

        const targetFileId = resolveImportTarget(
          fileNode,
          moduleSpecifier.text,
          snapshot,
          fileIdByAbsolutePath,
        )

        if (!targetFileId || !statement.importClause) {
          continue
        }

        const importClause = statement.importClause

        if (importClause.name) {
          fileBindings.set(importClause.name.text, {
            kind: 'default',
            localName: importClause.name.text,
            importedName: null,
            targetFileId,
          })
        }

        if (importClause.namedBindings) {
          if (ts.isNamespaceImport(importClause.namedBindings)) {
            fileBindings.set(importClause.namedBindings.name.text, {
              kind: 'namespace',
              localName: importClause.namedBindings.name.text,
              importedName: null,
              targetFileId,
            })
          } else {
            for (const importSpecifier of importClause.namedBindings.elements) {
              fileBindings.set(importSpecifier.name.text, {
                kind: 'named',
                localName: importSpecifier.name.text,
                importedName:
                  importSpecifier.propertyName?.text ?? importSpecifier.name.text,
                targetFileId,
              })
            }
          }
        }
      }

      for (const binding of collectRequireBindings(statement, fileNode, snapshot, fileIdByAbsolutePath)) {
        fileBindings.set(binding.localName, binding)
      }
    }

    bindingsByFile.set(fileNode.id, fileBindings)
  }

  return bindingsByFile
}

function collectRequireBindings(
  statement: ts.Statement,
  fileNode: FileNode,
  snapshot: ProjectSnapshot,
  fileIdByAbsolutePath: Map<string, string>,
) {
  if (!ts.isVariableStatement(statement)) {
    return []
  }

  const bindings: ImportBinding[] = []

  for (const declaration of statement.declarationList.declarations) {
    if (
      !declaration.initializer ||
      !ts.isCallExpression(declaration.initializer) ||
      !ts.isIdentifier(declaration.initializer.expression) ||
      declaration.initializer.expression.text !== 'require' ||
      declaration.initializer.arguments.length !== 1 ||
      !ts.isStringLiteral(declaration.initializer.arguments[0])
    ) {
      continue
    }

    const targetFileId = resolveImportTarget(
      fileNode,
      declaration.initializer.arguments[0].text,
      snapshot,
      fileIdByAbsolutePath,
    )

    if (!targetFileId) {
      continue
    }

    if (ts.isIdentifier(declaration.name)) {
      bindings.push({
        kind: 'namespace',
        localName: declaration.name.text,
        importedName: null,
        targetFileId,
      })
      continue
    }

    if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) {
          continue
        }

        const importedName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text

        bindings.push({
          kind: 'named',
          localName: element.name.text,
          importedName,
          targetFileId,
        })
      }
    }
  }

  return bindings
}

function collectSymbolsByFile(nodes: ProjectSnapshot['nodes']) {
  const symbolsByFile = new Map<string, SymbolNode[]>()

  for (const node of Object.values(nodes)) {
    if (node.kind !== 'symbol') {
      continue
    }

    const fileSymbols = symbolsByFile.get(node.fileId) ?? []
    fileSymbols.push(node)
    symbolsByFile.set(node.fileId, fileSymbols)
  }

  for (const fileSymbols of symbolsByFile.values()) {
    fileSymbols.sort((left, right) => {
      const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
      const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

      if (leftLine !== rightLine) {
        return leftLine - rightLine
      }

      return left.id.localeCompare(right.id)
    })
  }

  return symbolsByFile
}

function collectAstCallsFromSymbol(input: {
  edgesById: Map<string, GraphEdge>
  fileNode: FileNode
  resolutionContext: AstCallResolutionContext
  sourceFile: ts.SourceFile
  sourceSymbol: SymbolNode
  traversalRoot: ts.Node
}) {
  const {
    edgesById,
    fileNode,
    resolutionContext,
    sourceFile,
    sourceSymbol,
    traversalRoot,
  } = input

  function addTargets(targets: SymbolNode[], callSiteNode: ts.Node, calleeName: string) {
    for (const targetSymbol of targets) {
      const range = getSourceRange(callSiteNode, sourceFile)
      const id = [
        'calls',
        sourceSymbol.id,
        targetSymbol.id,
        'ts-js-ast',
        `${range.start.line}:${range.start.column}`,
      ].join(':')

      if (edgesById.has(id)) {
        continue
      }

      edgesById.set(id, {
        id,
        kind: 'calls',
        source: sourceSymbol.id,
        target: targetSymbol.id,
        inferred: true,
        metadata: {
          analyzer: 'ts-js-ast',
          callee: calleeName,
          line: range.start.line,
          column: range.start.column,
        },
      })
    }
  }

  function visit(node: ts.Node) {
    if (node !== traversalRoot && isNestedCallableSymbolBoundary(node)) {
      return
    }

    if (ts.isCallExpression(node)) {
      const target = resolveCallExpressionTarget(
        node.expression,
        fileNode.id,
        sourceSymbol,
        resolutionContext,
      )

      if (target.symbols.length > 0) {
        addTargets(target.symbols, node, target.calleeName)
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const target = resolveJsxTagTarget(
        node.tagName,
        fileNode.id,
        sourceSymbol,
        resolutionContext,
      )

      if (target.symbols.length > 0) {
        addTargets(target.symbols, node, target.calleeName)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(traversalRoot)
}

function getCallTraversalRoot(
  node:
    | ts.FunctionDeclaration
    | ts.ClassDeclaration
    | ts.MethodDeclaration
    | ts.VariableDeclaration,
) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.body ?? null
  }

  if (ts.isClassDeclaration(node)) {
    return null
  }

  const functionLike = getVariableDeclarationFunctionLike(node)

  if (functionLike) {
    return functionLike.body
  }

  return node.initializer ?? null
}

function resolveCallExpressionTarget(
  expression: ts.Expression,
  sourceFileId: string,
  sourceSymbol: SymbolNode,
  context: AstCallResolutionContext,
) {
  const unwrappedExpression = unwrapExpression(expression)

  if (ts.isIdentifier(unwrappedExpression)) {
    return {
      calleeName: unwrappedExpression.text,
      symbols: resolveIdentifierTarget(
        sourceFileId,
        unwrappedExpression.text,
        sourceSymbol,
        context,
      ),
    }
  }

  if (ts.isPropertyAccessExpression(unwrappedExpression)) {
    const propertyName = unwrappedExpression.name.text

    if (
      unwrappedExpression.expression.kind === ts.SyntaxKind.ThisKeyword ||
      unwrappedExpression.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      return {
        calleeName: propertyName,
        symbols: resolveSiblingMemberTarget(sourceSymbol, propertyName, context),
      }
    }

    if (ts.isIdentifier(unwrappedExpression.expression)) {
      const namespaceBinding = context.importBindingsByFile
        .get(sourceFileId)
        ?.get(unwrappedExpression.expression.text)

      if (namespaceBinding?.kind === 'namespace') {
        return {
          calleeName: propertyName,
          symbols: resolveImportBinding(namespaceBinding, context, propertyName),
        }
      }
    }
  }

  return {
    calleeName: getExpressionText(unwrappedExpression),
    symbols: [],
  }
}

function resolveJsxTagTarget(
  tagName: ts.JsxTagNameExpression,
  sourceFileId: string,
  sourceSymbol: SymbolNode,
  context: AstCallResolutionContext,
) {
  if (ts.isIdentifier(tagName)) {
    if (!isComponentLikeName(tagName.text)) {
      return {
        calleeName: tagName.text,
        symbols: [],
      }
    }

    return {
      calleeName: tagName.text,
      symbols: resolveIdentifierTarget(sourceFileId, tagName.text, sourceSymbol, context),
    }
  }

  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.expression)) {
    const namespaceBinding = context.importBindingsByFile
      .get(sourceFileId)
      ?.get(tagName.expression.text)

    if (namespaceBinding?.kind === 'namespace') {
      return {
        calleeName: tagName.name.text,
        symbols: resolveImportBinding(namespaceBinding, context, tagName.name.text),
      }
    }
  }

  return {
    calleeName: getExpressionText(tagName),
    symbols: [],
  }
}

function resolveIdentifierTarget(
  sourceFileId: string,
  name: string,
  sourceSymbol: SymbolNode,
  context: AstCallResolutionContext,
) {
  const importBinding = context.importBindingsByFile.get(sourceFileId)?.get(name)

  if (importBinding) {
    return resolveImportBinding(importBinding, context)
  }

  return chooseLocalSymbolsByName(
    context.symbolsByFile.get(sourceFileId) ?? [],
    name,
    sourceSymbol,
  )
}

function resolveImportBinding(
  binding: ImportBinding,
  context: AstCallResolutionContext,
  namespaceMemberName?: string,
) {
  const targetName = namespaceMemberName ?? binding.importedName
  const targetSymbols = context.symbolsByFile.get(binding.targetFileId) ?? []

  if (targetName) {
    return chooseImportedSymbolsByName(targetSymbols, targetName)
  }

  const byLocalName = chooseImportedSymbolsByName(targetSymbols, binding.localName)

  if (byLocalName.length > 0) {
    return byLocalName
  }

  const byFileBasename = chooseImportedSymbolsByName(
    targetSymbols,
    getImportDefaultBasename(binding.targetFileId),
  )

  if (byFileBasename.length > 0) {
    return byFileBasename
  }

  const topLevelCallableSymbols = targetSymbols.filter(
    (symbolNode) => !symbolNode.parentSymbolId && isCallableSymbol(symbolNode),
  )

  return topLevelCallableSymbols.length === 1 ? topLevelCallableSymbols : []
}

function chooseLocalSymbolsByName(
  symbols: SymbolNode[],
  name: string,
  sourceSymbol: SymbolNode,
) {
  const candidates = symbols.filter(
    (symbolNode) => symbolNode.name === name && isCallableSymbol(symbolNode),
  )

  if (candidates.length <= 1) {
    return candidates
  }

  return [sortCallTargetCandidates(candidates, sourceSymbol)[0]]
}

function chooseImportedSymbolsByName(symbols: SymbolNode[], name: string) {
  const candidates = symbols.filter(
    (symbolNode) => symbolNode.name === name && isCallableSymbol(symbolNode),
  )

  if (candidates.length <= 1) {
    return candidates
  }

  const topLevelCandidates = candidates.filter((symbolNode) => !symbolNode.parentSymbolId)

  return topLevelCandidates.length > 0 ? [topLevelCandidates[0]] : [candidates[0]]
}

function resolveSiblingMemberTarget(
  sourceSymbol: SymbolNode,
  memberName: string,
  context: AstCallResolutionContext,
) {
  const sourceParent = sourceSymbol.parentSymbolId

  if (!sourceParent) {
    return []
  }

  return (context.symbolsByFile.get(sourceSymbol.fileId) ?? []).filter(
    (symbolNode) =>
      symbolNode.parentSymbolId === sourceParent &&
      symbolNode.name === memberName &&
      isCallableSymbol(symbolNode),
  )
}

function sortCallTargetCandidates(
  candidates: SymbolNode[],
  sourceSymbol: SymbolNode,
) {
  return [...candidates].sort((left, right) => {
    const leftRank = getCallTargetRank(left, sourceSymbol)
    const rightRank = getCallTargetRank(right, sourceSymbol)

    if (leftRank !== rightRank) {
      return leftRank - rightRank
    }

    const leftLine = left.range?.start.line ?? Number.MAX_SAFE_INTEGER
    const rightLine = right.range?.start.line ?? Number.MAX_SAFE_INTEGER

    if (leftLine !== rightLine) {
      return leftLine - rightLine
    }

    return left.id.localeCompare(right.id)
  })
}

function getCallTargetRank(candidate: SymbolNode, sourceSymbol: SymbolNode) {
  if (candidate.parentSymbolId === sourceSymbol.id) {
    return 0
  }

  if (candidate.parentSymbolId === sourceSymbol.parentSymbolId) {
    return 1
  }

  if (!candidate.parentSymbolId) {
    return 2
  }

  if (candidate.id === sourceSymbol.id) {
    return 3
  }

  return 4
}

function isNestedCallableSymbolBoundary(node: ts.Node) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node)
  ) {
    return true
  }

  return ts.isVariableDeclaration(node) && Boolean(getVariableDeclarationFunctionLike(node))
}

function isCallableSymbol(symbolNode: SymbolNode) {
  return (
    symbolNode.symbolKind === 'function' ||
    symbolNode.symbolKind === 'method' ||
    symbolNode.symbolKind === 'class'
  )
}

function isComponentLikeName(name: string) {
  return /^[A-Z]/.test(name)
}

function getImportDefaultBasename(fileId: string) {
  const fileBasename = basename(fileId).replace(/\.[^.]+$/, '')
  const parentBasename = basename(dirname(fileId))

  return fileBasename === 'index' ? parentBasename : fileBasename
}

function getExpressionText(node: ts.Node) {
  return node.getText().slice(0, 80)
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
    getVariableDeclarationFunctionLike(node)
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

  const functionLike = ts.isVariableDeclaration(node)
    ? getVariableDeclarationFunctionLike(node)
    : node

  if (!functionLike) {
    return false
  }

  if (
    ts.isArrowFunction(functionLike) &&
    !ts.isBlock(functionLike.body) &&
    isJsxExpression(functionLike.body)
  ) {
    return true
  }

  let returnsJsx = false

  function visit(child: ts.Node) {
    if (child !== functionLike && isFunctionLikeNode(child)) {
      return
    }

    if (
      ts.isReturnStatement(child) &&
      child.expression &&
      isJsxExpression(child.expression)
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

function getVariableDeclarationFunctionLike(node: ts.VariableDeclaration) {
  if (!node.initializer) {
    return null
  }

  const initializer = unwrapExpression(node.initializer)

  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    return initializer
  }

  if (!ts.isCallExpression(initializer) || !isReactComponentWrapperCall(initializer.expression)) {
    return null
  }

  const componentArgument = initializer.arguments
    .map((argument) => unwrapExpression(argument))
    .find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))

  return componentArgument && (ts.isArrowFunction(componentArgument) || ts.isFunctionExpression(componentArgument))
    ? componentArgument
    : null
}

function isReactComponentWrapperCall(expression: ts.Expression) {
  const unwrappedExpression = unwrapExpression(expression)

  if (ts.isIdentifier(unwrappedExpression)) {
    return unwrappedExpression.text === 'memo' || unwrappedExpression.text === 'forwardRef'
  }

  if (
    ts.isPropertyAccessExpression(unwrappedExpression) &&
    ts.isIdentifier(unwrappedExpression.name)
  ) {
    return (
      unwrappedExpression.name.text === 'memo' ||
      unwrappedExpression.name.text === 'forwardRef'
    )
  }

  return false
}

function isJsxExpression(expression: ts.Expression) {
  const unwrappedExpression = unwrapExpression(expression)

  return (
    ts.isJsxElement(unwrappedExpression) ||
    ts.isJsxFragment(unwrappedExpression) ||
    ts.isJsxSelfClosingElement(unwrappedExpression)
  )
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }

  return current
}

function isFunctionLikeNode(node: ts.Node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
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

import { execFile } from 'node:child_process'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import Parser from 'tree-sitter'
import RustLanguage from 'tree-sitter-rust'

import type {
  LanguageAdapter,
  LanguageAdapterInput,
  LanguageAdapterResult,
} from '../../schema/analysis'
import type {
  FileNode,
  GraphEdge,
  ProjectSnapshot,
  SourceRange,
  SymbolKind,
  SymbolNode,
} from '../../schema/snapshot'

import { buildRustCallGraph } from '../rustAnalyzerCallgraph'
import { createEmptySymbolIndex, registerSymbolNodes } from '../symbolIndex'

const execFileAsync = promisify(execFile)

const RUST_SOURCE_EXTENSION = '.rs'
const CARGO_MANIFEST_NAME = 'Cargo.toml'
const ROOT_MODULE_BASENAMES = new Set(['lib.rs', 'main.rs', 'mod.rs'])

const RUST_TARGET_TAGS = {
  bench: 'bench',
  bin: 'bin',
  'custom-build': 'build_script',
  example: 'example',
  lib: 'lib',
  'proc-macro': 'proc_macro',
  test: 'test',
} as const

type RustTargetTag = (typeof RUST_TARGET_TAGS)[keyof typeof RUST_TARGET_TAGS]

interface CargoMetadata {
  packages: CargoPackage[]
  workspace_members: string[]
  workspace_root: string
}

interface CargoPackage {
  id: string
  manifest_path: string
  name: string
  targets: CargoTarget[]
}

interface CargoTarget {
  kind: string[]
  name: string
  src_path: string
}

interface RustPackageContext {
  id: string
  packageRoot: string
  targets: Array<{
    srcPath: string
    tags: RustTargetTag[]
  }>
  isWorkspaceMember: boolean
}

interface MutableRustContext {
  edges: GraphEdge[]
  nodes: ProjectSnapshot['nodes']
}

export function createRustLanguageAdapter(): LanguageAdapter {
  return {
    id: 'rust',
    displayName: 'Rust / Cargo',
    supports: {
      symbols: true,
      imports: true,
      calls: true,
    },
    matches(fileNode) {
      return (
        extname(fileNode.path).toLowerCase() === RUST_SOURCE_EXTENSION ||
        fileNode.name === CARGO_MANIFEST_NAME
      )
    },
    async analyze({
      snapshot,
      fileNodes,
      options,
    }: LanguageAdapterInput): Promise<LanguageAdapterResult> {
      const context: MutableRustContext = {
        edges: [],
        nodes: { ...snapshot.nodes },
      }
      const rustFileNodes = fileNodes.filter(isRustSourceFile)
      const manifestFileNodes = getCargoManifestFileNodes(snapshot)
      const fileIdByAbsolutePath = createFileIdByAbsolutePath(snapshot)

      for (const fileNode of rustFileNodes) {
        context.nodes[fileNode.id] = withNodeTagsAndLanguage(fileNode, [], 'rust')
      }

      for (const manifestFileNode of manifestFileNodes) {
        context.nodes[manifestFileNode.id] = withNodeTagsAndLanguage(
          manifestFileNode,
          [],
          'toml',
        )
      }

      const metadataSets = await loadCargoMetadata(snapshot, manifestFileNodes)
      const packageContexts = buildRustPackageContexts(metadataSets)
      const packageContextByFileId = assignRustFilesToPackages(
        snapshot,
        rustFileNodes,
        packageContexts,
      )
      const entryFileIds = new Set<string>()

      if (metadataSets.length === 0) {
        applyConventionalRustEntrypoints(snapshot, context.nodes, entryFileIds)
      } else {
        applyCargoMetadataTags(
          snapshot.rootDir,
          rustFileNodes,
          fileIdByAbsolutePath,
          packageContexts,
          context.nodes,
          entryFileIds,
        )
      }

      const parsedTrees =
        options.analyzeSymbols === false && options.analyzeImports === false
          ? new Map<string, Parser.Tree>()
          : parseRustFiles(rustFileNodes)
      const symbolIndex = createEmptySymbolIndex()

      if (options.analyzeSymbols !== false) {
        const rustSymbols = extractRustSymbols(rustFileNodes, parsedTrees, context)
        registerSymbolNodes(rustSymbols, symbolIndex)
      }

      if (options.analyzeImports !== false) {
        context.edges.push(
          ...extractRustImportEdges(
            snapshot,
            rustFileNodes,
            parsedTrees,
            fileIdByAbsolutePath,
            packageContextByFileId,
          ),
        )
      }

      if (options.analyzeCalls && options.analyzeSymbols !== false) {
        const callAnalysisSnapshot: ProjectSnapshot = {
          ...snapshot,
          entryFileIds: [...entryFileIds],
          nodes: context.nodes,
          edges: [...snapshot.edges, ...context.edges],
        }

        const callGraph = await buildRustCallGraph(callAnalysisSnapshot, symbolIndex)
        context.edges.push(...callGraph.edges)
      }

      return {
        nodes: context.nodes,
        edges: dedupeEdges(context.edges),
        entryFileIds: [...entryFileIds],
      }
    },
  }
}

function isRustSourceFile(fileNode: FileNode) {
  return extname(fileNode.path).toLowerCase() === RUST_SOURCE_EXTENSION
}

function getCargoManifestFileNodes(snapshot: ProjectSnapshot) {
  return Object.values(snapshot.nodes).filter(
    (node): node is FileNode => node.kind === 'file' && node.name === CARGO_MANIFEST_NAME,
  )
}

function createFileIdByAbsolutePath(snapshot: ProjectSnapshot) {
  const fileIdByAbsolutePath = new Map<string, string>()

  for (const node of Object.values(snapshot.nodes)) {
    if (node.kind !== 'file') {
      continue
    }

    fileIdByAbsolutePath.set(resolve(snapshot.rootDir, node.path), node.id)
  }

  return fileIdByAbsolutePath
}

async function loadCargoMetadata(
  snapshot: ProjectSnapshot,
  manifestFileNodes: FileNode[],
) {
  const metadataByWorkspaceRoot = new Map<string, CargoMetadata>()

  for (const manifestFileNode of manifestFileNodes.sort(comparePathDepth)) {
    const metadata = await readCargoMetadata(
      snapshot.rootDir,
      resolve(snapshot.rootDir, manifestFileNode.path),
    )

    if (!metadata) {
      continue
    }

    metadataByWorkspaceRoot.set(resolve(metadata.workspace_root), metadata)
  }

  return [...metadataByWorkspaceRoot.values()]
}

function comparePathDepth(left: FileNode, right: FileNode) {
  const leftDepth = left.path.split('/').length
  const rightDepth = right.path.split('/').length

  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth
  }

  return left.path.localeCompare(right.path)
}

async function readCargoMetadata(rootDir: string, manifestPath: string) {
  try {
    const { stdout } = await execFileAsync(
      'cargo',
      [
        'metadata',
        '--format-version=1',
        '--no-deps',
        '--manifest-path',
        manifestPath,
      ],
      { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 },
    )

    return JSON.parse(stdout) as CargoMetadata
  } catch {
    return null
  }
}

function buildRustPackageContexts(metadataSets: CargoMetadata[]) {
  const packageContexts = new Map<string, RustPackageContext>()

  for (const metadata of metadataSets) {
    const workspaceMemberIds = new Set(metadata.workspace_members)

    for (const pkg of metadata.packages) {
      packageContexts.set(pkg.id, {
        id: pkg.id,
        packageRoot: dirname(pkg.manifest_path),
        targets: pkg.targets.map((target) => ({
          srcPath: resolve(target.src_path),
          tags: getRustTargetTags(target.kind),
        })),
        isWorkspaceMember: workspaceMemberIds.has(pkg.id),
      })
    }
  }

  return [...packageContexts.values()].sort(
    (left, right) => right.packageRoot.length - left.packageRoot.length,
  )
}

function assignRustFilesToPackages(
  snapshot: ProjectSnapshot,
  rustFileNodes: FileNode[],
  packageContexts: RustPackageContext[],
) {
  const packageContextByFileId = new Map<string, RustPackageContext>()

  for (const fileNode of rustFileNodes) {
    const absolutePath = resolve(snapshot.rootDir, fileNode.path)
    const packageContext = packageContexts.find((candidate) =>
      isWithinPath(absolutePath, candidate.packageRoot),
    )

    if (packageContext) {
      packageContextByFileId.set(fileNode.id, packageContext)
    }
  }

  return packageContextByFileId
}

function applyCargoMetadataTags(
  rootDir: string,
  rustFileNodes: FileNode[],
  fileIdByAbsolutePath: Map<string, string>,
  packageContexts: RustPackageContext[],
  nodes: ProjectSnapshot['nodes'],
  entryFileIds: Set<string>,
) {
  for (const packageContext of packageContexts) {
    for (const fileNode of rustFileNodes) {
      const absolutePath = resolve(rootDir, fileNode.path)

      if (!isWithinPath(absolutePath, packageContext.packageRoot)) {
        continue
      }

      const workspaceTags = packageContext.isWorkspaceMember ? ['workspace_member'] : []
      nodes[fileNode.id] = withNodeTagsAndLanguage(fileNode, workspaceTags, 'rust')
    }
  }

  for (const packageContext of packageContexts) {
    for (const target of packageContext.targets) {
      const targetFileId = fileIdByAbsolutePath.get(target.srcPath)

      if (!targetFileId) {
        continue
      }

      const targetNode = nodes[targetFileId]

      if (!targetNode || targetNode.kind !== 'file') {
        continue
      }

      const targetTags = new Set<string>()

      if (packageContext.isWorkspaceMember) {
        targetTags.add('workspace_member')
      }

      targetTags.add('entrypoint')

      for (const targetTag of target.tags) {
        targetTags.add(targetTag)
      }

      nodes[targetFileId] = withNodeTagsAndLanguage(targetNode, [...targetTags], 'rust')
      entryFileIds.add(targetFileId)
    }
  }
}

function parseRustFiles(rustFileNodes: FileNode[]) {
  const parser = new Parser()
  parser.setLanguage(RustLanguage as unknown as Parser.Language)

  const parsedTrees = new Map<string, Parser.Tree>()

  for (const fileNode of rustFileNodes) {
    if (!fileNode.content) {
      continue
    }

    parsedTrees.set(fileNode.id, parser.parse(fileNode.content))
  }

  return parsedTrees
}

function extractRustSymbols(
  rustFileNodes: FileNode[],
  parsedTrees: Map<string, Parser.Tree>,
  context: MutableRustContext,
) {
  const rustSymbols: SymbolNode[] = []

  for (const fileNode of rustFileNodes) {
    const tree = parsedTrees.get(fileNode.id)

    if (!tree) {
      continue
    }

    collectRustSymbols(tree.rootNode, fileNode, context, null, rustSymbols)
  }

  return rustSymbols
}

function collectRustSymbols(
  node: Parser.SyntaxNode,
  fileNode: FileNode,
  context: MutableRustContext,
  parentSymbolId: string | null,
  rustSymbols: SymbolNode[],
) {
  const symbolMetadata = getRustSymbolMetadata(node)
  let currentParentSymbolId = parentSymbolId

  if (symbolMetadata) {
    const symbolNode = createRustSymbolNode(
      fileNode,
      symbolMetadata.name,
      symbolMetadata.symbolKind,
      symbolMetadata.nativeSymbolKind,
      toSourceRange(node),
      parentSymbolId,
      symbolMetadata.visibility,
    )

    context.nodes[symbolNode.id] = symbolNode
    rustSymbols.push(symbolNode)
    context.edges.push({
      id: `contains:${parentSymbolId ?? fileNode.id}->${symbolNode.id}`,
      kind: 'contains',
      source: parentSymbolId ?? fileNode.id,
      target: symbolNode.id,
    })
    currentParentSymbolId = symbolNode.id
  }

  for (const child of node.namedChildren) {
    collectRustSymbols(child, fileNode, context, currentParentSymbolId, rustSymbols)
  }
}

function getRustSymbolMetadata(node: Parser.SyntaxNode) {
  switch (node.type) {
    case 'function_item': {
      const nameNode = node.childForFieldName('name')

      if (!nameNode) {
        return null
      }

      const isMethod = isRustMethodNode(node)

      return {
        name: nameNode.text,
        symbolKind: isMethod ? ('method' as const) : ('function' as const),
        nativeSymbolKind: isMethod ? 'method' : 'function',
        visibility: getRustVisibility(node),
      }
    }

    case 'struct_item':
    case 'enum_item':
    case 'union_item':
    case 'trait_item':
    case 'type_item':
    case 'associated_type': {
      const nameNode = node.childForFieldName('name')

      if (!nameNode) {
        return null
      }

      return {
        name: nameNode.text,
        symbolKind: 'class' as const,
        nativeSymbolKind: mapRustNativeSymbolKind(node.type),
        visibility: getRustVisibility(node),
      }
    }

    case 'const_item':
    case 'static_item': {
      const nameNode = node.childForFieldName('name')

      if (!nameNode) {
        return null
      }

      return {
        name: nameNode.text,
        symbolKind: 'constant' as const,
        nativeSymbolKind: mapRustNativeSymbolKind(node.type),
        visibility: getRustVisibility(node),
      }
    }

    case 'mod_item': {
      const nameNode = node.childForFieldName('name')

      if (!nameNode) {
        return null
      }

      return {
        name: nameNode.text,
        symbolKind: 'module' as const,
        nativeSymbolKind: 'module',
        visibility: getRustVisibility(node),
      }
    }

    case 'impl_item': {
      const implName = buildImplSymbolName(node)

      if (!implName) {
        return null
      }

      return {
        name: implName,
        symbolKind: 'module' as const,
        nativeSymbolKind: 'impl',
        visibility: getRustVisibility(node),
      }
    }

    default:
      return null
  }
}

function createRustSymbolNode(
  fileNode: FileNode,
  name: string,
  symbolKind: SymbolKind,
  nativeSymbolKind: string,
  range: SourceRange,
  parentSymbolId: string | null,
  visibility: SymbolNode['visibility'],
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
    language: 'rust',
    symbolKind,
    nativeSymbolKind,
    visibility,
    signature: name,
    range,
  }
}

function toSourceRange(node: Parser.SyntaxNode): SourceRange {
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column,
    },
  }
}

function mapRustNativeSymbolKind(nodeType: string) {
  switch (nodeType) {
    case 'struct_item':
      return 'struct'
    case 'enum_item':
      return 'enum'
    case 'union_item':
      return 'union'
    case 'trait_item':
      return 'trait'
    case 'type_item':
      return 'type_alias'
    case 'associated_type':
      return 'associated_type'
    case 'const_item':
      return 'const'
    case 'static_item':
      return 'static'
    default:
      return nodeType
  }
}

function buildImplSymbolName(node: Parser.SyntaxNode) {
  const typeNode = node.childForFieldName('type')
  const traitNode = node.childForFieldName('trait')

  if (traitNode && typeNode) {
    return `impl ${traitNode.text} for ${typeNode.text}`
  }

  if (typeNode) {
    return `impl ${typeNode.text}`
  }

  return null
}

function isRustMethodNode(node: Parser.SyntaxNode) {
  let current: Parser.SyntaxNode | null = node.parent

  while (current) {
    if (current.type === 'impl_item' || current.type === 'trait_item') {
      return true
    }

    if (
      current.type === 'source_file' ||
      current.type === 'function_item' ||
      current.type === 'mod_item'
    ) {
      return false
    }

    current = current.parent
  }

  return false
}

function getRustVisibility(node: Parser.SyntaxNode): SymbolNode['visibility'] {
  return /^pub(?:\(|\s)/.test(node.text) ? 'public' : 'private'
}

function extractRustImportEdges(
  snapshot: ProjectSnapshot,
  rustFileNodes: FileNode[],
  parsedTrees: Map<string, Parser.Tree>,
  fileIdByAbsolutePath: Map<string, string>,
  packageContextByFileId: Map<string, RustPackageContext>,
) {
  const edges: GraphEdge[] = []

  for (const fileNode of rustFileNodes) {
    const tree = parsedTrees.get(fileNode.id)
    const packageContext = packageContextByFileId.get(fileNode.id)

    if (!tree) {
      continue
    }

    walkRustNodes(tree.rootNode, (node) => {
      if (node.type === 'use_declaration') {
        const argumentNode = node.childForFieldName('argument')

        if (!argumentNode) {
          return
        }

        for (const pathSegments of collectUsePathSegments(argumentNode)) {
          const targetFileId = resolveRustUseTarget(
            snapshot,
            fileNode,
            pathSegments,
            fileIdByAbsolutePath,
            packageContext,
          )

          if (!targetFileId || targetFileId === fileNode.id) {
            continue
          }

          edges.push({
            id: `imports:${fileNode.id}->${targetFileId}:rust:${pathSegments.join('::')}`,
            kind: 'imports',
            source: fileNode.id,
            target: targetFileId,
            label: pathSegments.join('::'),
            metadata: {
              dependencyKind: 'use',
              language: 'rust',
            },
          })
        }
      }

      if (node.type === 'mod_item' && !node.childForFieldName('body')) {
        const moduleName = node.childForFieldName('name')?.text

        if (!moduleName) {
          return
        }

        const targetFileId = resolveDeclaredModuleTarget(
          snapshot,
          fileNode,
          moduleName,
          fileIdByAbsolutePath,
        )

        if (!targetFileId || targetFileId === fileNode.id) {
          return
        }

        edges.push({
          id: `imports:${fileNode.id}->${targetFileId}:rust:mod:${moduleName}`,
          kind: 'imports',
          source: fileNode.id,
          target: targetFileId,
          label: `mod ${moduleName}`,
          metadata: {
            language: 'rust',
            dependencyKind: 'mod',
          },
        })
      }
    })
  }

  return dedupeEdges(edges)
}

function walkRustNodes(
  node: Parser.SyntaxNode,
  visitor: (node: Parser.SyntaxNode) => void,
) {
  visitor(node)

  for (const child of node.namedChildren) {
    walkRustNodes(child, visitor)
  }
}

function collectUsePathSegments(
  node: Parser.SyntaxNode,
  prefix: string[] = [],
): string[][] {
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
      return [[...prefix, node.text]]

    case 'self':
      return [prefix.length > 0 ? [...prefix] : ['self']]

    case 'scoped_identifier':
      return [[...prefix, ...flattenScopedIdentifier(node)]]

    case 'use_as_clause': {
      const originalNode = node.namedChildren[0]
      return originalNode ? collectUsePathSegments(originalNode, prefix) : []
    }

    case 'use_wildcard': {
      const baseNode = node.namedChildren[0]

      if (!baseNode) {
        return []
      }

      return collectUsePathSegments(baseNode, prefix)
    }

    case 'use_list':
      return node.namedChildren.flatMap((child) => collectUsePathSegments(child, prefix))

    case 'scoped_use_list': {
      const baseNode = node.namedChildren[0]
      const remainderNode = node.namedChildren[1]

      if (!baseNode) {
        return []
      }

      const baseSegments = [...prefix, ...flattenPathSegments(baseNode)]

      if (!remainderNode) {
        return [baseSegments]
      }

      return collectUsePathSegments(remainderNode, baseSegments)
    }

    default:
      return []
  }
}

function flattenPathSegments(node: Parser.SyntaxNode): string[] {
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'self':
    case 'super':
      return [node.text]

    case 'scoped_identifier':
      return flattenScopedIdentifier(node)

    case 'use_as_clause':
      return node.namedChildren[0] ? flattenPathSegments(node.namedChildren[0]) : []

    case 'use_wildcard':
      return node.namedChildren[0] ? flattenPathSegments(node.namedChildren[0]) : []

    default:
      return node.namedChildren.flatMap((child) => flattenPathSegments(child))
  }
}

function flattenScopedIdentifier(node: Parser.SyntaxNode): string[] {
  return node.namedChildren.flatMap((child) => flattenPathSegments(child))
}

function resolveRustUseTarget(
  snapshot: ProjectSnapshot,
  fileNode: FileNode,
  usePathSegments: string[],
  fileIdByAbsolutePath: Map<string, string>,
  packageContext?: RustPackageContext,
) {
  const candidateTargetRoots = getCandidateTargetRoots(snapshot, fileNode, packageContext)
  const currentFileAbsolutePath = resolve(snapshot.rootDir, fileNode.path)

  for (const targetRoot of candidateTargetRoots) {
    const currentModuleSegments = deriveModuleSegmentsForFile(currentFileAbsolutePath, targetRoot)

    if (!currentModuleSegments) {
      continue
    }

    const absolutePathSegments = absolutizeRustUsePath(
      usePathSegments,
      currentModuleSegments,
    )

    if (!absolutePathSegments) {
      continue
    }

    for (let segmentCount = absolutePathSegments.length; segmentCount >= 0; segmentCount -= 1) {
      const moduleSegments = absolutePathSegments.slice(0, segmentCount)
      const targetFileId = resolveRustModulePath(
        fileIdByAbsolutePath,
        targetRoot,
        moduleSegments,
      )

      if (targetFileId) {
        return targetFileId
      }
    }
  }

  return null
}

function getCandidateTargetRoots(
  snapshot: ProjectSnapshot,
  fileNode: FileNode,
  packageContext?: RustPackageContext,
) {
  if (packageContext) {
    const currentFileAbsolutePath = resolve(snapshot.rootDir, fileNode.path)
    const targetSrcPaths = packageContext.targets.map((target) => target.srcPath)
    const matchingTargets = targetSrcPaths.filter((targetRoot) =>
      deriveModuleSegmentsForFile(currentFileAbsolutePath, targetRoot) !== null,
    )

    if (matchingTargets.length > 0) {
      return matchingTargets
    }

    return targetSrcPaths
  }

  return getFallbackTargetRoots(snapshot)
}

function getFallbackTargetRoots(snapshot: ProjectSnapshot) {
  const fallbackRoots: string[] = []

  for (const candidate of ['src/lib.rs', 'src/main.rs', 'build.rs']) {
    if (snapshot.nodes[candidate]?.kind === 'file') {
      fallbackRoots.push(resolve(snapshot.rootDir, candidate))
    }
  }

  return fallbackRoots
}

function deriveModuleSegmentsForFile(fileAbsolutePath: string, targetRootPath: string) {
  const targetModuleBaseDir = getModuleBaseDirForFile(targetRootPath)
  const relativePath = normalizePath(relative(targetModuleBaseDir, fileAbsolutePath))

  if (
    relativePath === '' &&
    normalizePath(fileAbsolutePath) === normalizePath(targetRootPath)
  ) {
    return []
  }

  if (!relativePath || relativePath.startsWith('../') || relativePath === '..') {
    return null
  }

  const pathSegments = relativePath.split('/').filter(Boolean)

  if (pathSegments.length === 0) {
    return []
  }

  const lastSegment = pathSegments[pathSegments.length - 1]

  if (lastSegment === 'mod.rs') {
    return pathSegments.slice(0, -1)
  }

  if (!lastSegment.endsWith('.rs')) {
    return null
  }

  return [...pathSegments.slice(0, -1), stripRsExtension(lastSegment)]
}

function absolutizeRustUsePath(
  usePathSegments: string[],
  currentModuleSegments: string[],
) {
  if (usePathSegments.length === 0) {
    return null
  }

  const segments = [...usePathSegments]
  const firstSegment = segments.shift()

  if (!firstSegment) {
    return null
  }

  if (firstSegment === 'crate') {
    return segments
  }

  if (firstSegment === 'self') {
    return [...currentModuleSegments, ...segments]
  }

  if (firstSegment === 'super') {
    let currentSegments = [...currentModuleSegments]
    let pendingSegments = [...segments]

    while (pendingSegments[0] === 'super') {
      currentSegments = currentSegments.slice(0, -1)
      pendingSegments = pendingSegments.slice(1)
    }

    return [...currentSegments.slice(0, -1), ...pendingSegments]
  }

  return [firstSegment, ...segments]
}

function resolveRustModulePath(
  fileIdByAbsolutePath: Map<string, string>,
  targetRootPath: string,
  moduleSegments: string[],
) {
  if (moduleSegments.length === 0) {
    return fileIdByAbsolutePath.get(targetRootPath) ?? null
  }

  const moduleBaseDir = getModuleBaseDirForFile(targetRootPath)
  const moduleAbsolutePath = resolve(moduleBaseDir, ...moduleSegments)

  for (const candidate of buildRustModuleCandidates(moduleAbsolutePath)) {
    const targetFileId = fileIdByAbsolutePath.get(candidate)

    if (targetFileId) {
      return targetFileId
    }
  }

  return null
}

function resolveDeclaredModuleTarget(
  snapshot: ProjectSnapshot,
  fileNode: FileNode,
  moduleName: string,
  fileIdByAbsolutePath: Map<string, string>,
) {
  const currentFileAbsolutePath = resolve(snapshot.rootDir, fileNode.path)
  const moduleBaseDir = getModuleBaseDirForFile(currentFileAbsolutePath)
  const moduleAbsolutePath = resolve(moduleBaseDir, moduleName)

  for (const candidate of buildRustModuleCandidates(moduleAbsolutePath)) {
    const targetFileId = fileIdByAbsolutePath.get(candidate)

    if (targetFileId) {
      return targetFileId
    }
  }

  return null
}

function getModuleBaseDirForFile(filePath: string) {
  return ROOT_MODULE_BASENAMES.has(basename(filePath))
    ? dirname(filePath)
    : filePath.slice(0, -RUST_SOURCE_EXTENSION.length)
}

function buildRustModuleCandidates(moduleAbsolutePath: string) {
  return [
    `${moduleAbsolutePath}${RUST_SOURCE_EXTENSION}`,
    resolve(moduleAbsolutePath, 'mod.rs'),
  ]
}

function stripRsExtension(value: string) {
  return value.endsWith(RUST_SOURCE_EXTENSION)
    ? value.slice(0, -RUST_SOURCE_EXTENSION.length)
    : value
}

function applyConventionalRustEntrypoints(
  snapshot: ProjectSnapshot,
  nodes: ProjectSnapshot['nodes'],
  entryFileIds: Set<string>,
) {
  const conventionalTargets: Array<{
    path: string
    tags: string[]
  }> = [
    { path: 'src/lib.rs', tags: ['entrypoint', 'lib'] },
    { path: 'src/main.rs', tags: ['entrypoint', 'bin'] },
    { path: 'build.rs', tags: ['entrypoint', 'build_script'] },
  ]

  for (const target of conventionalTargets) {
    const node = nodes[target.path]

    if (!node || node.kind !== 'file') {
      continue
    }

    nodes[target.path] = withNodeTagsAndLanguage(node, target.tags, 'rust')
    entryFileIds.add(target.path)
  }

  for (const node of Object.values(nodes)) {
    if (!isRustSourceFileNode(node)) {
      continue
    }

    const normalizedPath = normalizePath(relative(snapshot.rootDir, resolve(snapshot.rootDir, node.path)))

    if (normalizedPath.startsWith('examples/')) {
      nodes[node.id] = withNodeTagsAndLanguage(node, ['entrypoint', 'example'], 'rust')
      entryFileIds.add(node.id)
    } else if (normalizedPath.startsWith('tests/')) {
      nodes[node.id] = withNodeTagsAndLanguage(node, ['entrypoint', 'test'], 'rust')
      entryFileIds.add(node.id)
    } else if (normalizedPath.startsWith('benches/')) {
      nodes[node.id] = withNodeTagsAndLanguage(node, ['entrypoint', 'bench'], 'rust')
      entryFileIds.add(node.id)
    }
  }
}

function isRustSourceFileNode(node: ProjectSnapshot['nodes'][string]): node is FileNode {
  return node?.kind === 'file' && isRustSourceFile(node)
}

function withNodeTagsAndLanguage(
  fileNode: FileNode,
  nextTags: string[],
  language: string,
): FileNode {
  return {
    ...fileNode,
    language,
    tags: [...new Set([...fileNode.tags, ...nextTags])],
    facets: [...new Set(fileNode.facets)],
  }
}

function normalizePath(value: string) {
  return value.split('\\').join('/')
}

function isWithinPath(candidatePath: string, parentPath: string) {
  const relativePath = normalizePath(relative(parentPath, candidatePath))
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !relativePath.startsWith('../'))
  )
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map<string, GraphEdge>()

  for (const edge of edges) {
    uniqueEdges.set(edge.id, edge)
  }

  return [...uniqueEdges.values()]
}

function getRustTargetTags(targetKinds: string[]) {
  const tags = new Set<RustTargetTag>()

  for (const targetKind of targetKinds) {
    const mappedTag = RUST_TARGET_TAGS[targetKind as keyof typeof RUST_TARGET_TAGS]

    if (mappedTag) {
      tags.add(mappedTag)
    }
  }

  return [...tags]
}

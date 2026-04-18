import { dirname } from 'node:path'

import type {
  AnalysisFact,
  ProjectFacetDefinition,
  ProjectPlugin,
  ProjectPluginDetection,
  ProjectPluginInput,
} from '../../schema/projectPlugin'
import type {
  FileNode,
  ProjectNode,
  ProjectSnapshot,
  SymbolNode,
} from '../../schema/snapshot'

const REACT_FACET_DEFINITIONS: ProjectFacetDefinition[] = [
  {
    id: 'react:component',
    label: 'React Component',
    category: 'framework',
    description: 'A symbol or file that likely represents a React component.',
  },
  {
    id: 'react:hook',
    label: 'React Hook',
    category: 'framework',
    description: 'A symbol or file that likely represents a React hook.',
  },
  {
    id: 'react:client-component',
    label: 'Client Component',
    category: 'framework',
    description: 'A React file or component running in a client-only boundary.',
  },
]

const REACT_PACKAGE_NAMES = new Set(['react', 'react-dom'])

export function createReactProjectPlugin(): ProjectPlugin {
  return {
    id: 'react',
    displayName: 'React',
    version: 1,
    async detect(input) {
      const detections: ProjectPluginDetection[] = []
      const seenScopeRoots = new Set<string>()
      const fileNodesByPath = new Map(input.fileNodes.map((fileNode) => [fileNode.path, fileNode]))
      const packageScopes = new Set<string>()

      for (const fileNode of input.fileNodes) {
        if (fileNode.name !== 'package.json' || !fileNode.content) {
          continue
        }

        const packageJson = parsePackageJson(fileNode.content)

        if (!packageJson || !packageJsonUsesReact(packageJson)) {
          continue
        }

        const scopeRoot = normalizeScopeRoot(dirname(fileNode.path))
        packageScopes.add(scopeRoot)
        seenScopeRoots.add(scopeRoot)
        detections.push({
          pluginId: 'react',
          displayName: 'React',
          scopeRoot,
          confidence: 1,
          reason: `${fileNode.path} declares react dependencies`,
        })
      }

      const jsxPaths = new Set(
        input.facts
          .filter((fact) => fact.namespace === 'ts-js' && fact.kind === 'contains_jsx')
          .map((fact) => fact.path),
      )
      const fallbackGroups = new Map<string, string[]>()

      for (const fact of input.facts) {
        if (
          fact.namespace !== 'ts-js' ||
          fact.kind !== 'imports_package' ||
          typeof fact.data?.packageName !== 'string' ||
          !REACT_PACKAGE_NAMES.has(fact.data.packageName) ||
          !jsxPaths.has(fact.path) ||
          isPathWithinAnyScope(fact.path, packageScopes)
        ) {
          continue
        }

        const groupingRoot = deriveFallbackScopeRoot(fact.path, fileNodesByPath)
        const existing = fallbackGroups.get(groupingRoot) ?? []
        existing.push(fact.path)
        fallbackGroups.set(groupingRoot, existing)
      }

      for (const [scopeRoot, paths] of fallbackGroups) {
        if (seenScopeRoots.has(scopeRoot)) {
          continue
        }

        seenScopeRoots.add(scopeRoot)
        detections.push({
          pluginId: 'react',
          displayName: 'React',
          scopeRoot,
          confidence: 0.6,
          reason: `JSX and React imports detected in ${paths[0]}`,
        })
      }

      return detections.sort((left, right) => left.scopeRoot.localeCompare(right.scopeRoot))
    },
    async analyze(input) {
      return analyzeReactScope(input)
    },
  }
}

function analyzeReactScope(input: ProjectPluginInput) {
  const nodes: Record<string, ProjectNode> = {}
  const factsBySubjectId = groupFactsBySubjectId(input.scopedFacts)
  const symbolNodes = getScopedSymbolNodes(input.snapshot, input.scopedFileNodes)
  const fileNodesById = new Map(input.scopedFileNodes.map((fileNode) => [fileNode.id, fileNode]))

  for (const fileNode of input.scopedFileNodes) {
    const fileFacts = factsBySubjectId.get(fileNode.id) ?? []
    const nextFacets = new Set(fileNode.facets)
    const usesClientDirective = fileFacts.some(
      (fact) => fact.kind === 'file_directive' && fact.data?.value === 'use client',
    )

    if (usesClientDirective) {
      nextFacets.add('react:client-component')
    }

    nodes[fileNode.id] = {
      ...fileNode,
      facets: [...nextFacets],
    }
  }

  for (const symbolNode of symbolNodes) {
    const symbolFacts = factsBySubjectId.get(symbolNode.id) ?? []
    const fileNode = fileNodesById.get(symbolNode.fileId)
    const fileFacts = fileNode ? factsBySubjectId.get(fileNode.id) ?? [] : []
    const nextFacets = new Set(symbolNode.facets)
    const hasExport = symbolFacts.some((fact) => fact.kind === 'symbol_exported')
    const returnsJsx = symbolFacts.some((fact) => fact.kind === 'symbol_returns_jsx')
    const callsHook = symbolFacts.some((fact) => fact.kind === 'symbol_calls_hook')
    const usesClientDirective = fileFacts.some(
      (fact) => fact.kind === 'file_directive' && fact.data?.value === 'use client',
    )

    if (
      symbolNode.symbolKind === 'function' &&
      returnsJsx &&
      (isPascalCase(symbolNode.name) || hasExport)
    ) {
      nextFacets.add('react:component')
    }

    if (symbolNode.symbolKind === 'function' && isHookName(symbolNode.name) && callsHook) {
      nextFacets.add('react:hook')
    }

    if (usesClientDirective && nextFacets.has('react:component')) {
      nextFacets.add('react:client-component')
    }

    nodes[symbolNode.id] = {
      ...symbolNode,
      facets: [...nextFacets],
    }

    if (fileNode) {
      const nextFileFacets = new Set((nodes[fileNode.id] ?? fileNode).facets)

      if (nextFacets.has('react:component')) {
        nextFileFacets.add('react:component')
      }

      if (nextFacets.has('react:hook')) {
        nextFileFacets.add('react:hook')
      }

      if (nextFacets.has('react:client-component')) {
        nextFileFacets.add('react:client-component')
      }

      nodes[fileNode.id] = {
        ...(nodes[fileNode.id] ?? fileNode),
        facets: [...nextFileFacets],
      }
    }
  }

  return {
    nodes,
    facetDefinitions: REACT_FACET_DEFINITIONS,
  }
}

function groupFactsBySubjectId(facts: AnalysisFact[]) {
  const result = new Map<string, AnalysisFact[]>()

  for (const fact of facts) {
    const existing = result.get(fact.subjectId) ?? []
    existing.push(fact)
    result.set(fact.subjectId, existing)
  }

  return result
}

function getScopedSymbolNodes(
  snapshot: ProjectSnapshot,
  scopedFileNodes: FileNode[],
) {
  const fileIdSet = new Set(scopedFileNodes.map((fileNode) => fileNode.id))

  return Object.values(snapshot.nodes).filter(
    (node): node is SymbolNode =>
      node.kind === 'symbol' && fileIdSet.has(node.fileId),
  )
}

function parsePackageJson(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

function packageJsonUsesReact(packageJson: Record<string, unknown>) {
  const dependencyGroups = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
  ]

  return dependencyGroups.some((group) => {
    if (!group || typeof group !== 'object') {
      return false
    }

    return Object.keys(group).some((dependencyName) => REACT_PACKAGE_NAMES.has(dependencyName))
  })
}

function normalizeScopeRoot(scopeRoot: string) {
  return scopeRoot === '.' ? '' : scopeRoot.split('\\').join('/')
}

function isPathWithinScope(path: string, scopeRoot: string) {
  return scopeRoot === '' || path === scopeRoot || path.startsWith(`${scopeRoot}/`)
}

function isPathWithinAnyScope(path: string, scopeRoots: Set<string>) {
  for (const scopeRoot of scopeRoots) {
    if (isPathWithinScope(path, scopeRoot)) {
      return true
    }
  }

  return false
}

function deriveFallbackScopeRoot(
  path: string,
  fileNodesByPath: Map<string, FileNode>,
) {
  const pathSegments = path.split('/')

  if (pathSegments.length <= 1) {
    return ''
  }

  const firstSegment = pathSegments[0] ?? ''
  const firstSegmentPackageJson = firstSegment
    ? fileNodesByPath.get(`${firstSegment}/package.json`)
    : null

  if (firstSegmentPackageJson) {
    return firstSegment
  }

  if (firstSegment && firstSegment !== 'src') {
    return firstSegment
  }

  return normalizeScopeRoot(dirname(path))
}

function isPascalCase(name: string) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

function isHookName(name: string) {
  return /^use[A-Z0-9]/.test(name)
}

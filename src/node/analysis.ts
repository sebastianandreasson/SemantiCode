import { extname } from 'node:path'

import type { LanguageAdapter } from '../schema/analysis'
import type {
  AnalysisFact,
  ProjectFacetDefinition,
  ProjectPluginDetection,
} from '../schema/projectPlugin'
import type {
  FileNode,
  GraphEdge,
  NodeTag,
  ProjectSnapshot,
  ReadProjectSnapshotOptions,
} from '../schema/snapshot'

import { createRustLanguageAdapter } from './adapters/rust'
import { createTsJsLanguageAdapter } from './adapters/tsjs'
import { createBuiltInProjectPlugins } from './project-plugins'

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.mp4',
  '.webm',
])

const CONFIG_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'eslint.config.js',
  'eslint.config.mjs',
  'prettier.config.js',
  'prettier.config.cjs',
  'cargo.toml',
  'cargo.lock',
  'rust-toolchain.toml',
  'rustfmt.toml',
  'clippy.toml',
])

export async function enrichProjectSnapshot(
  snapshot: ProjectSnapshot,
  options: ReadProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const fileNodes = getFileNodes(snapshot)
  const context = {
    nodes: { ...snapshot.nodes },
    edges: [...snapshot.edges],
    entryFileIds: new Set(snapshot.entryFileIds),
    facts: [] as AnalysisFact[],
    facetDefinitions: [...snapshot.facetDefinitions],
    detectedPlugins: [...snapshot.detectedPlugins],
  }

  applyBaseFileTags(fileNodes, context.nodes)

  for (const adapter of getLanguageAdapters(options)) {
    const workingSnapshot: ProjectSnapshot = {
      ...snapshot,
      nodes: context.nodes,
      edges: context.edges,
      entryFileIds: [...context.entryFileIds],
    }
    const adapterFileNodes = getFileNodes(workingSnapshot).filter((fileNode) =>
      adapter.matches(fileNode),
    )

    if (adapterFileNodes.length === 0) {
      continue
    }

    try {
      const result = await adapter.analyze({
        snapshot: workingSnapshot,
        fileNodes: adapterFileNodes,
        options,
      })

      if (result.nodes) {
        Object.assign(context.nodes, result.nodes)
      }

      if (result.edges) {
        context.edges.push(...result.edges)
      }

      if (result.entryFileIds) {
        for (const entryFileId of result.entryFileIds) {
          context.entryFileIds.add(entryFileId)
        }
      }

      if (result.tags?.length) {
        snapshot.tags = dedupeTags([...snapshot.tags, ...result.tags])
      }

      if (result.facts?.length) {
        context.facts.push(...result.facts)
      }
    } catch (error) {
      console.warn(
        `[semanticode] Adapter "${adapter.id}" failed; continuing without its analysis.`,
        error,
      )
    }
  }

  for (const projectPlugin of getProjectPlugins(options)) {
    const workingSnapshot = buildWorkingSnapshot(snapshot, context)
    const workingFileNodes = getFileNodes(workingSnapshot)

    try {
      const detections = await projectPlugin.detect({
        snapshot: workingSnapshot,
        fileNodes: workingFileNodes,
        facts: context.facts,
        options,
      })

      for (const detection of detections) {
        const scopedFileNodes = workingFileNodes.filter((fileNode) =>
          isPathWithinScope(fileNode.path, detection.scopeRoot),
        )
        const scopedFacts = context.facts.filter((fact) =>
          isPathWithinScope(fact.path, detection.scopeRoot),
        )
        const pluginResult = await projectPlugin.analyze({
          snapshot: buildWorkingSnapshot(snapshot, context),
          fileNodes: workingFileNodes,
          facts: context.facts,
          options,
          detection,
          scopedFileNodes,
          scopedFacts,
        })

        if (pluginResult.nodes) {
          Object.assign(context.nodes, pluginResult.nodes)
        }

        if (pluginResult.edges) {
          context.edges.push(...pluginResult.edges)
        }

        if (pluginResult.tags?.length) {
          snapshot.tags = dedupeTags([...snapshot.tags, ...pluginResult.tags])
        }

        if (pluginResult.facetDefinitions?.length) {
          context.facetDefinitions = dedupeFacetDefinitions([
            ...context.facetDefinitions,
            ...pluginResult.facetDefinitions,
          ])
        }

        context.detectedPlugins.push(detection)
      }
    } catch (error) {
      console.warn(
        `[semanticode] Project plugin "${projectPlugin.id}" failed; continuing without its analysis.`,
        error,
      )
    }
  }

  return {
    ...snapshot,
    entryFileIds: [...context.entryFileIds],
    nodes: dedupeNodeMetadata(context.nodes),
    edges: dedupeEdges(context.edges),
    tags: dedupeTags(snapshot.tags),
    facetDefinitions: dedupeFacetDefinitions(context.facetDefinitions),
    detectedPlugins: dedupeProjectPluginDetections(context.detectedPlugins),
  }
}

function getLanguageAdapters(options: ReadProjectSnapshotOptions) {
  return options.adapters?.length
    ? options.adapters
    : [createTsJsLanguageAdapter(), createRustLanguageAdapter()]
}

function getProjectPlugins(options: ReadProjectSnapshotOptions) {
  return options.projectPlugins?.length
    ? options.projectPlugins
    : createBuiltInProjectPlugins()
}

function getFileNodes(snapshot: ProjectSnapshot) {
  return Object.values(snapshot.nodes).filter(
    (node): node is FileNode => node.kind === 'file',
  )
}

function buildWorkingSnapshot(
  snapshot: ProjectSnapshot,
  context: {
    nodes: ProjectSnapshot['nodes']
    edges: GraphEdge[]
    entryFileIds: Set<string>
    facetDefinitions: ProjectFacetDefinition[]
    detectedPlugins: ProjectPluginDetection[]
  },
): ProjectSnapshot {
  return {
    ...snapshot,
    nodes: context.nodes,
    edges: context.edges,
    entryFileIds: [...context.entryFileIds],
    facetDefinitions: context.facetDefinitions,
    detectedPlugins: context.detectedPlugins,
  }
}

function applyBaseFileTags(
  fileNodes: FileNode[],
  nodes: ProjectSnapshot['nodes'],
) {
  for (const fileNode of fileNodes) {
    const nextTags = new Set(fileNode.tags)
    const normalizedPath = fileNode.path.toLowerCase()
    const extension = extname(fileNode.path).toLowerCase()
    const basename = fileNode.name.toLowerCase()

    if (
      normalizedPath.includes('/__tests__/') ||
      /\.test\.[cm]?[jt]sx?$/.test(normalizedPath) ||
      /\.spec\.[cm]?[jt]sx?$/.test(normalizedPath)
    ) {
      nextTags.add('test')
    }

    if (
      CONFIG_BASENAMES.has(fileNode.name) ||
      basename.endsWith('.config.js') ||
      basename.endsWith('.config.ts') ||
      basename.endsWith('.config.mjs') ||
      basename.endsWith('.config.cjs')
    ) {
      nextTags.add('config')
    }

    if (
      normalizedPath.includes('/generated/') ||
      normalizedPath.includes('/__generated__/') ||
      basename.includes('.generated.') ||
      basename.includes('.gen.')
    ) {
      nextTags.add('generated')
    }

    if (ASSET_EXTENSIONS.has(extension)) {
      nextTags.add('asset')
    }

    nodes[fileNode.id] = {
      ...fileNode,
      tags: [...nextTags],
    }
  }
}

function isPathWithinScope(path: string, scopeRoot: string) {
  return scopeRoot === '' || path === scopeRoot || path.startsWith(`${scopeRoot}/`)
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map<string, GraphEdge>()

  for (const edge of edges) {
    uniqueEdges.set(edge.id, edge)
  }

  return [...uniqueEdges.values()]
}

function dedupeTags(tags: NodeTag[]) {
  const uniqueTags = new Map(tags.map((tag) => [tag.id, tag]))
  return [...uniqueTags.values()]
}

function dedupeFacetDefinitions(facetDefinitions: ProjectFacetDefinition[]) {
  const uniqueFacetDefinitions = new Map(
    facetDefinitions.map((facetDefinition) => [facetDefinition.id, facetDefinition]),
  )
  return [...uniqueFacetDefinitions.values()]
}

function dedupeProjectPluginDetections(detections: ProjectPluginDetection[]) {
  const uniqueDetections = new Map<string, ProjectPluginDetection>()

  for (const detection of detections) {
    uniqueDetections.set(`${detection.pluginId}:${detection.scopeRoot}`, detection)
  }

  return [...uniqueDetections.values()]
}

function dedupeNodeMetadata(nodes: ProjectSnapshot['nodes']) {
  const nextNodes: ProjectSnapshot['nodes'] = {}

  for (const [nodeId, node] of Object.entries(nodes)) {
    nextNodes[nodeId] = {
      ...node,
      tags: [...new Set(node.tags)],
      facets: [...new Set(node.facets)],
    }
  }

  return nextNodes
}

export { createRustLanguageAdapter, createTsJsLanguageAdapter }
export type { LanguageAdapter }

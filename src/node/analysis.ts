import { extname } from 'node:path'

import type { LanguageAdapter } from '../schema/analysis'
import type {
  FileNode,
  GraphEdge,
  NodeTag,
  ProjectSnapshot,
  ReadProjectSnapshotOptions,
} from '../schema/snapshot'

import { createRustLanguageAdapter } from './adapters/rust'
import { createTsJsLanguageAdapter } from './adapters/tsjs'

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
    } catch (error) {
      console.warn(
        `[semanticode] Adapter "${adapter.id}" failed; continuing without its analysis.`,
        error,
      )
    }
  }

  return {
    ...snapshot,
    entryFileIds: [...context.entryFileIds],
    nodes: context.nodes,
    edges: dedupeEdges(context.edges),
    tags: dedupeTags(snapshot.tags),
  }
}

function getLanguageAdapters(options: ReadProjectSnapshotOptions) {
  return options.adapters?.length
    ? options.adapters
    : [createTsJsLanguageAdapter(), createRustLanguageAdapter()]
}

function getFileNodes(snapshot: ProjectSnapshot) {
  return Object.values(snapshot.nodes).filter(
    (node): node is FileNode => node.kind === 'file',
  )
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

export { createRustLanguageAdapter, createTsJsLanguageAdapter }
export type { LanguageAdapter }

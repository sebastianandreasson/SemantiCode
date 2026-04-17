import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'

import type {
  CodebaseFile,
  DirectoryNode,
  GraphEdge,
  ProjectNode,
  ProjectSnapshot,
  ReadProjectSnapshotOptions,
} from '../types'
import {
  DEFAULT_PROJECT_TAGS,
  PROJECT_SNAPSHOT_SCHEMA_VERSION,
} from '../schema/snapshot'
import { enrichProjectSnapshot } from './analysis'
import { createIgnoreMatcher } from './gitignore'
import {
  readCachedProjectSnapshot,
  writeCachedProjectSnapshot,
} from './projectSnapshotCache'

const DEFAULT_MAX_DEPTH = 12
const DEFAULT_MAX_FILE_SIZE = 100_000
const DEFAULT_MAX_FILES = 2_000

interface WalkState {
  filesSeen: number
  includeContents: boolean
  maxDepth: number
  maxFileSize: number
  maxFiles: number
  rootDir: string
  edges: GraphEdge[]
  nodes: Record<string, ProjectNode>
  rootIds: string[]
  ignoreMatcher: ReturnType<typeof createIgnoreMatcher>
}

export async function readProjectSnapshot(
  options: ReadProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const rootDir = options.rootDir ?? process.cwd()
  const cachedSnapshot = await readCachedProjectSnapshot({
    rootDir,
    options,
  })

  if (cachedSnapshot) {
    return cachedSnapshot
  }

  const snapshot = await readProjectSnapshotFresh({
    ...options,
    rootDir,
  })

  await writeCachedProjectSnapshot({
    rootDir,
    options,
    snapshot,
  })

  return snapshot
}

async function readProjectSnapshotFresh(
  options: ReadProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const rootDir = options.rootDir ?? process.cwd()
  const state: WalkState = {
    filesSeen: 0,
    includeContents: options.includeContents ?? true,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFileSize: options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    rootDir,
    edges: [],
    nodes: {},
    rootIds: [],
    ignoreMatcher: createIgnoreMatcher(rootDir, options.ignoredNames),
  }

  state.rootIds = await walkDirectory(rootDir, state, 0, null, [])

  const snapshot: ProjectSnapshot = {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    rootDir,
    generatedAt: new Date().toISOString(),
    totalFiles: state.filesSeen,
    rootIds: state.rootIds,
    entryFileIds: [],
    nodes: state.nodes,
    edges: state.edges,
    tags: DEFAULT_PROJECT_TAGS,
  }

  return enrichProjectSnapshot(snapshot, options)
}

async function walkDirectory(
  directoryPath: string,
  state: WalkState,
  depth: number,
  parentId: string | null,
  parentIgnoreContexts: Awaited<
    ReturnType<ReturnType<typeof createIgnoreMatcher>['loadContexts']>
  >,
): Promise<string[]> {
  if (depth > state.maxDepth || state.filesSeen >= state.maxFiles) {
    return []
  }

  const ignoreContexts = await state.ignoreMatcher.loadContexts(
    directoryPath,
    parentIgnoreContexts,
  )

  const directoryEntries = await readdir(directoryPath, { withFileTypes: true })
  const sortedEntries = directoryEntries
    .filter((entry) => {
      const absolutePath = join(directoryPath, entry.name)
      const relativePath = normalizePath(relative(state.rootDir, absolutePath))
      const isDirectory = entry.isDirectory()

      return !state.ignoreMatcher.isIgnored(relativePath, isDirectory, ignoreContexts)
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1
      }

      return left.name.localeCompare(right.name)
    })

  const childIds: string[] = []

  for (const entry of sortedEntries) {
    if (state.filesSeen >= state.maxFiles) {
      break
    }

    const absolutePath = join(directoryPath, entry.name)
    const relativePath = normalizePath(relative(state.rootDir, absolutePath))

    if (entry.isSymbolicLink()) {
      continue
    }

    if (entry.isDirectory()) {
      const children = await walkDirectory(
        absolutePath,
        state,
        depth + 1,
        relativePath,
        ignoreContexts,
      )
      const directoryNode: DirectoryNode = {
        kind: 'directory',
        id: relativePath,
        name: entry.name,
        path: relativePath,
        tags: [],
        parentId,
        childIds: children,
        depth,
      }

      state.nodes[directoryNode.id] = directoryNode
      childIds.push(directoryNode.id)
      addContainsEdge(state, parentId, directoryNode.id)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    state.filesSeen += 1
    const fileNode = await readProjectFile(
      absolutePath,
      relativePath,
      parentId,
      state,
    )
    state.nodes[fileNode.id] = fileNode
    childIds.push(fileNode.id)
    addContainsEdge(state, parentId, fileNode.id)
  }

  return childIds
}

async function readProjectFile(
  absolutePath: string,
  relativePath: string,
  parentId: string | null,
  state: WalkState,
): Promise<CodebaseFile> {
  const fileStat = await stat(absolutePath)
  const fileNode: CodebaseFile = {
    kind: 'file',
    id: relativePath,
    name: basename(absolutePath),
    path: relativePath,
    tags: [],
    parentId,
    extension: extname(absolutePath).slice(1),
    size: fileStat.size,
    content: null,
  }

  if (!state.includeContents) {
    return fileNode
  }

  if (fileStat.size > state.maxFileSize) {
    fileNode.contentOmittedReason = 'too_large'
    return fileNode
  }

  try {
    const buffer = await readFile(absolutePath)

    if (buffer.includes(0)) {
      fileNode.contentOmittedReason = 'binary'
      return fileNode
    }

    fileNode.content = buffer.toString('utf8')
    return fileNode
  } catch {
    fileNode.contentOmittedReason = 'read_error'
    return fileNode
  }
}

function normalizePath(pathValue: string) {
  return pathValue.split('\\').join('/')
}

function addContainsEdge(
  state: WalkState,
  parentId: string | null,
  childId: string,
) {
  if (!parentId) {
    return
  }

  state.edges.push({
    id: `contains:${parentId}->${childId}`,
    kind: 'contains',
    source: parentId,
    target: childId,
  })
}

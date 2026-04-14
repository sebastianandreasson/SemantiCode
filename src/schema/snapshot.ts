export const PROJECT_SNAPSHOT_SCHEMA_VERSION = 1 as const

export type SnapshotSchemaVersion = typeof PROJECT_SNAPSHOT_SCHEMA_VERSION

export type GraphEdgeKind =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'references'
  | 'generated_from'
  | 'pipeline_step'
  | 'custom'

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'module'
  | 'unknown'

export type NodeTagId =
  | 'entrypoint'
  | 'test'
  | 'config'
  | 'generated'
  | 'asset'
  | 'likely_unused'
  | string

export type FileContentOmittedReason = 'binary' | 'too_large' | 'read_error'

export interface SourceLocation {
  line: number
  column: number
}

export interface SourceRange {
  start: SourceLocation
  end: SourceLocation
}

export interface GraphEdge {
  id: string
  kind: GraphEdgeKind
  source: string
  target: string
  label?: string
  inferred?: boolean
  metadata?: Record<string, boolean | number | string | null>
}

export interface NodeTag {
  id: NodeTagId
  label: string
  category: 'system' | 'analysis' | 'user'
  description?: string
}

interface BaseProjectNode {
  id: string
  name: string
  path: string
  tags: NodeTagId[]
}

export interface DirectoryNode extends BaseProjectNode {
  kind: 'directory'
  parentId: string | null
  childIds: string[]
  depth: number
}

export interface FileNode extends BaseProjectNode {
  kind: 'file'
  parentId: string | null
  extension: string
  size: number
  content: string | null
  contentOmittedReason?: FileContentOmittedReason
}

export interface SymbolNode extends BaseProjectNode {
  kind: 'symbol'
  fileId: string
  parentSymbolId: string | null
  symbolKind: SymbolKind
  signature?: string
  range?: SourceRange
}

export type FileSystemNode = DirectoryNode | FileNode
export type ProjectNode = FileSystemNode | SymbolNode

export interface ProjectSnapshot {
  schemaVersion: SnapshotSchemaVersion
  rootDir: string
  generatedAt: string
  totalFiles: number
  rootIds: string[]
  entryFileIds: string[]
  nodes: Record<string, ProjectNode>
  edges: GraphEdge[]
  tags: NodeTag[]
}

export interface ReadProjectSnapshotOptions {
  rootDir?: string
  includeContents?: boolean
  ignoredNames?: string[]
  maxDepth?: number
  maxFileSize?: number
  maxFiles?: number
  analyzeImports?: boolean
  analyzeSymbols?: boolean
  analyzeCalls?: boolean
}

export const DEFAULT_PROJECT_TAGS: NodeTag[] = [
  {
    id: 'entrypoint',
    label: 'Entrypoint',
    category: 'system',
    description: 'A file treated as a likely application entrypoint.',
  },
  {
    id: 'test',
    label: 'Test',
    category: 'system',
    description: 'A test file or test-support module.',
  },
  {
    id: 'config',
    label: 'Config',
    category: 'system',
    description: 'A configuration file used at build or runtime.',
  },
  {
    id: 'generated',
    label: 'Generated',
    category: 'analysis',
    description: 'Generated code or machine-authored output.',
  },
  {
    id: 'asset',
    label: 'Asset',
    category: 'system',
    description: 'A non-source asset such as an image or static payload.',
  },
  {
    id: 'likely_unused',
    label: 'Likely Unused',
    category: 'analysis',
    description: 'A file not currently reachable from known entrypoints.',
  },
]

export type CodebaseEntryKind = FileSystemNode['kind']
export type CodebaseDirectory = DirectoryNode
export type CodebaseFile = FileNode
export type CodebaseEntry = FileSystemNode
export type CodebaseSnapshot = ProjectSnapshot

export function isDirectoryNode(node: ProjectNode): node is DirectoryNode {
  return node.kind === 'directory'
}

export function isFileNode(node: ProjectNode): node is FileNode {
  return node.kind === 'file'
}

export function isSymbolNode(node: ProjectNode): node is SymbolNode {
  return node.kind === 'symbol'
}

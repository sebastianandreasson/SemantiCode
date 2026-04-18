import type {
  FileNode,
  GraphEdge,
  NodeTag,
  ProjectNode,
  ProjectSnapshot,
  ReadProjectSnapshotOptions,
} from './snapshot'
import type { AnalysisFact } from './projectPlugin'

export interface LanguageAdapterCapabilities {
  symbols: boolean
  imports: boolean
  calls: boolean
}

export interface LanguageAdapterInput {
  snapshot: ProjectSnapshot
  fileNodes: FileNode[]
  options: ReadProjectSnapshotOptions
}

export interface LanguageAdapterResult {
  nodes?: Record<string, ProjectNode>
  edges?: GraphEdge[]
  entryFileIds?: string[]
  tags?: NodeTag[]
  facts?: AnalysisFact[]
}

export interface LanguageAdapter {
  id: string
  displayName: string
  supports: LanguageAdapterCapabilities
  matches(fileNode: FileNode): boolean
  analyze(input: LanguageAdapterInput): Promise<LanguageAdapterResult>
}

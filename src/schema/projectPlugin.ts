import type {
  FileNode,
  GraphEdge,
  NodeTag,
  ProjectNode,
  ProjectSnapshot,
  ReadProjectSnapshotOptions,
} from './snapshot'

export interface AnalysisFact {
  id: string
  namespace: string
  kind: string
  subjectId: string
  path: string
  data?: Record<string, boolean | number | string | null>
}

export interface ProjectFacetDefinition {
  id: string
  label: string
  category: 'framework' | 'runtime' | 'domain' | 'analysis'
  description?: string
}

export interface ProjectPluginDetection {
  pluginId: string
  displayName: string
  scopeRoot: string
  confidence?: number
  reason?: string
}

export interface ProjectPluginDetectInput {
  snapshot: ProjectSnapshot
  fileNodes: FileNode[]
  facts: AnalysisFact[]
  options: ReadProjectSnapshotOptions
}

export interface ProjectPluginInput extends ProjectPluginDetectInput {
  detection: ProjectPluginDetection
  scopedFacts: AnalysisFact[]
  scopedFileNodes: FileNode[]
}

export interface ProjectPluginResult {
  nodes?: Record<string, ProjectNode>
  edges?: GraphEdge[]
  tags?: NodeTag[]
  facetDefinitions?: ProjectFacetDefinition[]
}

export interface ProjectPlugin {
  id: string
  displayName: string
  version: number
  detect(input: ProjectPluginDetectInput): Promise<ProjectPluginDetection[]>
  analyze(input: ProjectPluginInput): Promise<ProjectPluginResult>
}

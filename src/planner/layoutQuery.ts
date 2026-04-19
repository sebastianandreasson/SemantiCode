import type {
  HybridLayoutProposal,
  LayoutQueryEdgeRef,
  LayoutQueryNodeRef,
  LayoutQueryStats,
  LayoutSelector,
  LayoutSuggestionExecutionPath,
} from '../schema/layoutSuggestion'
import type { LayoutNodeScope, LayoutSpec } from '../schema/layout'
import type { LayoutDraft } from '../schema/planner'
import type {
  GraphEdge,
  GraphEdgeKind,
  ProjectNode,
  ProjectSnapshot,
} from '../schema/snapshot'
import {
  createHybridLayoutDraft,
  getNodeLoc,
  isNodeInScope,
  matchLayoutSelector,
  materializeHybridLayoutProposal,
} from './hybridLayout'

export const DEFAULT_LAYOUT_QUERY_LIMIT = 50
export const MAX_LAYOUT_QUERY_LIMIT = 200
export const MAX_LAYOUT_NEIGHBORHOOD_DEPTH = 2
export const MAX_LAYOUT_QUERY_OUTPUT_CHARS = 120_000

export type LayoutQueryOperation =
  | 'createLayoutDraft'
  | 'findNodes'
  | 'getNeighborhood'
  | 'getNodes'
  | 'getWorkspaceSummary'
  | 'previewHybridLayout'
  | 'summarizeScope'

export interface LayoutQueryCommand {
  args?: Record<string, unknown>
  operation: LayoutQueryOperation
}

export interface LayoutQuerySessionInput {
  baseLayoutId?: string | null
  existingLayouts?: LayoutSpec[]
  executionPath: LayoutSuggestionExecutionPath
  nodeScope?: LayoutNodeScope
  prompt: string
  rootDir: string
  snapshot: ProjectSnapshot
  visibleNodeIds?: string[]
}

export interface LayoutQuerySessionResult {
  budgetExhausted?: boolean
  draft?: LayoutDraft
  ok: boolean
  result?: unknown
  warning?: string
}

interface LayoutQueryStatsDelta {
  returnedEdgeCount?: number
  returnedNodeCount?: number
  truncatedResultCount?: number
}

export class LayoutQuerySession {
  readonly id: string
  private readonly degreeByNodeId: Map<string, number>
  private readonly edgeByNodeId: Map<string, GraphEdge[]>
  private readonly existingLayouts: LayoutSpec[]
  private readonly input: LayoutQuerySessionInput
  private createdDraft: LayoutDraft | null = null
  private outputChars = 0
  private readonly stats: Omit<LayoutQueryStats, 'executionPath'> = {
    returnedEdgeCount: 0,
    returnedNodeCount: 0,
    toolCallCount: 0,
    truncatedResultCount: 0,
  }

  constructor(id: string, input: LayoutQuerySessionInput) {
    this.id = id
    this.input = input
    this.existingLayouts = input.existingLayouts ?? []
    this.degreeByNodeId = buildDegreeMap(input.snapshot.edges)
    this.edgeByNodeId = buildEdgeIndex(input.snapshot.edges)
  }

  getCreatedDraft() {
    return this.createdDraft
  }

  getStats(): LayoutQueryStats {
    return {
      executionPath: this.input.executionPath,
      ...this.stats,
    }
  }

  async execute(command: LayoutQueryCommand): Promise<LayoutQuerySessionResult> {
    this.stats.toolCallCount += 1

    try {
      switch (command.operation) {
        case 'getWorkspaceSummary':
          return this.prepareResult(this.getWorkspaceSummary())
        case 'findNodes':
          return this.findNodes(command.args ?? {})
        case 'getNodes':
          return this.getNodes(command.args ?? {})
        case 'getNeighborhood':
          return this.getNeighborhood(command.args ?? {})
        case 'summarizeScope':
          return this.summarizeScope(command.args ?? {})
        case 'previewHybridLayout':
          return this.prepareResult(this.previewHybridLayout(command.args ?? {}))
        case 'createLayoutDraft':
          return this.createLayoutDraft(command.args ?? {})
        default:
          return {
            ok: false,
            warning: `Unknown layout query operation: ${(command as LayoutQueryCommand).operation}`,
          }
      }
    } catch (error) {
      return {
        ok: false,
        warning: error instanceof Error ? error.message : 'Layout query failed.',
      }
    }
  }

  private getWorkspaceSummary() {
    const nodes = Object.values(this.input.snapshot.nodes)
    const countsByNodeKind = countBy(nodes, (node) => node.kind)
    const countsBySymbolKind = countBy(
      nodes.filter((node) => node.kind === 'symbol'),
      (node) => (node.kind === 'symbol' ? node.symbolKind : 'unknown'),
    )
    const countsByFacet = countStrings(nodes.flatMap((node) => node.facets))
    const countsByTag = countStrings(nodes.flatMap((node) => node.tags))
    const topDirectories = topEntries(
      countStrings(
        nodes
          .map((node) => getTopDirectory(node.path))
          .filter((directory): directory is string => Boolean(directory)),
      ),
      20,
    )

    return {
      availableFacets: this.input.snapshot.facetDefinitions,
      countsByFacet: topEntries(countsByFacet, 30),
      countsByNodeKind,
      countsBySymbolKind,
      countsByTag: topEntries(countsByTag, 30),
      entryFileIds: this.input.snapshot.entryFileIds,
      existingLayouts: this.existingLayouts.map((layout) => ({
        id: layout.id,
        nodeScope: layout.nodeScope,
        strategy: layout.strategy,
        title: layout.title,
        updatedAt: layout.updatedAt,
      })),
      prompt: this.input.prompt,
      rootDir: this.input.rootDir,
      topDirectories,
      totalEdges: this.input.snapshot.edges.length,
      totalNodes: nodes.length,
    }
  }

  private findNodes(args: Record<string, unknown>) {
    const selector = parseSelector(args)
    const limit = clampLimit(args.limit)
    const matchedNodes = this.matchNodes(selector)
    const nodes = matchedNodes.slice(0, limit).map((node) => this.toNodeRef(node))
    const truncated = matchedNodes.length > nodes.length

    return this.prepareResult({
      limit,
      nodes,
      total: matchedNodes.length,
      truncated,
    }, undefined, {
      returnedNodeCount: nodes.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private getNodes(args: Record<string, unknown>) {
    const requestedNodeIds = parseStringArray(args.nodeIds)
    const nodeIds = requestedNodeIds.slice(0, MAX_LAYOUT_QUERY_LIMIT)
    const nodes = nodeIds
      .map((nodeId) => this.input.snapshot.nodes[nodeId])
      .filter((node): node is ProjectNode => Boolean(node))
      .map((node) => this.toNodeRef(node))
    const truncated = requestedNodeIds.length > nodeIds.length

    return this.prepareResult({
      nodes,
      total: nodes.length,
      truncated,
    }, undefined, {
      returnedNodeCount: nodes.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private getNeighborhood(args: Record<string, unknown>) {
    const seedNodeIds = parseStringArray(args.seedNodeIds)
    const edgeKinds = parseStringArray(args.edgeKinds) as GraphEdgeKind[]
    const direction = parseDirection(args.direction)
    const maxDepth = Math.min(
      MAX_LAYOUT_NEIGHBORHOOD_DEPTH,
      Math.max(1, Number(args.depth ?? 1)),
    )
    const limit = clampLimit(args.limit)
    const visited = new Set<string>()
    const edgeIds = new Set<string>()
    const queue = seedNodeIds
      .filter((nodeId) => this.input.snapshot.nodes[nodeId])
      .map((nodeId) => ({ depth: 0, nodeId }))

    for (const seedNodeId of seedNodeIds) {
      if (this.input.snapshot.nodes[seedNodeId]) {
        visited.add(seedNodeId)
      }
    }

    while (queue.length > 0 && visited.size < limit) {
      const current = queue.shift()

      if (!current || current.depth >= maxDepth) {
        continue
      }

      for (const edge of this.edgeByNodeId.get(current.nodeId) ?? []) {
        if (edgeKinds.length > 0 && !edgeKinds.includes(edge.kind)) {
          continue
        }

        const isOutgoing = edge.source === current.nodeId
        const isIncoming = edge.target === current.nodeId

        if (direction === 'incoming' && !isIncoming) {
          continue
        }

        if (direction === 'outgoing' && !isOutgoing) {
          continue
        }

        const nextNodeId = isOutgoing ? edge.target : edge.source

        edgeIds.add(edge.id)

        if (!visited.has(nextNodeId)) {
          visited.add(nextNodeId)
          queue.push({ depth: current.depth + 1, nodeId: nextNodeId })
        }

        if (visited.size >= limit) {
          break
        }
      }
    }

    const nodes = [...visited]
      .map((nodeId) => this.input.snapshot.nodes[nodeId])
      .filter((node): node is ProjectNode => Boolean(node))
      .sort((left, right) => compareQueryNodes(this.input.snapshot, this.degreeByNodeId, left, right))
      .map((node) => this.toNodeRef(node))
    const edges = [...edgeIds]
      .map((edgeId) => this.input.snapshot.edges.find((edge) => edge.id === edgeId))
      .filter((edge): edge is GraphEdge => Boolean(edge))
      .map(toEdgeRef)

    const truncated = visited.size >= limit

    return this.prepareResult({
      depth: maxDepth,
      edges,
      nodes,
      seedNodeIds,
      truncated,
    }, undefined, {
      returnedEdgeCount: edges.length,
      returnedNodeCount: nodes.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private summarizeScope(args: Record<string, unknown>) {
    const selector = parseSelector(args.selector ?? args)
    const representativeLimit = clampLimit(args.limit, 24)
    const nodes = this.matchNodes(selector)
    const representativeNodes = nodes
      .slice(0, representativeLimit)
      .map((node) => this.toNodeRef(node))
    const truncated = nodes.length > representativeNodes.length

    return this.prepareResult({
      countsByFacet: topEntries(countStrings(nodes.flatMap((node) => node.facets)), 20),
      countsByNodeKind: countBy(nodes, (node) => node.kind),
      countsByPath: topEntries(countStrings(nodes.map((node) => getTopDirectory(node.path) ?? '.')), 20),
      countsBySymbolKind: countBy(
        nodes.filter((node) => node.kind === 'symbol'),
        (node) => (node.kind === 'symbol' ? node.symbolKind : 'unknown'),
      ),
      representativeNodes,
      total: nodes.length,
      truncated,
    }, undefined, {
      returnedNodeCount: representativeNodes.length,
      truncatedResultCount: truncated ? 1 : 0,
    })
  }

  private previewHybridLayout(args: Record<string, unknown>) {
    const proposal = parseHybridProposal(args.proposal ?? args)
    const result = materializeHybridLayoutProposal({
      baseLayoutId: this.input.baseLayoutId,
      existingLayouts: this.existingLayouts,
      prompt: this.input.prompt,
      proposal,
      rootDir: this.input.rootDir,
      snapshot: this.input.snapshot,
      visibleNodeIds: this.input.visibleNodeIds,
    })

    return {
      hiddenNodeCount: result.hiddenNodeIds.length,
      issues: result.validation.issues,
      placementCount: result.placementCount,
      unresolvedSelectors: result.unresolvedSelectors,
      valid: result.validation.valid,
      warnings: result.warnings,
    }
  }

  private async createLayoutDraft(args: Record<string, unknown>) {
    const proposal = parseHybridProposal(args.proposal ?? args)
    const { draft, result } = await createHybridLayoutDraft({
      baseLayoutId: this.input.baseLayoutId,
      existingLayouts: this.existingLayouts,
      prompt: this.input.prompt,
      proposal,
      rootDir: this.input.rootDir,
      snapshot: this.input.snapshot,
      visibleNodeIds: this.input.visibleNodeIds,
    })

    this.createdDraft = draft

    const resultPayload = {
      draftId: draft.id,
      hiddenNodeCount: result.hiddenNodeIds.length,
      issues: result.validation.issues,
      placementCount: result.placementCount,
      status: draft.status,
      title: draft.layout?.title ?? proposal.title,
      valid: result.validation.valid,
      warnings: result.warnings,
    }
    const serialized = JSON.stringify(resultPayload)
    this.outputChars += Math.min(serialized.length, MAX_LAYOUT_QUERY_OUTPUT_CHARS)

    return {
      draft,
      ok: true,
      result: resultPayload,
    }
  }

  private matchNodes(selector: LayoutSelector) {
    return Object.values(this.input.snapshot.nodes)
      .filter((node) =>
        isNodeInScope(node, this.input.nodeScope ?? 'symbols') &&
        matchLayoutSelector(
          this.input.snapshot,
          selector,
          node,
          this.degreeByNodeId.get(node.id) ?? 0,
        ),
      )
      .sort((left, right) => compareQueryNodes(this.input.snapshot, this.degreeByNodeId, left, right))
  }

  private toNodeRef(node: ProjectNode): LayoutQueryNodeRef {
    const base = {
      degree: this.degreeByNodeId.get(node.id) ?? 0,
      facets: node.facets,
      id: node.id,
      kind: node.kind,
      loc: getNodeLoc(this.input.snapshot, node),
      name: node.name,
      path: node.path,
      tags: node.tags,
    }

    if (node.kind === 'symbol') {
      return {
        ...base,
        fileId: node.fileId,
        range: node.range,
        symbolKind: node.symbolKind,
      }
    }

    return base
  }

  private prepareResult(
    result: unknown,
    draft?: LayoutDraft,
    statsDelta?: LayoutQueryStatsDelta,
  ): LayoutQuerySessionResult {
    const serialized = JSON.stringify(result)

    if (this.outputChars + serialized.length > MAX_LAYOUT_QUERY_OUTPUT_CHARS) {
      this.stats.truncatedResultCount += 1
      return {
        budgetExhausted: true,
        ok: false,
        warning:
          'Layout query output budget exhausted. Narrow the query with stricter filters or create the draft from the information already returned.',
      }
    }

    this.outputChars += serialized.length
    this.applyStatsDelta(statsDelta)

    return {
      draft,
      ok: true,
      result,
    }
  }

  private applyStatsDelta(statsDelta?: LayoutQueryStatsDelta) {
    if (!statsDelta) {
      return
    }

    this.stats.returnedEdgeCount += statsDelta.returnedEdgeCount ?? 0
    this.stats.returnedNodeCount += statsDelta.returnedNodeCount ?? 0
    this.stats.truncatedResultCount += statsDelta.truncatedResultCount ?? 0
  }
}

export function createLayoutQuerySession(
  id: string,
  input: LayoutQuerySessionInput,
) {
  return new LayoutQuerySession(id, input)
}

function parseSelector(value: unknown): LayoutSelector {
  if (!value || typeof value !== 'object') {
    return {}
  }

  return value as LayoutSelector
}

function parseHybridProposal(value: unknown): HybridLayoutProposal {
  if (!value || typeof value !== 'object') {
    throw new Error('A hybrid layout proposal object is required.')
  }

  const proposal = value as HybridLayoutProposal

  if (!proposal.title || typeof proposal.title !== 'string') {
    throw new Error('Hybrid layout proposal requires a title.')
  }

  return proposal
}

function parseStringArray(value: unknown): string[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }

  return typeof value === 'string' ? [value] : []
}

function parseDirection(value: unknown): 'both' | 'incoming' | 'outgoing' {
  return value === 'incoming' || value === 'outgoing' ? value : 'both'
}

function clampLimit(value: unknown, defaultLimit = DEFAULT_LAYOUT_QUERY_LIMIT) {
  const numericValue = Number(value ?? defaultLimit)

  if (!Number.isFinite(numericValue)) {
    return defaultLimit
  }

  return Math.max(1, Math.min(MAX_LAYOUT_QUERY_LIMIT, Math.floor(numericValue)))
}

function toEdgeRef(edge: GraphEdge): LayoutQueryEdgeRef {
  return {
    id: edge.id,
    inferred: edge.inferred,
    kind: edge.kind,
    label: edge.label,
    source: edge.source,
    target: edge.target,
  }
}

function buildDegreeMap(edges: GraphEdge[]) {
  const degreeByNodeId = new Map<string, number>()

  for (const edge of edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1)
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1)
  }

  return degreeByNodeId
}

function buildEdgeIndex(edges: GraphEdge[]) {
  const edgeByNodeId = new Map<string, GraphEdge[]>()

  for (const edge of edges) {
    const sourceEdges = edgeByNodeId.get(edge.source) ?? []
    sourceEdges.push(edge)
    edgeByNodeId.set(edge.source, sourceEdges)

    const targetEdges = edgeByNodeId.get(edge.target) ?? []
    targetEdges.push(edge)
    edgeByNodeId.set(edge.target, targetEdges)
  }

  return edgeByNodeId
}

function compareQueryNodes(
  snapshot: ProjectSnapshot,
  degreeByNodeId: Map<string, number>,
  left: ProjectNode,
  right: ProjectNode,
) {
  const degreeDelta = (degreeByNodeId.get(right.id) ?? 0) - (degreeByNodeId.get(left.id) ?? 0)

  if (degreeDelta !== 0) {
    return degreeDelta
  }

  const locDelta = getNodeLoc(snapshot, right) - getNodeLoc(snapshot, left)

  if (locDelta !== 0) {
    return locDelta
  }

  return left.path.localeCompare(right.path) || left.name.localeCompare(right.name)
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  return Object.fromEntries(topEntries(countStrings(items.map(getKey)), 100))
}

function countStrings(values: string[]) {
  const counts = new Map<string, number>()

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return counts
}

function topEntries(counts: Map<string, number>, limit: number) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
}

function getTopDirectory(path: string) {
  const [firstSegment] = path.split('/').filter(Boolean)
  return firstSegment
}

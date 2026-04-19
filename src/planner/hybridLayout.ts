import { randomUUID } from 'node:crypto'

import type {
  HybridLayoutProposal,
  LayoutArrangementSpacing,
  LayoutSelector,
} from '../schema/layoutSuggestion'
import type {
  LayoutAnnotation,
  LayoutLane,
  LayoutNodePlacement,
  LayoutNodeScope,
  LayoutSpec,
} from '../schema/layout'
import type { LayoutDraft, LayoutPlannerProposalEnvelope } from '../schema/planner'
import {
  buildLayoutPlannerContext,
  materializeAgentLayout,
  saveLayoutDraft,
  validateLayoutPlannerProposal,
} from './index'
import {
  isSymbolNode,
  type GraphEdgeKind,
  type ProjectNode,
  type ProjectSnapshot,
} from '../schema/snapshot'

const DEFAULT_SYMBOL_WIDTH = 248
const DEFAULT_SYMBOL_HEIGHT = 82
const DEFAULT_FILE_WIDTH = 260
const DEFAULT_FILE_HEIGHT = 80
const DEFAULT_DIRECTORY_WIDTH = 280
const DEFAULT_DIRECTORY_HEIGHT = 110

export interface MaterializeHybridLayoutInput {
  baseLayoutId?: string | null
  existingLayouts?: LayoutSpec[]
  prompt: string
  proposal: HybridLayoutProposal
  rootDir: string
  snapshot: ProjectSnapshot
  visibleNodeIds?: string[]
}

export interface MaterializeHybridLayoutResult {
  envelope: LayoutPlannerProposalEnvelope
  hiddenNodeIds: string[]
  placementCount: number
  unresolvedSelectors: string[]
  validation: ReturnType<typeof validateLayoutPlannerProposal>
  warnings: string[]
}

export async function createHybridLayoutDraft(
  input: MaterializeHybridLayoutInput,
): Promise<{
  draft: LayoutDraft
  result: MaterializeHybridLayoutResult
}> {
  const result = materializeHybridLayoutProposal(input)
  const timestamp = new Date().toISOString()
  const draft: LayoutDraft = {
    id: `draft:${randomUUID()}`,
    source: 'agent',
    status: result.validation.valid ? 'draft' : 'rejected',
    prompt: input.prompt,
    proposalEnvelope: result.envelope,
    layout: result.validation.valid
      ? materializeAgentLayout(
          buildHybridPlannerContext(input, resolveProposalNodeScope(input.proposal)),
          result.envelope,
          {
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        )
      : null,
    validation: result.validation,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await saveLayoutDraft(input.rootDir, draft)

  return {
    draft,
    result,
  }
}

export function materializeHybridLayoutProposal(
  input: MaterializeHybridLayoutInput,
): MaterializeHybridLayoutResult {
  const proposal = normalizeHybridProposal(input.proposal)
  const nodeScope = resolveProposalNodeScope(proposal)
  const context = buildHybridPlannerContext(input, nodeScope)
  const scopedNodeIds = new Set(context.nodes.map((node) => node.id))
  const scopedNodes = context.nodes
    .map((nodeRef) => input.snapshot.nodes[nodeRef.id])
    .filter(Boolean)
  const visibleNodeIds = resolveVisibleNodeIds({
    input,
    nodeScope,
    proposal,
    scopedNodeIds,
  })
  const warnings: string[] = []
  const unresolvedSelectors: string[] = []
  const laneById = new Map<string, LayoutLane>()
  const groups = (proposal.groups ?? []).map((group) => {
    const nodeIds = resolveHybridMemberIds({
      explicitNodeIds: group.nodeIds,
      fallbackVisibleNodeIds: visibleNodeIds,
      input,
      label: `group:${group.id}`,
      scopedNodeIds,
      selector: group.selector,
      unresolvedSelectors,
    })

    return {
      collapsed: group.collapsed,
      id: group.id,
      nodeIds,
      title: group.title,
    }
  })
  const lanes = (proposal.lanes ?? []).map((lane, index) => {
    const nodeIds = resolveHybridMemberIds({
      explicitNodeIds: lane.nodeIds,
      fallbackVisibleNodeIds: visibleNodeIds,
      input,
      label: `lane:${lane.id}`,
      scopedNodeIds,
      selector: lane.selector,
      unresolvedSelectors,
    })
    const normalizedLane = {
      id: lane.id,
      nodeIds,
      order: lane.order ?? index,
      title: lane.title,
    }

    laneById.set(normalizedLane.id, normalizedLane)
    return normalizedLane
  })
  const placements = buildHybridPlacements({
    lanes,
    nodes: scopedNodes,
    proposal,
    snapshot: input.snapshot,
    visibleNodeIds,
  })
  const hiddenNodeIds = Array.from(scopedNodeIds)
    .filter((nodeId) => !visibleNodeIds.has(nodeId))
    .sort()
  const annotations = normalizeAnnotations(proposal.annotations ?? [])
  const envelope: LayoutPlannerProposalEnvelope = {
    proposal: {
      annotations,
      description: proposal.description,
      groups,
      hiddenNodeIds,
      lanes,
      placements: Object.values(placements),
      strategy: 'agent',
      title: proposal.title,
    },
    ambiguities: unresolvedSelectors,
    confidence: unresolvedSelectors.length > 0 ? 0.68 : 0.82,
    rationale: buildHybridRationale(proposal),
    warnings,
  }
  const validation = validateLayoutPlannerProposal(context, envelope)

  return {
    envelope,
    hiddenNodeIds,
    placementCount: Object.keys(placements).length,
    unresolvedSelectors,
    validation,
    warnings,
  }
}

export function matchLayoutSelector(
  snapshot: ProjectSnapshot,
  selector: LayoutSelector,
  node: ProjectNode,
  degree: number,
) {
  if (selector.nodeIds?.length && !selector.nodeIds.includes(node.id)) {
    return false
  }

  if (!matchesStringOrArray(selector.kind, node.kind)) {
    return false
  }

  if (
    selector.symbolKind &&
    (!isSymbolNode(node) || !matchesStringOrArray(selector.symbolKind, node.symbolKind))
  ) {
    return false
  }

  if (selector.facet && !matchesAny(selector.facet, node.facets)) {
    return false
  }

  if (selector.tag && !matchesAny(selector.tag, node.tags)) {
    return false
  }

  if (selector.pathPrefix && !node.path.startsWith(selector.pathPrefix)) {
    return false
  }

  if (selector.pathContains && !node.path.includes(selector.pathContains)) {
    return false
  }

  if (
    selector.nameContains &&
    !node.name.toLowerCase().includes(selector.nameContains.toLowerCase())
  ) {
    return false
  }

  if (selector.nameRegex) {
    try {
      if (!new RegExp(selector.nameRegex).test(node.name)) {
        return false
      }
    } catch {
      return false
    }
  }

  const loc = getNodeLoc(snapshot, node)

  if (selector.locMin !== undefined && loc < selector.locMin) {
    return false
  }

  if (selector.locMax !== undefined && loc > selector.locMax) {
    return false
  }

  if (selector.degreeMin !== undefined && degree < selector.degreeMin) {
    return false
  }

  if (selector.degreeMax !== undefined && degree > selector.degreeMax) {
    return false
  }

  return true
}

export function getNodeLoc(snapshot: ProjectSnapshot, node: ProjectNode): number {
  if (isSymbolNode(node) && node.range) {
    return Math.max(1, node.range.end.line - node.range.start.line + 1)
  }

  if (node.kind === 'file') {
    return node.content ? node.content.split(/\r?\n/).length : 1
  }

  if (node.kind === 'directory') {
    return node.childIds.reduce<number>((total, childId) => {
      const child = snapshot.nodes[childId]
      return child ? total + getNodeLoc(snapshot, child) : total
    }, 0)
  }

  return 1
}

export function isNodeInScope(node: ProjectNode, nodeScope: LayoutNodeScope) {
  if (nodeScope === 'symbols') {
    return node.kind === 'symbol'
  }

  if (nodeScope === 'filesystem') {
    return node.kind === 'file' || node.kind === 'directory'
  }

  return true
}

function normalizeHybridProposal(proposal: HybridLayoutProposal): HybridLayoutProposal {
  return {
    ...proposal,
    title: proposal.title?.trim() || 'Custom layout',
  }
}

function resolveProposalNodeScope(proposal: HybridLayoutProposal): LayoutNodeScope {
  return proposal.nodeScope ?? 'symbols'
}

function buildHybridPlannerContext(
  input: MaterializeHybridLayoutInput,
  nodeScope: LayoutNodeScope,
) {
  return buildLayoutPlannerContext(input.snapshot, {
    baseLayoutId: input.baseLayoutId,
    constraints: {
      allowDirectories: nodeScope !== 'symbols',
      allowFiles: nodeScope !== 'symbols',
      allowSymbols: nodeScope !== 'filesystem',
      nodeScope,
    },
    existingLayouts: input.existingLayouts,
    prompt: input.prompt,
    visibleNodeIds: input.visibleNodeIds,
  })
}

function resolveVisibleNodeIds(input: {
  input: MaterializeHybridLayoutInput
  nodeScope: LayoutNodeScope
  proposal: HybridLayoutProposal
  scopedNodeIds: Set<string>
}) {
  const visibleNodeIds = new Set<string>()
  const degreeByNodeId = buildDegreeMap(input.input.snapshot.edges)
  const includeSelectors = input.proposal.visibility?.include ?? []

  if (includeSelectors.length > 0) {
    for (const selector of includeSelectors) {
      for (const node of Object.values(input.input.snapshot.nodes)) {
        if (
          input.scopedNodeIds.has(node.id) &&
          matchLayoutSelector(
            input.input.snapshot,
            selector,
            node,
            degreeByNodeId.get(node.id) ?? 0,
          )
        ) {
          visibleNodeIds.add(node.id)
        }
      }
    }
  } else if (input.input.visibleNodeIds?.length) {
    for (const nodeId of input.input.visibleNodeIds) {
      if (input.scopedNodeIds.has(nodeId)) {
        visibleNodeIds.add(nodeId)
      }
    }
  } else {
    for (const nodeId of input.scopedNodeIds) {
      visibleNodeIds.add(nodeId)
    }
  }

  for (const selector of input.proposal.visibility?.exclude ?? []) {
    for (const node of Object.values(input.input.snapshot.nodes)) {
      if (
        visibleNodeIds.has(node.id) &&
        matchLayoutSelector(
          input.input.snapshot,
          selector,
          node,
          degreeByNodeId.get(node.id) ?? 0,
        )
      ) {
        visibleNodeIds.delete(node.id)
      }
    }
  }

  for (const hiddenNodeId of input.proposal.visibility?.hiddenNodeIds ?? []) {
    visibleNodeIds.delete(hiddenNodeId)
  }

  for (const anchor of input.proposal.anchors ?? []) {
    if (input.scopedNodeIds.has(anchor.nodeId)) {
      visibleNodeIds.add(anchor.nodeId)
    }
  }

  return visibleNodeIds
}

function resolveHybridMemberIds(input: {
  explicitNodeIds?: string[]
  fallbackVisibleNodeIds: Set<string>
  input: MaterializeHybridLayoutInput
  label: string
  scopedNodeIds: Set<string>
  selector?: LayoutSelector
  unresolvedSelectors: string[]
}) {
  const nodeIds = new Set<string>()

  for (const nodeId of input.explicitNodeIds ?? []) {
    if (input.scopedNodeIds.has(nodeId) && input.fallbackVisibleNodeIds.has(nodeId)) {
      nodeIds.add(nodeId)
    }
  }

  if (input.selector) {
    const degreeByNodeId = buildDegreeMap(input.input.snapshot.edges)

    for (const node of Object.values(input.input.snapshot.nodes)) {
      if (
        input.scopedNodeIds.has(node.id) &&
        input.fallbackVisibleNodeIds.has(node.id) &&
        matchLayoutSelector(
          input.input.snapshot,
          input.selector,
          node,
          degreeByNodeId.get(node.id) ?? 0,
        )
      ) {
        nodeIds.add(node.id)
      }
    }
  }

  if ((input.explicitNodeIds?.length || input.selector) && nodeIds.size === 0) {
    input.unresolvedSelectors.push(input.label)
  }

  return [...nodeIds].sort()
}

function buildHybridPlacements(input: {
  lanes: LayoutLane[]
  nodes: ProjectNode[]
  proposal: HybridLayoutProposal
  snapshot: ProjectSnapshot
  visibleNodeIds: Set<string>
}) {
  const placements: Record<string, LayoutNodePlacement> = {}
  const anchoredNodeIds = new Set<string>()

  for (const anchor of input.proposal.anchors ?? []) {
    const node = input.snapshot.nodes[anchor.nodeId]

    if (!node || !input.visibleNodeIds.has(anchor.nodeId)) {
      continue
    }

    anchoredNodeIds.add(anchor.nodeId)
    placements[anchor.nodeId] = {
      height: anchor.height ?? getDefaultNodeSize(node).height,
      nodeId: anchor.nodeId,
      width: anchor.width ?? getDefaultNodeSize(node).width,
      x: anchor.x,
      y: anchor.y,
    }
  }

  const unplacedNodes = input.nodes
    .filter((node) => input.visibleNodeIds.has(node.id) && !anchoredNodeIds.has(node.id))
    .sort((left, right) => compareLayoutNodes(input.snapshot, left, right, input.proposal))
  const mode = input.proposal.arrangement?.mode ?? 'lanes'
  const spacing = resolveSpacing(input.proposal.arrangement?.spacing ?? 'normal')

  if (mode === 'radial') {
    placeRadial(unplacedNodes, placements, spacing)
  } else if (mode === 'dependency_flow') {
    placeDependencyFlow(unplacedNodes, placements, input.snapshot, spacing)
  } else if (mode === 'grid' || input.lanes.length === 0) {
    placeGrid(unplacedNodes, placements, spacing)
  } else {
    placeLanes(unplacedNodes, placements, input.snapshot, input.lanes, spacing)
  }

  return resolvePlacementCollisions(placements)
}

function placeLanes(
  nodes: ProjectNode[],
  placements: Record<string, LayoutNodePlacement>,
  snapshot: ProjectSnapshot,
  lanes: LayoutLane[],
  spacing: { x: number; y: number },
) {
  const placed = new Set<string>()
  const sortedLanes = [...lanes].sort((left, right) => left.order - right.order)

  sortedLanes.forEach((lane, laneIndex) => {
    let cursorY = 0

    for (const nodeId of lane.nodeIds) {
      const node = snapshot.nodes[nodeId]

      if (!node || placed.has(nodeId) || placements[nodeId]) {
        continue
      }

      const size = getDefaultNodeSize(node)
      placements[nodeId] = {
        ...size,
        nodeId,
        x: laneIndex * spacing.x,
        y: cursorY,
      }
      cursorY += size.height + spacing.y
      placed.add(nodeId)
    }
  })

  const remainingNodes = nodes.filter((node) => !placed.has(node.id))
  const remainingBaseX = sortedLanes.length * spacing.x
  let cursorX = remainingBaseX
  let cursorY = 0
  let rowHeight = 0

  for (const node of remainingNodes) {
    const size = getDefaultNodeSize(node)

    if (cursorX > remainingBaseX && cursorX - remainingBaseX > spacing.x * 3) {
      cursorX = remainingBaseX
      cursorY += rowHeight + spacing.y
      rowHeight = 0
    }

    placements[node.id] = {
      ...size,
      nodeId: node.id,
      x: cursorX,
      y: cursorY,
    }
    cursorX += size.width + Math.round(spacing.x * 0.38)
    rowHeight = Math.max(rowHeight, size.height)
  }
}

function placeGrid(
  nodes: ProjectNode[],
  placements: Record<string, LayoutNodePlacement>,
  spacing: { x: number; y: number },
) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))

  nodes.forEach((node, index) => {
    const size = getDefaultNodeSize(node)
    placements[node.id] = {
      ...size,
      nodeId: node.id,
      x: (index % columns) * spacing.x,
      y: Math.floor(index / columns) * spacing.y,
    }
  })
}

function placeDependencyFlow(
  nodes: ProjectNode[],
  placements: Record<string, LayoutNodePlacement>,
  snapshot: ProjectSnapshot,
  spacing: { x: number; y: number },
) {
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()

  for (const edge of snapshot.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1)
  }

  const buckets = new Map<number, ProjectNode[]>()

  for (const node of nodes) {
    const rank = Math.max(
      0,
      Math.min(5, (outgoing.get(node.id) ?? 0) - (incoming.get(node.id) ?? 0) + 2),
    )
    const bucket = buckets.get(rank) ?? []
    bucket.push(node)
    buckets.set(rank, bucket)
  }

  for (const [rank, bucketNodes] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bucketNodes.forEach((node, index) => {
      const size = getDefaultNodeSize(node)
      placements[node.id] = {
        ...size,
        nodeId: node.id,
        x: rank * spacing.x,
        y: index * spacing.y,
      }
    })
  }
}

function placeRadial(
  nodes: ProjectNode[],
  placements: Record<string, LayoutNodePlacement>,
  spacing: { x: number; y: number },
) {
  const radius = Math.max(spacing.x, Math.round(nodes.length * 18))
  const centerX = radius
  const centerY = radius

  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length)
    const size = getDefaultNodeSize(node)
    placements[node.id] = {
      ...size,
      nodeId: node.id,
      x: Math.round(centerX + Math.cos(angle) * radius),
      y: Math.round(centerY + Math.sin(angle) * radius),
    }
  })
}

function resolvePlacementCollisions(
  placements: Record<string, LayoutNodePlacement>,
) {
  const occupied = new Set<string>()
  const nextPlacements: Record<string, LayoutNodePlacement> = {}

  for (const placement of Object.values(placements).sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  )) {
    let x = placement.x
    let y = placement.y
    let key = getCollisionKey(x, y)

    while (occupied.has(key)) {
      x += 48
      y += 36
      key = getCollisionKey(x, y)
    }

    occupied.add(key)
    nextPlacements[placement.nodeId] = {
      ...placement,
      x,
      y,
    }
  }

  return nextPlacements
}

function getCollisionKey(x: number, y: number) {
  return `${Math.round(x / 48)}:${Math.round(y / 36)}`
}

function compareLayoutNodes(
  snapshot: ProjectSnapshot,
  left: ProjectNode,
  right: ProjectNode,
  proposal: HybridLayoutProposal,
) {
  for (const key of proposal.arrangement?.sortBy ?? ['degree', 'loc', 'path', 'name']) {
    if (key === 'loc') {
      const delta = getNodeLoc(snapshot, right) - getNodeLoc(snapshot, left)
      if (delta !== 0) {
        return delta
      }
    }

    if (key === 'degree') {
      const degrees = buildDegreeMap(snapshot.edges)
      const delta = (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0)
      if (delta !== 0) {
        return delta
      }
    }

    if (key === 'path') {
      const delta = left.path.localeCompare(right.path)
      if (delta !== 0) {
        return delta
      }
    }

    if (key === 'name') {
      const delta = left.name.localeCompare(right.name)
      if (delta !== 0) {
        return delta
      }
    }

    if (key === 'kind') {
      const delta = left.kind.localeCompare(right.kind)
      if (delta !== 0) {
        return delta
      }
    }
  }

  return left.id.localeCompare(right.id)
}

function getDefaultNodeSize(node: ProjectNode) {
  if (node.kind === 'directory') {
    return {
      height: DEFAULT_DIRECTORY_HEIGHT,
      width: DEFAULT_DIRECTORY_WIDTH,
    }
  }

  if (node.kind === 'file') {
    return {
      height: DEFAULT_FILE_HEIGHT,
      width: DEFAULT_FILE_WIDTH,
    }
  }

  return {
    height: DEFAULT_SYMBOL_HEIGHT,
    width: DEFAULT_SYMBOL_WIDTH,
  }
}

function resolveSpacing(spacing: LayoutArrangementSpacing) {
  if (spacing === 'compact') {
    return { x: 360, y: 132 }
  }

  if (spacing === 'wide') {
    return { x: 560, y: 220 }
  }

  return { x: 450, y: 168 }
}

function normalizeAnnotations(annotations: LayoutAnnotation[]) {
  return annotations.map((annotation, index) => ({
    ...annotation,
    id: annotation.id || `annotation:${index + 1}`,
    label: annotation.label || `Annotation ${index + 1}`,
  }))
}

function buildHybridRationale(proposal: HybridLayoutProposal) {
  const parts = [
    proposal.description?.trim(),
    `Hybrid query-first layout using ${proposal.arrangement?.mode ?? 'lanes'} arrangement.`,
  ].filter(Boolean)

  if (proposal.edgeEmphasis?.length) {
    parts.push(`Emphasizes ${proposal.edgeEmphasis.join(', ')} edges.`)
  }

  return parts.join(' ')
}

function matchesStringOrArray<T extends string>(
  expected: T | T[] | undefined,
  value: T,
) {
  if (!expected) {
    return true
  }

  return Array.isArray(expected) ? expected.includes(value) : expected === value
}

function matchesAny(expected: string | string[], values: string[]) {
  const expectedValues = Array.isArray(expected) ? expected : [expected]
  return expectedValues.some((value) => values.includes(value))
}

function buildDegreeMap(edges: { kind: GraphEdgeKind; source: string; target: string }[]) {
  const degreeByNodeId = new Map<string, number>()

  for (const edge of edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1)
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1)
  }

  return degreeByNodeId
}

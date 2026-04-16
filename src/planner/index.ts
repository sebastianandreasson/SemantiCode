import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  LayoutAnnotation,
  LayoutGroup,
  LayoutLane,
  LayoutNodeScope,
  LayoutNodePlacement,
  LayoutSpec,
} from '../schema/layout'
import {
  DEFAULT_LAYOUT_PLANNER_CONSTRAINTS,
  type LayoutDraft,
  type LayoutPlanner,
  type LayoutPlannerConstraints,
  type LayoutPlannerContext,
  type LayoutPlannerPlacement,
  type LayoutPlannerProposalEnvelope,
  type LayoutPlannerRequest,
  type PlannerEdgeRef,
  type PlannerExistingLayout,
  type PlannerExistingLayoutSummary,
  type PlannerNodeRef,
  type ValidationIssue,
  type ValidationResult,
} from '../schema/planner'
import type {
  GraphEdge,
  ProjectNode,
  ProjectSnapshot,
} from '../schema/snapshot'

const LAYOUTS_DIRECTORY = '.semanticode/layouts'
const DRAFTS_DIRECTORY = '.semanticode/layouts/drafts'
const PLANNER_EDGE_KINDS = new Set(['contains', 'imports', 'calls'])

export interface BuildLayoutPlannerContextOptions {
  prompt: string
  existingLayouts?: LayoutSpec[]
  baseLayoutId?: string | null
  constraints?: Partial<LayoutPlannerConstraints>
  visibleNodeIds?: string[]
}

export interface MaterializeAgentLayoutOptions {
  id?: string
  createdAt?: string
  updatedAt?: string
}

export interface RunLayoutPlannerOptions {
  rootDir?: string
  existingLayouts?: LayoutSpec[]
  constraints?: Partial<LayoutPlannerConstraints>
  visibleNodeIds?: string[]
  throwOnError?: boolean
}

export interface RunLayoutPlannerInput {
  snapshot: ProjectSnapshot
  prompt: string
  planner: LayoutPlanner
  baseLayoutId?: string | null
  options?: RunLayoutPlannerOptions
}

export class LayoutPlannerValidationError extends Error {
  readonly validation: ValidationResult

  constructor(validation: ValidationResult) {
    super('Layout planner proposal failed validation.')
    this.name = 'LayoutPlannerValidationError'
    this.validation = validation
  }
}

export function buildLayoutPlannerContext(
  snapshot: ProjectSnapshot,
  options: BuildLayoutPlannerContextOptions,
): LayoutPlannerContext {
  const normalizedExistingLayouts = (options.existingLayouts ?? []).map(
    normalizeLayoutSpec,
  )
  const constraints = {
    ...DEFAULT_LAYOUT_PLANNER_CONSTRAINTS,
    ...options.constraints,
  }
  const baseLayout =
    options.baseLayoutId
      ? normalizedExistingLayouts.find((layout) => layout.id === options.baseLayoutId) ?? null
      : null
  const visibleNodeIds = normalizeVisibleNodeIds(
    snapshot,
    baseLayout,
    constraints.nodeScope,
    options.visibleNodeIds,
  )

  return {
    snapshotMeta: {
      schemaVersion: snapshot.schemaVersion,
      rootDir: snapshot.rootDir,
      generatedAt: snapshot.generatedAt,
      totalFiles: snapshot.totalFiles,
      totalNodes: Object.keys(snapshot.nodes).length,
      totalEdges: snapshot.edges.length,
    },
    nodes: getScopedNodes(snapshot, constraints.nodeScope).map(createPlannerNodeRef),
    edges: getScopedEdges(snapshot, constraints.nodeScope).map(createPlannerEdgeRef),
    entryFileIds: [...snapshot.entryFileIds],
    visibleNodeIds,
    availableTags: snapshot.tags.map((tag) => ({ ...tag })),
    existingLayouts: normalizedExistingLayouts.map(summarizeLayout),
    baseLayout: baseLayout ? expandExistingLayout(baseLayout) : null,
    prompt: options.prompt,
    constraints,
  }
}

export function validateLayoutPlannerProposal(
  context: LayoutPlannerContext,
  envelope: LayoutPlannerProposalEnvelope,
): ValidationResult {
  const issues: ValidationIssue[] = []
  const proposal = envelope.proposal

  if (!proposal) {
    issues.push({
      code: 'missing_proposal',
      message: 'Planner response did not include a proposal.',
      severity: 'error',
      field: 'proposal',
    })

    return {
      valid: false,
      issues,
    }
  }

  if (!proposal.title.trim()) {
    issues.push({
      code: 'missing_title',
      message: 'Planner proposal title cannot be empty.',
      severity: 'error',
      field: 'proposal.title',
    })
  }

  if (proposal.strategy !== 'agent') {
    issues.push({
      code: 'invalid_strategy',
      message: 'Planner proposal strategy must be "agent".',
      severity: 'error',
      field: 'proposal.strategy',
    })
  }

  if (!context.constraints.allowLanes && proposal.lanes.length > 0) {
    issues.push({
      code: 'disallowed_lanes',
      message: 'Planner proposal may not define lanes for this request.',
      severity: 'error',
      field: 'proposal.lanes',
    })
  }

  if (!context.constraints.allowGroups && proposal.groups.length > 0) {
    issues.push({
      code: 'disallowed_groups',
      message: 'Planner proposal may not define groups for this request.',
      severity: 'error',
      field: 'proposal.groups',
    })
  }

  if (!context.constraints.allowAnnotations && proposal.annotations.length > 0) {
    issues.push({
      code: 'disallowed_annotations',
      message: 'Planner proposal may not define annotations for this request.',
      severity: 'error',
      field: 'proposal.annotations',
    })
  }

  if (proposal.lanes.length > context.constraints.maxLanes) {
    issues.push({
      code: 'max_lanes_exceeded',
      message: `Planner proposal exceeds max lanes (${context.constraints.maxLanes}).`,
      severity: 'error',
      field: 'proposal.lanes',
    })
  }

  if (proposal.annotations.length > context.constraints.maxAnnotations) {
    issues.push({
      code: 'max_annotations_exceeded',
      message: `Planner proposal exceeds max annotations (${context.constraints.maxAnnotations}).`,
      severity: 'error',
      field: 'proposal.annotations',
    })
  }

  if (
    context.constraints.maxHiddenNodes !== null &&
    proposal.hiddenNodeIds.length > context.constraints.maxHiddenNodes
  ) {
    issues.push({
      code: 'max_hidden_nodes_exceeded',
      message: `Planner proposal exceeds max hidden nodes (${context.constraints.maxHiddenNodes}).`,
      severity: 'error',
      field: 'proposal.hiddenNodeIds',
    })
  }

  const nodeRefs = new Map(context.nodes.map((node) => [node.id, node]))
  const laneIds = new Set<string>()
  const groupIds = new Set<string>()
  const annotationIds = new Set<string>()
  const placementNodeIds = new Set<string>()
  const hiddenNodeIds = new Set<string>()

  for (const lane of proposal.lanes) {
    if (laneIds.has(lane.id)) {
      issues.push({
        code: 'duplicate_lane_id',
        message: `Duplicate lane id "${lane.id}".`,
        severity: 'error',
        field: 'proposal.lanes',
      })
      continue
    }

    laneIds.add(lane.id)
    validateReferencedNodeIds(
      lane.nodeIds,
      nodeRefs,
      issues,
      'proposal.lanes',
    )
  }

  for (const group of proposal.groups) {
    if (groupIds.has(group.id)) {
      issues.push({
        code: 'duplicate_group_id',
        message: `Duplicate group id "${group.id}".`,
        severity: 'error',
        field: 'proposal.groups',
      })
      continue
    }

    groupIds.add(group.id)
    validateReferencedNodeIds(
      group.nodeIds,
      nodeRefs,
      issues,
      'proposal.groups',
    )
  }

  for (const annotation of proposal.annotations) {
    if (annotationIds.has(annotation.id)) {
      issues.push({
        code: 'duplicate_annotation_id',
        message: `Duplicate annotation id "${annotation.id}".`,
        severity: 'error',
        field: 'proposal.annotations',
      })
      continue
    }

    annotationIds.add(annotation.id)
  }

  for (const placement of proposal.placements) {
    if (placementNodeIds.has(placement.nodeId)) {
      issues.push({
        code: 'duplicate_node_placement',
        message: `Node "${placement.nodeId}" was placed more than once.`,
        severity: 'error',
        field: 'proposal.placements',
        nodeId: placement.nodeId,
      })
      continue
    }

    placementNodeIds.add(placement.nodeId)
    validatePlacement(placement, nodeRefs, laneIds, context, issues)
  }

  for (const nodeId of proposal.hiddenNodeIds) {
    if (hiddenNodeIds.has(nodeId)) {
      issues.push({
        code: 'duplicate_hidden_node',
        message: `Hidden node "${nodeId}" was listed more than once.`,
        severity: 'error',
        field: 'proposal.hiddenNodeIds',
        nodeId,
      })
      continue
    }

    hiddenNodeIds.add(nodeId)

    if (!nodeRefs.has(nodeId)) {
      issues.push({
        code: 'unknown_node',
        message: `Hidden node "${nodeId}" does not exist in the snapshot.`,
        severity: 'error',
        field: 'proposal.hiddenNodeIds',
        nodeId,
      })
    }
  }

  return {
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
  }
}

export function materializeAgentLayout(
  context: LayoutPlannerContext,
  envelope: LayoutPlannerProposalEnvelope,
  options: MaterializeAgentLayoutOptions = {},
): LayoutSpec {
  const validation = validateLayoutPlannerProposal(context, envelope)

  if (!validation.valid) {
    throw new LayoutPlannerValidationError(validation)
  }

  const proposal = envelope.proposal
  const timestamp = options.createdAt ?? new Date().toISOString()

  return {
    id: options.id ?? createLayoutId(proposal.title),
    title: proposal.title.trim(),
    strategy: 'agent',
    nodeScope: context.constraints.nodeScope,
    description: proposal.description?.trim() || undefined,
    placements: Object.fromEntries(
      proposal.placements.map((placement) => [
        placement.nodeId,
        normalizePlacement(placement),
      ]),
    ),
    groups: proposal.groups.map(normalizeGroup),
    lanes: proposal.lanes.map(normalizeLane),
    annotations: proposal.annotations.map(normalizeAnnotation),
    hiddenNodeIds: Array.from(new Set(proposal.hiddenNodeIds)),
    createdAt: timestamp,
    updatedAt: options.updatedAt ?? timestamp,
  }
}

export async function runLayoutPlanner({
  snapshot,
  prompt,
  planner,
  baseLayoutId = null,
  options = {},
}: RunLayoutPlannerInput): Promise<LayoutDraft> {
  const rootDir = options.rootDir ?? snapshot.rootDir
  const existingLayouts =
    options.existingLayouts ?? (await listSavedLayouts(rootDir))
  const context = buildLayoutPlannerContext(snapshot, {
    prompt,
    existingLayouts,
    baseLayoutId,
    constraints: options.constraints,
    visibleNodeIds: options.visibleNodeIds,
  })
  const request: LayoutPlannerRequest = {
    prompt,
    context,
    baseLayoutId,
    constraints: context.constraints,
  }
  const proposalEnvelope = await planner(request)
  const validation = validateLayoutPlannerProposal(context, proposalEnvelope)
  const timestamp = new Date().toISOString()
  const draft: LayoutDraft = {
    id: createDraftId(),
    source: 'agent',
    status: validation.valid ? 'draft' : 'rejected',
    prompt,
    proposalEnvelope,
    layout: validation.valid
      ? materializeAgentLayout(context, proposalEnvelope, {
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      : null,
    validation,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  await saveLayoutDraft(rootDir, draft)

  if (!validation.valid && options.throwOnError) {
    throw new LayoutPlannerValidationError(validation)
  }

  return draft
}

export async function saveLayoutDraft(
  rootDir: string,
  draft: LayoutDraft,
): Promise<LayoutDraft> {
  await mkdir(getDraftsDirectory(rootDir), { recursive: true })
  await writeFile(
    getDraftFilePath(rootDir, draft.id),
    JSON.stringify(draft, null, 2),
    'utf8',
  )

  return draft
}

export async function loadLayoutDraft(
  rootDir: string,
  draftId: string,
): Promise<LayoutDraft> {
  const rawDraft = await readFile(getDraftFilePath(rootDir, draftId), 'utf8')

  return normalizeDraft(JSON.parse(rawDraft) as LayoutDraft)
}

export async function listLayoutDrafts(
  rootDir: string,
): Promise<LayoutDraft[]> {
  const draftsDirectory = getDraftsDirectory(rootDir)
  const entries = await safeReadJsonFiles<LayoutDraft>(draftsDirectory)

  return entries.map(normalizeDraft).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )
}

export async function listSavedLayouts(
  rootDir: string,
): Promise<LayoutSpec[]> {
  const layoutsDirectory = getLayoutsDirectory(rootDir)
  const entries = await readdirOrEmpty(layoutsDirectory)
  const layouts: LayoutSpec[] = []

  for (const entry of entries) {
    if (entry === 'drafts' || !entry.endsWith('.json')) {
      continue
    }

    try {
      const rawLayout = await readFile(join(layoutsDirectory, entry), 'utf8')
      layouts.push(normalizeLayoutSpec(JSON.parse(rawLayout) as LayoutSpec))
    } catch {
      continue
    }
  }

  return layouts
}

export async function acceptLayoutDraft(
  rootDir: string,
  draftId: string,
): Promise<LayoutSpec> {
  const draft = await loadLayoutDraft(rootDir, draftId)

  if (!draft.layout || !draft.validation.valid) {
    throw new LayoutPlannerValidationError(draft.validation)
  }

  const acceptedDraft: LayoutDraft = {
    ...draft,
    status: 'accepted',
    updatedAt: new Date().toISOString(),
  }

  await mkdir(getLayoutsDirectory(rootDir), { recursive: true })
  await writeFile(
    getLayoutFilePath(rootDir, draft.layout.id),
    JSON.stringify(draft.layout, null, 2),
    'utf8',
  )
  await saveLayoutDraft(rootDir, acceptedDraft)

  return draft.layout
}

export async function rejectLayoutDraft(
  rootDir: string,
  draftId: string,
): Promise<void> {
  try {
    await unlink(getDraftFilePath(rootDir, draftId))
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }
}

function createPlannerNodeRef(node: ProjectNode): PlannerNodeRef {
  if (node.kind === 'file') {
    return {
      id: node.id,
      kind: node.kind,
      path: node.path,
      tags: [...node.tags],
      size: node.size,
    }
  }

  if (node.kind === 'symbol') {
    return {
      id: node.id,
      kind: node.kind,
      path: node.path,
      fileId: node.fileId,
      symbolKind: node.symbolKind,
      tags: [...node.tags],
      range: node.range,
    }
  }

  return {
    id: node.id,
    kind: node.kind,
    path: node.path,
    tags: [...node.tags],
  }
}

function createPlannerEdgeRef(edge: GraphEdge): PlannerEdgeRef {
  return {
    id: edge.id,
    kind: edge.kind,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    inferred: edge.inferred,
  }
}

function summarizeLayout(layout: LayoutSpec): PlannerExistingLayoutSummary {
  return {
    id: layout.id,
    title: layout.title,
    strategy: layout.strategy,
    nodeScope: getLayoutNodeScope(layout),
    description: layout.description,
    updatedAt: layout.updatedAt,
  }
}

function expandExistingLayout(layout: LayoutSpec): PlannerExistingLayout {
  return {
    ...summarizeLayout(layout),
    placements: Object.values(layout.placements).sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    ),
    hiddenNodeIds: [...layout.hiddenNodeIds],
  }
}

function normalizeVisibleNodeIds(
  snapshot: ProjectSnapshot,
  baseLayout: LayoutSpec | null,
  nodeScope: LayoutNodeScope,
  visibleNodeIds?: string[],
) {
  const scopedNodeIds = new Set(getScopedNodes(snapshot, nodeScope).map((node) => node.id))

  if (visibleNodeIds) {
    return visibleNodeIds.filter((nodeId) => scopedNodeIds.has(nodeId))
  }

  if (baseLayout) {
    const hiddenNodeIds = new Set(baseLayout.hiddenNodeIds)

    return Array.from(scopedNodeIds).filter((nodeId) => !hiddenNodeIds.has(nodeId))
  }

  return Array.from(scopedNodeIds)
}

function validatePlacement(
  placement: LayoutPlannerPlacement,
  nodeRefs: Map<string, PlannerNodeRef>,
  laneIds: Set<string>,
  context: LayoutPlannerContext,
  issues: ValidationIssue[],
) {
  const nodeRef = nodeRefs.get(placement.nodeId)

  if (!nodeRef) {
    issues.push({
      code: 'unknown_node',
      message: `Placed node "${placement.nodeId}" does not exist in the snapshot.`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
    return
  }

  if (!isNodeKindAllowed(nodeRef, context.constraints)) {
    issues.push({
      code: 'disallowed_node_kind',
      message: `Node "${placement.nodeId}" of kind "${nodeRef.kind}" is disallowed by planner constraints.`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }

  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) {
    issues.push({
      code: 'invalid_coordinate',
      message: `Node "${placement.nodeId}" must have finite x and y coordinates.`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }

  if (
    placement.width !== undefined &&
    !Number.isFinite(placement.width)
  ) {
    issues.push({
      code: 'invalid_coordinate',
      message: `Node "${placement.nodeId}" width must be a finite number.`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }

  if (
    placement.height !== undefined &&
    !Number.isFinite(placement.height)
  ) {
    issues.push({
      code: 'invalid_coordinate',
      message: `Node "${placement.nodeId}" height must be a finite number.`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }

  if (placement.parentId && !nodeRefs.has(placement.parentId)) {
    issues.push({
      code: 'unknown_parent',
      message: `Node "${placement.nodeId}" references unknown parent "${placement.parentId}".`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }

  if (placement.laneId && !laneIds.has(placement.laneId)) {
    issues.push({
      code: 'unknown_lane',
      message: `Node "${placement.nodeId}" references unknown lane "${placement.laneId}".`,
      severity: 'error',
      field: 'proposal.placements',
      nodeId: placement.nodeId,
    })
  }
}

function validateReferencedNodeIds(
  nodeIds: string[],
  nodeRefs: Map<string, PlannerNodeRef>,
  issues: ValidationIssue[],
  field: string,
) {
  for (const nodeId of nodeIds) {
    if (!nodeRefs.has(nodeId)) {
      issues.push({
        code: 'unknown_node',
        message: `Referenced node "${nodeId}" does not exist in the snapshot.`,
        severity: 'error',
        field,
        nodeId,
      })
    }
  }
}

function isNodeKindAllowed(
  nodeRef: PlannerNodeRef,
  constraints: LayoutPlannerConstraints,
) {
  switch (nodeRef.kind) {
    case 'file':
      return constraints.allowFiles
    case 'directory':
      return constraints.allowDirectories
    case 'symbol':
      return constraints.allowSymbols
    default:
      return false
  }
}

function normalizePlacement(
  placement: LayoutPlannerPlacement,
): LayoutNodePlacement {
  return {
    nodeId: placement.nodeId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    parentId: placement.parentId,
    laneId: placement.laneId,
    hidden: placement.hidden,
    zIndex: placement.zIndex,
  }
}

function normalizeGroup(group: LayoutGroup): LayoutGroup {
  return {
    id: group.id,
    title: group.title,
    nodeIds: [...group.nodeIds],
    collapsed: group.collapsed,
  }
}

function normalizeLane(lane: LayoutLane): LayoutLane {
  return {
    id: lane.id,
    title: lane.title,
    order: lane.order,
    nodeIds: [...lane.nodeIds],
  }
}

function normalizeAnnotation(annotation: LayoutAnnotation): LayoutAnnotation {
  return {
    id: annotation.id,
    label: annotation.label,
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height,
  }
}

function createDraftId() {
  return `draft-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function createLayoutId(title: string) {
  return `agent-${slugify(title)}-${randomUUID().slice(0, 8)}`
}

function getScopedNodes(
  snapshot: ProjectSnapshot,
  nodeScope: LayoutNodeScope,
) {
  return Object.values(snapshot.nodes).filter((node) => {
    if (nodeScope !== 'symbols') {
      return true
    }

    return node.kind === 'symbol'
  })
}

function getScopedEdges(
  snapshot: ProjectSnapshot,
  nodeScope: LayoutNodeScope,
) {
  const allowedNodeIds = new Set(
    getScopedNodes(snapshot, nodeScope).map((node) => node.id),
  )

  return snapshot.edges.filter((edge) => {
    if (!PLANNER_EDGE_KINDS.has(edge.kind)) {
      return false
    }

    if (!allowedNodeIds.has(edge.source) || !allowedNodeIds.has(edge.target)) {
      return false
    }

    if (nodeScope !== 'symbols') {
      return true
    }

    if (edge.kind === 'calls') {
      return true
    }

    if (edge.kind !== 'contains') {
      return false
    }

    const sourceNode = snapshot.nodes[edge.source]
    const targetNode = snapshot.nodes[edge.target]

    return sourceNode?.kind === 'symbol' && targetNode?.kind === 'symbol'
  })
}

function normalizeLayoutSpec(layout: LayoutSpec): LayoutSpec {
  return {
    ...layout,
    nodeScope: getLayoutNodeScope(layout),
  }
}

function normalizeDraft(draft: LayoutDraft): LayoutDraft {
  return {
    ...draft,
    layout: draft.layout ? normalizeLayoutSpec(draft.layout) : null,
  }
}

function getLayoutNodeScope(
  layout: Pick<LayoutSpec, 'nodeScope'>,
): LayoutNodeScope {
  return layout.nodeScope ?? 'filesystem'
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'layout'
}

function getLayoutsDirectory(rootDir: string) {
  return join(rootDir, LAYOUTS_DIRECTORY)
}

function getDraftsDirectory(rootDir: string) {
  return join(rootDir, DRAFTS_DIRECTORY)
}

function getDraftFilePath(rootDir: string, draftId: string) {
  return join(getDraftsDirectory(rootDir), `${toFileSafeId(draftId)}.json`)
}

function getLayoutFilePath(rootDir: string, layoutId: string) {
  return join(getLayoutsDirectory(rootDir), `${toFileSafeId(layoutId)}.json`)
}

function toFileSafeId(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, '-')
}

async function readdirOrEmpty(directoryPath: string) {
  try {
    return await readdir(directoryPath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }

    throw error
  }
}

async function safeReadJsonFiles<T>(directoryPath: string): Promise<T[]> {
  const entries = await readdirOrEmpty(directoryPath)
  const results: T[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue
    }

    try {
      const rawValue = await readFile(join(directoryPath, entry), 'utf8')
      results.push(JSON.parse(rawValue) as T)
    } catch {
      continue
    }
  }

  return results
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export {
  DEFAULT_LAYOUT_PLANNER_CONSTRAINTS,
  type LayoutDraft,
  type LayoutPlanner,
  type LayoutPlannerConstraints,
  type LayoutPlannerContext,
  type LayoutPlannerPlacement,
  type LayoutPlannerProposalEnvelope,
  type LayoutPlannerRequest,
  type ValidationResult,
}

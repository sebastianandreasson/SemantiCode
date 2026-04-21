import { isSymbolNode, type ProjectSnapshot } from '../schema/snapshot'
import type { LayoutSpec } from '../schema/layout'
import type { LayoutDraft } from '../schema/planner'
import type {
  CanvasBaseScene,
  LayoutCompareOverlayReference,
} from '../schema/scene'

export interface ResolvedCanvasScene {
  kind: 'layout' | 'semantic_projection' | 'agent_focus_semantic'
  nodeScope: LayoutSpec['nodeScope']
  layoutSpec: LayoutSpec
}

export interface ResolvedCanvasOverlay {
  kind: 'layout_compare'
  sourceType: LayoutCompareOverlayReference['sourceType']
  sourceId: string
  sourceTitle: string
  nodeIds: string[]
  missingNodeIds: string[]
  groupTitles: string[]
  laneTitles: string[]
}

export function resolveCanvasScene(input: {
  activeLayout: LayoutSpec | null
  agentFocusLayout?: LayoutSpec | null
  baseScene: CanvasBaseScene
  layouts: LayoutSpec[]
}): ResolvedCanvasScene | null {
  if (input.baseScene.kind === 'agent_focus_semantic') {
    if (!input.agentFocusLayout) {
      return null
    }

    return {
      kind: 'agent_focus_semantic',
      nodeScope: input.agentFocusLayout.nodeScope,
      layoutSpec: input.agentFocusLayout,
    }
  }

  if (input.baseScene.kind === 'semantic_projection') {
    const semanticLayout =
      input.layouts.find((layout) => layout.strategy === 'semantic') ??
      input.activeLayout

    if (!semanticLayout) {
      return null
    }

    return {
      kind: 'semantic_projection',
      nodeScope: semanticLayout.nodeScope,
      layoutSpec: semanticLayout,
    }
  }

  if (!input.activeLayout) {
    return null
  }

  return {
    kind: 'layout',
    nodeScope: input.activeLayout.nodeScope,
    layoutSpec: input.activeLayout,
  }
}

export function resolveLayoutCompareOverlay(input: {
  snapshot: ProjectSnapshot
  compareOverlay: LayoutCompareOverlayReference | null
  draftLayouts: LayoutDraft[]
  layouts: LayoutSpec[]
  scene: ResolvedCanvasScene | null
}): ResolvedCanvasOverlay | null {
  if (!input.compareOverlay || input.scene?.kind !== 'semantic_projection') {
    return null
  }

  const sourceLayout = getSourceLayout(input.compareOverlay, input.draftLayouts, input.layouts)

  if (!sourceLayout) {
    return null
  }

  const visibleNodeIds = new Set(
    Object.keys(input.scene.layoutSpec.placements).filter(
      (nodeId) => !input.scene?.layoutSpec.hiddenNodeIds.includes(nodeId),
    ),
  )
  const sourceHiddenNodeIds = new Set(sourceLayout.layout.hiddenNodeIds)
  const sourceSymbolIds = Object.keys(sourceLayout.layout.placements).filter((nodeId) => {
    const node = input.snapshot.nodes[nodeId]
    return Boolean(node && isSymbolNode(node) && !sourceHiddenNodeIds.has(nodeId))
  })
  const nodeIds = sourceSymbolIds.filter((nodeId) => visibleNodeIds.has(nodeId))
  const missingNodeIds = sourceSymbolIds.filter((nodeId) => !visibleNodeIds.has(nodeId))

  return {
    kind: 'layout_compare',
    sourceType: input.compareOverlay.sourceType,
    sourceId: input.compareOverlay.sourceId,
    sourceTitle: sourceLayout.title,
    nodeIds,
    missingNodeIds,
    groupTitles: sourceLayout.layout.groups.map((group) => group.title),
    laneTitles: sourceLayout.layout.lanes.map((lane) => lane.title),
  }
}

export function canCompareLayoutAgainstSemantic(layout: LayoutSpec | null | undefined) {
  return Boolean(layout && layout.nodeScope === 'symbols' && layout.strategy !== 'semantic')
}

function getSourceLayout(
  overlay: LayoutCompareOverlayReference,
  draftLayouts: LayoutDraft[],
  layouts: LayoutSpec[],
) {
  if (overlay.sourceType === 'draft') {
    const draft = draftLayouts.find((candidate) => candidate.id === overlay.sourceId)

    if (!draft?.layout) {
      return null
    }

    return {
      layout: draft.layout,
      title: draft.layout.title ?? draft.id,
    }
  }

  const layout = layouts.find((candidate) => candidate.id === overlay.sourceId)

  if (!layout) {
    return null
  }

  return {
    layout,
    title: layout.title,
  }
}

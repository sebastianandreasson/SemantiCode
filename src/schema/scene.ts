export type CanvasBaseScene =
  | {
      kind: 'active_layout'
    }
  | {
      kind: 'semantic_projection'
    }
  | {
      kind: 'agent_focus_semantic'
    }

export type CompareOverlaySourceType = 'layout' | 'draft'

export type OverlayFocusMode = 'highlight_dim'

export interface LayoutCompareOverlayReference {
  kind: 'layout_compare'
  sourceType: CompareOverlaySourceType
  sourceId: string
}

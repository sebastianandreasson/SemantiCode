export const CODEBASE_VISUALIZER_ROUTE_BASE = '/__codebase-visualizer'
export const CODEBASE_VISUALIZER_ROUTE =
  `${CODEBASE_VISUALIZER_ROUTE_BASE}/snapshot`
export const CODEBASE_VISUALIZER_LAYOUTS_ROUTE =
  `${CODEBASE_VISUALIZER_ROUTE_BASE}/layouts`
export const CODEBASE_VISUALIZER_DRAFTS_ROUTE =
  `${CODEBASE_VISUALIZER_ROUTE_BASE}/drafts`

export function buildCodebaseVisualizerDraftActionRoute(
  draftId: string,
  action: 'accept' | 'reject',
) {
  return `${CODEBASE_VISUALIZER_DRAFTS_ROUTE}/${encodeURIComponent(draftId)}/${action}`
}

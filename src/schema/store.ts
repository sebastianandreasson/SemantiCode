import type {
  LayoutSpec,
  SelectionState,
  ViewportState,
  VisualizerViewMode,
} from './layout'
import type { LayoutDraft } from './planner'
import type { AnalysisState } from './api'
import type { ProjectSnapshot } from './snapshot'
import type {
  CanvasBaseScene,
  LayoutCompareOverlayReference,
  OverlayFocusMode,
} from './scene'

export type GraphLayerKey = 'contains' | 'imports' | 'calls'

export type GraphLayerVisibility = Record<GraphLayerKey, boolean>

export interface WorkspaceUiState {
  activeDraftId?: string
  activeLayoutId?: string
}

export interface WorkingSetState {
  nodeIds: string[]
  source: 'selection' | 'manual'
  updatedAt: string | null
}

export interface UiPreferences {
  canvasWidthRatio?: number
  graphLayers?: Partial<GraphLayerVisibility>
  inspectorOpen?: boolean
  projectsSidebarOpen?: boolean
  themeMode?: 'light' | 'dark'
  viewMode?: VisualizerViewMode
  workspaceStateByRootDir?: Record<string, WorkspaceUiState>
}

export interface VisualizerStoreState {
  status: AnalysisState
  errorMessage: string | null
  snapshot: ProjectSnapshot | null
  layouts: LayoutSpec[]
  activeLayoutId: string | null
  draftLayouts: LayoutDraft[]
  activeDraftId: string | null
  viewport: ViewportState
  selection: SelectionState
  viewMode: VisualizerViewMode
  baseScene: CanvasBaseScene
  compareOverlay: LayoutCompareOverlayReference | null
  overlayVisibility: boolean
  overlayFocusMode: OverlayFocusMode
  workingSet: WorkingSetState
  collapsedDirectoryIds: string[]
  expandedSymbolClusterIds: string[]
  graphLayers: GraphLayerVisibility
}

export interface VisualizerStoreActions {
  setStatus: (status: AnalysisState) => void
  setErrorMessage: (message: string | null) => void
  setSnapshot: (snapshot: ProjectSnapshot | null) => void
  setLayouts: (layouts: LayoutSpec[]) => void
  setActiveLayoutId: (layoutId: string | null) => void
  setDraftLayouts: (draftLayouts: LayoutDraft[]) => void
  setActiveDraftId: (draftId: string | null) => void
  setViewport: (viewport: Partial<ViewportState>) => void
  setSelection: (selection: Partial<SelectionState>) => void
  setViewMode: (viewMode: VisualizerViewMode) => void
  setBaseScene: (scene: CanvasBaseScene) => void
  setCompareOverlay: (overlay: LayoutCompareOverlayReference | null) => void
  clearCompareOverlay: () => void
  setOverlayVisibility: (visible: boolean) => void
  setOverlayFocusMode: (mode: OverlayFocusMode) => void
  setWorkingSet: (
    workingSet: Partial<WorkingSetState> & Pick<WorkingSetState, 'nodeIds'>,
  ) => void
  adoptSelectionAsWorkingSet: () => void
  clearWorkingSet: () => void
  toggleCollapsedDirectory: (nodeId: string) => void
  setCollapsedDirectoryIds: (nodeIds: string[]) => void
  toggleSymbolCluster: (clusterId: string) => void
  setExpandedSymbolClusterIds: (clusterIds: string[]) => void
  selectNode: (nodeId: string | null, options?: { additive?: boolean }) => void
  selectEdge: (edgeId: string | null) => void
  setInspectorTab: (tab: SelectionState['inspectorTab']) => void
  toggleGraphLayer: (layer: GraphLayerKey) => void
  setGraphLayerVisibility: (
    layers: Partial<GraphLayerVisibility>,
  ) => void
  reset: () => void
}

export type VisualizerStore = VisualizerStoreState & VisualizerStoreActions

export const DEFAULT_GRAPH_LAYER_VISIBILITY: GraphLayerVisibility = {
  contains: true,
  imports: false,
  calls: false,
}

export const DEFAULT_WORKING_SET_STATE: WorkingSetState = {
  nodeIds: [],
  source: 'selection',
  updatedAt: null,
}

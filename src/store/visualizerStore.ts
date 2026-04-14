import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

import {
  DEFAULT_SELECTION_STATE,
  DEFAULT_VIEWPORT_STATE,
  type SelectionState,
  type VisualizerViewMode,
} from '../schema/layout'
import {
  isFileNode,
  isSymbolNode,
  type ProjectSnapshot,
} from '../schema/snapshot'
import {
  DEFAULT_GRAPH_LAYER_VISIBILITY,
  type VisualizerStore,
  type VisualizerStoreState,
} from '../schema/store'

const INITIAL_VISUALIZER_STATE: VisualizerStoreState = {
  status: 'idle',
  errorMessage: null,
  snapshot: null,
  layouts: [],
  activeLayoutId: null,
  draftLayouts: [],
  activeDraftId: null,
  viewport: DEFAULT_VIEWPORT_STATE,
  selection: DEFAULT_SELECTION_STATE,
  viewMode: 'filesystem',
  graphLayers: DEFAULT_GRAPH_LAYER_VISIBILITY,
}

export function createVisualizerStore(
  initialState: Partial<VisualizerStoreState> = {},
) {
  return createStore<VisualizerStore>()((set, get) => ({
    ...INITIAL_VISUALIZER_STATE,
    ...initialState,
    viewport: {
      ...INITIAL_VISUALIZER_STATE.viewport,
      ...initialState.viewport,
    },
    selection: {
      ...INITIAL_VISUALIZER_STATE.selection,
      ...initialState.selection,
    },
    graphLayers: {
      ...INITIAL_VISUALIZER_STATE.graphLayers,
      ...initialState.graphLayers,
    },
    setStatus: (status) => {
      set({ status })
    },
    setErrorMessage: (errorMessage) => {
      set({ errorMessage })
    },
    setSnapshot: (snapshot) => {
      const viewMode = get().viewMode
      const currentSelection = get().selection
      const nextNodeId = getNextSelectedNodeId(snapshot, currentSelection, viewMode)

      set({
        snapshot,
        selection: {
          ...currentSelection,
          nodeId: nextNodeId,
        },
      })
    },
    setLayouts: (layouts) => {
      const activeLayoutId =
        layouts.some((layout) => layout.id === get().activeLayoutId)
          ? get().activeLayoutId
          : layouts[0]?.id ?? null

      set({
        layouts,
        activeLayoutId,
      })
    },
    setActiveLayoutId: (activeLayoutId) => {
      set({ activeLayoutId })
    },
    setDraftLayouts: (draftLayouts) => {
      const activeDraftId =
        draftLayouts.some((draft) => draft.id === get().activeDraftId)
          ? get().activeDraftId
          : draftLayouts[0]?.id ?? null

      set({
        draftLayouts,
        activeDraftId,
      })
    },
    setActiveDraftId: (activeDraftId) => {
      set({ activeDraftId })
    },
    setViewport: (viewport) => {
      set((state) => ({
        viewport: {
          ...state.viewport,
          ...viewport,
        },
      }))
    },
    setSelection: (selection) => {
      set((state) => ({
        selection: {
          ...state.selection,
          ...selection,
        },
      }))
    },
    setViewMode: (viewMode) => {
      set((state) => ({
        viewMode,
        selection: {
          ...state.selection,
          nodeId: getNextSelectedNodeId(snapshotOrNull(state), state.selection, viewMode),
        },
      }))
    },
    selectNode: (nodeId) => {
      set((state) => ({
        selection: {
          ...state.selection,
          nodeId,
          edgeId: null,
          inspectorTab: 'file',
        },
      }))
    },
    selectEdge: (edgeId) => {
      set((state) => ({
        selection: {
          ...state.selection,
          edgeId,
          nodeId: state.selection.nodeId,
          inspectorTab: 'graph',
        },
      }))
    },
    setInspectorTab: (inspectorTab) => {
      set((state) => ({
        selection: {
          ...state.selection,
          inspectorTab,
        },
      }))
    },
    toggleGraphLayer: (layer) => {
      set((state) => ({
        graphLayers: {
          ...state.graphLayers,
          [layer]: !state.graphLayers[layer],
        },
      }))
    },
    setGraphLayerVisibility: (layers) => {
      set((state) => ({
        graphLayers: {
          ...state.graphLayers,
          ...layers,
        },
      }))
    },
    reset: () => {
      set(INITIAL_VISUALIZER_STATE)
    },
  }))
}

export const visualizerStore = createVisualizerStore()

export function useVisualizerStore<T>(
  selector: (state: VisualizerStore) => T,
) {
  return useStore(visualizerStore, selector)
}

function getNextSelectedNodeId(
  snapshot: ProjectSnapshot | null,
  selection: SelectionState,
  viewMode: VisualizerViewMode,
) {
  if (!snapshot) {
    return null
  }

  const selectedNode = selection.nodeId ? snapshot.nodes[selection.nodeId] : null

  if (
    selectedNode &&
    ((viewMode === 'filesystem' && selectedNode.kind !== 'symbol') ||
      (viewMode === 'symbols' && isSymbolNode(selectedNode)))
  ) {
    return selection.nodeId
  }

  return viewMode === 'symbols'
    ? getFirstSymbolNodeId(snapshot)
    : getFirstFileNodeId(snapshot)
}

function getFirstFileNodeId(snapshot: ProjectSnapshot) {
  for (const rootId of snapshot.rootIds) {
    const fileNodeId = findFirstFileNodeId(rootId, snapshot)

    if (fileNodeId) {
      return fileNodeId
    }
  }

  return null
}

function getFirstSymbolNodeId(snapshot: ProjectSnapshot) {
  return (
    Object.values(snapshot.nodes)
      .filter(isSymbolNode)
      .sort((left, right) => left.path.localeCompare(right.path))[0]?.id ?? null
  )
}

function snapshotOrNull(state: VisualizerStore) {
  return state.snapshot
}

function findFirstFileNodeId(
  nodeId: string,
  snapshot: ProjectSnapshot,
): string | null {
  const node = snapshot.nodes[nodeId]

  if (!node) {
    return null
  }

  if (isFileNode(node)) {
    return node.id
  }

  if (node.kind !== 'directory') {
    return null
  }

  for (const childId of node.childIds) {
    const fileNodeId = findFirstFileNodeId(childId, snapshot)

    if (fileNodeId) {
      return fileNodeId
    }
  }

  return null
}

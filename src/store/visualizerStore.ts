import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

import {
  DEFAULT_SELECTION_STATE,
  DEFAULT_VIEWPORT_STATE,
  type SelectionState,
  type VisualizerViewMode,
} from '../schema/layout'
import {
  isDirectoryNode,
  isFileNode,
  isSymbolNode,
  type ProjectSnapshot,
} from '../schema/snapshot'
import {
  DEFAULT_WORKING_SET_STATE,
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
  baseScene: {
    kind: 'active_layout',
  },
  compareOverlay: null,
  overlayVisibility: true,
  overlayFocusMode: 'highlight_dim',
  workingSet: DEFAULT_WORKING_SET_STATE,
  collapsedDirectoryIds: [],
  expandedSymbolClusterIds: [],
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
    workingSet: {
      ...INITIAL_VISUALIZER_STATE.workingSet,
      ...initialState.workingSet,
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
      const nextNodeIds = getNextSelectedNodeIds(snapshot, currentSelection, viewMode, nextNodeId)
      const nextWorkingSetNodeIds = getNextWorkingSetNodeIds(snapshot, get().workingSet.nodeIds)
      const nextCollapsedDirectoryIds = getNextCollapsedDirectoryIds(
        snapshot,
        get().collapsedDirectoryIds,
      )

      set({
        snapshot,
        expandedSymbolClusterIds: [],
        collapsedDirectoryIds: nextCollapsedDirectoryIds,
        workingSet: {
          ...get().workingSet,
          nodeIds: nextWorkingSetNodeIds,
          updatedAt:
            nextWorkingSetNodeIds.length === get().workingSet.nodeIds.length &&
            nextWorkingSetNodeIds.every((nodeId, index) => nodeId === get().workingSet.nodeIds[index])
              ? get().workingSet.updatedAt
              : get().workingSet.updatedAt ?? new Date().toISOString(),
        },
        selection: {
          ...currentSelection,
          nodeId: nextNodeId,
          nodeIds: nextNodeIds,
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
        baseScene:
          viewMode === 'symbols' ? state.baseScene : { kind: 'active_layout' },
        compareOverlay: viewMode === 'symbols' ? state.compareOverlay : null,
        overlayVisibility: viewMode === 'symbols' ? state.overlayVisibility : true,
        graphLayers:
          viewMode === 'symbols'
            ? {
                contains: false,
                imports: false,
                calls: true,
              }
            : {
                contains: true,
                imports: false,
                calls: false,
              },
        selection: {
          ...state.selection,
          nodeId: getNextSelectedNodeId(snapshotOrNull(state), state.selection, viewMode),
          nodeIds: getNextSelectedNodeIds(
            snapshotOrNull(state),
            state.selection,
            viewMode,
            getNextSelectedNodeId(snapshotOrNull(state), state.selection, viewMode),
          ),
        },
      }))
    },
    setBaseScene: (baseScene) => {
      set({ baseScene })
    },
    setCompareOverlay: (compareOverlay) => {
      set({ compareOverlay })
    },
    clearCompareOverlay: () => {
      set({ compareOverlay: null, overlayVisibility: true })
    },
    setOverlayVisibility: (overlayVisibility) => {
      set({ overlayVisibility })
    },
    setOverlayFocusMode: (overlayFocusMode) => {
      set({ overlayFocusMode })
    },
    setWorkingSet: (workingSet) => {
      set((state) => ({
        workingSet: {
          ...state.workingSet,
          ...workingSet,
          updatedAt: new Date().toISOString(),
        },
      }))
    },
    adoptSelectionAsWorkingSet: () => {
      set((state) => ({
        workingSet: {
          nodeIds: state.selection.nodeIds.length > 0
            ? [...state.selection.nodeIds]
            : state.selection.nodeId
              ? [state.selection.nodeId]
              : [],
          source: 'selection',
          updatedAt: new Date().toISOString(),
        },
      }))
    },
    clearWorkingSet: () => {
      set({
        workingSet: DEFAULT_WORKING_SET_STATE,
      })
    },
    toggleCollapsedDirectory: (nodeId) => {
      set((state) => {
        const snapshot = state.snapshot
        const node = snapshot?.nodes[nodeId]

        if (!snapshot || !node || !isDirectoryNode(node)) {
          return state
        }

        const isCollapsed = state.collapsedDirectoryIds.includes(nodeId)
        const collapsedDirectoryIds = isCollapsed
          ? state.collapsedDirectoryIds.filter((id) => id !== nodeId)
          : [...state.collapsedDirectoryIds, nodeId]

        const currentPrimaryNode = state.selection.nodeId
          ? snapshot.nodes[state.selection.nodeId]
          : null
        const shouldResetSelection =
          currentPrimaryNode !== null &&
          currentPrimaryNode.id !== nodeId &&
          isDescendantDirectoryNode(snapshot, nodeId, currentPrimaryNode.id)

        return {
          collapsedDirectoryIds,
          selection: shouldResetSelection
            ? {
                ...state.selection,
                nodeId,
                nodeIds: [nodeId],
                edgeId: null,
                inspectorTab: 'file',
              }
            : state.selection,
        }
      })
    },
    setCollapsedDirectoryIds: (collapsedDirectoryIds) => {
      set({ collapsedDirectoryIds })
    },
    toggleSymbolCluster: (clusterId) => {
      set((state) => ({
        expandedSymbolClusterIds: state.expandedSymbolClusterIds.includes(clusterId)
          ? state.expandedSymbolClusterIds.filter((id) => id !== clusterId)
          : [...state.expandedSymbolClusterIds, clusterId],
      }))
    },
    setExpandedSymbolClusterIds: (expandedSymbolClusterIds) => {
      set({ expandedSymbolClusterIds })
    },
    selectNode: (nodeId, options) => {
      set((state) => {
        if (!nodeId) {
          return {
            selection: {
              ...state.selection,
              nodeId: null,
              nodeIds: [],
              edgeId: null,
              inspectorTab: 'file',
            },
          }
        }

        const additive = Boolean(options?.additive)
        const snapshot = state.snapshot
        const canMultiSelect =
          additive &&
          snapshot !== null &&
          isMultiSelectableNode(snapshot, nodeId, state.viewMode) &&
          state.selection.nodeIds.every((selectedNodeId) =>
            isMultiSelectableNode(snapshot, selectedNodeId, state.viewMode),
          )

        if (canMultiSelect) {
          const alreadySelected = state.selection.nodeIds.includes(nodeId)
          const nextNodeIds = alreadySelected
            ? state.selection.nodeIds.filter((selectedNodeId) => selectedNodeId !== nodeId)
            : [...state.selection.nodeIds, nodeId]
          const nextPrimaryNodeId =
            nextNodeIds.length === 0
              ? null
              : alreadySelected && state.selection.nodeId === nodeId
                ? nextNodeIds[nextNodeIds.length - 1] ?? null
                : nodeId

          return {
            selection: {
              ...state.selection,
              nodeId: nextPrimaryNodeId,
              nodeIds: nextNodeIds,
              edgeId: null,
              inspectorTab: 'file',
            },
          }
        }

        return {
          selection: {
            ...state.selection,
            nodeId,
            nodeIds: [nodeId],
            edgeId: null,
            inspectorTab: 'file',
          },
        }
      })
    },
    selectEdge: (edgeId) => {
      set((state) => ({
        selection: {
          ...state.selection,
          edgeId,
          nodeId: state.selection.nodeId,
          nodeIds: state.selection.nodeIds,
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

function getNextSelectedNodeIds(
  snapshot: ProjectSnapshot | null,
  selection: SelectionState,
  viewMode: VisualizerViewMode,
  nextNodeId: string | null,
) {
  if (!snapshot) {
    return []
  }

  if (viewMode !== 'filesystem') {
    return nextNodeId ? [nextNodeId] : []
  }

  const nextNodeIds = selection.nodeIds.filter((nodeId) =>
    isMultiSelectableNode(snapshot, nodeId, viewMode),
  )

  if (nextNodeIds.length > 0) {
    return nextNodeIds
  }

  return nextNodeId && isMultiSelectableNode(snapshot, nextNodeId, viewMode) ? [nextNodeId] : []
}

function getNextWorkingSetNodeIds(
  snapshot: ProjectSnapshot | null,
  nodeIds: string[],
) {
  if (!snapshot) {
    return []
  }

  return nodeIds.filter((nodeId) => Boolean(snapshot.nodes[nodeId]))
}

function getNextCollapsedDirectoryIds(
  snapshot: ProjectSnapshot | null,
  nodeIds: string[],
) {
  if (!snapshot) {
    return []
  }

  return nodeIds.filter((nodeId) => {
    const node = snapshot.nodes[nodeId]
    return Boolean(node && isDirectoryNode(node))
  })
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

function isMultiSelectableNode(snapshot: ProjectSnapshot, nodeId: string, viewMode: VisualizerViewMode) {
  const node = snapshot.nodes[nodeId]
  if (!node) {
    return false
  }

  return viewMode === 'symbols' ? isSymbolNode(node) : isFileNode(node)
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

function isDescendantDirectoryNode(
  snapshot: ProjectSnapshot,
  directoryId: string,
  nodeId: string,
) {
  let currentNode = snapshot.nodes[nodeId]

  while (currentNode && !isSymbolNode(currentNode) && currentNode.parentId) {
    if (currentNode.parentId === directoryId) {
      return true
    }

    currentNode = snapshot.nodes[currentNode.parentId]
  }

  return false
}

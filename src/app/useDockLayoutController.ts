import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import type {
  DockLayoutPreference,
  DockPanelId,
  DockSlot,
  DockSlotSize,
  UiPreferences,
} from '../types'
import {
  DOCK_PANEL_DEFINITIONS,
  buildDockLayoutFromPreferences,
  clampDockSlotSize,
  dockPanelIntoSlot,
  getDockLayoutStyle,
  isDockPanelOpen,
  resizeDockSlot,
  resolveDockCandidate,
  setDockPanelOpen,
  setDockSlotActivePanel,
  type DockCandidate,
} from './dock/dockModel'

type BooleanUpdater = boolean | ((current: boolean) => boolean)

interface DockDragSession {
  kind: 'move' | 'resize'
  panelId: DockPanelId
  pointerId: number
  sourceSlot: DockSlot
  startLayout: DockLayoutPreference
  workspaceRect: DOMRect
}

export interface DockPreviewState extends DockCandidate {
  panelId: DockPanelId
}

export function useDockLayoutController(input: {
  initialPreferences: UiPreferences
}) {
  const [dockLayout, setDockLayout] = useState(() =>
    buildDockLayoutFromPreferences(input.initialPreferences),
  )
  const [dockPreview, setDockPreview] = useState<DockPreviewState | null>(null)
  const [activeDragPointerId, setActiveDragPointerId] = useState<number | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const dragSessionRef = useRef<DockDragSession | null>(null)
  const dockLayoutRef = useRef(dockLayout)

  useEffect(() => {
    dockLayoutRef.current = dockLayout
  }, [dockLayout])

  const dockPreviewRef = useRef<DockPreviewState | null>(dockPreview)

  useEffect(() => {
    dockPreviewRef.current = dockPreview
  }, [dockPreview])

  useEffect(() => {
    const session = dragSessionRef.current

    if (!session || activeDragPointerId === null) {
      return
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = session.kind === 'move'
      ? 'grabbing'
      : session.sourceSlot === 'bottom'
        ? 'ns-resize'
        : 'ew-resize'
    document.body.style.userSelect = 'none'

    function handlePointerMove(event: PointerEvent) {
      const currentSession = dragSessionRef.current

      if (!currentSession || event.pointerId !== currentSession.pointerId) {
        return
      }

      const point = {
        x: event.clientX,
        y: event.clientY,
      }

      if (currentSession.kind === 'resize') {
        const nextSize = getResizedSlotSize(currentSession, point)

        setDockLayout((currentLayout) =>
          resizeDockSlot(
            currentLayout,
            currentSession.sourceSlot,
            clampDockSlotSize(currentLayout, currentSession.sourceSlot, nextSize),
          ),
        )
        setDockPreview(null)
        return
      }

      const definition = DOCK_PANEL_DEFINITIONS[currentSession.panelId]
      const candidate = resolveDockCandidate({
        allowedSlots: definition.allowedSlots,
        layout: dockLayoutRef.current,
        point,
        sourceSlot: currentSession.sourceSlot,
        workspaceRect: currentSession.workspaceRect,
      })

      setDockPreview(
        candidate
          ? {
              ...candidate,
              panelId: currentSession.panelId,
            }
          : null,
      )

    }

    function handlePointerUp(event: PointerEvent) {
      const currentSession = dragSessionRef.current

      if (!currentSession || event.pointerId !== currentSession.pointerId) {
        return
      }

      const preview = dockPreviewRef.current

      if (currentSession.kind === 'move' && preview) {
        setDockLayout((currentLayout) =>
          dockPanelIntoSlot(currentLayout, currentSession.panelId, preview.slot),
        )
      }

      dragSessionRef.current = null
      setActiveDragPointerId(null)
      setDockPreview(null)
    }

    function handlePointerCancel(event: PointerEvent) {
      const currentSession = dragSessionRef.current

      if (!currentSession || event.pointerId !== currentSession.pointerId) {
        return
      }

      setDockLayout(currentSession.startLayout)
      dragSessionRef.current = null
      setActiveDragPointerId(null)
      setDockPreview(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return
      }

      const currentSession = dragSessionRef.current

      if (!currentSession) {
        return
      }

      setDockLayout(currentSession.startLayout)
      dragSessionRef.current = null
      setActiveDragPointerId(null)
      setDockPreview(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeDragPointerId])

  const dockWorkspaceStyle = useMemo(
    () => getDockLayoutStyle(dockLayout),
    [dockLayout],
  )

  const hydrateDockLayoutFromPreferences = useCallback((preferences: UiPreferences) => {
    setDockLayout(buildDockLayoutFromPreferences(preferences))
  }, [])

  const setPanelOpen = useCallback((panelId: DockPanelId, nextOpen: BooleanUpdater) => {
    setDockLayout((currentLayout) => {
      const currentOpen = isDockPanelOpen(currentLayout, panelId)
      const resolvedOpen =
        typeof nextOpen === 'function' ? nextOpen(currentOpen) : nextOpen

      return setDockPanelOpen(currentLayout, panelId, resolvedOpen)
    })
  }, [])

  const setSlotActivePanel = useCallback(
    (slot: DockSlot, panelId: DockPanelId) => {
      setDockLayout((currentLayout) =>
        setDockSlotActivePanel(currentLayout, slot, panelId),
      )
    },
    [],
  )

  const handleSlotHandlePointerDown = useCallback(
    (slot: DockSlot, event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return
      }

      const workspaceElement = workspaceRef.current
      const slotState = dockLayoutRef.current.slots[slot]
      const panelId = slotState.activePanelId

      if (!workspaceElement || !panelId) {
        return
      }

      dragSessionRef.current = {
        kind: 'resize',
        panelId,
        pointerId: event.pointerId,
        sourceSlot: slot,
        startLayout: dockLayoutRef.current,
        workspaceRect: workspaceElement.getBoundingClientRect(),
      }
      setActiveDragPointerId(event.pointerId)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [],
  )

  const handlePanelMovePointerDown = useCallback(
    (
      panelId: DockPanelId,
      sourceSlot: DockSlot,
      event: ReactPointerEvent<HTMLButtonElement>,
    ) => {
      if (event.button !== 0) {
        return
      }

      const workspaceElement = workspaceRef.current
      const slotState = dockLayoutRef.current.slots[sourceSlot]

      if (!workspaceElement || !slotState.panelIds.includes(panelId)) {
        return
      }

      dragSessionRef.current = {
        kind: 'move',
        panelId,
        pointerId: event.pointerId,
        sourceSlot,
        startLayout: dockLayoutRef.current,
        workspaceRect: workspaceElement.getBoundingClientRect(),
      }
      setActiveDragPointerId(event.pointerId)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [],
  )

  return {
    dockLayout,
    dockPreview,
    dockWorkspaceRef: workspaceRef,
    dockWorkspaceStyle,
    handlePanelMovePointerDown,
    handleSlotHandlePointerDown,
    hydrateDockLayoutFromPreferences,
    setDockLayout,
    setPanelOpen,
    setSlotActivePanel,
  }
}

function getResizedSlotSize(
  session: DockDragSession,
  point: { x: number; y: number },
): DockSlotSize {
  if (session.sourceSlot === 'bottom') {
    return {
      unit: 'px',
      value: session.workspaceRect.bottom - point.y,
    }
  }

  if (session.sourceSlot === 'right') {
    return {
      unit: 'px',
      value: session.workspaceRect.right - point.x,
    }
  }

  return {
    unit: 'px',
    value: point.x - session.workspaceRect.left,
  }
}

import type {
  DockLayoutPreference,
  DockPanelId,
  DockPanelState,
  DockSlot,
  DockSlotSize,
  DockSlotState,
  UiPreferences,
} from '../../types'

export const DOCK_SLOTS: DockSlot[] = ['left', 'right', 'bottom']
export const DOCK_PANEL_IDS: DockPanelId[] = ['outline', 'inspector', 'agent']

const DEFAULT_CANVAS_WIDTH_RATIO = 0.6
const MIN_CANVAS_WIDTH_RATIO = 0.32
const MAX_CANVAS_WIDTH_RATIO = 0.78

export interface DockPanelDefinition {
  id: DockPanelId
  label: string
  allowedSlots: DockSlot[]
  defaultSlot: DockSlot
  minSize: Partial<Record<DockSlot, number>>
  maxSize: Partial<Record<DockSlot, number>>
  defaultSize: Record<DockSlot, DockSlotSize>
}

export interface DockCandidate {
  slot: DockSlot
  willCreateTab: boolean
}

export const DOCK_PANEL_DEFINITIONS: Record<DockPanelId, DockPanelDefinition> = {
  outline: {
    id: 'outline',
    label: 'outline',
    allowedSlots: ['left', 'right'],
    defaultSlot: 'left',
    minSize: {
      left: 220,
      right: 220,
    },
    maxSize: {
      left: 520,
      right: 520,
    },
    defaultSize: {
      left: { value: 18, unit: 'rem' },
      right: { value: 18, unit: 'rem' },
      bottom: { value: 288, unit: 'px' },
    },
  },
  inspector: {
    id: 'inspector',
    label: 'inspector',
    allowedSlots: ['left', 'right'],
    defaultSlot: 'right',
    minSize: {
      left: 280,
      right: 280,
    },
    maxSize: {
      left: 640,
      right: 640,
    },
    defaultSize: {
      left: { value: 22.5, unit: 'rem' },
      right: { value: 0.4, unit: 'ratio' },
      bottom: { value: 320, unit: 'px' },
    },
  },
  agent: {
    id: 'agent',
    label: 'agent',
    allowedSlots: ['left', 'right', 'bottom'],
    defaultSlot: 'bottom',
    minSize: {
      left: 260,
      right: 300,
      bottom: 220,
    },
    maxSize: {
      left: 560,
      right: 680,
      bottom: 640,
    },
    defaultSize: {
      left: { value: 22, unit: 'rem' },
      right: { value: 26, unit: 'rem' },
      bottom: { value: 288, unit: 'px' },
    },
  },
}

export function buildDefaultDockLayout(): DockLayoutPreference {
  return {
    version: 1,
    slots: {
      left: {
        panelIds: ['outline'],
        activePanelId: 'outline',
        size: { value: 18, unit: 'rem' },
      },
      right: {
        panelIds: [],
        activePanelId: null,
        size: { value: 0.4, unit: 'ratio' },
      },
      bottom: {
        panelIds: [],
        activePanelId: null,
        size: { value: 288, unit: 'px' },
      },
    },
    panels: {
      outline: {
        id: 'outline',
        open: true,
        slot: 'left',
      },
      inspector: {
        id: 'inspector',
        open: false,
        slot: 'right',
      },
      agent: {
        id: 'agent',
        open: false,
        slot: 'bottom',
      },
    },
  }
}

export function buildDockLayoutFromPreferences(
  preferences: UiPreferences | Partial<UiPreferences> | null | undefined,
): DockLayoutPreference {
  const normalized = normalizeDockLayoutPreference(preferences?.dockLayout)

  if (normalized) {
    return normalized
  }

  return migrateLegacyDockPreferences(preferences)
}

export function normalizeDockLayoutPreference(
  value: unknown,
): DockLayoutPreference | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Partial<DockLayoutPreference>

  if (candidate.version !== 1 || !candidate.slots || !candidate.panels) {
    return undefined
  }

  const fallback = buildDefaultDockLayout()
  const panels = Object.fromEntries(
    DOCK_PANEL_IDS.map((panelId) => {
      const definition = DOCK_PANEL_DEFINITIONS[panelId]
      const panel = candidate.panels?.[panelId] as Partial<DockPanelState> | undefined
      const slot = isDockSlot(panel?.slot) && definition.allowedSlots.includes(panel.slot)
        ? panel.slot
        : fallback.panels[panelId].slot

      return [
        panelId,
        {
          id: panelId,
          open: typeof panel?.open === 'boolean' ? panel.open : fallback.panels[panelId].open,
          slot,
        } satisfies DockPanelState,
      ]
    }),
  ) as Record<DockPanelId, DockPanelState>

  const slots = Object.fromEntries(
    DOCK_SLOTS.map((slot) => {
      const slotState = candidate.slots?.[slot] as Partial<DockSlotState> | undefined
      const fallbackSlot = fallback.slots[slot]
      const panelIds = normalizeSlotPanelIds(slot, slotState?.panelIds, panels)
      const activePanelId =
        isDockPanelId(slotState?.activePanelId) && panelIds.includes(slotState.activePanelId)
          ? slotState.activePanelId
          : panelIds[0] ?? null

      return [
        slot,
        {
          panelIds,
          activePanelId,
          size: normalizeSlotSize(slotState?.size, fallbackSlot.size),
        } satisfies DockSlotState,
      ]
    }),
  ) as Record<DockSlot, DockSlotState>

  return normalizeDockLayout({
    version: 1,
    panels,
    slots,
  })
}

export function getDockLayoutStyle(layout: DockLayoutPreference) {
  return {
    '--cbv-dock-left-track': getSlotTrackSize(layout, 'left'),
    '--cbv-dock-right-track': getSlotTrackSize(layout, 'right'),
    '--cbv-dock-bottom-track': getSlotTrackSize(layout, 'bottom'),
  } as Record<string, string>
}

export function isDockPanelOpen(
  layout: DockLayoutPreference,
  panelId: DockPanelId,
) {
  return layout.panels[panelId]?.open === true
}

export function setDockPanelOpen(
  layout: DockLayoutPreference,
  panelId: DockPanelId,
  open: boolean,
) {
  const panel = layout.panels[panelId]

  if (!panel) {
    return layout
  }

  if (open) {
    return dockPanelIntoSlot(layout, panelId, panel.slot)
  }

  const nextLayout = cloneDockLayout(layout)
  const slot = nextLayout.slots[panel.slot]

  slot.panelIds = slot.panelIds.filter((id) => id !== panelId)
  slot.activePanelId = slot.activePanelId === panelId ? slot.panelIds[0] ?? null : slot.activePanelId
  nextLayout.panels[panelId] = {
    ...panel,
    open: false,
  }

  return normalizeDockLayout(nextLayout)
}

export function setDockSlotActivePanel(
  layout: DockLayoutPreference,
  slot: DockSlot,
  panelId: DockPanelId,
) {
  if (!layout.slots[slot].panelIds.includes(panelId)) {
    return layout
  }

  return {
    ...layout,
    slots: {
      ...layout.slots,
      [slot]: {
        ...layout.slots[slot],
        activePanelId: panelId,
      },
    },
  }
}

export function dockPanelIntoSlot(
  layout: DockLayoutPreference,
  panelId: DockPanelId,
  targetSlot: DockSlot,
) {
  const definition = DOCK_PANEL_DEFINITIONS[panelId]

  if (!definition.allowedSlots.includes(targetSlot)) {
    return layout
  }

  const nextLayout = cloneDockLayout(layout)
  const currentSlot = nextLayout.panels[panelId].slot

  for (const slot of DOCK_SLOTS) {
    nextLayout.slots[slot].panelIds = nextLayout.slots[slot].panelIds.filter(
      (id) => id !== panelId,
    )

    if (nextLayout.slots[slot].activePanelId === panelId) {
      nextLayout.slots[slot].activePanelId = nextLayout.slots[slot].panelIds[0] ?? null
    }
  }

  const target = nextLayout.slots[targetSlot]

  target.panelIds = [...target.panelIds, panelId]
  target.activePanelId = panelId
  nextLayout.panels[panelId] = {
    id: panelId,
    open: true,
    slot: targetSlot,
  }

  if (currentSlot !== targetSlot && target.panelIds.length === 1) {
    target.size = getDefaultSizeForSlot(panelId, targetSlot)
  }

  return normalizeDockLayout(nextLayout)
}

export function resizeDockSlot(
  layout: DockLayoutPreference,
  slot: DockSlot,
  size: DockSlotSize,
) {
  return {
    ...layout,
    slots: {
      ...layout.slots,
      [slot]: {
        ...layout.slots[slot],
        size,
      },
    },
  }
}

export function clampDockSlotSize(
  layout: DockLayoutPreference,
  slot: DockSlot,
  size: DockSlotSize,
) {
  const activePanelId = layout.slots[slot].activePanelId
  const definition = activePanelId ? DOCK_PANEL_DEFINITIONS[activePanelId] : null
  const minSize = definition?.minSize[slot] ?? (slot === 'bottom' ? 180 : 220)
  const maxSize = definition?.maxSize[slot] ?? (slot === 'bottom' ? 720 : 720)

  if (size.unit === 'ratio') {
    return {
      value: clampNumber(size.value, 0.18, 0.7),
      unit: 'ratio' as const,
    }
  }

  return {
    value: clampNumber(size.value, minSize, maxSize),
    unit: 'px' as const,
  }
}

export function resolveDockCandidate(input: {
  allowedSlots: DockSlot[]
  layout: DockLayoutPreference
  point: { x: number; y: number }
  sourceSlot: DockSlot
  workspaceRect: DOMRect
}): DockCandidate | null {
  const { allowedSlots, point, sourceSlot, workspaceRect } = input
  const edgeZone = Math.min(
    160,
    Math.max(72, Math.min(workspaceRect.width, workspaceRect.height) * 0.12),
  )
  const distances: Array<{ distance: number; slot: DockSlot }> = [
    { distance: point.x - workspaceRect.left, slot: 'left' },
    { distance: workspaceRect.right - point.x, slot: 'right' },
    { distance: workspaceRect.bottom - point.y, slot: 'bottom' },
  ]
  const candidate = distances
    .filter((entry) => entry.slot !== sourceSlot)
    .filter((entry) => allowedSlots.includes(entry.slot))
    .filter((entry) => entry.distance >= 0 && entry.distance <= edgeZone)
    .sort((left, right) => left.distance - right.distance)[0]

  if (!candidate) {
    return null
  }

  return {
    slot: candidate.slot,
    willCreateTab: input.layout.slots[candidate.slot].panelIds.length > 0,
  }
}

export function getLegacyCanvasWidthRatio(layout: DockLayoutPreference) {
  const rightSlot = layout.slots.right

  if (!rightSlot.panelIds.includes('inspector')) {
    return DEFAULT_CANVAS_WIDTH_RATIO
  }

  if (rightSlot.size.unit === 'ratio') {
    return clampNumber(1 - rightSlot.size.value, MIN_CANVAS_WIDTH_RATIO, MAX_CANVAS_WIDTH_RATIO)
  }

  return DEFAULT_CANVAS_WIDTH_RATIO
}

function migrateLegacyDockPreferences(
  preferences: Partial<UiPreferences> | null | undefined,
) {
  const canvasWidthRatio = clampNumber(
    preferences?.canvasWidthRatio ?? DEFAULT_CANVAS_WIDTH_RATIO,
    MIN_CANVAS_WIDTH_RATIO,
    MAX_CANVAS_WIDTH_RATIO,
  )
  const inspectorOpen = preferences?.inspectorOpen ?? false
  const outlineOpen = preferences?.projectsSidebarOpen ?? true

  return normalizeDockLayout({
    version: 1,
    slots: {
      left: {
        panelIds: outlineOpen ? ['outline'] : [],
        activePanelId: outlineOpen ? 'outline' : null,
        size: { value: 18, unit: 'rem' },
      },
      right: {
        panelIds: inspectorOpen ? ['inspector'] : [],
        activePanelId: inspectorOpen ? 'inspector' : null,
        size: { value: 1 - canvasWidthRatio, unit: 'ratio' },
      },
      bottom: {
        panelIds: [],
        activePanelId: null,
        size: { value: 288, unit: 'px' },
      },
    },
    panels: {
      outline: {
        id: 'outline',
        open: outlineOpen,
        slot: 'left',
      },
      inspector: {
        id: 'inspector',
        open: inspectorOpen,
        slot: 'right',
      },
      agent: {
        id: 'agent',
        open: false,
        slot: 'bottom',
      },
    },
  })
}

function normalizeDockLayout(layout: DockLayoutPreference): DockLayoutPreference {
  const nextLayout = cloneDockLayout(layout)

  for (const slot of DOCK_SLOTS) {
    nextLayout.slots[slot].panelIds = normalizeSlotPanelIds(
      slot,
      nextLayout.slots[slot].panelIds,
      nextLayout.panels,
    )
    nextLayout.slots[slot].activePanelId =
      nextLayout.slots[slot].activePanelId &&
      nextLayout.slots[slot].panelIds.includes(nextLayout.slots[slot].activePanelId)
        ? nextLayout.slots[slot].activePanelId
        : nextLayout.slots[slot].panelIds[0] ?? null
  }

  for (const panelId of DOCK_PANEL_IDS) {
    const panel = nextLayout.panels[panelId]

    if (!panel.open) {
      continue
    }

    const slot = nextLayout.slots[panel.slot]

    if (!slot.panelIds.includes(panelId)) {
      slot.panelIds.push(panelId)
    }

    if (!slot.activePanelId) {
      slot.activePanelId = panelId
    }
  }

  return nextLayout
}

function normalizeSlotPanelIds(
  slot: DockSlot,
  value: unknown,
  panels: Record<DockPanelId, DockPanelState>,
) {
  if (!Array.isArray(value)) {
    return []
  }

  const ids: DockPanelId[] = []

  for (const id of value) {
    if (
      isDockPanelId(id) &&
      panels[id]?.open &&
      panels[id]?.slot === slot &&
      !ids.includes(id)
    ) {
      ids.push(id)
    }
  }

  return ids
}

function normalizeSlotSize(
  value: unknown,
  fallback: DockSlotSize,
): DockSlotSize {
  if (!value || typeof value !== 'object') {
    return fallback
  }

  const candidate = value as Partial<DockSlotSize>

  if (
    typeof candidate.value !== 'number' ||
    !Number.isFinite(candidate.value) ||
    (candidate.unit !== 'px' && candidate.unit !== 'rem' && candidate.unit !== 'ratio')
  ) {
    return fallback
  }

  return {
    value: candidate.value,
    unit: candidate.unit,
  }
}

function getSlotTrackSize(layout: DockLayoutPreference, slot: DockSlot) {
  const slotState = layout.slots[slot]

  if (slotState.panelIds.length === 0) {
    return '0px'
  }

  const size = slotState.size

  if (size.unit === 'ratio') {
    const percent = clampNumber(size.value, 0.14, 0.72) * 100
    return `${percent.toFixed(2)}%`
  }

  if (size.unit === 'rem') {
    return `${size.value}rem`
  }

  return `${Math.round(size.value)}px`
}

function getDefaultSizeForSlot(panelId: DockPanelId, slot: DockSlot) {
  return DOCK_PANEL_DEFINITIONS[panelId].defaultSize[slot]
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function cloneDockLayout(layout: DockLayoutPreference): DockLayoutPreference {
  return {
    version: 1,
    panels: Object.fromEntries(
      DOCK_PANEL_IDS.map((panelId) => [
        panelId,
        {
          ...layout.panels[panelId],
        },
      ]),
    ) as Record<DockPanelId, DockPanelState>,
    slots: Object.fromEntries(
      DOCK_SLOTS.map((slot) => [
        slot,
        {
          activePanelId: layout.slots[slot].activePanelId,
          panelIds: [...layout.slots[slot].panelIds],
          size: {
            ...layout.slots[slot].size,
          },
        },
      ]),
    ) as Record<DockSlot, DockSlotState>,
  }
}

function isDockSlot(value: unknown): value is DockSlot {
  return value === 'left' || value === 'right' || value === 'bottom'
}

function isDockPanelId(value: unknown): value is DockPanelId {
  return value === 'outline' || value === 'inspector' || value === 'agent'
}

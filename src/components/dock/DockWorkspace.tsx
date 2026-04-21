import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from 'react'

import {
  DOCK_PANEL_DEFINITIONS,
  DOCK_SLOTS,
} from '../../app/dock/dockModel'
import type { DockPreviewState } from '../../app/useDockLayoutController'
import type {
  DockLayoutPreference,
  DockPanelId,
  DockSlot,
} from '../../types'

interface DockWorkspaceProps {
  center: ReactNode
  dockLayout: DockLayoutPreference
  dockPreview: DockPreviewState | null
  onSlotActivePanelChange: (slot: DockSlot, panelId: DockPanelId) => void
  onSlotHandlePointerDown: (
    slot: DockSlot,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  onPanelMovePointerDown: (
    panelId: DockPanelId,
    slot: DockSlot,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  renderPanel: (
    panelId: DockPanelId,
    active: boolean,
    moveHandle: ReactNode,
  ) => ReactNode
  workspaceRef: RefObject<HTMLDivElement | null>
  workspaceStyle: CSSProperties
}

export function DockWorkspace({
  center,
  dockLayout,
  dockPreview,
  onPanelMovePointerDown,
  onSlotActivePanelChange,
  onSlotHandlePointerDown,
  renderPanel,
  workspaceRef,
  workspaceStyle,
}: DockWorkspaceProps) {
  const panelEntries = DOCK_SLOTS.flatMap((slot) =>
    dockLayout.slots[slot].panelIds.map((panelId) => ({
      panelId,
      slot,
    })),
  )

  return (
    <div
      className="cbv-dock-workspace"
      ref={workspaceRef}
      style={workspaceStyle}
    >
      <div className="cbv-dock-center">{center}</div>
      {DOCK_SLOTS.map((slot) => (
        <DockSlotChrome
          key={slot}
          layout={dockLayout}
          onActivePanelChange={onSlotActivePanelChange}
          onHandlePointerDown={onSlotHandlePointerDown}
          onPanelMovePointerDown={onPanelMovePointerDown}
          slot={slot}
        />
      ))}
      {panelEntries.map(({ panelId, slot }) => {
        const slotState = dockLayout.slots[slot]
        const active = slotState.activePanelId === panelId
        const hasTabs = slotState.panelIds.length > 1
        const moveHandle = !hasTabs && active ? (
          <DockPanelMoveButton
            onPanelMovePointerDown={onPanelMovePointerDown}
            panelId={panelId}
            slot={slot}
          />
        ) : null

        return (
          <div
            aria-hidden={!active}
            className={`cbv-dock-panel-host is-${panelId}${active ? ' is-active' : ''}${hasTabs ? ' has-tabs' : ''}`}
            data-panel-id={panelId}
            data-slot={slot}
            key={panelId}
          >
            {renderPanel(panelId, active, moveHandle)}
          </div>
        )
      })}
      {dockPreview ? <DockPreviewOverlay preview={dockPreview} /> : null}
    </div>
  )
}

function DockSlotChrome({
  layout,
  onActivePanelChange,
  onHandlePointerDown,
  onPanelMovePointerDown,
  slot,
}: {
  layout: DockLayoutPreference
  onActivePanelChange: (slot: DockSlot, panelId: DockPanelId) => void
  onHandlePointerDown: (
    slot: DockSlot,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  onPanelMovePointerDown: (
    panelId: DockPanelId,
    slot: DockSlot,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  slot: DockSlot
}) {
  const slotState = layout.slots[slot]
  const activePanelId = slotState.activePanelId

  if (slotState.panelIds.length === 0 || !activePanelId) {
    return null
  }

  const activeLabel = DOCK_PANEL_DEFINITIONS[activePanelId].label
  const hasTabs = slotState.panelIds.length > 1

  return (
    <div className="cbv-dock-slot-chrome" data-slot={slot}>
      {hasTabs ? (
        <div
          aria-label={`${slot} panels`}
          className="cbv-dock-slot-tabs"
          role="tablist"
        >
          {slotState.panelIds.map((panelId) => {
            const label = DOCK_PANEL_DEFINITIONS[panelId].label
            const active = activePanelId === panelId

            return (
              <button
                aria-selected={active}
                className={active ? 'is-active' : ''}
                key={panelId}
                onClick={() => onActivePanelChange(slot, panelId)}
                onPointerDown={(event) => {
                  onActivePanelChange(slot, panelId)
                  onPanelMovePointerDown(panelId, slot, event)
                }}
                role="tab"
                title={`Drag to move ${label}`}
                type="button"
              >
                {label}
              </button>
            )
          })}
        </div>
      ) : null}
      <button
        aria-label={`Resize ${activeLabel} panel`}
        className="cbv-dock-slot-handle"
        onPointerDown={(event) => onHandlePointerDown(slot, event)}
        title={`Resize ${activeLabel}`}
        type="button"
      >
        <span />
      </button>
    </div>
  )
}

function DockPanelMoveButton({
  onPanelMovePointerDown,
  panelId,
  slot,
}: {
  onPanelMovePointerDown: (
    panelId: DockPanelId,
    slot: DockSlot,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void
  panelId: DockPanelId
  slot: DockSlot
}) {
  const label = DOCK_PANEL_DEFINITIONS[panelId].label

  return (
    <button
      aria-label={`Move ${label} panel`}
      className="cbv-inspector-close cbv-dock-panel-move-button"
      onPointerDown={(event) => onPanelMovePointerDown(panelId, slot, event)}
      title={`Drag to move ${label}`}
      type="button"
    >
      ⑂
    </button>
  )
}

function DockPreviewOverlay({ preview }: { preview: DockPreviewState }) {
  const label = DOCK_PANEL_DEFINITIONS[preview.panelId].label
  const previewStyle = {
    '--cbv-dock-preview-area': `dock-${preview.slot}`,
  } as CSSProperties

  return (
    <div
      className="cbv-dock-preview"
      data-slot={preview.slot}
      data-tab={preview.willCreateTab ? 'true' : 'false'}
      style={previewStyle}
    >
      <span>{preview.willCreateTab ? `${label} tab` : label}</span>
    </div>
  )
}

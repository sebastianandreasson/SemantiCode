import { describe, expect, it } from 'vitest'

import {
  buildDockLayoutFromPreferences,
  dockPanelIntoSlot,
  resolveDockCandidate,
  setDockPanelOpen,
} from './dockModel'

describe('dockModel', () => {
  it('migrates legacy chrome preferences into dock slots', () => {
    const layout = buildDockLayoutFromPreferences({
      canvasWidthRatio: 0.62,
      inspectorOpen: true,
      projectsSidebarOpen: true,
    })

    expect(layout.slots.left.panelIds).toEqual(['outline'])
    expect(layout.slots.left.activePanelId).toBe('outline')
    expect(layout.slots.right.panelIds).toEqual(['inspector'])
    expect(layout.slots.right.activePanelId).toBe('inspector')
    expect(layout.slots.right.size).toEqual({ value: 0.38, unit: 'ratio' })
    expect(layout.panels.outline.open).toBe(true)
    expect(layout.panels.inspector.open).toBe(true)
  })

  it('tabs panels when docking into an occupied slot instead of swapping', () => {
    const layout = buildDockLayoutFromPreferences({
      projectsSidebarOpen: true,
    })
    const agentOpen = setDockPanelOpen(layout, 'agent', true)
    const tabbed = dockPanelIntoSlot(agentOpen, 'agent', 'left')

    expect(tabbed.slots.left.panelIds).toEqual(['outline', 'agent'])
    expect(tabbed.slots.left.activePanelId).toBe('agent')
    expect(tabbed.panels.outline.slot).toBe('left')
    expect(tabbed.panels.outline.open).toBe(true)
    expect(tabbed.panels.agent.slot).toBe('left')
    expect(tabbed.panels.agent.open).toBe(true)
    expect(tabbed.slots.bottom.panelIds).toEqual([])
  })

  it('reports tab previews when a drag target already has a panel', () => {
    const layout = buildDockLayoutFromPreferences({
      projectsSidebarOpen: true,
    })
    const candidate = resolveDockCandidate({
      allowedSlots: ['left', 'right', 'bottom'],
      layout,
      point: {
        x: 24,
        y: 360,
      },
      sourceSlot: 'bottom',
      workspaceRect: createRect(0, 0, 1200, 800),
    })

    expect(candidate).toEqual({
      slot: 'left',
      willCreateTab: true,
    })
  })

  it('preserves the last slot for closed panels so reopening restores placement', () => {
    const layout = dockPanelIntoSlot(
      setDockPanelOpen(buildDockLayoutFromPreferences({}), 'agent', true),
      'agent',
      'right',
    )
    const closed = setDockPanelOpen(layout, 'agent', false)
    const reopened = setDockPanelOpen(closed, 'agent', true)

    expect(closed.slots.right.panelIds).toEqual([])
    expect(closed.panels.agent.slot).toBe('right')
    expect(reopened.slots.right.panelIds).toEqual(['agent'])
    expect(reopened.panels.agent.open).toBe(true)
  })
})

function createRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  } as DOMRect
}

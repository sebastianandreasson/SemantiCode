import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

const screenshotDir = join(process.cwd(), 'test-results', 'visual-smoke')

declare global {
  interface Window {
    __SEMANTICODE_VISUAL_READY__?: boolean
  }
}

async function openHarness(page: Page, scenario = 'default') {
  await page.goto(`/visual-test.html?scenario=${encodeURIComponent(scenario)}`)
  await page.waitForFunction(() => window.__SEMANTICODE_VISUAL_READY__ === true)
  await expect(page.locator('.cbv-app-shell')).toBeVisible()
}

async function capture(page: Page, name: string) {
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({
    fullPage: true,
    path: join(screenshotDir, `${name}.png`),
  })
}

test.describe('Semanticode visual smoke harness', () => {
  test('captures the default redesigned shell', async ({ page }) => {
    await openHarness(page)

    await expect(page.locator('.cbv-workspace-sidebar')).toBeVisible()
    await expect(page.locator('.cbv-canvas')).toBeVisible()
    await expect(page.locator('.cbv-inspector')).toBeVisible()
    await expect(page.locator('.cbv-agent-strip')).toBeVisible()
    await capture(page, 'default-shell')
  })

  test('captures the workspace switcher view', async ({ page }) => {
    await openHarness(page)

    await page.getByRole('button', { name: /workspaces/i }).click()

    await expect(page.getByRole('button', { name: /\+ add workspace/i })).toBeVisible()
    await capture(page, 'workspace-switcher')
  })

  test('captures the topbar layout dropdown above the canvas', async ({ page }) => {
    await openHarness(page)

    await page.locator('.cbv-layout-trigger').click()

    await expect(page.locator('.cbv-layout-menu')).toBeVisible()
    await capture(page, 'layout-dropdown')
  })

  test('keeps the inspector close button visible when narrow', async ({ page }) => {
    await page.setViewportSize({ height: 860, width: 1_180 })
    await openHarness(page, 'narrow-inspector')

    await expect(page.locator('.cbv-inspector .cbv-inspector-close').first()).toBeVisible()
    await capture(page, 'narrow-inspector')
  })

  test('captures the bottom drawer chat, agents, and layout tabs', async ({ page }) => {
    await openHarness(page)

    await page.locator('.cbv-agent-strip-toggle').click()
    await expect(page.locator('.cbv-agent-drawer.is-open')).toBeVisible()
    await capture(page, 'drawer-chat')

    await page.locator('.cbv-agent-drawer-tabs .is-agents').click()
    await expect(page.locator('.cbv-runs-surface')).toBeVisible()
    await capture(page, 'drawer-agents')

    await page.locator('.cbv-agent-drawer-tabs .is-layout').click()
    await expect(page.locator('.cbv-agent-layout-panel')).toBeVisible()
    await capture(page, 'drawer-layout')
  })

  test('captures the canvas utility menu with the tiny legend visible', async ({ page }) => {
    await openHarness(page)

    await expect(page.locator('.cbv-canvas-legend-anchor')).toBeVisible()
    await page.locator('.cbv-canvas-utility-trigger').click()
    await expect(page.locator('.cbv-canvas-utility-popover')).toBeVisible()
    await capture(page, 'canvas-utility-menu')
  })

  test('follows exact hidden symbol edits without switching layouts', async ({ page }) => {
    await openHarness(page, 'follow-hidden-symbol')

    const selectedLayoutLabel = await page.locator('.cbv-layout-trigger-label').textContent()

    await page.locator('.cbv-canvas-utility-trigger').click()
    await page.getByRole('button', { name: 'Follow active agent' }).click()
    await page.getByRole('button', { name: 'Show follow debug' }).click()

    await expect(page.locator('.cbv-agent-heat-debug')).toContainText(
      'Target: symbol · src/components/ProjectDashboard.tsx · exact_symbol',
    )
    await expect(page.locator('.cbv-layout-trigger-label')).toHaveText(selectedLayoutLabel ?? '')
    await expect(page.locator('.react-flow__node.selected')).toContainText('useProject')
    await capture(page, 'follow-hidden-symbol')
  })
})

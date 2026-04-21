import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { UiPreferences } from '../schema/store'
import { normalizeDockLayoutPreference } from '../app/dock/dockModel'

const UI_PREFERENCES_FILENAME = 'ui-preferences.json'

export async function loadUiPreferences(
  userDataDir: string,
): Promise<UiPreferences> {
  try {
    const fileContents = await readFile(getUiPreferencesPath(userDataDir), 'utf8')
    const parsed = JSON.parse(fileContents) as Partial<UiPreferences> | null
    return normalizeUiPreferences(parsed)
  } catch {
    return {}
  }
}

export async function persistUiPreferences(
  userDataDir: string,
  preferences: UiPreferences,
) {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    getUiPreferencesPath(userDataDir),
    JSON.stringify(normalizeUiPreferences(preferences), null, 2),
    'utf8',
  )
}

function getUiPreferencesPath(userDataDir: string) {
  return join(userDataDir, UI_PREFERENCES_FILENAME)
}

function normalizeUiPreferences(
  preferences: Partial<UiPreferences> | null | undefined,
): UiPreferences {
  if (!preferences) {
    return {}
  }

  return {
    canvasWidthRatio:
      typeof preferences.canvasWidthRatio === 'number'
        ? preferences.canvasWidthRatio
        : undefined,
    dockLayout: normalizeDockLayoutPreference(preferences.dockLayout),
    graphLayers:
      preferences.graphLayers && typeof preferences.graphLayers === 'object'
        ? preferences.graphLayers
        : undefined,
    inspectorOpen:
      typeof preferences.inspectorOpen === 'boolean'
        ? preferences.inspectorOpen
        : undefined,
    projectsSidebarOpen:
      typeof preferences.projectsSidebarOpen === 'boolean'
        ? preferences.projectsSidebarOpen
        : undefined,
    themeMode:
      preferences.themeMode === 'dark' || preferences.themeMode === 'light'
        ? preferences.themeMode
        : undefined,
    viewMode:
      preferences.viewMode === 'filesystem' || preferences.viewMode === 'symbols'
        ? preferences.viewMode
        : undefined,
    workspaceStateByRootDir: normalizeWorkspaceStateByRootDir(
      preferences.workspaceStateByRootDir,
    ),
  }
}

function normalizeWorkspaceStateByRootDir(
  value: Partial<UiPreferences>['workspaceStateByRootDir'],
) {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const entries = Object.entries(value).flatMap(([rootDir, state]) => {
    if (!state || typeof state !== 'object') {
      return []
    }

    const nextState = {
      activeDraftId:
        typeof state.activeDraftId === 'string' && state.activeDraftId.length > 0
          ? state.activeDraftId
          : undefined,
      activeLayoutId:
        typeof state.activeLayoutId === 'string' && state.activeLayoutId.length > 0
          ? state.activeLayoutId
          : undefined,
    }

    if (!nextState.activeDraftId && !nextState.activeLayoutId) {
      return []
    }

    return [[rootDir, nextState] as const]
  })

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

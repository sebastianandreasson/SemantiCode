import type { UiPreferences } from '../types'
import { normalizeDockLayoutPreference } from './dock/dockModel'

export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'semanticode:theme'
export const UI_PREFERENCES_STORAGE_KEY = 'semanticode:ui-preferences'
export const LIGHT_THEME_BACKGROUND = '#f6f0e5'
export const DARK_THEME_BACKGROUND = '#171a1f'

type InitialThemeDesktopBridge = {
  initialUiPreferences?: UiPreferences
}

function readInjectedInitialTheme(): ThemeMode | null {
  const injectedTheme = (
    globalThis as typeof globalThis & {
      __SEMANTICODE_INITIAL_THEME__?: unknown
    }
  ).__SEMANTICODE_INITIAL_THEME__

  return injectedTheme === 'dark' || injectedTheme === 'light'
    ? injectedTheme
    : null
}

function readInitialDesktopUiPreferences(): UiPreferences {
  const desktopBridge = (
    globalThis as typeof globalThis & {
      semanticodeDesktop?: InitialThemeDesktopBridge
      semanticodeDesktopAgent?: InitialThemeDesktopBridge
    }
  ).semanticodeDesktop ?? (
    globalThis as typeof globalThis & {
      semanticodeDesktopAgent?: InitialThemeDesktopBridge
    }
  ).semanticodeDesktopAgent

  const preferences = desktopBridge?.initialUiPreferences
  return preferences && typeof preferences === 'object' ? preferences : {}
}

function readStoredUiPreferencesFallback(): UiPreferences {
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as UiPreferences

    return {
      canvasWidthRatio:
        typeof parsed.canvasWidthRatio === 'number'
          ? parsed.canvasWidthRatio
          : undefined,
      dockLayout: normalizeDockLayoutPreference(parsed.dockLayout),
      graphLayers: parsed.graphLayers,
      inspectorOpen:
        typeof parsed.inspectorOpen === 'boolean'
          ? parsed.inspectorOpen
          : undefined,
      projectsSidebarOpen:
        typeof parsed.projectsSidebarOpen === 'boolean'
          ? parsed.projectsSidebarOpen
          : undefined,
      themeMode:
        parsed.themeMode === 'dark' || parsed.themeMode === 'light'
          ? parsed.themeMode
          : undefined,
      viewMode:
        parsed.viewMode === 'filesystem' || parsed.viewMode === 'symbols'
          ? parsed.viewMode
          : undefined,
      workspaceStateByRootDir: normalizeWorkspaceStateByRootDir(
        parsed.workspaceStateByRootDir,
      ),
    }
  } catch {
    return {}
  }
}

export function readStoredUiPreferences(): UiPreferences {
  const injectedTheme = readInjectedInitialTheme()
  const desktopPreferences = readInitialDesktopUiPreferences()
  const storedPreferences = readStoredUiPreferencesFallback()

  return {
    canvasWidthRatio:
      desktopPreferences.canvasWidthRatio ?? storedPreferences.canvasWidthRatio,
    dockLayout:
      normalizeDockLayoutPreference(desktopPreferences.dockLayout) ??
      storedPreferences.dockLayout,
    graphLayers: desktopPreferences.graphLayers ?? storedPreferences.graphLayers,
    inspectorOpen:
      desktopPreferences.inspectorOpen ?? storedPreferences.inspectorOpen,
    projectsSidebarOpen:
      desktopPreferences.projectsSidebarOpen ?? storedPreferences.projectsSidebarOpen,
    themeMode:
      injectedTheme ??
      desktopPreferences.themeMode ??
      storedPreferences.themeMode,
    viewMode: desktopPreferences.viewMode ?? storedPreferences.viewMode,
    workspaceStateByRootDir:
      desktopPreferences.workspaceStateByRootDir ??
      storedPreferences.workspaceStateByRootDir,
  }
}

export function readThemeMode(): ThemeMode {
  const storedPreferencesTheme = readStoredUiPreferences().themeMode

  if (storedPreferencesTheme === 'dark' || storedPreferencesTheme === 'light') {
    return storedPreferencesTheme
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)

    if (storedTheme === 'dark' || storedTheme === 'light') {
      return storedTheme
    }
  } catch {
    // Ignore storage failures and fall back to light mode.
  }

  return 'light'
}

export function applyThemeMode(themeMode: ThemeMode) {
  document.documentElement.dataset.theme = themeMode
  document.documentElement.style.colorScheme = themeMode
  document.documentElement.style.background =
    themeMode === 'dark' ? DARK_THEME_BACKGROUND : LIGHT_THEME_BACKGROUND
  document.body.dataset.theme = themeMode
  document.body.style.background =
    themeMode === 'dark' ? DARK_THEME_BACKGROUND : LIGHT_THEME_BACKGROUND
}

export function applyInitialThemeMode() {
  applyThemeMode(readThemeMode())
}

function normalizeWorkspaceStateByRootDir(
  value: UiPreferences['workspaceStateByRootDir'],
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

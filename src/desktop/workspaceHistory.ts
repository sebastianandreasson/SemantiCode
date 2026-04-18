import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const WORKSPACE_HISTORY_FILENAME = 'workspace-history.json'
const MAX_RECENT_WORKSPACES = 8

export interface RecentWorkspaceEntry {
  name: string
  rootDir: string
  lastOpenedAt: string
}

export interface WorkspaceHistoryState {
  lastOpenedRootDir: string | null
  recentWorkspaces: RecentWorkspaceEntry[]
}

export function createEmptyWorkspaceHistoryState(): WorkspaceHistoryState {
  return {
    lastOpenedRootDir: null,
    recentWorkspaces: [],
  }
}

export async function loadWorkspaceHistoryState(
  userDataDir: string,
): Promise<WorkspaceHistoryState> {
  try {
    const fileContents = await readFile(getWorkspaceHistoryPath(userDataDir), 'utf8')
    const parsed = JSON.parse(fileContents) as Partial<WorkspaceHistoryState> | null

    return normalizeWorkspaceHistoryState(parsed)
  } catch {
    return createEmptyWorkspaceHistoryState()
  }
}

export async function persistWorkspaceHistoryState(
  userDataDir: string,
  state: WorkspaceHistoryState,
) {
  await mkdir(userDataDir, { recursive: true })
  await writeFile(
    getWorkspaceHistoryPath(userDataDir),
    JSON.stringify(state, null, 2),
    'utf8',
  )
}

export function rememberWorkspace(
  state: WorkspaceHistoryState,
  rootDir: string,
  openedAt: string = new Date().toISOString(),
): WorkspaceHistoryState {
  const normalizedRootDir = resolve(rootDir)
  const nextEntry: RecentWorkspaceEntry = {
    name: basename(normalizedRootDir) || normalizedRootDir,
    rootDir: normalizedRootDir,
    lastOpenedAt: openedAt,
  }
  const recentWorkspaces = [
    nextEntry,
    ...state.recentWorkspaces.filter((entry) => entry.rootDir !== normalizedRootDir),
  ].slice(0, MAX_RECENT_WORKSPACES)

  return {
    lastOpenedRootDir: normalizedRootDir,
    recentWorkspaces,
  }
}

export function removeWorkspaceFromHistory(
  state: WorkspaceHistoryState,
  rootDir: string,
): WorkspaceHistoryState {
  const normalizedRootDir = resolve(rootDir)
  const recentWorkspaces = state.recentWorkspaces.filter(
    (entry) => entry.rootDir !== normalizedRootDir,
  )

  return {
    lastOpenedRootDir:
      state.lastOpenedRootDir === normalizedRootDir
        ? recentWorkspaces[0]?.rootDir ?? null
        : state.lastOpenedRootDir,
    recentWorkspaces,
  }
}

function getWorkspaceHistoryPath(userDataDir: string) {
  return join(userDataDir, WORKSPACE_HISTORY_FILENAME)
}

function normalizeWorkspaceHistoryState(
  state: Partial<WorkspaceHistoryState> | null | undefined,
): WorkspaceHistoryState {
  if (!state) {
    return createEmptyWorkspaceHistoryState()
  }

  const recentWorkspaces = Array.isArray(state.recentWorkspaces)
    ? state.recentWorkspaces
        .filter(
          (entry): entry is RecentWorkspaceEntry =>
            Boolean(
              entry &&
                typeof entry.name === 'string' &&
                typeof entry.rootDir === 'string' &&
                typeof entry.lastOpenedAt === 'string',
            ),
        )
        .map((entry) => ({
          ...entry,
          rootDir: resolve(entry.rootDir),
        }))
    : []

  const lastOpenedRootDir =
    typeof state.lastOpenedRootDir === 'string'
      ? resolve(state.lastOpenedRootDir)
      : null

  return {
    lastOpenedRootDir,
    recentWorkspaces: recentWorkspaces.slice(0, MAX_RECENT_WORKSPACES),
  }
}

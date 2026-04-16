import { describe, expect, it } from 'vitest'

import {
  createEmptyWorkspaceHistoryState,
  rememberWorkspace,
} from './workspaceHistory'

describe('workspaceHistory', () => {
  it('remembers the most recent workspace first and updates last-opened root', () => {
    const state = rememberWorkspace(
      createEmptyWorkspaceHistoryState(),
      '/tmp/workspace-a',
      '2026-04-16T09:00:00.000Z',
    )

    expect(state.lastOpenedRootDir).toBe('/tmp/workspace-a')
    expect(state.recentWorkspaces).toEqual([
      {
        name: 'workspace-a',
        rootDir: '/tmp/workspace-a',
        lastOpenedAt: '2026-04-16T09:00:00.000Z',
      },
    ])
  })

  it('moves an existing workspace to the top instead of duplicating it', () => {
    const first = rememberWorkspace(
      createEmptyWorkspaceHistoryState(),
      '/tmp/workspace-a',
      '2026-04-16T09:00:00.000Z',
    )
    const second = rememberWorkspace(
      rememberWorkspace(first, '/tmp/workspace-b', '2026-04-16T10:00:00.000Z'),
      '/tmp/workspace-a',
      '2026-04-16T11:00:00.000Z',
    )

    expect(second.lastOpenedRootDir).toBe('/tmp/workspace-a')
    expect(second.recentWorkspaces).toEqual([
      {
        name: 'workspace-a',
        rootDir: '/tmp/workspace-a',
        lastOpenedAt: '2026-04-16T11:00:00.000Z',
      },
      {
        name: 'workspace-b',
        rootDir: '/tmp/workspace-b',
        lastOpenedAt: '2026-04-16T10:00:00.000Z',
      },
    ])
  })
})

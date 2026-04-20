import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FollowCameraCommand, FollowInspectorCommand } from '../../types'
import {
  FOLLOW_AGENT_TARGET_LINGER_MS,
  useFollowAgentExecutors,
} from './useFollowAgentExecutors'

describe('useFollowAgentExecutors', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('waits for the focus animation and target linger before acknowledging camera commands', async () => {
    vi.useFakeTimers()

    const cameraCommand = createCameraCommand()
    const inspectorCommand = createInspectorCommand(cameraCommand)
    const acknowledgeCameraCommand = vi.fn()
    const acknowledgeInspectorCommand = vi.fn()
    const selectFileNode = vi.fn()
    const setInspectorOpen = vi.fn()
    const setInspectorTabToFile = vi.fn()
    let resolveFocus: (() => void) | null = null
    const focusCanvasOnFollowTarget = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFocus = resolve
        }),
    )

    render(
      <ExecutorProbe
        acknowledgeCameraCommand={acknowledgeCameraCommand}
        acknowledgeInspectorCommand={acknowledgeInspectorCommand}
        cameraCommand={cameraCommand}
        focusCanvasOnFollowTarget={focusCanvasOnFollowTarget}
        inspectorCommand={inspectorCommand}
        selectFileNode={selectFileNode}
        setInspectorOpen={setInspectorOpen}
        setInspectorTabToFile={setInspectorTabToFile}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(focusCanvasOnFollowTarget).toHaveBeenCalledOnce()
    expect(selectFileNode).toHaveBeenCalledWith(cameraCommand.target.fileNodeId)
    expect(setInspectorTabToFile).toHaveBeenCalledOnce()
    expect(setInspectorOpen).toHaveBeenCalledWith(true)
    expect(acknowledgeInspectorCommand).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLLOW_AGENT_TARGET_LINGER_MS * 2)
    })

    expect(acknowledgeCameraCommand).not.toHaveBeenCalled()
    expect(acknowledgeInspectorCommand).not.toHaveBeenCalled()

    await act(async () => {
      resolveFocus?.()
      await Promise.resolve()
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLLOW_AGENT_TARGET_LINGER_MS - 1)
    })

    expect(acknowledgeCameraCommand).not.toHaveBeenCalled()
    expect(acknowledgeInspectorCommand).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(acknowledgeCameraCommand).toHaveBeenCalledWith({
      commandId: cameraCommand.id,
      intent: 'activity',
    })
    expect(acknowledgeInspectorCommand).toHaveBeenCalledWith({
      commandId: inspectorCommand.id,
      pendingPath: inspectorCommand.pendingPath,
    })
  })
})

function ExecutorProbe(input: {
  acknowledgeCameraCommand: (command: {
    commandId: string
    intent: 'activity' | 'edit'
  }) => void
  acknowledgeInspectorCommand?: (command: {
    commandId: string
    pendingPath?: string | null
  }) => void
  cameraCommand: FollowCameraCommand | null
  focusCanvasOnFollowTarget: () => Promise<void> | void
  inspectorCommand?: FollowInspectorCommand | null
  selectFileNode?: (nodeId: string) => void
  setInspectorOpen?: (open: boolean) => void
  setInspectorTabToFile?: () => void
}) {
  useFollowAgentExecutors({
    acknowledgeCameraCommand: input.acknowledgeCameraCommand,
    acknowledgeInspectorCommand: input.acknowledgeInspectorCommand ?? (() => undefined),
    acknowledgeRefreshCommand: () => undefined,
    active: true,
    cameraCommand: input.cameraCommand,
    canMoveCamera: true,
    focusCanvasOnFollowTarget: input.focusCanvasOnFollowTarget,
    inspectorCommand: input.inspectorCommand ?? null,
    onLiveWorkspaceRefresh: null,
    refreshCommand: null,
    selectFileNode: input.selectFileNode ?? (() => undefined),
    setInspectorOpen: input.setInspectorOpen ?? (() => undefined),
    setInspectorTabToFile: input.setInspectorTabToFile ?? (() => undefined),
    setRefreshStatus: () => undefined,
  })

  return null
}

function createCameraCommand(): FollowCameraCommand {
  return {
    id: 'camera:activity:operation:read:debug:file:debug:file_fallback',
    target: {
      confidence: 'file_fallback',
      eventKey: 'operation:read:debug',
      fileNodeId: 'file:debug',
      intent: 'activity',
      kind: 'file',
      path: 'debug_brute.js',
      primaryNodeId: 'file:debug',
      requiresSnapshotRefresh: false,
      shouldOpenInspector: true,
      symbolNodeIds: [],
      timestamp: '2026-04-18T10:00:01.000Z',
      toolNames: ['read_file'],
    },
  }
}

function createInspectorCommand(cameraCommand: FollowCameraCommand): FollowInspectorCommand {
  return {
    id: 'inspector:activity:debug_brute.js:operation:read:debug',
    pendingPath: null,
    scrollToDiffRequestKey: null,
    target: cameraCommand.target,
  }
}

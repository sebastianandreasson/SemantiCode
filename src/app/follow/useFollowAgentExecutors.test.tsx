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
    const selectFollowNode = vi.fn()
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
        selectFollowNode={selectFollowNode}
        setInspectorOpen={setInspectorOpen}
        setInspectorTabToFile={setInspectorTabToFile}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(focusCanvasOnFollowTarget).toHaveBeenCalledOnce()
    expect(selectFollowNode).not.toHaveBeenCalled()
    expect(setInspectorTabToFile).not.toHaveBeenCalled()
    expect(setInspectorOpen).not.toHaveBeenCalled()
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

    expect(selectFollowNode).toHaveBeenCalledWith(cameraCommand.target.primaryNodeId)
    expect(setInspectorTabToFile).toHaveBeenCalledOnce()
    expect(setInspectorOpen).toHaveBeenCalledWith(true)

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

  it('selects and focuses exact symbol follow targets', async () => {
    vi.useFakeTimers()

    const cameraCommand = createSymbolCameraCommand()
    const inspectorCommand = createInspectorCommand(cameraCommand)
    const selectFollowNode = vi.fn()
    const focusCanvasOnFollowTarget = vi.fn()

    render(
      <ExecutorProbe
        acknowledgeCameraCommand={() => undefined}
        cameraCommand={cameraCommand}
        focusCanvasOnFollowTarget={focusCanvasOnFollowTarget}
        inspectorCommand={inspectorCommand}
        selectFollowNode={selectFollowNode}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    expect(selectFollowNode).toHaveBeenCalledWith('symbol:createPRNG')
    expect(focusCanvasOnFollowTarget).toHaveBeenCalledWith({
      fileNodeId: 'file:debug',
      isEdit: true,
      mode: 'symbols',
      nodeIds: ['symbol:createPRNG', 'symbol:helper'],
    })
  })

  it('runs a pending camera command after the current command finishes lingering', async () => {
    vi.useFakeTimers()

    const firstCameraCommand = createCameraCommand()
    const firstInspectorCommand = createInspectorCommand(firstCameraCommand)
    const nextCameraCommand = createSymbolCameraCommand()
    const nextInspectorCommand = createInspectorCommand(nextCameraCommand)
    const acknowledgeCameraCommand = vi.fn()
    const focusResolvers: Array<() => void> = []
    const focusCanvasOnFollowTarget = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          focusResolvers.push(resolve)
        }),
    )

    const { rerender } = render(
      <ExecutorProbe
        acknowledgeCameraCommand={acknowledgeCameraCommand}
        cameraCommand={firstCameraCommand}
        focusCanvasOnFollowTarget={focusCanvasOnFollowTarget}
        inspectorCommand={firstInspectorCommand}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(focusCanvasOnFollowTarget).toHaveBeenCalledTimes(1)

    rerender(
      <ExecutorProbe
        acknowledgeCameraCommand={acknowledgeCameraCommand}
        cameraCommand={nextCameraCommand}
        focusCanvasOnFollowTarget={focusCanvasOnFollowTarget}
        inspectorCommand={nextInspectorCommand}
      />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(focusCanvasOnFollowTarget).toHaveBeenCalledTimes(1)

    await act(async () => {
      focusResolvers[0]?.()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOLLOW_AGENT_TARGET_LINGER_MS)
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
    })

    expect(acknowledgeCameraCommand).toHaveBeenCalledWith({
      commandId: firstCameraCommand.id,
      intent: 'activity',
    })
    expect(focusCanvasOnFollowTarget).toHaveBeenCalledTimes(2)
    expect(focusCanvasOnFollowTarget).toHaveBeenLastCalledWith({
      fileNodeId: 'file:debug',
      isEdit: true,
      mode: 'symbols',
      nodeIds: ['symbol:createPRNG', 'symbol:helper'],
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
  selectFollowNode?: (nodeId: string) => void
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
    selectFollowNode: input.selectFollowNode ?? (() => undefined),
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

function createSymbolCameraCommand(): FollowCameraCommand {
  return {
    id: 'camera:edit:operation:write:debug:symbol:createPRNG:exact_symbol',
    target: {
      confidence: 'exact_symbol',
      eventKey: 'operation:write:debug',
      fileNodeId: 'file:debug',
      intent: 'edit',
      kind: 'symbol',
      path: 'debug_brute.js',
      primaryNodeId: 'symbol:createPRNG',
      requiresSnapshotRefresh: true,
      shouldOpenInspector: true,
      symbolNodeIds: ['symbol:createPRNG', 'symbol:helper'],
      timestamp: '2026-04-18T10:00:01.000Z',
      toolNames: ['replaceSymbolRange'],
    },
  }
}

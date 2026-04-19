import { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentFileOperation } from '../types'
import { useAgentFileOperations } from './useAgentFileOperations'

const mockClient = {
  getHttpState: vi.fn(),
  subscribe: vi.fn(),
}

vi.mock('../agent/DesktopAgentClient', () => {
  return {
    DesktopAgentClient: vi.fn(() => mockClient),
  }
})

describe('useAgentFileOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.subscribe.mockReturnValue(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('uses polled agent state when no live bridge file operation arrives', async () => {
    const operation = createFileOperation({
      id: 'operation-1',
      path: 'src/game/store/stepGame.ts',
      timestamp: new Date().toISOString(),
    })

    mockClient.getHttpState.mockResolvedValue({
      fileOperations: [operation],
      messages: [],
      session: null,
      timeline: [],
    })

    render(<OperationProbe enabled={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('operation-paths').textContent).toBe(
        'src/game/store/stepGame.ts',
      )
    })
    expect(mockClient.subscribe).toHaveBeenCalledTimes(1)
    expect(mockClient.getHttpState).toHaveBeenCalled()
  })

  it('does not replay stale polled operations from before follow was enabled', async () => {
    const operation = createFileOperation({
      id: 'operation-1',
      path: 'src/game/components/VictorySummaryScreen.tsx',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    })
    let resolveState: ((value: {
      fileOperations: AgentFileOperation[]
      messages: []
      session: null
      timeline: []
    }) => void) | undefined
    const statePromise = new Promise<{
      fileOperations: AgentFileOperation[]
      messages: []
      session: null
      timeline: []
    }>((resolve) => {
      resolveState = resolve
    })

    mockClient.getHttpState.mockReturnValue(statePromise)

    render(<OperationProbe enabled={true} />)

    await waitFor(() => {
      expect(mockClient.getHttpState).toHaveBeenCalled()
    })
    await act(async () => {
      resolveState?.({
        fileOperations: [operation],
        messages: [],
        session: null,
        timeline: [],
      })
      await statePromise
    })
    expect(screen.getByTestId('operation-paths').textContent).toBe('none')
  })
})

function OperationProbe(input: { enabled: boolean }) {
  const operations = useAgentFileOperations({ enabled: input.enabled })

  return (
    <div data-testid="operation-paths">
      {operations.map((operation) => operation.path ?? 'no-path').join(', ') || 'none'}
    </div>
  )
}

function createFileOperation(input: {
  id: string
  path: string
  timestamp: string
}): AgentFileOperation {
  return {
    confidence: 'exact',
    id: input.id,
    kind: 'file_read',
    path: input.path,
    paths: [input.path],
    sessionId: 'session-1',
    source: 'codex-cli',
    status: 'completed',
    timestamp: input.timestamp,
    toolCallId: 'call-1',
    toolName: 'read_file',
  }
}

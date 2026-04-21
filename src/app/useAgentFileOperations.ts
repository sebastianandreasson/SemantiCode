import { useEffect, useMemo, useState } from 'react'

import { DesktopAgentClient } from '../agent/DesktopAgentClient'
import type { AgentFileOperation } from '../types'

const MAX_LIVE_FILE_OPERATIONS = 250
const POLLED_FILE_OPERATIONS_INTERVAL_MS = 1000
const GENERATION_LOOKBACK_MS = 5000
const EMPTY_AGENT_FILE_OPERATIONS: AgentFileOperation[] = []

export function useAgentFileOperations(input: {
  enabled: boolean
}) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [enabledSinceMs, setEnabledSinceMs] = useState<number | null>(null)
  const [operations, setOperations] = useState<AgentFileOperation[]>(EMPTY_AGENT_FILE_OPERATIONS)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setOperations((currentOperations) =>
        currentOperations.length === 0
          ? currentOperations
          : EMPTY_AGENT_FILE_OPERATIONS,
      )
      setEnabledSinceMs(input.enabled ? Date.now() : null)
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [input.enabled])

  useEffect(() => {
    if (!input.enabled || enabledSinceMs === null) {
      return
    }

    return agentClient.subscribe((event) => {
      if (event.type !== 'file_operation') {
        return
      }

      setOperations((currentOperations) =>
        upsertOperation(currentOperations, event.operation),
      )
    })
  }, [agentClient, enabledSinceMs, input.enabled])

  useEffect(() => {
    if (!input.enabled || enabledSinceMs === null) {
      return
    }

    let cancelled = false

    const refreshOperations = async () => {
      try {
        const agentState = await agentClient.getHttpState()

        if (cancelled) {
          return
        }

        setOperations((currentOperations) =>
          (agentState.fileOperations ?? [])
            .filter((operation) => isOperationInActiveWindow(enabledSinceMs, operation))
            .reduce(upsertOperation, currentOperations),
        )
      } catch {
        // Live bridge events are still the primary source when HTTP polling fails.
      }
    }

    void refreshOperations()
    const intervalId = window.setInterval(() => {
      void refreshOperations()
    }, POLLED_FILE_OPERATIONS_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [agentClient, enabledSinceMs, input.enabled])

  return input.enabled && enabledSinceMs !== null
    ? operations
    : EMPTY_AGENT_FILE_OPERATIONS
}

function isOperationInActiveWindow(
  enabledSinceMs: number,
  operation: AgentFileOperation,
) {
  const timestampMs = new Date(operation.timestamp).getTime()
  if (!Number.isFinite(timestampMs)) {
    return true
  }

  return timestampMs >= enabledSinceMs - GENERATION_LOOKBACK_MS
}

function upsertOperation(
  previousOperations: AgentFileOperation[],
  operation: AgentFileOperation,
) {
  const existingIndex = previousOperations.findIndex(
    (previousOperation) => previousOperation.id === operation.id,
  )
  const nextOperations =
    existingIndex === -1
      ? [operation, ...previousOperations]
      : previousOperations.map((previousOperation, index) =>
          index === existingIndex ? operation : previousOperation,
        )

  return nextOperations
    .sort(compareOperationsDescending)
    .slice(0, MAX_LIVE_FILE_OPERATIONS)
}

function compareOperationsDescending(
  left: AgentFileOperation,
  right: AgentFileOperation,
) {
  const leftTimestampMs = new Date(left.timestamp).getTime()
  const rightTimestampMs = new Date(right.timestamp).getTime()

  if (Number.isFinite(leftTimestampMs) && Number.isFinite(rightTimestampMs)) {
    return rightTimestampMs - leftTimestampMs
  }

  return right.id.localeCompare(left.id)
}

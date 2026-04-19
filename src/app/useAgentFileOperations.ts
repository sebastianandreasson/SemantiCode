import { useEffect, useMemo, useReducer } from 'react'

import { DesktopAgentClient } from '../agent/DesktopAgentClient'
import type { AgentFileOperation } from '../types'

const MAX_LIVE_FILE_OPERATIONS = 250
const POLLED_FILE_OPERATIONS_INTERVAL_MS = 1000
const GENERATION_LOOKBACK_MS = 5000

interface OperationEntry {
  generation: number
  operation: AgentFileOperation
}

interface OperationState {
  activeGeneration: number | null
  activeGenerationStartedAtMs: number | null
  entries: OperationEntry[]
  generationSequence: number
}

type OperationAction =
  | {
      enabled: boolean
      nowMs: number
      type: 'ENABLED_CHANGED'
    }
  | {
      operation: AgentFileOperation
      type: 'OPERATION_RECEIVED'
    }
  | {
      operations: AgentFileOperation[]
      type: 'OPERATIONS_RECEIVED'
    }

export function useAgentFileOperations(input: {
  enabled: boolean
}) {
  const agentClient = useMemo(() => new DesktopAgentClient(), [])
  const [state, dispatch] = useReducer(operationReducer, {
    activeGeneration: null,
    activeGenerationStartedAtMs: null,
    entries: [],
    generationSequence: 0,
  })

  useEffect(() => {
    dispatch({
      enabled: input.enabled,
      nowMs: Date.now(),
      type: 'ENABLED_CHANGED',
    })
  }, [input.enabled])

  useEffect(() => {
    if (!input.enabled) {
      return
    }

    return agentClient.subscribe((event) => {
      if (event.type !== 'file_operation') {
        return
      }

      dispatch({
        operation: event.operation,
        type: 'OPERATION_RECEIVED',
      })
    })
  }, [agentClient, input.enabled])

  useEffect(() => {
    if (!input.enabled) {
      return
    }

    let cancelled = false

    const refreshOperations = async () => {
      try {
        const agentState = await agentClient.getHttpState()

        if (cancelled) {
          return
        }

        dispatch({
          operations: agentState.fileOperations ?? [],
          type: 'OPERATIONS_RECEIVED',
        })
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
  }, [agentClient, input.enabled])

  return useMemo(() => {
    if (!input.enabled) {
      return []
    }

    const activeGeneration = state.activeGeneration

    if (activeGeneration === null) {
      return []
    }

    return state.entries
      .filter((entry) => entry.generation === activeGeneration)
      .map((entry) => entry.operation)
  }, [input.enabled, state.activeGeneration, state.entries])
}

function operationReducer(
  state: OperationState,
  action: OperationAction,
): OperationState {
  switch (action.type) {
    case 'ENABLED_CHANGED': {
      if (!action.enabled) {
        return {
          ...state,
          activeGeneration: null,
          activeGenerationStartedAtMs: null,
        }
      }

      if (state.activeGeneration !== null) {
        return state
      }

      const nextGeneration = state.generationSequence + 1

      return {
        ...state,
        activeGeneration: nextGeneration,
        activeGenerationStartedAtMs: action.nowMs,
        generationSequence: nextGeneration,
      }
    }

    case 'OPERATION_RECEIVED': {
      if (state.activeGeneration === null) {
        return state
      }

      return {
        ...state,
        entries: upsertOperationEntry(state.entries, {
          generation: state.activeGeneration,
          operation: action.operation,
        }),
      }
    }

    case 'OPERATIONS_RECEIVED': {
      if (state.activeGeneration === null) {
        return state
      }

      const nextEntries = action.operations
        .filter((operation) => isOperationInActiveGeneration(state, operation))
        .reduce(
          (entries, operation) =>
            upsertOperationEntry(entries, {
              generation: state.activeGeneration!,
              operation,
            }),
          state.entries,
        )

      return {
        ...state,
        entries: nextEntries,
      }
    }
  }
}

function isOperationInActiveGeneration(
  state: OperationState,
  operation: AgentFileOperation,
) {
  if (state.activeGenerationStartedAtMs === null) {
    return true
  }

  const timestampMs = new Date(operation.timestamp).getTime()
  if (!Number.isFinite(timestampMs)) {
    return true
  }

  return timestampMs >= state.activeGenerationStartedAtMs - GENERATION_LOOKBACK_MS
}

function upsertOperationEntry(
  previousEntries: OperationEntry[],
  entry: OperationEntry,
) {
  const existingIndex = previousEntries.findIndex(
    (previousEntry) =>
      previousEntry.generation === entry.generation &&
      previousEntry.operation.id === entry.operation.id,
  )
  const nextEntries =
    existingIndex === -1
      ? [entry, ...previousEntries]
      : previousEntries.map((previousEntry, index) =>
          index === existingIndex ? entry : previousEntry,
        )

  return nextEntries
    .sort(compareEntriesDescending)
    .slice(0, MAX_LIVE_FILE_OPERATIONS)
}

function compareEntriesDescending(left: OperationEntry, right: OperationEntry) {
  if (left.generation !== right.generation) {
    return right.generation - left.generation
  }

  const leftTimestampMs = new Date(left.operation.timestamp).getTime()
  const rightTimestampMs = new Date(right.operation.timestamp).getTime()

  if (Number.isFinite(leftTimestampMs) && Number.isFinite(rightTimestampMs)) {
    return rightTimestampMs - leftTimestampMs
  }

  return right.operation.id.localeCompare(left.operation.id)
}

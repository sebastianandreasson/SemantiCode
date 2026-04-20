import { useEffect, useRef, useState } from 'react'

import type {
  FollowCameraCommand,
  FollowInspectorCommand,
  FollowRefreshCommand,
  TelemetryMode,
} from '../../types'

const LIVE_SNAPSHOT_REFRESH_DEBOUNCE_MS = 500
const LIVE_SNAPSHOT_REFRESH_MIN_INTERVAL_MS = 1800
export const FOLLOW_AGENT_TARGET_LINGER_MS = 900

interface FocusFollowTargetInput {
  fileNodeId: string
  isEdit: boolean
  mode: TelemetryMode
  nodeIds: string[]
}

interface UseFollowAgentExecutorsOptions {
  active: boolean
  acknowledgeCameraCommand: (input: {
    commandId: string
    intent: 'activity' | 'edit'
  }) => void
  acknowledgeInspectorCommand: (input: {
    commandId: string
    pendingPath?: string | null
  }) => void
  acknowledgeRefreshCommand: (commandId: string) => void
  cameraCommand: FollowCameraCommand | null
  canMoveCamera: boolean
  focusCanvasOnFollowTarget: (input: FocusFollowTargetInput) => Promise<void> | void
  inspectorCommand: FollowInspectorCommand | null
  onLiveWorkspaceRefresh?: (() => Promise<void>) | null
  refreshCommand: FollowRefreshCommand | null
  selectFileNode: (nodeId: string) => void
  setInspectorOpen: (open: boolean) => void
  setInspectorTabToFile: () => void
  setRefreshStatus: (status: 'idle' | 'in_flight') => void
}

export function useFollowAgentExecutors({
  active,
  acknowledgeCameraCommand,
  acknowledgeInspectorCommand,
  acknowledgeRefreshCommand,
  cameraCommand,
  canMoveCamera,
  focusCanvasOnFollowTarget,
  inspectorCommand,
  onLiveWorkspaceRefresh,
  refreshCommand,
  selectFileNode,
  setInspectorOpen,
  setInspectorTabToFile,
  setRefreshStatus,
}: UseFollowAgentExecutorsOptions) {
  const [followedEditDiffRequestKey, setFollowedEditDiffRequestKey] = useState<string | null>(null)
  const acknowledgeCameraCommandRef = useRef(acknowledgeCameraCommand)
  const acknowledgeInspectorCommandRef = useRef(acknowledgeInspectorCommand)
  const cameraCommandRef = useRef(cameraCommand)
  const cameraExecutorTimeoutRef = useRef<number | null>(null)
  const cameraLingerTimeoutRef = useRef<number | null>(null)
  const cameraRunTokenRef = useRef(0)
  const focusCanvasOnFollowTargetRef = useRef(focusCanvasOnFollowTarget)
  const inspectorCommandRef = useRef(inspectorCommand)
  const runningCameraCommandIdRef = useRef<string | null>(null)
  const refreshExecutorTimeoutRef = useRef<number | null>(null)
  const lastRefreshExecutorAtRef = useRef(0)
  const selectFileNodeRef = useRef(selectFileNode)
  const setInspectorOpenRef = useRef(setInspectorOpen)
  const setInspectorTabToFileRef = useRef(setInspectorTabToFile)

  useEffect(() => {
    acknowledgeCameraCommandRef.current = acknowledgeCameraCommand
  }, [acknowledgeCameraCommand])

  useEffect(() => {
    acknowledgeInspectorCommandRef.current = acknowledgeInspectorCommand
  }, [acknowledgeInspectorCommand])

  useEffect(() => {
    cameraCommandRef.current = cameraCommand
  }, [cameraCommand])

  useEffect(() => {
    focusCanvasOnFollowTargetRef.current = focusCanvasOnFollowTarget
  }, [focusCanvasOnFollowTarget])

  useEffect(() => {
    inspectorCommandRef.current = inspectorCommand
  }, [inspectorCommand])

  useEffect(() => {
    selectFileNodeRef.current = selectFileNode
  }, [selectFileNode])

  useEffect(() => {
    setInspectorOpenRef.current = setInspectorOpen
  }, [setInspectorOpen])

  useEffect(() => {
    setInspectorTabToFileRef.current = setInspectorTabToFile
  }, [setInspectorTabToFile])

  useEffect(() => {
    return () => {
      cameraRunTokenRef.current += 1
      runningCameraCommandIdRef.current = null

      if (cameraExecutorTimeoutRef.current !== null) {
        window.clearTimeout(cameraExecutorTimeoutRef.current)
        cameraExecutorTimeoutRef.current = null
      }

      if (cameraLingerTimeoutRef.current !== null) {
        window.clearTimeout(cameraLingerTimeoutRef.current)
        cameraLingerTimeoutRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (active) {
      return
    }

    let cancelled = false
    window.setTimeout(() => {
      if (!cancelled) {
        setFollowedEditDiffRequestKey(null)
      }
    }, 0)

    return () => {
      cancelled = true
    }
  }, [active])

  useEffect(() => {
    if (active) {
      return
    }

    runningCameraCommandIdRef.current = null
    cameraRunTokenRef.current += 1

    if (cameraExecutorTimeoutRef.current !== null) {
      window.clearTimeout(cameraExecutorTimeoutRef.current)
      cameraExecutorTimeoutRef.current = null
    }

    if (cameraLingerTimeoutRef.current !== null) {
      window.clearTimeout(cameraLingerTimeoutRef.current)
      cameraLingerTimeoutRef.current = null
    }
  }, [active])

  useEffect(() => {
    if (!active || !canMoveCamera || !cameraCommand?.id) {
      return
    }

    if (runningCameraCommandIdRef.current !== null) {
      return
    }

    const command = cameraCommandRef.current

    if (!command) {
      return
    }

    const pairedInspectorCommand = getPairedInspectorCommand(
      command,
      inspectorCommandRef.current,
    )
    const cameraRunToken = cameraRunTokenRef.current + 1
    cameraRunTokenRef.current = cameraRunToken
    runningCameraCommandIdRef.current = command.id

    cameraExecutorTimeoutRef.current = window.setTimeout(() => {
      cameraExecutorTimeoutRef.current = null
      runInspectorFollowStep(pairedInspectorCommand)

      void Promise.resolve(focusCanvasOnFollowTargetRef.current({
        fileNodeId: command.target.fileNodeId,
        isEdit: command.target.intent === 'edit',
        mode: getTargetTelemetryMode(command.target),
        nodeIds:
          command.target.kind === 'symbol'
            ? [command.target.primaryNodeId]
            : [command.target.fileNodeId],
      })).finally(() => {
        if (
          !active ||
          cameraRunTokenRef.current !== cameraRunToken ||
          runningCameraCommandIdRef.current !== command.id
        ) {
          return
        }

        cameraLingerTimeoutRef.current = window.setTimeout(() => {
          cameraLingerTimeoutRef.current = null

          if (
            !active ||
            cameraRunTokenRef.current !== cameraRunToken ||
            runningCameraCommandIdRef.current !== command.id
          ) {
            return
          }

          runningCameraCommandIdRef.current = null
          acknowledgeCameraCommandRef.current({
            commandId: command.id,
            intent: command.target.intent,
          })
          if (pairedInspectorCommand) {
            acknowledgeInspectorCommandRef.current({
              commandId: pairedInspectorCommand.id,
              pendingPath: pairedInspectorCommand.pendingPath,
            })
          }
        }, FOLLOW_AGENT_TARGET_LINGER_MS)
      })
    }, 0)

    return () => {
      if (
        cameraExecutorTimeoutRef.current !== null &&
        runningCameraCommandIdRef.current === command.id
      ) {
        window.clearTimeout(cameraExecutorTimeoutRef.current)
        cameraExecutorTimeoutRef.current = null
        runningCameraCommandIdRef.current = null
        cameraRunTokenRef.current += 1
      }
    }
  }, [
    active,
    cameraCommand?.id,
    canMoveCamera,
    inspectorCommand?.id,
  ])

  useEffect(() => {
    if (!active || !refreshCommand || !onLiveWorkspaceRefresh) {
      return
    }

    acknowledgeRefreshCommand(refreshCommand.id)

    if (refreshExecutorTimeoutRef.current !== null) {
      window.clearTimeout(refreshExecutorTimeoutRef.current)
      refreshExecutorTimeoutRef.current = null
    }

    const now = Date.now()
    const earliestAllowedAt =
      lastRefreshExecutorAtRef.current + LIVE_SNAPSHOT_REFRESH_MIN_INTERVAL_MS
    const delay = Math.max(
      LIVE_SNAPSHOT_REFRESH_DEBOUNCE_MS,
      Math.max(0, earliestAllowedAt - now),
    )

    refreshExecutorTimeoutRef.current = window.setTimeout(() => {
      refreshExecutorTimeoutRef.current = null
      lastRefreshExecutorAtRef.current = Date.now()
      setRefreshStatus('in_flight')

      void onLiveWorkspaceRefresh()
        .catch(() => undefined)
        .finally(() => {
          setRefreshStatus('idle')
        })
    }, delay)

    return () => {
      if (refreshExecutorTimeoutRef.current !== null) {
        window.clearTimeout(refreshExecutorTimeoutRef.current)
        refreshExecutorTimeoutRef.current = null
        setRefreshStatus('idle')
      }
    }
  }, [
    acknowledgeRefreshCommand,
    active,
    onLiveWorkspaceRefresh,
    refreshCommand,
    setRefreshStatus,
  ])

  return {
    clearFollowedEditDiffRequestKey: () => setFollowedEditDiffRequestKey(null),
    followedEditDiffRequestKey,
  }

  function runInspectorFollowStep(command: FollowInspectorCommand | null) {
    if (!command) {
      return
    }

    selectFileNodeRef.current(command.target.fileNodeId)
    setInspectorTabToFileRef.current()
    setInspectorOpenRef.current(true)
    setFollowedEditDiffRequestKey(command.scrollToDiffRequestKey)
  }
}

function getTargetTelemetryMode(target: FollowCameraCommand['target']): TelemetryMode {
  return target.kind === 'symbol' ? 'symbols' : 'files'
}

function getPairedInspectorCommand(
  cameraCommand: FollowCameraCommand,
  inspectorCommand: FollowInspectorCommand | null,
) {
  if (
    !inspectorCommand ||
    inspectorCommand.target.eventKey !== cameraCommand.target.eventKey ||
    inspectorCommand.target.intent !== cameraCommand.target.intent ||
    inspectorCommand.target.path !== cameraCommand.target.path
  ) {
    return null
  }

  return inspectorCommand
}

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  buildSemanticodeRunRoute,
  buildSemanticodeRunStopRoute,
  buildSemanticodeRunTimelineRoute,
  SEMANTICODE_RUNS_ROUTE,
  SEMANTICODE_TELEMETRY_ACTIVITY_ROUTE,
  SEMANTICODE_TELEMETRY_HEATMAP_ROUTE,
  SEMANTICODE_TELEMETRY_OVERVIEW_ROUTE,
} from '../../shared/constants'
import type {
  AutonomousRunDetailResponse,
  AutonomousRunStartPayload,
  AutonomousRunStartResponse,
  AutonomousRunStopResponse,
  AutonomousRunTimelineResponse,
  AutonomousRunsResponse,
  TelemetryActivityResponse,
  TelemetryHeatmapResponse,
  TelemetryMode,
  TelemetryOverviewResponse,
  TelemetrySource,
  TelemetryWindow,
} from '../../types'
import type { SemanticodeRequestHandlerOptions } from './types'
import { buildRequestUrl, readJsonBody, sendJson } from './utils'

export async function handleAutonomousRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (
    pathname?.startsWith(`${SEMANTICODE_RUNS_ROUTE}`) &&
    !options.autonomousRunRuntime
  ) {
    sendJson(response, 503, {
      message: 'The autonomous run runtime is not available for this host.',
    })
    return true
  }

  if (
    pathname?.startsWith('/__semanticode/telemetry/') &&
    !options.telemetryRuntime
  ) {
    sendJson(response, 503, {
      message: 'Telemetry is not available for this host.',
    })
    return true
  }

  if (pathname === SEMANTICODE_RUNS_ROUTE && method === 'GET' && options.autonomousRunRuntime) {
    const [detectedTaskFile, runsState] = await Promise.all([
      options.autonomousRunRuntime.getDetectedTaskFile(options.rootDir),
      options.autonomousRunRuntime.listRuns(options.rootDir),
    ])

    const result: AutonomousRunsResponse = {
      activeRunId: runsState.activeRunId,
      detectedTaskFile,
      runs: runsState.runs,
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === `${SEMANTICODE_RUNS_ROUTE}/start` && method === 'POST' && options.autonomousRunRuntime) {
    const payload = await readJsonBody<AutonomousRunStartPayload>(request)
    const run = await options.autonomousRunRuntime.startRun(options.rootDir, payload ?? {})
    const result: AutonomousRunStartResponse = {
      activeRunId: run.runId,
      detectedTaskFile: await options.autonomousRunRuntime.getDetectedTaskFile(options.rootDir),
      run,
    }

    sendJson(response, 200, result)
    return true
  }

  if (options.autonomousRunRuntime) {
    const matchedRunId = matchRunId(pathname ?? '')

    if (matchedRunId) {
      if (pathname === buildSemanticodeRunRoute(matchedRunId) && method === 'GET') {
        const result: AutonomousRunDetailResponse = {
          run: await options.autonomousRunRuntime.getRunDetail(options.rootDir, matchedRunId),
        }

        sendJson(response, 200, result)
        return true
      }

      if (pathname === buildSemanticodeRunTimelineRoute(matchedRunId) && method === 'GET') {
        const result: AutonomousRunTimelineResponse = {
          timeline: await options.autonomousRunRuntime.getRunTimeline(options.rootDir, matchedRunId),
        }

        sendJson(response, 200, result)
        return true
      }

      if (pathname === buildSemanticodeRunStopRoute(matchedRunId) && method === 'POST') {
        const result: AutonomousRunStopResponse = await options.autonomousRunRuntime.stopRun(
          options.rootDir,
          matchedRunId,
        )

        sendJson(response, 200, result)
        return true
      }
    }
  }

  if (pathname === SEMANTICODE_TELEMETRY_OVERVIEW_ROUTE && method === 'GET' && options.telemetryRuntime) {
    const query = getTelemetryQuery(request)
    const overview = await options.telemetryRuntime.getTelemetryOverview({
      ...query,
      rootDir: options.rootDir,
    })

    if (options.autonomousRunRuntime) {
      const runsState = await options.autonomousRunRuntime.listRuns(options.rootDir)
      overview.activeRuns = runsState.runs
        .filter((run) => run.status === 'running')
        .map((run) => ({
          runId: run.runId,
          status: run.status,
          task: run.task,
        }))
    }

    const result: TelemetryOverviewResponse = { overview }
    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_TELEMETRY_HEATMAP_ROUTE && method === 'GET' && options.telemetryRuntime) {
    const query = getTelemetryQuery(request)
    const result: TelemetryHeatmapResponse = {
      samples: await options.telemetryRuntime.getTelemetryHeatmap({
        ...query,
        rootDir: options.rootDir,
      }),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_TELEMETRY_ACTIVITY_ROUTE && method === 'GET' && options.telemetryRuntime) {
    const query = getTelemetryQuery(request)
    const result: TelemetryActivityResponse = {
      events: await options.telemetryRuntime.getTelemetryActivity({
        ...query,
        rootDir: options.rootDir,
      }),
    }

    sendJson(response, 200, result)
    return true
  }

  return false
}

function getTelemetryQuery(request: IncomingMessage) {
  const url = new URL(buildRequestUrl(request))
  const source = normalizeSource(url.searchParams.get('source'))
  const windowValue = normalizeWindow(url.searchParams.get('window'))
  const mode = normalizeMode(url.searchParams.get('mode'))
  const runId = url.searchParams.get('runId')?.trim() || undefined
  const sessionId = url.searchParams.get('sessionId')?.trim() || undefined
  const sinceMs = normalizeSinceMs(url.searchParams.get('sinceMs'))

  return {
    mode,
    runId,
    sessionId,
    sinceMs,
    source,
    window: windowValue,
  }
}

function normalizeMode(value: string | null): TelemetryMode {
  return value === 'files' ? 'files' : 'symbols'
}

function normalizeSource(value: string | null): TelemetrySource {
  if (value === 'interactive' || value === 'autonomous') {
    return value
  }

  return 'all'
}

function normalizeWindow(value: string | null): TelemetryWindow {
  if (value === '30') {
    return 30
  }

  if (value === '120') {
    return 120
  }

  if (value === 'run') {
    return 'run'
  }

  if (value === 'session') {
    return 'session'
  }

  if (value === 'workspace') {
    return 'workspace'
  }

  return 60
}

function normalizeSinceMs(value: string | null) {
  const sinceMs = Number(value)

  return Number.isFinite(sinceMs) && sinceMs > 0
    ? sinceMs
    : undefined
}

function matchRunId(pathname: string) {
  const match = /^\/__semanticode\/runs\/([^/]+)/.exec(pathname)

  if (!match) {
    return null
  }

  return decodeURIComponent(match[1])
}

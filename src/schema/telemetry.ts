export type TelemetrySource = 'interactive' | 'autonomous' | 'all'

export type TelemetryWindow = 30 | 60 | 120 | 'session' | 'run' | 'workspace'

export type TelemetryMode = 'files' | 'symbols'

export type TelemetryConfidence = 'exact' | 'attributed' | 'fallback'

export interface AgentHeatSample {
  path: string
  nodeIds: string[]
  symbolNodeIds?: string[]
  weight: number
  requestCount: number
  totalTokens: number
  lastSeenAt: string
  source: TelemetrySource
  confidence: TelemetryConfidence
}

export interface TelemetryOverviewBucket {
  key: string
  label: string
  requestCount: number
  totalTokens: number
}

export interface TelemetryOverview {
  source: TelemetrySource
  window: TelemetryWindow
  requestCount: number
  totalTokens: number
  topFiles: TelemetryOverviewBucket[]
  topDirectories: TelemetryOverviewBucket[]
  topTools: TelemetryOverviewBucket[]
  activeRuns: {
    runId: string
    status: string
    task: string
  }[]
}

export interface TelemetryActivityEvent {
  key: string
  timestamp: string
  source: TelemetrySource
  runId: string
  sessionId: string
  path: string
  symbolNodeIds?: string[]
  toolNames: string[]
  requestCount: number
  totalTokens: number
  confidence: TelemetryConfidence
}

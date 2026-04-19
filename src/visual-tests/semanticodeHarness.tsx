import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '../theme.css'
import '../index.css'
import '../styles.css'

import { applyInitialThemeMode } from '../app/themeBootstrap'
import { Semanticode } from '../components/Semanticode'
import { visualizerStore } from '../store/visualizerStore'
import type {
  AgentMessage,
  AgentSettingsState,
  AgentSessionSummary,
  AgentTimelineItem,
  AutonomousRunDetail,
  AutonomousRunSummary,
  AutonomousRunTimelinePoint,
  LayoutSpec,
  PreprocessedWorkspaceContext,
  PreprocessingStatus,
  ProjectSnapshot,
  TelemetryActivityEvent,
  TelemetryOverview,
  UiPreferences,
  WorkspaceArtifactSyncStatus,
  WorkspaceProfile,
} from '../types'

type VisualDesktopBridge = {
  cancel: () => Promise<boolean>
  closeWorkspace: () => Promise<boolean>
  createSession: () => Promise<AgentSessionSummary>
  getUiPreferences: () => Promise<UiPreferences>
  getWorkspaceHistory: () => Promise<WorkspaceHistoryPayload>
  initialUiPreferences: UiPreferences
  isAvailable: boolean
  isDesktop: boolean
  onEvent: () => () => void
  openWorkspaceDialog: () => Promise<boolean>
  openWorkspaceRootDir: () => Promise<boolean>
  removeWorkspaceHistoryEntry: (rootDir: string) => Promise<WorkspaceHistoryPayload>
  sendMessage: () => Promise<boolean>
  setUiPreferences: (preferences: UiPreferences) => Promise<UiPreferences>
}

type WorkspaceHistoryPayload = {
  activeWorkspaceRootDir: string | null
  recentWorkspaces: {
    name: string
    rootDir: string
    lastOpenedAt: string
  }[]
}

declare global {
  interface Window {
    __SEMANTICODE_INITIAL_THEME__?: 'dark' | 'light'
    __SEMANTICODE_VISUAL_READY__?: boolean
    semanticodeDesktop?: VisualDesktopBridge
  }
}

const generatedAt = '2026-04-18T08:30:00.000Z'
const rootDir = '/Users/sebastianandreasson/Documents/code/work/visual-fixture'
const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'default'

const dashboardContent = [
  "'use client'",
  "import { useMemo, useState } from 'react'",
  "import { fetchProject } from '../api/client'",
  '',
  "export function ProjectDashboard({ projectId }: { projectId: string }) {",
  '  const project = useProject(projectId)',
  '  return <section><h1>{project.name}</h1><ProjectTimeline /></section>',
  '}',
  '',
  'export function useProject(projectId: string) {',
  '  const [name] = useState(projectId)',
  '  return useMemo(() => ({ name, projectId }), [name, projectId])',
  '}',
  '',
  'function ProjectTimeline() {',
  '  return <ol><li>Design</li><li>Build</li></ol>',
  '}',
].join('\n')

const apiClientContent = [
  'export class ApiClient {',
  '  constructor(private readonly baseUrl: string) {}',
  '',
  '  async loadProject(projectId: string) {',
  "    return fetchProject(`${this.baseUrl}/projects/${projectId}`)",
  '  }',
  '}',
  '',
  'export async function fetchProject(url: string) {',
  '  const response = await fetch(url)',
  '  return response.json()',
  '}',
  '',
  "export const API_VERSION = '2026-04'",
].join('\n')

const snapshot: ProjectSnapshot = {
  detectedPlugins: [
    {
      confidence: 0.98,
      displayName: 'React',
      pluginId: 'react',
      reason: 'react dependency and JSX facts detected in src/components',
      scopeRoot: 'src/components',
    },
  ],
  edges: [
    {
      id: 'edge:dir-src-components',
      kind: 'contains',
      source: 'dir:src',
      target: 'dir:components',
    },
    {
      id: 'edge:dir-src-api',
      kind: 'contains',
      source: 'dir:src',
      target: 'dir:api',
    },
    {
      id: 'edge:file-dashboard-import-api',
      kind: 'imports',
      label: 'imports',
      source: 'file:dashboard',
      target: 'file:api-client',
    },
    {
      id: 'edge:dashboard-calls-hook',
      kind: 'calls',
      label: 'calls',
      source: 'symbol:dashboard',
      target: 'symbol:use-project',
    },
    {
      id: 'edge:api-calls-fetch',
      kind: 'calls',
      label: 'calls',
      source: 'symbol:api-client',
      target: 'symbol:fetch-project',
    },
  ],
  entryFileIds: ['file:dashboard'],
  facetDefinitions: [
    {
      category: 'framework',
      description: 'A React component detected by project semantics.',
      id: 'react:component',
      label: 'React Component',
    },
    {
      category: 'framework',
      description: 'A React hook detected by project semantics.',
      id: 'react:hook',
      label: 'React Hook',
    },
    {
      category: 'framework',
      description: 'A module marked with a React use client directive.',
      id: 'react:client-component',
      label: 'Client Component',
    },
  ],
  generatedAt,
  nodes: {
    'dir:api': {
      childIds: ['file:api-client'],
      depth: 1,
      facets: [],
      id: 'dir:api',
      kind: 'directory',
      name: 'api',
      parentId: 'dir:src',
      path: 'src/api',
      tags: [],
    },
    'dir:components': {
      childIds: ['file:dashboard'],
      depth: 1,
      facets: ['react:component'],
      id: 'dir:components',
      kind: 'directory',
      name: 'components',
      parentId: 'dir:src',
      path: 'src/components',
      tags: [],
    },
    'dir:src': {
      childIds: ['dir:components', 'dir:api'],
      depth: 0,
      facets: [],
      id: 'dir:src',
      kind: 'directory',
      name: 'src',
      parentId: null,
      path: 'src',
      tags: [],
    },
    'file:api-client': {
      content: apiClientContent,
      extension: '.ts',
      facets: [],
      id: 'file:api-client',
      kind: 'file',
      language: 'typescript',
      name: 'client.ts',
      parentId: 'dir:api',
      path: 'src/api/client.ts',
      size: apiClientContent.length,
      tags: [],
    },
    'file:dashboard': {
      content: dashboardContent,
      extension: '.tsx',
      facets: ['react:client-component'],
      id: 'file:dashboard',
      kind: 'file',
      language: 'typescriptreact',
      name: 'ProjectDashboard.tsx',
      parentId: 'dir:components',
      path: 'src/components/ProjectDashboard.tsx',
      size: dashboardContent.length,
      tags: ['entrypoint'],
    },
    'symbol:api-client': {
      facets: [],
      fileId: 'file:api-client',
      id: 'symbol:api-client',
      kind: 'symbol',
      language: 'typescript',
      name: 'ApiClient',
      parentSymbolId: null,
      path: 'src/api/client.ts:ApiClient',
      range: {
        end: { column: 1, line: 7 },
        start: { column: 1, line: 1 },
      },
      signature: 'class ApiClient',
      symbolKind: 'class',
      tags: [],
      visibility: 'public',
    },
    'symbol:api-version': {
      facets: [],
      fileId: 'file:api-client',
      id: 'symbol:api-version',
      kind: 'symbol',
      language: 'typescript',
      name: 'API_VERSION',
      parentSymbolId: null,
      path: 'src/api/client.ts:API_VERSION',
      range: {
        end: { column: 36, line: 13 },
        start: { column: 1, line: 13 },
      },
      signature: 'const API_VERSION',
      symbolKind: 'constant',
      tags: [],
      visibility: 'public',
    },
    'symbol:dashboard': {
      facets: ['react:component', 'react:client-component'],
      fileId: 'file:dashboard',
      id: 'symbol:dashboard',
      kind: 'symbol',
      language: 'typescriptreact',
      name: 'ProjectDashboard',
      parentSymbolId: null,
      path: 'src/components/ProjectDashboard.tsx:ProjectDashboard',
      range: {
        end: { column: 1, line: 8 },
        start: { column: 1, line: 5 },
      },
      signature: 'function ProjectDashboard({ projectId }: { projectId: string })',
      symbolKind: 'function',
      tags: [],
      visibility: 'public',
    },
    'symbol:fetch-project': {
      facets: [],
      fileId: 'file:api-client',
      id: 'symbol:fetch-project',
      kind: 'symbol',
      language: 'typescript',
      name: 'fetchProject',
      parentSymbolId: null,
      path: 'src/api/client.ts:fetchProject',
      range: {
        end: { column: 1, line: 11 },
        start: { column: 1, line: 9 },
      },
      signature: 'async function fetchProject(url: string)',
      symbolKind: 'function',
      tags: [],
      visibility: 'public',
    },
    'symbol:timeline': {
      facets: ['react:component'],
      fileId: 'file:dashboard',
      id: 'symbol:timeline',
      kind: 'symbol',
      language: 'typescriptreact',
      name: 'ProjectTimeline',
      parentSymbolId: null,
      path: 'src/components/ProjectDashboard.tsx:ProjectTimeline',
      range: {
        end: { column: 1, line: 17 },
        start: { column: 1, line: 15 },
      },
      signature: 'function ProjectTimeline()',
      symbolKind: 'function',
      tags: [],
      visibility: 'private',
    },
    'symbol:use-project': {
      facets: ['react:hook'],
      fileId: 'file:dashboard',
      id: 'symbol:use-project',
      kind: 'symbol',
      language: 'typescriptreact',
      name: 'useProject',
      parentSymbolId: null,
      path: 'src/components/ProjectDashboard.tsx:useProject',
      range: {
        end: { column: 1, line: 13 },
        start: { column: 1, line: 10 },
      },
      signature: 'function useProject(projectId: string)',
      symbolKind: 'function',
      tags: [],
      visibility: 'public',
    },
  },
  rootDir,
  rootIds: ['dir:src'],
  schemaVersion: 2,
  tags: [
    {
      category: 'system',
      description: 'Likely entrypoint for the fixture.',
      id: 'entrypoint',
      label: 'Entrypoint',
    },
  ],
  totalFiles: 2,
}

const visualLayout: LayoutSpec = {
  annotations: [],
  groups: [],
  hiddenNodeIds: [],
  id: 'layout:visual',
  lanes: [],
  nodeScope: 'symbols',
  placements: {
    'symbol:api-client': { nodeId: 'symbol:api-client', x: 520, y: 160 },
    'symbol:api-version': { nodeId: 'symbol:api-version', x: 790, y: 300 },
    'symbol:dashboard': { nodeId: 'symbol:dashboard', x: 80, y: 80 },
    'symbol:fetch-project': { nodeId: 'symbol:fetch-project', x: 540, y: 340 },
    'symbol:timeline': { nodeId: 'symbol:timeline', x: 80, y: 360 },
    'symbol:use-project': { nodeId: 'symbol:use-project', x: 80, y: 220 },
  },
  strategy: 'agent',
  title: 'Feature shell',
}

const workspaceProfile: WorkspaceProfile = {
  entryFiles: ['src/components/ProjectDashboard.tsx'],
  generatedAt,
  languages: ['typescript', 'typescriptreact'],
  notableTags: ['entrypoint'],
  rootDir,
  summary: 'React front end and TypeScript API client fixture for redesigned shell checks.',
  topDirectories: ['src/components', 'src/api'],
  totalFiles: 2,
  totalSymbols: 6,
}

const preprocessedWorkspaceContext: PreprocessedWorkspaceContext = {
  isComplete: true,
  purposeSummaries: [
    {
      domainHints: ['dashboard', 'react'],
      embeddingText: 'ProjectDashboard is the primary React component for the project overview.',
      fileId: 'file:dashboard',
      generatedAt,
      generator: 'llm',
      language: 'typescriptreact',
      path: 'src/components/ProjectDashboard.tsx:ProjectDashboard',
      sideEffects: [],
      sourceHash: 'dashboard-hash',
      summary: 'Primary React component for the project overview.',
      symbolId: 'symbol:dashboard',
      symbolKind: 'function',
    },
    {
      domainHints: ['data', 'hook'],
      embeddingText: 'useProject manages project state for the dashboard.',
      fileId: 'file:dashboard',
      generatedAt,
      generator: 'llm',
      language: 'typescriptreact',
      path: 'src/components/ProjectDashboard.tsx:useProject',
      sideEffects: [],
      sourceHash: 'hook-hash',
      summary: 'Hook that manages project state for the dashboard.',
      symbolId: 'symbol:use-project',
      symbolKind: 'function',
    },
  ],
  semanticEmbeddingModelId: null,
  semanticEmbeddings: [],
  snapshotId: 'visual-fixture',
  workspaceProfile,
}

const preprocessingStatus: PreprocessingStatus = {
  activity: null,
  currentItemPath: null,
  lastError: null,
  processedSymbols: 6,
  purposeSummaryCount: 2,
  runState: 'ready',
  semanticEmbeddingCount: 0,
  snapshotId: 'visual-fixture',
  totalSymbols: 6,
  updatedAt: generatedAt,
}

const workspaceSyncStatus: WorkspaceArtifactSyncStatus = {
  drafts: [],
  embeddings: {
    affectedPaths: [],
    obsoleteCount: 0,
    obsoleteSymbolIds: [],
    staleCount: 0,
    staleSymbolIds: [],
    state: 'in_sync',
    totalTracked: 6,
  },
  git: {
    branch: 'main',
    changedFiles: ['src/components/ProjectDashboard.tsx'],
    head: 'abc1234',
    isGitRepo: true,
    stagedFiles: [],
    unstagedFiles: ['src/components/ProjectDashboard.tsx'],
    untrackedFiles: [],
  },
  layouts: [],
  summaries: {
    affectedPaths: [],
    obsoleteCount: 0,
    obsoleteSymbolIds: [],
    staleCount: 0,
    staleSymbolIds: [],
    state: 'in_sync',
    totalTracked: 6,
  },
}

const activeRun: AutonomousRunSummary = {
  completedTodoCount: 2,
  isActive: true,
  iteration: 4,
  phase: 'developer',
  requestCount: 18,
  runId: 'run-visual',
  startedAt: '2026-04-18T08:00:00.000Z',
  status: 'running',
  task: 'Refine project dashboard layout and agent drawer polish',
  taskFile: 'TODOS.md',
  terminalReason: null,
  totalTokens: 184_240,
  updatedAt: generatedAt,
}

const runDetail: AutonomousRunDetail = {
  ...activeRun,
  lastOutputExcerpt: 'Updated ProjectDashboard.tsx and verified the drawer visual state.',
  logExcerpt: 'pi-harness run --task TODOS.md\niteration 4 developer editing ProjectDashboard.tsx',
  scope: {
    paths: ['src/components/ProjectDashboard.tsx', 'src/api/client.ts'],
    symbolPaths: [
      'src/components/ProjectDashboard.tsx:ProjectDashboard',
      'src/components/ProjectDashboard.tsx:useProject',
    ],
    title: 'visual fixture scope',
  },
  todos: [
    {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      firstTimestamp: '2026-04-18T08:01:00.000Z',
      inputTokens: 18_200,
      iteration: 2,
      kinds: ['todo'],
      key: 'todo-dashboard',
      lastTimestamp: '2026-04-18T08:10:00.000Z',
      outputTokens: 4_120,
      phase: 'developer',
      requestCount: 6,
      roles: ['developer'],
      status: 'completed',
      task: 'Improve dashboard structure',
      totalTokens: 22_320,
    },
  ],
}

const timeline: AutonomousRunTimelinePoint[] = [
  {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 8_600,
    key: 'point-1',
    label: 'ProjectDashboard.tsx',
    outputTokens: 1_200,
    requestCount: 4,
    timestamp: '2026-04-18T08:05:00.000Z',
    totalTokens: 9_800,
  },
  {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputTokens: 10_400,
    key: 'point-2',
    label: 'client.ts',
    outputTokens: 1_800,
    requestCount: 5,
    timestamp: generatedAt,
    totalTokens: 12_200,
  },
]

const telemetryOverview: TelemetryOverview = {
  activeRuns: [
    {
      runId: activeRun.runId,
      status: activeRun.status,
      task: activeRun.task,
    },
  ],
  requestCount: 20,
  source: 'all',
  topDirectories: [
    {
      key: 'src/components',
      label: 'src/components',
      requestCount: 12,
      totalTokens: 122_000,
    },
  ],
  topFiles: [
    {
      key: 'src/components/ProjectDashboard.tsx',
      label: 'ProjectDashboard.tsx',
      requestCount: 12,
      totalTokens: 122_000,
    },
  ],
  topTools: [
    {
      key: 'edit',
      label: 'edit',
      requestCount: 6,
      totalTokens: 41_000,
    },
  ],
  totalTokens: 362_337,
  window: 60,
}

const telemetryActivity: TelemetryActivityEvent[] = [
  {
    confidence: 'exact',
    key: 'activity-dashboard',
    path: 'src/components/ProjectDashboard.tsx',
    requestCount: 2,
    runId: activeRun.runId,
    sessionId: 'visual-session',
    source: 'autonomous',
    timestamp: generatedAt,
    toolNames: ['edit', 'read'],
    totalTokens: 24_200,
  },
]

const agentSession: AgentSessionSummary = {
  authMode: 'api_key',
  bootPromptEnabled: true,
  brokerSession: {
    state: 'signed_out',
  },
  createdAt: generatedAt,
  hasProviderApiKey: true,
  id: 'visual-agent-session',
  modelId: 'gpt-5.4',
  provider: 'openai',
  queue: {
    followUp: 1,
    steering: 0,
  },
  runState: 'ready',
  sessionName: 'visual-fixture',
  thinkingLevel: 'medium',
  transport: 'codex_cli',
  updatedAt: generatedAt,
  workspaceRootDir: rootDir,
}

const agentMessages: AgentMessage[] = [
  {
    blocks: [
      {
        kind: 'text',
        text: 'I am tracking the dashboard component and API client in the visual smoke fixture.',
      },
    ],
    createdAt: generatedAt,
    id: 'message-assistant',
    role: 'assistant',
  },
]

const agentTimeline: AgentTimelineItem[] = [
  {
    blockKind: 'text',
    createdAt: generatedAt,
    id: 'timeline-user',
    messageId: 'message-user',
    role: 'user',
    text: 'Tighten the bottom chat into a pi-style terminal surface.',
    type: 'message',
  },
  {
    args: { path: 'src/components/AgentPanel.tsx' },
    createdAt: generatedAt,
    durationMs: 42,
    endedAt: generatedAt,
    id: 'timeline-tool-read',
    paths: ['src/components/AgentPanel.tsx'],
    resultPreview: 'read 218 lines',
    startedAt: generatedAt,
    status: 'completed',
    toolCallId: 'tool-read',
    toolName: 'read',
    type: 'tool',
  },
  {
    args: { command: 'npm run test' },
    createdAt: generatedAt,
    id: 'timeline-tool-shell',
    paths: ['npm run test'],
    startedAt: generatedAt,
    status: 'running',
    toolCallId: 'tool-shell',
    toolName: 'bash',
    type: 'tool',
  },
  {
    blockKind: 'text',
    createdAt: generatedAt,
    id: 'timeline-assistant',
    messageId: 'message-assistant',
    role: 'assistant',
    text: 'I am tracking the dashboard component and API client in the visual smoke fixture.',
    type: 'message',
  },
  {
    counts: { actions: 7 },
    createdAt: generatedAt,
    event: 'turn_end',
    id: 'timeline-turn-done',
    label: 'turn done',
    status: 'completed',
    type: 'lifecycle',
  },
]

const agentSettings: AgentSettingsState = {
  authMode: 'api_key',
  availableModelsByProvider: {
    openai: [{ id: 'gpt-5.4' }],
  },
  availableProviders: ['openai'],
  brokerSession: {
    state: 'signed_out',
  },
  canEditAppServerUrl: true,
  canEditOpenAiOAuthConfig: true,
  hasApiKey: true,
  hasAppServerUrl: false,
  hasOpenAiOAuthClientId: false,
  hasOpenAiOAuthClientSecret: false,
  modelId: 'gpt-5.4',
  provider: 'openai',
  storageKind: 'plaintext',
}

const workspaceHistory: WorkspaceHistoryPayload = {
  activeWorkspaceRootDir: rootDir,
  recentWorkspaces: [
    {
      lastOpenedAt: generatedAt,
      name: 'visual-fixture',
      rootDir,
    },
    {
      lastOpenedAt: '2026-04-17T10:00:00.000Z',
      name: 'api-platform',
      rootDir: '/Users/sebastianandreasson/Documents/code/work/api-platform',
    },
    {
      lastOpenedAt: '2026-04-16T10:00:00.000Z',
      name: 'front-end-shell',
      rootDir: '/Users/sebastianandreasson/Documents/code/work/front-end-shell',
    },
  ],
}

let currentPreferences: UiPreferences = {
  canvasWidthRatio: scenario === 'narrow-inspector' ? 0.84 : 0.62,
  graphLayers: {
    calls: true,
    contains: true,
    imports: true,
  },
  inspectorOpen: true,
  projectsSidebarOpen: true,
  themeMode: 'dark',
  viewMode: 'symbols',
  workspaceStateByRootDir: {
    [rootDir]: {
      activeLayoutId: visualLayout.id,
    },
  },
}

window.__SEMANTICODE_INITIAL_THEME__ = 'dark'
window.localStorage.setItem('semanticode:theme', 'dark')
window.localStorage.setItem('semanticode:ui-preferences', JSON.stringify(currentPreferences))

window.semanticodeDesktop = {
  cancel: async () => true,
  closeWorkspace: async () => true,
  createSession: async () => agentSession,
  getUiPreferences: async () => currentPreferences,
  getWorkspaceHistory: async () => workspaceHistory,
  initialUiPreferences: currentPreferences,
  isAvailable: true,
  isDesktop: true,
  onEvent: () => () => undefined,
  openWorkspaceDialog: async () => true,
  openWorkspaceRootDir: async () => true,
  removeWorkspaceHistoryEntry: async (rootToRemove) => ({
    activeWorkspaceRootDir: workspaceHistory.activeWorkspaceRootDir,
    recentWorkspaces: workspaceHistory.recentWorkspaces.filter(
      (workspace) => workspace.rootDir !== rootToRemove,
    ),
  }),
  sendMessage: async () => true,
  setUiPreferences: async (preferences) => {
    currentPreferences = preferences
    window.localStorage.setItem('semanticode:ui-preferences', JSON.stringify(preferences))
    return preferences
  },
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = resolveRequestUrl(input)
  const path = url.pathname

  if (path === '/__semanticode/snapshot') {
    return jsonResponse(snapshot)
  }

  if (path === '/__semanticode/layouts') {
    return jsonResponse({
      activeDraftId: null,
      activeLayoutId: visualLayout.id,
      draftLayouts: [],
      layouts: [visualLayout],
    })
  }

  if (path === '/__semanticode/preprocessing') {
    return jsonResponse({ context: preprocessedWorkspaceContext })
  }

  if (path === '/__semanticode/preprocessing/summary') {
    return jsonResponse({ text: 'Fixture summary response.' })
  }

  if (path === '/__semanticode/preprocessing/embeddings') {
    return jsonResponse({ embeddings: [] })
  }

  if (path === '/__semanticode/preprocessing/group-prototypes') {
    return jsonResponse({ cache: null })
  }

  if (path === '/__semanticode/sync') {
    return jsonResponse({ sync: workspaceSyncStatus })
  }

  if (path === '/__semanticode/file-diff') {
    return jsonResponse({
      diff: {
        addedLineCount: 2,
        baseline: 'HEAD',
        changes: [
          {
            endLine: 6,
            kind: 'modified',
            startLine: 6,
          },
          {
            endLine: 7,
            kind: 'added',
            startLine: 7,
          },
        ],
        deletedLineCount: 0,
        fingerprint: 'visual-diff',
        hasDiff: true,
        isUntracked: false,
        modifiedLineCount: 1,
        path: url.searchParams.get('path') ?? 'src/components/ProjectDashboard.tsx',
      },
    })
  }

  if (path === '/__semanticode/workspace-history') {
    return jsonResponse(workspaceHistory)
  }

  if (path === '/__semanticode/ui-preferences') {
    if (init?.method === 'POST') {
      const payload = parseJsonBody<{ preferences?: UiPreferences }>(init)

      if (payload?.preferences) {
        currentPreferences = payload.preferences
      }
    }

    return jsonResponse({ preferences: currentPreferences })
  }

  if (path === '/__semanticode/runs') {
    return jsonResponse({
      activeRunId: activeRun.runId,
      detectedTaskFile: 'TODOS.md',
      runs: [activeRun],
    })
  }

  if (path === '/__semanticode/runs/start') {
    return jsonResponse({
      activeRunId: activeRun.runId,
      detectedTaskFile: 'TODOS.md',
      run: runDetail,
    })
  }

  if (path === `/__semanticode/runs/${activeRun.runId}`) {
    return jsonResponse({ run: runDetail })
  }

  if (path === `/__semanticode/runs/${activeRun.runId}/timeline`) {
    return jsonResponse({ timeline })
  }

  if (path === `/__semanticode/runs/${activeRun.runId}/stop`) {
    return jsonResponse({ ok: true, runId: activeRun.runId })
  }

  if (path === '/__semanticode/telemetry/overview') {
    return jsonResponse({ overview: telemetryOverview })
  }

  if (path === '/__semanticode/telemetry/heatmap') {
    return jsonResponse({
      samples: [
        {
          confidence: 'exact',
          lastSeenAt: generatedAt,
          nodeIds: ['file:dashboard', 'symbol:dashboard', 'symbol:use-project'],
          path: 'src/components/ProjectDashboard.tsx',
          requestCount: 8,
          source: 'autonomous',
          totalTokens: 122_000,
          weight: 0.92,
        },
      ],
    })
  }

  if (path === '/__semanticode/telemetry/activity') {
    return jsonResponse({ events: telemetryActivity })
  }

  if (path === '/__semanticode/agent/session') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/message') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/cancel') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/thinking') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/compact') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/sessions') {
    return jsonResponse({
      sessions: [
        {
          createdAt: generatedAt,
          id: 'visual-agent-session',
          messageCount: agentMessages.length,
          modifiedAt: generatedAt,
          name: 'visual-fixture',
          path: '/tmp/visual-agent-session.jsonl',
          preview: 'Tighten the bottom chat into a pi-style terminal surface.',
        },
      ],
    })
  }

  if (path === '/__semanticode/agent/session/new' || path === '/__semanticode/agent/session/resume') {
    return jsonResponse({ messages: agentMessages, session: agentSession, timeline: agentTimeline })
  }

  if (path === '/__semanticode/agent/settings') {
    return jsonResponse({ settings: agentSettings })
  }

  if (path === '/__semanticode/agent/auth/session') {
    return jsonResponse({ brokerSession: agentSession.brokerSession })
  }

  if (path === '/__semanticode/agent/auth/import-codex') {
    return jsonResponse({
      brokerSession: agentSession.brokerSession,
      message: 'Imported fixture Codex session.',
    })
  }

  if (path === '/__semanticode/agent/auth/login/start') {
    return jsonResponse({
      brokerSession: agentSession.brokerSession,
      implemented: false,
      loginUrl: null,
      message: 'Visual harness login is disabled.',
    })
  }

  return jsonResponse({ message: `Unhandled visual harness route: ${path}` }, 404)
}

applyInitialThemeMode()

visualizerStore.getState().reset()
visualizerStore.getState().setLayouts([visualLayout])
visualizerStore.getState().setActiveLayoutId(visualLayout.id)
visualizerStore.getState().setViewMode('symbols')

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing visual smoke root element.')
}

createRoot(rootElement).render(
  <Semanticode
    onBuildSemanticEmbeddings={() => undefined}
    onLiveWorkspaceRefresh={async () => undefined}
    onStartPreprocessing={() => undefined}
    onSuggestLayout={async () => undefined}
    preprocessedWorkspaceContext={preprocessedWorkspaceContext}
    preprocessingStatus={preprocessingStatus}
    snapshot={snapshot}
    workspaceProfile={workspaceProfile}
    workspaceSyncStatus={workspaceSyncStatus}
  />,
)

const readyTimer = window.setInterval(() => {
  const store = visualizerStore.getState()

  if (!store.snapshot) {
    return
  }

  store.selectNode('symbol:dashboard')
  store.setInspectorTab('file')
  window.__SEMANTICODE_VISUAL_READY__ = true
  window.clearInterval(readyTimer)
}, 50)

function resolveRequestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') {
    return new URL(input, window.location.origin)
  }

  if (input instanceof URL) {
    return new URL(input.toString(), window.location.origin)
  }

  return new URL(input.url, window.location.origin)
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
    },
    status,
  })
}

function parseJsonBody<T>(init: RequestInit) {
  if (typeof init.body !== 'string') {
    return null
  }

  try {
    return JSON.parse(init.body) as T
  } catch {
    return null
  }
}

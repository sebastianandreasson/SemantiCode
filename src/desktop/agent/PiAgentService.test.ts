import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.fn()
const mkdirMock = vi.fn()
const readFileMock = vi.fn()

const piCodingAgentMock = vi.hoisted(() => {
  type Listener = (event: Record<string, unknown>) => void

  const listeners = new Set<Listener>()
  const model = {
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    contextWindow: 272000,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    },
    id: 'gpt-5.4',
    input: ['text'],
    maxTokens: 128000,
    name: 'GPT-5.4',
    provider: 'openai-codex',
    reasoning: true,
  }
  let authStorageRef: {
    hasAuth: (provider: string) => boolean
  } | null = null
  let restoredSessionMessages: Array<Record<string, unknown>> = []

  class MockAuthStorage {
    credentials = new Map<string, unknown>()

    static create() {
      authStorageRef = new MockAuthStorage()
      return authStorageRef
    }

    static inMemory() {
      authStorageRef = new MockAuthStorage()
      return authStorageRef
    }

    set(provider: string, credential: unknown) {
      this.credentials.set(provider, credential)
    }

    setRuntimeApiKey(provider: string, apiKey: string) {
      this.credentials.set(provider, { key: apiKey, type: 'api_key' })
    }

    hasAuth(provider: string) {
      return this.credentials.has(provider)
    }
  }

  class MockModelRegistry {
    authStorage: MockAuthStorage

    constructor(authStorage: MockAuthStorage) {
      this.authStorage = authStorage
    }

    static create(authStorage: MockAuthStorage) {
      return new MockModelRegistry(authStorage)
    }

    find(provider: string, modelId: string) {
      return provider === model.provider && modelId === model.id ? model : undefined
    }

    getAll() {
      return [model]
    }

    getAvailable() {
      return this.hasConfiguredAuth(model) ? [model] : []
    }

    hasConfiguredAuth(candidate: { provider: string }) {
      return this.authStorage.hasAuth(candidate.provider)
    }

    refresh() {}
  }

  const session = {
    abort: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    dispose: vi.fn(),
    extensionRunner: {
      getRegisteredCommands: () => [],
    },
    followUpMode: 'all',
    getActiveToolNames: () => ['read'],
    getAllTools: () => [
      {
        description: 'Read a file',
        name: 'read',
      },
    ],
    getAvailableThinkingLevels: () => ['medium', 'high'],
    getFollowUpMessages: () => [],
    getSteeringMessages: () => [],
    isStreaming: false,
    model,
    modelRegistry: null as MockModelRegistry | null,
    prompt: vi.fn(async (message: string) => {
      const now = Date.now()

      for (const listener of listeners) {
        listener({
          message: {
            content: message,
            role: 'user',
            timestamp: now,
          },
          type: 'message_end',
        })
        listener({
          type: 'agent_start',
        })
        listener({
          type: 'turn_start',
        })
        listener({
          args: {
            path: 'src/App.tsx',
          },
          toolCallId: 'call-1',
          toolName: 'read',
          type: 'tool_execution_start',
        })
        listener({
          isError: false,
          result: {
            content: 'export function App() {}',
          },
          toolCallId: 'call-1',
          toolName: 'read',
          type: 'tool_execution_end',
        })
        listener({
          message: {
            content: [
              {
                text: 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
                type: 'text',
              },
            ],
            role: 'assistant',
            timestamp: now + 1,
          },
          type: 'message_start',
        })
        listener({
          message: {
            content: [
              {
                text: 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
                type: 'text',
              },
            ],
            role: 'assistant',
            timestamp: now + 1,
          },
          type: 'message_end',
        })
        listener({
          message: {
            content: [
              {
                text: 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
                type: 'text',
              },
            ],
            role: 'assistant',
            timestamp: now + 1,
          },
          toolResults: [],
          type: 'turn_end',
        })
        listener({
          type: 'agent_end',
        })
      }
    }),
    promptTemplates: [],
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
    },
    sessionFile: '/tmp/workspace/.pi/session.json',
    sessionName: 'Mock session',
    setActiveToolsByName: vi.fn(),
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(),
    state: {
      messages: [],
    },
    steeringMode: 'all',
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    thinkingLevel: 'medium',
  }

  const createMockSessionManager = (kind: string) => ({
    buildSessionContext: () => ({
      messages: kind === 'continueRecent' ? restoredSessionMessages : [],
      model: null,
      thinkingLevel: 'medium',
    }),
    kind,
  })

  return {
    AuthStorage: MockAuthStorage,
    ModelRegistry: MockModelRegistry,
    SessionManager: {
      continueRecent: vi.fn(() => createMockSessionManager('continueRecent')),
      create: vi.fn(() => createMockSessionManager('create')),
      list: vi.fn(async () => []),
      open: vi.fn(() => createMockSessionManager('open')),
    },
    SettingsManager: {
      inMemory: vi.fn(() => ({})),
    },
    createAgentSessionFromServices: vi.fn(async () => ({
      session,
    })),
    createAgentSessionRuntime: vi.fn(async (createRuntime, options) => {
      const runtimeResult = await createRuntime({
        cwd: options.cwd,
        sessionManager: options.sessionManager,
        sessionStartEvent: {
          type: 'session_start',
        },
      })

      return {
        ...runtimeResult,
        dispose: vi.fn(async () => {
          session.dispose()
        }),
        newSession: vi.fn(async () => {}),
        switchSession: vi.fn(async () => {}),
      }
    }),
    createAgentSessionServices: vi.fn(async () => {
      const modelRegistry = new MockModelRegistry(authStorageRef as MockAuthStorage)
      session.modelRegistry = modelRegistry

      return {
        diagnostics: {},
        modelRegistry,
      }
    }),
    createCodingTools: vi.fn(() => []),
    createFindTool: vi.fn(() => ({ name: 'find' })),
    createGrepTool: vi.fn(() => ({ name: 'grep' })),
    createLsTool: vi.fn(() => ({ name: 'ls' })),
    getAgentDir: vi.fn(() => '/tmp/semanticode-agent'),
    session,
    setRestoredSessionMessages: (messages: Array<Record<string, unknown>>) => {
      restoredSessionMessages = messages
    },
  }
})

const agentSettingsStoreMock = vi.hoisted(() => ({
  toolProfile: 'symbol_first' as 'standard' | 'symbol_first',
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/semanticode-tests'),
  },
}))

vi.mock('node:child_process', () => ({
  default: {
    execFile: execFileMock,
  },
  execFile: execFileMock,
}))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: mkdirMock,
    readFile: readFileMock,
  },
  mkdir: mkdirMock,
  readFile: readFileMock,
}))

vi.mock('@mariozechner/pi-coding-agent', () => piCodingAgentMock)

vi.mock('./PiAgentSettingsStore', () => ({
  CODEX_PROVIDER: 'openai-codex',
  CODEX_OPENAI_MODELS: [
    'gpt-5.4',
    'gpt-5.4-mini',
  ],
  PiAgentSettingsStore: class MockPiAgentSettingsStore {
    async applyConfiguredApiKeys() {}

    async getStoredApiKeys() {
      return {}
    }

    async getOpenAIOAuthClientConfig() {
      return {}
    }

    async getSettings() {
      return {
        authMode: 'brokered_oauth',
        brokerSession: {
          accountLabel: 'tester@example.com',
          hasAppSessionToken: true,
          state: 'authenticated',
        },
        canEditAppServerUrl: true,
        canEditOpenAiOAuthConfig: true,
        hasApiKey: false,
        hasAppServerUrl: false,
        hasOpenAiOAuthClientId: false,
        hasOpenAiOAuthClientSecret: false,
        modelId: 'gpt-5.4',
        openAiOAuthClientId: '',
        provider: 'openai-codex',
        storageKind: 'plaintext',
        toolProfile: agentSettingsStoreMock.toolProfile,
        availableProviders: ['openai-codex'],
        availableModelsByProvider: {
          'openai-codex': [{ id: 'gpt-5.4' }],
        },
      }
    }

    async saveSettings(input?: { toolProfile?: 'standard' | 'symbol_first' }) {
      if (input?.toolProfile) {
        agentSettingsStoreMock.toolProfile = input.toolProfile
      }

      return this.getSettings()
    }
  },
}))

vi.mock('../providers/openai-codex/provider', () => ({
  OpenAICodexProvider: class MockOpenAICodexProvider {
    async completeManualRedirect() {
      return { message: 'ok', ok: true }
    }

    async getAuthState() {
      return {
        accountLabel: 'tester@example.com',
        hasAppSessionToken: true,
        state: 'authenticated',
      }
    }

    async importCodexAuthSession() {
      return {
        brokerSession: await this.getAuthState(),
        message: 'Imported the local Codex ChatGPT session.',
      }
    }

    async getPiOAuthCredential() {
      return {
        access: 'fake-access-token',
        accountId: 'account-id',
        expires: Date.now() + 60 * 60 * 1000,
        refresh: 'fake-refresh-token',
      }
    }

    async logout() {
      return {
        accountLabel: undefined,
        hasAppSessionToken: false,
        state: 'signed_out',
      }
    }

    async startLogin() {
      return {
        brokerSession: await this.getAuthState(),
        implemented: true,
        loginUrl: 'https://auth.openai.com/oauth/authorize',
        message: 'Opened the browser for ChatGPT sign-in.',
      }
    }
  },
}))

describe('PiAgentService brokered oauth integration', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileMock.mockReset()
    mkdirMock.mockReset()
    readFileMock.mockReset()
    piCodingAgentMock.session.prompt.mockClear()
    piCodingAgentMock.SessionManager.continueRecent.mockClear()
    piCodingAgentMock.SessionManager.create.mockClear()
    piCodingAgentMock.createAgentSessionRuntime.mockClear()
    piCodingAgentMock.createAgentSessionFromServices.mockClear()
    piCodingAgentMock.setRestoredSessionMessages([])
    agentSettingsStoreMock.toolProfile = 'symbol_first'
    execFileMock.mockImplementation((_file, _args, callback) => {
      callback?.(new Error('rust-analyzer unavailable in test environment'), '', '')
      return undefined as never
    })
    mkdirMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue('{}')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates an SDK-backed Codex OAuth session and emits normalized tool and assistant events', async () => {
    const { PiAgentService } = await import('./PiAgentService')
    const service = new PiAgentService({
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    })
    const events: Array<Record<string, unknown> & { type: string }> = []
    const workspaceRootDir = '/tmp/workspace'

    service.subscribe((event) => {
      events.push(event as Record<string, unknown> & { type: string })
    })

    const summary = await service.ensureWorkspaceSession(workspaceRootDir)

    expect(summary.transport).toBe('provider')
    expect(summary.provider).toBe('openai-codex')
    expect(summary.modelId).toBe('gpt-5.4')
    expect(summary.runState).toBe('ready')
    expect(piCodingAgentMock.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: 'findSymbols' }),
          expect.objectContaining({ name: 'getSymbolOutline' }),
          expect.objectContaining({ name: 'readSymbolSlice' }),
          expect.objectContaining({ name: 'replaceSymbolRange' }),
          expect.objectContaining({ name: 'readFileWindow' }),
          expect.objectContaining({ name: 'replaceFileWindow' }),
        ]),
        tools: [],
      }),
    )
    expect(summary.capabilities).toMatchObject({
      compact: true,
      newSession: true,
      prompt: true,
      resumeSession: true,
      setThinkingLevel: true,
      steer: true,
    })
    await expect(service.getWorkspaceControls(workspaceRootDir)).resolves.toMatchObject({
      activeToolNames: ['read'],
      availableThinkingLevels: ['medium', 'high'],
      commands: expect.arrayContaining([
        expect.objectContaining({
          name: 'new',
          source: 'semanticode',
        }),
        expect.objectContaining({
          name: 'model',
          source: 'semanticode',
        }),
      ]),
      models: expect.arrayContaining([
        expect.objectContaining({
          authMode: 'brokered_oauth',
          id: 'gpt-5.4',
          provider: 'openai-codex',
        }),
      ]),
      runtimeKind: 'pi-sdk',
      sessionId: summary.id,
      tools: [
        expect.objectContaining({
          active: true,
          name: 'read',
        }),
      ],
    })

    await service.promptWorkspaceSession(workspaceRootDir, {
      contextInjection: 'Hidden Semanticode context.',
      displayText: 'List the files in this repo.',
      message: 'List the files in this repo.',
    })

    const sessionCreated = events.find((event) => event.type === 'session_created')
    const userMessage = events.find(
      (event) =>
        event.type === 'message' &&
        (event.message as { role?: string } | undefined)?.role === 'user',
    )
    const assistantMessage = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'message' &&
          (event.message as { role?: string } | undefined)?.role === 'assistant' &&
          Array.isArray((event.message as { blocks?: Array<{ text?: string }> } | undefined)?.blocks) &&
          (event.message as { blocks: Array<{ text?: string }> }).blocks.some(
            (block) => block.text === 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
          ),
      )
    const toolStart = events.find(
      (event) =>
        event.type === 'tool' &&
        (event.invocation as { toolCallId?: string; endedAt?: string } | undefined)?.toolCallId ===
          'call-1' &&
        !(event.invocation as { endedAt?: string } | undefined)?.endedAt,
    )
    const toolEnd = events.find(
      (event) =>
        event.type === 'tool' &&
        (event.invocation as { toolCallId?: string; endedAt?: string } | undefined)?.toolCallId ===
          'call-1' &&
        Boolean((event.invocation as { endedAt?: string } | undefined)?.endedAt),
    )
    const fileOperation = events.find(
      (event) =>
        event.type === 'file_operation' &&
        (event.operation as { toolCallId?: string } | undefined)?.toolCallId ===
          'call-1',
    )
    const assistantFileOperation = events.find(
      (event) =>
        event.type === 'file_operation' &&
        (event.operation as { source?: string } | undefined)?.source ===
          'assistant-message',
    )

    expect(sessionCreated).toBeTruthy()
    expect(userMessage).toBeTruthy()
    expect(assistantMessage).toBeTruthy()
    expect(toolStart).toMatchObject({
      invocation: {
        args: {
          path: 'src/App.tsx',
        },
        toolCallId: 'call-1',
        toolName: 'read',
      },
    })
    expect(toolEnd).toMatchObject({
      invocation: {
        isError: false,
        toolCallId: 'call-1',
        toolName: 'read',
      },
    })
    expect(fileOperation).toMatchObject({
      operation: {
        confidence: 'exact',
        kind: 'file_read',
        path: 'src/App.tsx',
        source: 'pi-sdk',
        toolCallId: 'call-1',
        toolName: 'read',
      },
      type: 'file_operation',
    })
    expect(assistantFileOperation).toMatchObject({
      operation: {
        confidence: 'fallback',
        kind: 'file_read',
        path: 'src/App.tsx',
        source: 'assistant-message',
        toolName: 'assistant_message',
      },
      type: 'file_operation',
    })
    expect(service.getWorkspaceFileOperations(workspaceRootDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: 'exact',
          kind: 'file_read',
          path: 'src/App.tsx',
          source: 'pi-sdk',
          toolCallId: 'call-1',
          toolName: 'read',
        }),
        expect.objectContaining({
          confidence: 'fallback',
          kind: 'file_read',
          path: 'src/App.tsx',
          source: 'assistant-message',
          toolName: 'assistant_message',
        }),
      ]),
    )

    expect(service.getWorkspaceMessages(workspaceRootDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blocks: [
            {
              kind: 'text',
              text: 'List the files in this repo.',
            },
          ],
          role: 'user',
        }),
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              kind: 'text',
              text: 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
            }),
          ]),
          role: 'assistant',
        }),
      ]),
    )
    expect(piCodingAgentMock.session.prompt).toHaveBeenCalledWith(
      'List the files in this repo.',
      expect.objectContaining({
        streamingBehavior: undefined,
      }),
    )
    expect(
      service
        .getWorkspaceMessages(workspaceRootDir)
        .some((message) =>
          message.blocks.some((block) => block.text.includes('Hidden Semanticode context.')),
        ),
    ).toBe(false)
    expect(
      service
        .getWorkspaceMessages(workspaceRootDir)
        .filter((message) => message.role === 'assistant'),
    ).toHaveLength(1)
    expect(
      service
        .getWorkspaceTimeline(workspaceRootDir)
        .filter(
          (item) =>
            item.type === 'message' &&
            item.role === 'assistant' &&
            item.blockKind === 'text' &&
            item.text === 'Found [`src/App.tsx`](/tmp/workspace/src/App.tsx).',
        ),
    ).toHaveLength(1)
    expect(
      service
        .getWorkspaceTimeline(workspaceRootDir)
        .find((item) => item.type === 'lifecycle' && item.event === 'turn_end'),
    ).toMatchObject({
      counts: {
        toolResults: 1,
      },
    })

    await service.disposeWorkspaceSession(workspaceRootDir)
  })

  it('includes broad SDK tools only for the standard tool profile', async () => {
    agentSettingsStoreMock.toolProfile = 'standard'
    const { PiAgentService } = await import('./PiAgentService')
    const service = new PiAgentService({
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    })

    await service.ensureWorkspaceSession('/tmp/workspace')

    expect(piCodingAgentMock.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: 'findSymbols' }),
        ]),
        tools: [
          { name: 'grep' },
          { name: 'find' },
          { name: 'ls' },
        ],
      }),
    )

    await service.disposeWorkspaceSession('/tmp/workspace')
  })

  it('starts a fresh implicit session instead of reusing local-model history for Codex OAuth', async () => {
    piCodingAgentMock.setRestoredSessionMessages([
      {
        content: [
          {
            text: 'Earlier local response.',
            type: 'text',
          },
        ],
        model: 'Qwen3.6-35B-A3B-Q8_0.gguf',
        provider: 'local',
        role: 'assistant',
      },
    ])

    const { PiAgentService } = await import('./PiAgentService')
    const service = new PiAgentService({
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    })

    await service.ensureWorkspaceSession('/tmp/workspace')

    expect(piCodingAgentMock.SessionManager.continueRecent).toHaveBeenCalledWith('/tmp/workspace')
    expect(piCodingAgentMock.SessionManager.create).toHaveBeenCalledWith('/tmp/workspace')
    expect(piCodingAgentMock.createAgentSessionRuntime).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        sessionManager: expect.objectContaining({
          kind: 'create',
        }),
      }),
    )

    await service.disposeWorkspaceSession('/tmp/workspace')
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const execFileMock = vi.fn()
const mkdirMock = vi.fn()
const readFileMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/semanticode-tests'),
  },
}))

vi.mock('node:child_process', () => ({
  default: {
    execFile: execFileMock,
    spawn: spawnMock,
  },
  execFile: execFileMock,
  spawn: spawnMock,
}))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: mkdirMock,
    readFile: readFileMock,
  },
  mkdir: mkdirMock,
  readFile: readFileMock,
}))

vi.mock('./PiAgentSettingsStore', () => ({
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
        provider: 'openai',
        storageKind: 'plaintext',
        availableProviders: ['openai'],
        availableModelsByProvider: {
          openai: [{ id: 'gpt-5.4' }],
        },
      }
    }

    async saveSettings() {
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

    async logout() {
      return {
        accountLabel: undefined,
        hasAppSessionToken: false,
        state: 'signed_out',
      }
    }

    async materializeCodexCliAuth() {
      return '/tmp/semanticode-tests/auth.json'
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

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()

  kill() {
    this.emit('close', 0)
    return true
  }
}

describe('PiAgentService brokered oauth integration', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
    execFileMock.mockReset()
    mkdirMock.mockReset()
    readFileMock.mockReset()
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

  it('creates a codex-cli session and emits normalized tool and assistant events', async () => {
    const child = new MockChildProcess()
    let codexPrompt = ''

    child.stdin.on('data', (chunk) => {
      codexPrompt += String(chunk)
    })

    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        child.stdout.write(
          `${JSON.stringify({
            payload: {
              arguments: '{"path":"src/App.tsx"}',
              call_id: 'call-1',
              name: 'read_file',
              type: 'function_call',
            },
            type: 'response_item',
          })}\n`,
        )
        child.stdout.write(
          `${JSON.stringify({
            payload: {
              call_id: 'call-1',
              type: 'function_call_output',
            },
            type: 'response_item',
          })}\n`,
        )
        child.stdout.write(
          `${JSON.stringify({
            item: {
              text: 'Found the file list.',
              type: 'agent_message',
            },
            type: 'item.completed',
          })}\n`,
        )
        child.stdout.end()
        child.emit('close', 0)
      }, 0)

      return child
    })

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

    expect(summary.transport).toBe('codex_cli')
    expect(summary.modelId).toBe('gpt-5.4')
    expect(summary.runState).toBe('ready')
    expect(summary.capabilities).toMatchObject({
      newSession: true,
      prompt: true,
      resumeSession: false,
      setThinkingLevel: false,
    })
    await expect(service.getWorkspaceControls(workspaceRootDir)).resolves.toMatchObject({
      activeToolNames: [],
      availableThinkingLevels: [],
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
          provider: 'openai',
        }),
      ]),
      runtimeKind: 'codex-subscription',
      sessionId: summary.id,
      tools: [],
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
            (block) => block.text === 'Found the file list.',
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

    expect(sessionCreated).toBeTruthy()
    expect(userMessage).toBeTruthy()
    expect(assistantMessage).toBeTruthy()
    expect(toolStart).toMatchObject({
      invocation: {
        args: {
          path: 'src/App.tsx',
        },
        toolCallId: 'call-1',
        toolName: 'read_file',
      },
    })
    expect(toolEnd).toMatchObject({
      invocation: {
        isError: false,
        toolCallId: 'call-1',
        toolName: 'read_file',
      },
    })

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
              text: 'Found the file list.',
            }),
          ]),
          role: 'assistant',
        }),
      ]),
    )
    expect(codexPrompt).toContain('Hidden Semanticode context.')
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
            item.text === 'Found the file list.',
        ),
    ).toHaveLength(1)

    await service.disposeWorkspaceSession(workspaceRootDir)
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const mkdirMock = vi.fn()
const readFileMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/codebase-visualizer-tests'),
  },
}))

vi.mock('node:child_process', () => ({
  default: {
    spawn: spawnMock,
  },
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
  PiAgentSettingsStore: class MockPiAgentSettingsStore {
    async applyConfiguredApiKeys() {}

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
      return '/tmp/codebase-visualizer-tests/auth.json'
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
    mkdirMock.mockReset()
    readFileMock.mockReset()
    mkdirMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue('{}')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a codex-cli session and emits normalized tool and assistant events', async () => {
    const child = new MockChildProcess()

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

    await service.promptWorkspaceSession(workspaceRootDir, 'List the files in this repo.')

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
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunConfig } from '@mariozechner/pi-agent/dist/transports/types.js'
import type { Message } from '@mariozechner/pi-ai'

const spawnMock = vi.fn()
const mkdirMock = vi.fn()
const readFileMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/semanticode-tests'),
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

class MockChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()

  kill() {
    this.emit('close', 0)
    return true
  }
}

describe('CodexCliTransport', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    mkdirMock.mockReset()
    readFileMock.mockReset()
    mkdirMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue('{}')
  })

  it('emits PI agent events from codex json output', async () => {
    const child = new MockChildProcess()

    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        child.stdout.write(
          `${JSON.stringify({
            item: {
              text: 'Hello from Codex',
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

    const [{ CodexCliTransport, createCodexCliModel }] = await Promise.all([
      import('./CodexCliTransport'),
    ])

    const transport = new CodexCliTransport({
      authProvider: {
        materializeCodexCliAuth: vi.fn().mockResolvedValue('/tmp/semanticode-tests/auth.json'),
      } as never,
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      workspaceRootDir: '/tmp/workspace',
    })

    const config: AgentRunConfig = {
      model: createCodexCliModel('gpt-5.4'),
      systemPrompt: 'Test prompt',
      tools: [],
    }
    const userMessage: Message = {
      role: 'user',
      content: 'Say hello',
      timestamp: Date.now(),
    }

    const events: Array<{ type: string }> = []

    for await (const event of transport.run([], userMessage, config)) {
      events.push(event)
    }

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_update',
      'message_update',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ])

    const turnEnd = events.find((event) => event.type === 'turn_end') as Extract<
      Awaited<ReturnType<typeof transport.run>> extends AsyncIterable<infer T> ? T : never,
      { type: 'turn_end' }
    >
    expect(turnEnd.message.content).toEqual([
      {
        text: 'Hello from Codex',
        type: 'text',
      },
    ])
  })

  it('emits observational tool execution events from codex tool calls', async () => {
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
              text: 'Done reading',
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

    const [{ CodexCliTransport, createCodexCliModel }] = await Promise.all([
      import('./CodexCliTransport'),
    ])

    const transport = new CodexCliTransport({
      authProvider: {
        materializeCodexCliAuth: vi.fn().mockResolvedValue('/tmp/semanticode-tests/auth.json'),
      } as never,
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      workspaceRootDir: '/tmp/workspace',
    })

    const config: AgentRunConfig = {
      model: createCodexCliModel('gpt-5.4'),
      systemPrompt: 'Test prompt',
      tools: [],
    }
    const userMessage: Message = {
      role: 'user',
      content: 'Inspect the file',
      timestamp: Date.now(),
    }

    const events: Array<Record<string, unknown> & { type: string }> = []

    for await (const event of transport.run([], userMessage, config)) {
      events.push(event as Record<string, unknown> & { type: string })
    }

    expect(events.map((event) => event.type)).toContain('tool_execution_start')
    expect(events.map((event) => event.type)).toContain('tool_execution_end')

    const toolStart = events.find((event) => event.type === 'tool_execution_start')
    const toolEnd = events.find((event) => event.type === 'tool_execution_end')

    expect(toolStart).toMatchObject({
      args: {
        path: 'src/App.tsx',
      },
      toolCallId: 'call-1',
      toolName: 'read_file',
    })
    expect(toolEnd).toMatchObject({
      isError: false,
      toolCallId: 'call-1',
      toolName: 'read_file',
    })
    expect(events.find((event) => event.type === 'turn_end')).toMatchObject({
      toolResults: [
        expect.objectContaining({
          isError: false,
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read_file',
        }),
      ],
    })
  })
})

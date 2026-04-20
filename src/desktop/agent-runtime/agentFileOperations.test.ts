import { describe, expect, it } from 'vitest'

import type { AgentMessage, AgentToolInvocation } from '../../schema/agent'
import {
  createFileOperationsFromAgentMessage,
  createFileOperationsFromToolInvocation,
} from './agentFileOperations'

describe('agent file operation normalization', () => {
  it('normalizes exact read tools into file read operations', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { path: '/workspace/src/App.tsx' },
        toolName: 'read_file',
      }),
      sessionId: 'session-1',
      source: 'pi-sdk',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'exact',
        kind: 'file_read',
        path: 'src/App.tsx',
        paths: ['src/App.tsx'],
        source: 'pi-sdk',
        status: 'running',
        toolName: 'read_file',
      },
    ])
  })

  it('normalizes exact write tools into file write operations', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { file_path: 'src/App.tsx' },
        endedAt: '2026-04-18T10:00:02.000Z',
        resultPreview: '{"ok":true,"path":"src/App.tsx"}',
        toolName: 'apply_patch',
      }),
      sessionId: 'session-1',
      source: 'pi-sdk',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'exact',
        kind: 'file_write',
        path: 'src/App.tsx',
        resultPreview: expect.stringContaining('"ok"'),
        source: 'pi-sdk',
        status: 'completed',
        toolName: 'apply_patch',
      },
    ])
  })

  it('infers shell reads from common read commands and path tokens', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { cmd: 'rg "follow" src/app/follow/model.ts package.json' },
        toolName: 'exec_command',
      }),
      sessionId: 'session-1',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'inferred',
        kind: 'file_read',
        path: 'src/app/follow/model.ts',
      },
      {
        confidence: 'inferred',
        kind: 'file_read',
        path: 'package.json',
      },
    ])
  })

  it('infers shell writes from redirects', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { command: 'printf ok > src/generated.ts' },
        toolName: 'shell',
      }),
      sessionId: 'session-1',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'inferred',
        kind: 'file_write',
        path: 'src/generated.ts',
      },
    ])
  })

  it('keeps pathless shell commands as shell operations', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { command: 'npm test' },
        toolName: 'bash',
      }),
      sessionId: 'session-1',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'inferred',
        kind: 'shell_command',
        paths: [],
        toolName: 'bash',
      },
    ])
  })

  it('extracts followable file reads from assistant markdown file links', () => {
    const operations = createFileOperationsFromAgentMessage({
      message: createMessage({
        text: [
          'Top files:',
          '1. [`src/game/store/useGameStore.ts`](/workspace/src/game/store/useGameStore.ts)',
          '2. `src/game/store/stepGame.ts`: core tick logic.',
        ].join('\n'),
      }),
      sessionId: 'session-1',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'fallback',
        kind: 'file_read',
        path: 'src/game/store/useGameStore.ts',
        paths: [
          'src/game/store/useGameStore.ts',
          'src/game/store/stepGame.ts',
        ],
        source: 'assistant-message',
        status: 'completed',
        toolName: 'assistant_message',
      },
      {
        confidence: 'fallback',
        kind: 'file_read',
        path: 'src/game/store/stepGame.ts',
        source: 'assistant-message',
        status: 'completed',
        toolName: 'assistant_message',
      },
    ])
  })
})

function createInvocation(
  overrides: Partial<AgentToolInvocation> & Pick<AgentToolInvocation, 'args' | 'toolName'>,
): AgentToolInvocation {
  return {
    args: overrides.args,
    endedAt: overrides.endedAt,
    isError: overrides.isError,
    paths: overrides.paths,
    resultPreview: overrides.resultPreview,
    startedAt: overrides.startedAt ?? '2026-04-18T10:00:00.000Z',
    toolCallId: overrides.toolCallId ?? 'call-1',
    toolName: overrides.toolName,
  }
}

function createMessage(input: {
  isStreaming?: boolean
  text: string
}): AgentMessage {
  return {
    blocks: [{ kind: 'text', text: input.text }],
    createdAt: '2026-04-18T10:00:00.000Z',
    id: 'message-1',
    isStreaming: input.isStreaming,
    role: 'assistant',
  }
}

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

  it('keeps explicit symbol ids and normalizes symbol paths to file paths', () => {
    const symbolNodeId = 'symbol:src/agent/foo.ts:runAgent:10:0-22:1'
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: {
          path: 'src/agent/foo.ts#runAgent@10:0',
          symbolNodeId,
        },
        toolName: 'readSymbolSlice',
      }),
      sessionId: 'session-1',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        kind: 'file_read',
        nodeIds: [symbolNodeId],
        path: 'src/agent/foo.ts',
        paths: ['src/agent/foo.ts'],
        symbolNodeIds: [symbolNodeId],
        toolName: 'readSymbolSlice',
      },
    ])
  })

  it('derives symbol ids and file paths from structured tool results', () => {
    const symbolNodeId = 'symbol:src/planner/layoutQuery.ts:findNodes:100:2-140:3'
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: { operation: 'findSymbols' },
        endedAt: '2026-04-18T10:00:02.000Z',
        resultPreview: JSON.stringify({
          nodes: [
            {
              id: symbolNodeId,
              kind: 'symbol',
              path: 'src/planner/layoutQuery.ts#findNodes@100:2',
            },
          ],
        }),
        toolName: 'findSymbols',
      }),
      sessionId: 'session-1',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        nodeIds: [symbolNodeId],
        path: 'src/planner/layoutQuery.ts',
        paths: ['src/planner/layoutQuery.ts'],
        symbolNodeIds: [symbolNodeId],
      },
    ])
  })

  it('tracks symbol range replacements as exact followable writes', () => {
    const symbolNodeId = 'symbol:src/agent/foo.ts:runAgent:10:0-22:1'
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: {
          expectedSliceHash: 'old-hash',
          symbolId: symbolNodeId,
        },
        endedAt: '2026-04-18T10:00:02.000Z',
        resultPreview: JSON.stringify({
          ok: true,
          result: {
            file: {
              path: 'src/agent/foo.ts',
            },
            symbolNodeIds: [symbolNodeId],
          },
        }),
        toolName: 'replaceSymbolRange',
      }),
      sessionId: 'session-1',
      source: 'pi-sdk',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'exact',
        kind: 'file_write',
        nodeIds: [symbolNodeId],
        path: 'src/agent/foo.ts',
        paths: ['src/agent/foo.ts'],
        source: 'pi-sdk',
        status: 'completed',
        symbolNodeIds: [symbolNodeId],
        toolName: 'replaceSymbolRange',
      },
    ])
  })

  it('tracks file window replacements as followable fallback writes', () => {
    const operations = createFileOperationsFromToolInvocation({
      invocation: createInvocation({
        args: {
          expectedWindowHash: 'old-hash',
          path: 'src/agent/foo.ts',
          reason: 'Need to update imports.',
          startLine: 1,
          endLine: 2,
        },
        endedAt: '2026-04-18T10:00:02.000Z',
        resultPreview: JSON.stringify({
          ok: true,
          result: {
            file: {
              path: 'src/agent/foo.ts',
            },
          },
        }),
        toolName: 'replaceFileWindow',
      }),
      sessionId: 'session-1',
      source: 'pi-sdk',
      workspaceRootDir: '/workspace',
    })

    expect(operations).toMatchObject([
      {
        confidence: 'exact',
        kind: 'file_write',
        path: 'src/agent/foo.ts',
        paths: ['src/agent/foo.ts'],
        source: 'pi-sdk',
        status: 'completed',
        toolName: 'replaceFileWindow',
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

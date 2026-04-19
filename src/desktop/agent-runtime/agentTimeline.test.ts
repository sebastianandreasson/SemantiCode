import { describe, expect, it } from 'vitest'

import {
  createLifecycleTimelineItem,
  createMessageTimelineItems,
  createToolTimelineItem,
  normalizeToolInvocation,
  upsertTimelineItem,
} from './agentTimeline'

describe('agent timeline normalization', () => {
  it('creates lifecycle rows for queue, retry, compaction, cancellation, and errors', () => {
    const events = [
      createLifecycleTimelineItem({
        counts: { followUp: 1, steering: 2 },
        event: 'queue_update',
        label: 'queue update',
        status: 'queued',
      }),
      createLifecycleTimelineItem({
        event: 'auto_retry_start',
        label: 'retry 1/3',
        status: 'running',
      }),
      createLifecycleTimelineItem({
        event: 'compaction_end',
        label: 'compaction done',
        status: 'completed',
      }),
      createLifecycleTimelineItem({
        event: 'cancelled',
        label: 'cancelled',
        status: 'completed',
      }),
      createLifecycleTimelineItem({
        detail: 'boom',
        event: 'error',
        label: 'error',
        status: 'error',
      }),
    ]

    expect(events.map((event) => event.type)).toEqual([
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'lifecycle',
      'lifecycle',
    ])
    expect(events.map((event) => event.type === 'lifecycle' ? event.event : '')).toEqual([
      'queue_update',
      'auto_retry_start',
      'compaction_end',
      'cancelled',
      'error',
    ])
  })

  it('creates message rows for user, assistant, and thinking blocks', () => {
    const rows = createMessageTimelineItems({
      blocks: [
        { kind: 'thinking', text: 'Inspecting files' },
        { kind: 'text', text: 'Done' },
      ],
      createdAt: '2026-04-15T00:00:00.000Z',
      id: 'message-1',
      isStreaming: true,
      role: 'assistant',
    })

    expect(rows).toMatchObject([
      {
        blockKind: 'thinking',
        isStreaming: true,
        role: 'assistant',
        text: 'Inspecting files',
        type: 'message',
      },
      {
        blockKind: 'text',
        isStreaming: true,
        role: 'assistant',
        text: 'Done',
        type: 'message',
      },
    ])
  })

  it('normalizes tool start and end rows with paths, status, duration, and result previews', () => {
    const started = normalizeToolInvocation({
      args: { path: 'src/App.tsx' },
      startedAt: '2026-04-15T00:00:00.000Z',
      toolCallId: 'call-1',
      toolName: 'read',
    })
    const ended = normalizeToolInvocation({
      args: started.args,
      endedAt: '2026-04-15T00:00:00.042Z',
      result: { ok: true, path: 'src/App.tsx' },
      startedAt: started.startedAt,
      toolCallId: started.toolCallId,
      toolName: started.toolName,
    })

    expect(createToolTimelineItem(started)).toMatchObject({
      paths: ['src/App.tsx'],
      status: 'running',
      toolName: 'read',
      type: 'tool',
    })
    expect(createToolTimelineItem(ended)).toMatchObject({
      durationMs: 42,
      paths: ['src/App.tsx'],
      resultPreview: expect.stringContaining('"ok": true'),
      status: 'completed',
      toolName: 'read',
      type: 'tool',
    })
  })

  it('upserts streaming tool updates in place', () => {
    const started = createToolTimelineItem(normalizeToolInvocation({
      args: { command: 'npm test' },
      startedAt: '2026-04-15T00:00:00.000Z',
      toolCallId: 'call-1',
      toolName: 'bash',
    }))
    const ended = {
      ...started,
      durationMs: 1200,
      endedAt: '2026-04-15T00:00:01.200Z',
      resultPreview: 'ok',
      status: 'completed' as const,
    }

    expect(upsertTimelineItem(upsertTimelineItem([], started), ended)).toEqual([ended])
  })
})

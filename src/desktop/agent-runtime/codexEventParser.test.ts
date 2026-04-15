import { describe, expect, it } from 'vitest'

import { parseCodexLineActions } from './codexEventParser'

describe('parseCodexLineActions', () => {
  it('parses event_msg assistant text', () => {
    const actions = parseCodexLineActions(
      JSON.stringify({
        payload: {
          message: 'Hello from Codex',
          type: 'agent_message',
        },
        type: 'event_msg',
      }),
    )

    expect(actions).toEqual([
      {
        kind: 'assistant_text',
        text: 'Hello from Codex',
      },
    ])
  })

  it('parses response_item reasoning summaries', () => {
    const actions = parseCodexLineActions(
      JSON.stringify({
        payload: {
          summary: [{ text: 'First thought' }, { text: 'Second thought' }],
          type: 'reasoning',
        },
        type: 'response_item',
      }),
    )

    expect(actions).toEqual([
      {
        kind: 'thinking_text',
        text: 'First thought\n\nSecond thought',
      },
    ])
  })

  it('parses completed assistant items', () => {
    const actions = parseCodexLineActions(
      JSON.stringify({
        item: {
          text: 'OK',
          type: 'agent_message',
        },
        type: 'item.completed',
      }),
    )

    expect(actions).toEqual([
      {
        kind: 'assistant_text',
        text: 'OK',
      },
    ])
  })

  it('parses tool start and end items', () => {
    const startActions = parseCodexLineActions(
      JSON.stringify({
        payload: {
          arguments: '{"path":"src/App.tsx"}',
          call_id: 'call-1',
          name: 'read_file',
          type: 'function_call',
        },
        type: 'response_item',
      }),
    )
    const endActions = parseCodexLineActions(
      JSON.stringify({
        payload: {
          call_id: 'call-1',
          type: 'function_call_output',
        },
        type: 'response_item',
      }),
    )

    expect(startActions).toHaveLength(1)
    expect(startActions[0]).toMatchObject({
      kind: 'tool_call_start',
      invocation: {
        args: {
          path: 'src/App.tsx',
        },
        toolCallId: 'call-1',
        toolName: 'read_file',
      },
    })
    expect(endActions).toEqual([
      {
        kind: 'tool_call_end',
        toolCallId: 'call-1',
      },
    ])
  })

  it('parses top-level error lines', () => {
    const actions = parseCodexLineActions(
      JSON.stringify({
        message: 'Reconnecting... 2/5',
        type: 'error',
      }),
    )

    expect(actions).toEqual([
      {
        kind: 'error',
        message: 'Reconnecting... 2/5',
      },
    ])
  })

  it('ignores non-message lifecycle events', () => {
    const actions = parseCodexLineActions(
      JSON.stringify({
        thread_id: 'thread-1',
        type: 'thread.started',
      }),
    )

    expect(actions).toEqual([])
  })
})

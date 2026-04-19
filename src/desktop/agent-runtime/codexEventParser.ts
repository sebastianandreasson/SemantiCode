import type { AgentToolInvocation } from '../../schema/agent'

interface CodexExecPayload {
  content?: Array<{
    text?: string
    type?: string
  }>
  phase?: string
  role?: string
  type?: string
}

interface CodexJsonLine {
  error?: {
    message?: string
  }
  item?: Record<string, unknown>
  message?: string
  payload?: Record<string, unknown>
  type?: string
}

export type CodexLineAction =
  | {
      kind: 'error'
      message: string
    }
  | {
      kind: 'assistant_text'
      text: string
    }
  | {
      kind: 'thinking_text'
      text: string
    }
  | {
      kind: 'tool_call_start'
      invocation: AgentToolInvocation
    }
  | {
      kind: 'tool_call_end'
      isError?: boolean
      result?: unknown
      toolCallId: string
    }

export function parseCodexLineActions(line: string): CodexLineAction[] {
  const normalizedLine = line.trim()

  if (!normalizedLine) {
    return []
  }

  let parsedLine: CodexJsonLine | null = null

  try {
    parsedLine = JSON.parse(normalizedLine) as CodexJsonLine
  } catch {
    return []
  }

  if (parsedLine.type === 'error' || parsedLine.type === 'turn.failed') {
    const errorMessage =
      typeof parsedLine.message === 'string'
        ? parsedLine.message.trim()
        : typeof parsedLine.error?.message === 'string'
          ? parsedLine.error.message.trim()
          : ''

    return errorMessage
      ? [
          {
            kind: 'error',
            message: errorMessage,
          },
        ]
      : []
  }

  if (parsedLine.type === 'event_msg') {
    return extractEventMessageActions(parsedLine.payload ?? {})
  }

  if (parsedLine.type === 'response_item') {
    return extractResponseItemActions(parsedLine.payload ?? {})
  }

  if (parsedLine.type === 'item.completed') {
    return extractCompletedItemActions(parsedLine.item ?? {})
  }

  return []
}

function extractEventMessageActions(payload: Record<string, unknown>): CodexLineAction[] {
  const payloadType = typeof payload.type === 'string' ? payload.type : ''

  if (payloadType === 'agent_reasoning') {
    const nextThinkingText = typeof payload.text === 'string' ? payload.text.trim() : ''

    return nextThinkingText
      ? [
          {
            kind: 'thinking_text',
            text: nextThinkingText,
          },
        ]
      : []
  }

  if (payloadType === 'agent_message') {
    const nextAssistantText =
      typeof payload.message === 'string' ? payload.message.trim() : ''

    return nextAssistantText
      ? [
          {
            kind: 'assistant_text',
            text: nextAssistantText,
          },
        ]
      : []
  }

  return []
}

function extractResponseItemActions(payload: Record<string, unknown>): CodexLineAction[] {
  const payloadType = typeof payload.type === 'string' ? payload.type : ''

  if (payloadType === 'message' && payload.role === 'assistant') {
    const nextText = extractMessageText(payload as CodexExecPayload)

    return nextText
      ? [
          {
            kind: 'assistant_text',
            text: nextText,
          },
        ]
      : []
  }

  if (payloadType === 'reasoning') {
    const nextThinkingText = extractReasoningSummary(payload)

    return nextThinkingText
      ? [
          {
            kind: 'thinking_text',
            text: nextThinkingText,
          },
        ]
      : []
  }

  if (payloadType === 'function_call') {
    const toolCallId = typeof payload.call_id === 'string' ? payload.call_id : null
    const toolName = typeof payload.name === 'string' ? payload.name : null

    if (!toolCallId || !toolName) {
      return []
    }

    return [
      {
        kind: 'tool_call_start',
        invocation: {
          args: parseToolArguments(payload.arguments),
          startedAt: new Date().toISOString(),
          toolCallId,
          toolName,
        },
      },
    ]
  }

  if (payloadType === 'function_call_output') {
    const toolCallId = typeof payload.call_id === 'string' ? payload.call_id : null

    return toolCallId
      ? [
          {
            kind: 'tool_call_end',
            isError: Boolean(payload.is_error ?? payload.isError ?? payload.error),
            result: extractToolResultPayload(payload),
            toolCallId,
          },
        ]
      : []
  }

  return []
}

function extractToolResultPayload(payload: Record<string, unknown>) {
  if ('output' in payload) {
    return payload.output
  }

  if ('content' in payload) {
    return payload.content
  }

  if ('result' in payload) {
    return payload.result
  }

  if ('error' in payload) {
    return payload.error
  }

  return undefined
}

function extractCompletedItemActions(item: Record<string, unknown>): CodexLineAction[] {
  const itemType = typeof item.type === 'string' ? item.type : ''

  if (itemType !== 'agent_message') {
    return []
  }

  const nextAssistantText = typeof item.text === 'string' ? item.text.trim() : ''

  return nextAssistantText
    ? [
        {
          kind: 'assistant_text',
          text: nextAssistantText,
        },
      ]
    : []
}

function extractMessageText(payload: CodexExecPayload) {
  return (payload.content ?? [])
    .filter((block) => block.type === 'output_text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n\n')
}

function extractReasoningSummary(payload: Record<string, unknown>) {
  const summary = Array.isArray(payload.summary) ? payload.summary : []

  return summary
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return ''
      }

      const text = (entry as Record<string, unknown>).text
      return typeof text === 'string' ? text.trim() : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function parseToolArguments(rawArguments: unknown) {
  if (typeof rawArguments !== 'string') {
    return rawArguments
  }

  try {
    return JSON.parse(rawArguments) as unknown
  } catch {
    return rawArguments
  }
}

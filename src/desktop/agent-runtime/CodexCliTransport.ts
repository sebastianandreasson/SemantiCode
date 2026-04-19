import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'
import type { AgentRunConfig, AgentTransport } from '@mariozechner/pi-agent/dist/transports/types.js'
import { EventStream } from '@mariozechner/pi-ai/dist/utils/event-stream.js'
import type {
  AgentEvent as PiAiAgentEvent,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
} from '@mariozechner/pi-ai'

import type { OpenAICodexProvider } from '../providers/openai-codex/provider'
import { parseCodexLineActions } from './codexEventParser'
import type { AgentToolInvocation } from '../../schema/agent'

const CODEX_AUTH_FILENAME = 'auth.json'
const CODEX_HOME_DIRNAME = 'codex-cli-runtime'
const MAX_STDERR_LINES = 12

export interface CodexCliTransportOptions {
  authProvider: OpenAICodexProvider
  logger?: Pick<Console, 'error' | 'info' | 'warn'>
  workspaceRootDir: string
}

interface ActiveCodexRunState {
  activeAssistantText: string
  hasLoggedStdoutLine: boolean
  hasLoggedStderrLine: boolean
  lastError: string | null
  processId: string
  stderrLines: string[]
  thinkingText: string
  toolInvocationsById: Map<string, AgentToolInvocation>
}

interface PartialAssistantState {
  message: AssistantMessage
  started: boolean
  textIndex: number | null
  thinkingIndex: number | null
}

type AgentEventStream = EventStream<PiAiAgentEvent, Message[]>

export class CodexCliTransport implements AgentTransport {
  private readonly authProvider: OpenAICodexProvider
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>
  private readonly workspaceRootDir: string

  constructor(options: CodexCliTransportOptions) {
    this.authProvider = options.authProvider
    this.logger = options.logger ?? console
    this.workspaceRootDir = options.workspaceRootDir
  }

  run(
    messages: Message[],
    userMessage: Message,
    config: AgentRunConfig,
    signal?: AbortSignal,
  ): AsyncIterable<PiAiAgentEvent> {
    const stream = new EventStream<PiAiAgentEvent, Message[]>(
      (event) => event.type === 'agent_end',
      (event) => (event.type === 'agent_end' ? event.messages : []),
    )

    void this.runCodex(messages, userMessage, config, stream, signal).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown Codex CLI transport failure.'
      const errorAssistantMessage = createAssistantMessage(config.model, {
        errorMessage,
        stopReason: signal?.aborted ? 'aborted' : 'error',
      })

      stream.push({ type: 'agent_start' })
      stream.push({ type: 'turn_start' })
      stream.push({ type: 'message_start', message: userMessage })
      stream.push({ type: 'message_end', message: userMessage })
      stream.push({ type: 'message_start', message: errorAssistantMessage })
      stream.push({ type: 'message_end', message: errorAssistantMessage })
      stream.push({
        type: 'turn_end',
        message: errorAssistantMessage,
        toolResults: [],
      })
      stream.push({
        type: 'agent_end',
        messages: [userMessage, errorAssistantMessage],
      })
    })

    return stream
  }

  private async runCodex(
    messages: Message[],
    userMessage: Message,
    config: AgentRunConfig,
    stream: AgentEventStream,
    signal?: AbortSignal,
  ) {
    const codexHome = await this.prepareCodexHome()
    const promptText = buildPromptTranscript(messages, userMessage)
    const child = spawn(
      'codex',
      [
        'exec',
        '--json',
        '--color',
        'never',
        '--skip-git-repo-check',
        '--ephemeral',
        '--full-auto',
        '--sandbox',
        'workspace-write',
        '-C',
        this.workspaceRootDir,
        '-m',
        config.model.id,
      ],
      {
        cwd: this.workspaceRootDir,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
        stdio: 'pipe',
      },
    )

    const processId = `codex-run:${randomUUID()}`
    const activeRunState: ActiveCodexRunState = {
      activeAssistantText: '',
      hasLoggedStdoutLine: false,
      hasLoggedStderrLine: false,
      lastError: null,
      processId,
      stderrLines: [],
      thinkingText: '',
      toolInvocationsById: new Map(),
    }
    const partialState = createPartialAssistantState(config.model)

    this.logger.info(
      `[semanticode][codex-cli-transport] Spawned run ${processId} for ${this.workspaceRootDir} with model ${config.model.id}.`,
    )

    let aborted = Boolean(signal?.aborted)
    const handleAbort = () => {
      aborted = true
      child.kill('SIGTERM')
    }

    stream.push({ type: 'agent_start' })
    stream.push({ type: 'turn_start' })
    stream.push({ type: 'message_start', message: userMessage })
    stream.push({ type: 'message_end', message: userMessage })

    if (signal) {
      signal.addEventListener('abort', handleAbort, { once: true })
    }

    child.stdin.write(promptText)
    child.stdin.end()

    const stopStdoutReader = attachLineReader(child.stdout, (line) => {
      this.handleStdoutLine(activeRunState, partialState, stream, line)
    })
    const stopStderrReader = attachLineReader(child.stderr, (line) => {
      const normalizedLine = line.trim()

      if (!normalizedLine) {
        return
      }

      if (!activeRunState.hasLoggedStderrLine) {
        activeRunState.hasLoggedStderrLine = true
        this.logger.warn(
          `[semanticode][codex-cli-transport] First stderr line for ${processId}: ${normalizedLine}`,
        )
      }

      activeRunState.stderrLines.push(normalizedLine)
      activeRunState.stderrLines = activeRunState.stderrLines.slice(-MAX_STDERR_LINES)
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 0))
    }).finally(() => {
      stopStdoutReader()
      stopStderrReader()
      if (signal) {
        signal.removeEventListener('abort', handleAbort)
      }
    })

    this.logger.info(
      `[semanticode][codex-cli-transport] Run ${processId} exited with status ${exitCode}.`,
    )

    finalizeOpenContent(partialState, stream)

    const finalAssistantMessage = createAssistantMessage(config.model, {
      content: partialState.message.content,
      errorMessage: undefined,
      stopReason: 'stop',
    })

    if (aborted) {
      const abortedMessage = createAssistantMessage(config.model, {
        content: partialState.message.content,
        errorMessage: 'Codex CLI run was aborted.',
        stopReason: 'aborted',
      })
      emitFinalTurn(stream, partialState, abortedMessage, userMessage)
      return
    }

    if (activeRunState.lastError) {
      const errorMessage = createAssistantMessage(config.model, {
        content: partialState.message.content,
        errorMessage: activeRunState.lastError,
        stopReason: 'error',
      })
      emitFinalTurn(stream, partialState, errorMessage, userMessage)
      return
    }

    if (exitCode !== 0) {
      const errorMessage = createAssistantMessage(config.model, {
        content: partialState.message.content,
        errorMessage: buildCodexExitError(activeRunState, exitCode),
        stopReason: 'error',
      })
      emitFinalTurn(stream, partialState, errorMessage, userMessage)
      return
    }

    ensureAssistantMessageStarted(partialState, stream)
    emitFinalTurn(stream, partialState, finalAssistantMessage, userMessage)
  }

  private handleStdoutLine(
    activeRunState: ActiveCodexRunState,
    partialState: PartialAssistantState,
    stream: AgentEventStream,
    line: string,
  ) {
    const actions = parseCodexLineActions(line)

    if (actions.length > 0 && !activeRunState.hasLoggedStdoutLine) {
      activeRunState.hasLoggedStdoutLine = true
      this.logger.info(
        `[semanticode][codex-cli-transport] First stdout event for ${activeRunState.processId}.`,
      )
    }

    for (const action of actions) {
      if (action.kind === 'error') {
        activeRunState.lastError = action.message
        continue
      }

      if (action.kind === 'thinking_text') {
        const nextThinkingText = appendStreamChunk(
          activeRunState.thinkingText,
          action.text,
        )
        const delta = nextThinkingText.slice(activeRunState.thinkingText.length)

        if (!delta) {
          continue
        }

        activeRunState.thinkingText = nextThinkingText
        ensureAssistantMessageStarted(partialState, stream)

        if (partialState.thinkingIndex === null) {
          partialState.thinkingIndex = partialState.message.content.length
          partialState.message.content.push({
            type: 'thinking',
            thinking: '',
          })
          emitAssistantUpdate(stream, partialState, {
            type: 'thinking_start',
            contentIndex: partialState.thinkingIndex,
            partial: cloneAssistantMessage(partialState.message),
          })
        }

        const content = partialState.message.content[
          partialState.thinkingIndex
        ] as ThinkingContent
        content.thinking += delta
        emitAssistantUpdate(stream, partialState, {
          type: 'thinking_delta',
          contentIndex: partialState.thinkingIndex,
          delta,
          partial: cloneAssistantMessage(partialState.message),
        })
        continue
      }

      if (action.kind === 'assistant_text') {
        const nextAssistantText = appendStreamChunk(
          activeRunState.activeAssistantText,
          action.text,
        )
        const delta = nextAssistantText.slice(activeRunState.activeAssistantText.length)

        if (!delta) {
          continue
        }

        activeRunState.activeAssistantText = nextAssistantText
        ensureAssistantMessageStarted(partialState, stream)

        if (partialState.textIndex === null) {
          partialState.textIndex = partialState.message.content.length
          partialState.message.content.push({
            type: 'text',
            text: '',
          })
          emitAssistantUpdate(stream, partialState, {
            type: 'text_start',
            contentIndex: partialState.textIndex,
            partial: cloneAssistantMessage(partialState.message),
          })
        }

        const content = partialState.message.content[partialState.textIndex] as TextContent
        content.text += delta
        emitAssistantUpdate(stream, partialState, {
          type: 'text_delta',
          contentIndex: partialState.textIndex,
          delta,
          partial: cloneAssistantMessage(partialState.message),
        })
        continue
      }

      if (action.kind === 'tool_call_start') {
        activeRunState.toolInvocationsById.set(
          action.invocation.toolCallId,
          action.invocation,
        )
        stream.push({
          type: 'tool_execution_start',
          args: action.invocation.args,
          toolCallId: action.invocation.toolCallId,
          toolName: action.invocation.toolName,
        })
        continue
      }

      if (action.kind === 'tool_call_end') {
        const existingInvocation = activeRunState.toolInvocationsById.get(action.toolCallId)

        if (!existingInvocation) {
          continue
        }

        stream.push({
          type: 'tool_execution_end',
          isError: Boolean(action.isError),
          result: formatCodexToolResult(action.result),
          toolCallId: existingInvocation.toolCallId,
          toolName: existingInvocation.toolName,
        })
      }
    }
  }

  private async prepareCodexHome() {
    const codexHome = join(app.getPath('userData'), CODEX_HOME_DIRNAME)

    await mkdir(codexHome, { recursive: true })
    await this.authProvider.materializeCodexCliAuth(codexHome)

    const authFilePath = join(codexHome, CODEX_AUTH_FILENAME)

    try {
      await readFile(authFilePath, 'utf8')
    } catch (error) {
      this.logger.error(
        `[semanticode][codex-cli-transport] Failed to materialize Codex auth at ${authFilePath}: ${
          error instanceof Error ? error.message : 'Unknown error.'
        }`,
      )
      throw error
    }

    return codexHome
  }
}

export function createCodexCliModel(modelId: string): Model<'openai-responses'> {
  return {
    api: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
    contextWindow: 1_000_000,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    },
    headers: {},
    id: modelId,
    input: ['text'],
    maxTokens: 64_000,
    name: modelId,
    provider: 'openai',
    reasoning: true,
  }
}

function emitFinalTurn(
  stream: AgentEventStream,
  partialState: PartialAssistantState,
  message: AssistantMessage,
  userMessage: Message,
) {
  ensureAssistantMessageStarted(partialState, stream)
  stream.push({
    type: 'message_end',
    message,
  })
  stream.push({
    type: 'turn_end',
    message,
    toolResults: [],
  })
  stream.push({
    type: 'agent_end',
    messages: [userMessage, message],
  })
}

function emitAssistantUpdate(
  stream: AgentEventStream,
  partialState: PartialAssistantState,
  assistantMessageEvent: AssistantMessageEvent,
) {
  stream.push({
    type: 'message_update',
    assistantMessageEvent,
    message: cloneAssistantMessage(partialState.message),
  })
}

function createPartialAssistantState(model: Model<Api>): PartialAssistantState {
  return {
    message: createAssistantMessage(model),
    started: false,
    textIndex: null,
    thinkingIndex: null,
  }
}

function ensureAssistantMessageStarted(
  partialState: PartialAssistantState,
  stream: AgentEventStream,
) {
  if (partialState.started) {
    return
  }

  partialState.started = true
  stream.push({
    type: 'message_start',
    message: cloneAssistantMessage(partialState.message),
  })
}

function finalizeOpenContent(
  partialState: PartialAssistantState,
  stream: AgentEventStream,
) {
  if (partialState.thinkingIndex !== null) {
    const content = partialState.message.content[partialState.thinkingIndex] as ThinkingContent
    emitAssistantUpdate(stream, partialState, {
      type: 'thinking_end',
      content: content.thinking,
      contentIndex: partialState.thinkingIndex,
      partial: cloneAssistantMessage(partialState.message),
    })
  }

  if (partialState.textIndex !== null) {
    const content = partialState.message.content[partialState.textIndex] as TextContent
    emitAssistantUpdate(stream, partialState, {
      type: 'text_end',
      content: content.text,
      contentIndex: partialState.textIndex,
      partial: cloneAssistantMessage(partialState.message),
    })
  }
}

function createAssistantMessage(
  model: Model<Api>,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    api: model.api,
    content: [],
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: 0,
      output: 0,
    },
    ...overrides,
  }
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  }
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
) {
  stream.setEncoding?.('utf8')
  let buffer = ''

  const flushBuffer = () => {
    const trimmedBuffer = buffer.trim()

    if (trimmedBuffer) {
      onLine(trimmedBuffer)
    }

    buffer = ''
  }

  const handleChunk = (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

    while (true) {
      const newlineIndex = buffer.search(/\r?\n/)

      if (newlineIndex === -1) {
        break
      }

      const line = buffer.slice(0, newlineIndex)
      const newlineLength = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(newlineIndex + newlineLength)
      onLine(line)
    }
  }

  stream.on('data', handleChunk)
  stream.on('end', flushBuffer)

  return () => {
    stream.off('data', handleChunk)
    stream.off('end', flushBuffer)
    flushBuffer()
  }
}

function appendStreamChunk(currentText: string, nextText: string) {
  if (!currentText) {
    return nextText
  }

  if (currentText.includes(nextText)) {
    return currentText
  }

  return `${currentText}\n\n${nextText}`
}

function buildPromptTranscript(messages: Message[], userMessage: Message) {
  const transcriptBlocks = [...messages, userMessage]
    .map((message) => serializeMessage(message))
    .filter(Boolean)

  const currentPrompt = extractUserFacingText(userMessage)

  if (transcriptBlocks.length <= 1) {
    return currentPrompt
  }

  return [
    'Continue this conversation in the active workspace.',
    '',
    'Conversation so far:',
    transcriptBlocks.join('\n\n'),
    '',
    'Respond to the latest user request only. Keep the prior conversation as context.',
  ].join('\n')
}

function serializeMessage(message: Message) {
  if (message.role === 'toolResult') {
    return ''
  }

  const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User'
  const text = extractUserFacingText(message)

  if (!text) {
    return ''
  }

  return `${roleLabel}:\n${text}`
}

function extractUserFacingText(message: Message) {
  if (typeof message.content === 'string') {
    return message.content.trim()
  }

  return message.content
    .map((block) => {
      if (block.type === 'text') {
        return block.text.trim()
      }

      if (block.type === 'thinking') {
        return `[thinking]\n${block.thinking.trim()}`
      }

      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function buildCodexExitError(activeRunState: ActiveCodexRunState, exitCode: number) {
  const stderrTail = activeRunState.stderrLines.filter(Boolean).join('\n')

  if (stderrTail) {
    return `Codex CLI exited with status ${exitCode}.\n${stderrTail}`
  }

  return `Codex CLI exited with status ${exitCode}.`
}

function formatCodexToolResult(result: unknown) {
  if (result === undefined || result === null) {
    return ''
  }

  if (typeof result === 'string') {
    return result
  }

  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

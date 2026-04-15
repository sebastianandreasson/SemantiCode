import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

import { app } from 'electron'

import type { AgentMessage, AgentToolInvocation } from '../../schema/agent'
import type { OpenAICodexProvider } from '../providers/openai-codex/provider'
import { parseCodexLineActions } from './codexEventParser'
import type { AgentRuntimeEventHandlers, CodexCliRuntimeSession } from './types'

interface CodexCliRuntimeOptions {
  authProvider: OpenAICodexProvider
  logger?: Pick<Console, 'error' | 'info' | 'warn'>
}

interface CodexCliRunInput extends AgentRuntimeEventHandlers {
  conversationHistory: AgentMessage[]
  modelId: string
  prompt: string
  session: CodexCliRuntimeSession
}

interface ActiveRunState {
  activeAssistantText: string
  child: ChildProcessWithoutNullStreams
  hasLoggedStdoutLine: boolean
  hasLoggedStderrLine: boolean
  processId: string
  sessionId: string
  stderrLines: string[]
  thinkingText: string
  toolInvocationsById: Map<string, AgentToolInvocation>
}

const CODEX_AUTH_FILENAME = 'auth.json'
const CODEX_HOME_DIRNAME = 'codex-cli-runtime'
const MAX_STDERR_LINES = 12

export class CodexCliRuntime {
  private readonly authProvider: OpenAICodexProvider
  private readonly activeRunsBySessionId = new Map<string, ActiveRunState>()
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>

  constructor(options: CodexCliRuntimeOptions) {
    this.authProvider = options.authProvider
    this.logger = options.logger ?? console
  }

  createSession(workspaceRootDir: string): CodexCliRuntimeSession {
    return {
      activeAssistantMessageId: null,
      activeProcessId: null,
      id: `codex-cli-session:${randomUUID()}`,
      workspaceRootDir,
    }
  }

  async run(input: CodexCliRunInput) {
    await this.cancel(input.session)
    input.onStateChange({
      runState: 'running',
    })

    const codexHome = await this.prepareCodexHome()
    const promptText = buildPromptTranscript(input.conversationHistory, input.prompt)
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
        input.session.workspaceRootDir,
        '-m',
        input.modelId,
      ],
      {
        cwd: input.session.workspaceRootDir,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
        stdio: 'pipe',
      },
    )

    const processId = `codex-run:${randomUUID()}`
    const activeRunState: ActiveRunState = {
      activeAssistantText: '',
      child,
      hasLoggedStdoutLine: false,
      hasLoggedStderrLine: false,
      processId,
      sessionId: input.session.id,
      stderrLines: [],
      thinkingText: '',
      toolInvocationsById: new Map(),
    }

    this.activeRunsBySessionId.set(input.session.id, activeRunState)
    input.session.activeProcessId = processId
    this.logger.info(
      `[codebase-visualizer][codex-cli] Spawned run ${processId} for session ${input.session.id} with model ${input.modelId}.`,
    )

    child.stdin.write(promptText)
    child.stdin.end()
    const stopStdoutReader = attachLineReader(child.stdout, (line) => {
      this.handleStdoutLine(activeRunState, line, input)
    })
    const stopStderrReader = attachLineReader(child.stderr, (line) => {
      const normalizedLine = line.trim()

      if (!normalizedLine) {
        return
      }

      if (!activeRunState.hasLoggedStderrLine) {
        activeRunState.hasLoggedStderrLine = true
        this.logger.warn(
          `[codebase-visualizer][codex-cli] First stderr line for ${processId}: ${normalizedLine}`,
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
      this.activeRunsBySessionId.delete(input.session.id)
      input.session.activeProcessId = null
    })

    this.logger.info(
      `[codebase-visualizer][codex-cli] Run ${processId} exited with status ${exitCode}.`,
    )

    const finalAssistantMessage = this.emitAssistantMessage(activeRunState, input, false)

    if (exitCode !== 0) {
      const errorMessage = buildCodexExitError(activeRunState, exitCode)

      input.onStateChange({
        lastError: errorMessage,
        runState: 'error',
      })

      if (!finalAssistantMessage || !hasVisibleAssistantContent(finalAssistantMessage)) {
        input.onMessage({
          blocks: [{ kind: 'text', text: errorMessage }],
          createdAt: new Date().toISOString(),
          id: `agent-message:${input.session.id}:error:${randomUUID()}`,
          role: 'assistant',
        })
      }

      throw new Error(errorMessage)
    }

    input.onStateChange({
      lastError: undefined,
      runState: 'ready',
    })
  }

  async cancel(session: CodexCliRuntimeSession) {
    const activeRunState = this.activeRunsBySessionId.get(session.id)

    if (!activeRunState) {
      return false
    }

    activeRunState.child.kill('SIGTERM')

    const killTimer = setTimeout(() => {
      activeRunState.child.kill('SIGKILL')
    }, 1500)

    activeRunState.child.once('close', () => {
      clearTimeout(killTimer)
    })

    return true
  }

  async disposeSession(session: CodexCliRuntimeSession) {
    await this.cancel(session)
  }

  private handleStdoutLine(
    activeRunState: ActiveRunState,
    line: string,
    input: CodexCliRunInput,
  ) {
    const actions = parseCodexLineActions(line)

    if (actions.length > 0 && !activeRunState.hasLoggedStdoutLine) {
      activeRunState.hasLoggedStdoutLine = true
      this.logger.info(
        `[codebase-visualizer][codex-cli] First stdout event for ${activeRunState.processId}.`,
      )
    }

    for (const action of actions) {
      if (action.kind === 'error') {
        activeRunState.stderrLines.push(action.message)
        activeRunState.stderrLines = activeRunState.stderrLines.slice(-MAX_STDERR_LINES)
        input.onStateChange({
          lastError: action.message,
          runState: 'running',
        })
        continue
      }

      if (action.kind === 'assistant_text') {
        activeRunState.activeAssistantText = appendStreamChunk(
          activeRunState.activeAssistantText,
          action.text,
        )
        this.emitAssistantMessage(activeRunState, input, true)
        continue
      }

      if (action.kind === 'thinking_text') {
        activeRunState.thinkingText = appendStreamChunk(
          activeRunState.thinkingText,
          action.text,
        )
        this.emitAssistantMessage(activeRunState, input, true)
        continue
      }

      if (action.kind === 'tool_call_start') {
        if (!input.onTool) {
          continue
        }

        activeRunState.toolInvocationsById.set(
          action.invocation.toolCallId,
          action.invocation,
        )
        input.onTool(action.invocation)
        continue
      }

      if (action.kind === 'tool_call_end') {
        if (!input.onTool) {
          continue
        }

        const existingInvocation = activeRunState.toolInvocationsById.get(action.toolCallId)

        if (!existingInvocation) {
          continue
        }

        input.onTool({
          ...existingInvocation,
          endedAt: new Date().toISOString(),
          isError: false,
        })
      }
    }
  }

  private emitAssistantMessage(
    activeRunState: ActiveRunState,
    input: CodexCliRunInput,
    isStreaming: boolean,
  ) {
    const blocks: AgentMessage['blocks'] = []

    if (activeRunState.thinkingText.trim().length > 0) {
      blocks.push({
        kind: 'thinking',
        text: activeRunState.thinkingText.trim(),
      })
    }

    if (activeRunState.activeAssistantText.trim().length > 0) {
      blocks.push({
        kind: 'text',
        text: activeRunState.activeAssistantText.trim(),
      })
    }

    if (blocks.length === 0) {
      return null
    }

    if (!input.session.activeAssistantMessageId) {
      input.session.activeAssistantMessageId = `agent-message:${input.session.id}:assistant:${randomUUID()}`
    }

    const assistantMessage: AgentMessage = {
      blocks,
      createdAt: new Date().toISOString(),
      id: input.session.activeAssistantMessageId,
      isStreaming,
      role: 'assistant',
    }

    input.onMessage(assistantMessage)

    if (!isStreaming) {
      input.session.activeAssistantMessageId = null
    }

    return assistantMessage
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
        `[codebase-visualizer][codex-cli] Failed to materialize Codex auth at ${authFilePath}: ${
          error instanceof Error ? error.message : 'Unknown error.'
        }`,
      )
      throw error
    }

    return codexHome
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

function buildPromptTranscript(conversationHistory: AgentMessage[], currentPrompt: string) {
  const transcriptBlocks = conversationHistory
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const blockText = message.blocks
        .map((block) => `${block.kind === 'thinking' ? '[thinking]' : ''}${block.text}`.trim())
        .filter(Boolean)
        .join('\n\n')

      return `${message.role === 'user' ? 'User' : 'Assistant'}:\n${blockText}`
    })
    .filter(Boolean)

  if (transcriptBlocks.length === 0) {
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

function buildCodexExitError(activeRunState: ActiveRunState, exitCode: number) {
  const stderrTail = activeRunState.stderrLines.filter(Boolean).join('\n')

  if (stderrTail) {
    return `Codex CLI exited with status ${exitCode}.\n${stderrTail}`
  }

  return `Codex CLI exited with status ${exitCode}.`
}

function hasVisibleAssistantContent(message: AgentMessage) {
  return message.blocks.some((block) => block.text.trim().length > 0)
}

import { resolve } from 'node:path'

import {
  buildAgentPromptText,
  DEFAULT_STANDALONE_HOST,
  DEFAULT_STANDALONE_PORT,
  startStandaloneServer,
} from '../hosts/standaloneServer'
import { readProjectSnapshot } from '../node/readProjectSnapshot'
import { createLayoutQuerySession } from '../planner/layoutQuery'
import { listSavedLayouts } from '../planner'

const DEFAULT_HOST = DEFAULT_STANDALONE_HOST
const DEFAULT_PORT = DEFAULT_STANDALONE_PORT

export interface RunCliOptions {
  args?: string[]
}

export async function runCli(options: RunCliOptions = {}) {
  const parsedArguments = parseArguments(options.args ?? process.argv.slice(2))

  if (parsedArguments.help) {
    printHelp()
    return
  }

  if (parsedArguments.command === 'layout-helper') {
    await runLayoutHelper(parsedArguments)
    return
  }

  const rootDir = resolve(parsedArguments.rootDir ?? process.cwd())
  const serverHandle = await startStandaloneServer({
    rootDir,
    host: parsedArguments.host,
    port: parsedArguments.port,
  })

  process.stdout.write(`Semanticode running at ${serverHandle.url}\n`)
  process.stdout.write(`Visualizing ${rootDir}\n`)
  process.stdout.write(
    `Agent instructions written to ${serverHandle.instructionsPath}\n\n`,
  )
  process.stdout.write('Copy/paste this to your favorite coding agent:\n\n')
  process.stdout.write(buildAgentPromptText(serverHandle.instructionsPath) + '\n\n')

  const shutdown = () => {
    void serverHandle.close().finally(() => {
      process.exit(0)
    })
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

interface ParsedArguments {
  command: 'serve' | 'layout-helper'
  help: boolean
  host: string
  port: number
  rootDir: string | null
}

function parseArguments(args: string[]): ParsedArguments {
  let command: ParsedArguments['command'] = 'serve'
  let help = false
  let host = DEFAULT_HOST
  let port = DEFAULT_PORT
  let rootDir: string | null = null

  const remainingArgs = [...args]

  if (remainingArgs[0] === 'layout-helper') {
    command = 'layout-helper'
    remainingArgs.shift()
  }

  for (let index = 0; index < remainingArgs.length; index += 1) {
    const argument = remainingArgs[index]

    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }

    if (argument === '--host') {
      host = remainingArgs[index + 1] ?? host
      index += 1
      continue
    }

    if (argument === '--root') {
      rootDir = remainingArgs[index + 1] ?? rootDir
      index += 1
      continue
    }

    if (argument === '--port' || argument === '-p') {
      const nextValue = Number(remainingArgs[index + 1])

      if (!Number.isFinite(nextValue)) {
        throw new Error(`Invalid port value: ${remainingArgs[index + 1] ?? ''}`)
      }

      port = nextValue
      index += 1
      continue
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    }

    rootDir = argument
  }

  return {
    command,
    help,
    host,
    port,
    rootDir,
  }
}

async function runLayoutHelper(parsedArguments: ParsedArguments) {
  const rootDir = resolve(parsedArguments.rootDir ?? process.cwd())
  const payload = JSON.parse(await readStdin()) as {
    args?: Record<string, unknown>
    operation?: string
  }

  if (!payload.operation) {
    throw new Error('layout-helper requires a JSON payload with an operation.')
  }

  const [snapshot, existingLayouts] = await Promise.all([
    readProjectSnapshot({
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
      rootDir,
    }),
    listSavedLayouts(rootDir),
  ])
  const session = createLayoutQuerySession('layout-helper', {
    executionPath: 'codex_cli_bridge',
    existingLayouts,
    nodeScope: 'symbols',
    prompt: 'CLI layout helper request',
    rootDir,
    snapshot,
  })
  const result = await session.execute({
    args: payload.args,
    operation: payload.operation as never,
  })

  process.stdout.write(JSON.stringify({
    ...result,
    queryStats: session.getStats(),
  }, null, 2))
  process.stdout.write('\n')
}

function readStdin() {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let input = ''

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => resolvePromise(input))
    process.stdin.on('error', rejectPromise)
  })
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: semanticode [path] [--port 3210] [--host 127.0.0.1]',
      '       semanticode layout-helper --root <path>',
      '',
      'Starts a local web app that visualizes the target repository.',
    ].join('\n') + '\n',
  )
}

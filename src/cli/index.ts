import { resolve } from 'node:path'

import {
  buildAgentPromptText,
  DEFAULT_STANDALONE_HOST,
  DEFAULT_STANDALONE_PORT,
  startStandaloneServer,
} from '../hosts/standaloneServer'

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
  help: boolean
  host: string
  port: number
  rootDir: string | null
}

function parseArguments(args: string[]): ParsedArguments {
  let help = false
  let host = DEFAULT_HOST
  let port = DEFAULT_PORT
  let rootDir: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }

    if (argument === '--host') {
      host = args[index + 1] ?? host
      index += 1
      continue
    }

    if (argument === '--port' || argument === '-p') {
      const nextValue = Number(args[index + 1])

      if (!Number.isFinite(nextValue)) {
        throw new Error(`Invalid port value: ${args[index + 1] ?? ''}`)
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
    help,
    host,
    port,
    rootDir,
  }
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: semanticode [path] [--port 3210] [--host 127.0.0.1]',
      '',
      'Starts a local web app that visualizes the target repository.',
    ].join('\n') + '\n',
  )
}

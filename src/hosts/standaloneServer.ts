import { readFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureAgentInstructions } from '../cli/agentInstructions'
import { handleCodebaseVisualizerRequest } from '../node/http'
import type { AgentRuntimeRequestBridge } from '../node/http'

export const DEFAULT_STANDALONE_HOST = '127.0.0.1'
export const DEFAULT_STANDALONE_PORT = 3210

const STANDALONE_HTML_ENTRY = '/standalone.html'

export interface StartStandaloneServerOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  rootDir: string
  host?: string
  port?: number
}

export interface StandaloneServerHandle {
  close: () => Promise<void>
  host: string
  instructionsPath: string
  port: number
  rootDir: string
  server: Server
  url: string
}

export async function startStandaloneServer(
  options: StartStandaloneServerOptions,
): Promise<StandaloneServerHandle> {
  const host = options.host ?? DEFAULT_STANDALONE_HOST
  const port = options.port ?? DEFAULT_STANDALONE_PORT
  const rootDir = resolve(options.rootDir)
  const instructionsPath = await ensureAgentInstructions(rootDir)
  const standaloneDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'standalone',
  )

  const server = createServer(async (request, response) => {
    const handled = await handleCodebaseVisualizerRequest(request, response, {
      agentRuntime: options.agentRuntime,
      rootDir,
      analyzeCalls: true,
      analyzeImports: true,
      analyzeSymbols: true,
    })

    if (handled) {
      return
    }

    await serveStandaloneAsset(request.url ?? '/', standaloneDir, response)
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, host, () => {
      server.off('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  const resolvedPort = typeof address === 'object' && address ? address.port : port
  const resolvedHost = typeof address === 'object' && address ? address.address : host

  return {
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error)
            return
          }

          resolvePromise()
        })
      }),
    host: resolvedHost,
    instructionsPath,
    port: resolvedPort,
    rootDir,
    server,
    url: `http://${resolvedHost}:${resolvedPort}`,
  }
}

export function buildAgentPromptText(instructionsPath: string) {
  return [
    `Look up "${instructionsPath}" and follow it to construct a new Codebase Visualizer layout draft for this repository.`,
    'Use the following layout brief:',
    '"REPLACE WITH YOUR CUSTOM STRUCTURE HERE"',
    'Save the result as a draft layout so it appears in Codebase Visualizer.',
  ].join('\n')
}

async function serveStandaloneAsset(
  urlPath: string,
  standaloneDir: string,
  response: ServerResponse,
) {
  const pathname = decodeURIComponent(urlPath.split('?')[0] || '/')
  const normalizedPath =
    pathname === '/'
      ? STANDALONE_HTML_ENTRY
      : pathname.replace(/\/+$/, '') || STANDALONE_HTML_ENTRY
  const targetPath = resolve(standaloneDir, `.${normalizedPath}`)

  if (!targetPath.startsWith(standaloneDir)) {
    response.statusCode = 403
    response.end('Forbidden')
    return
  }

  try {
    const fileContents = await readFile(targetPath)
    response.statusCode = 200
    response.setHeader(
      'Content-Type',
      getContentType(targetPath) ?? 'application/octet-stream',
    )
    response.end(fileContents)
    return
  } catch {
    if (pathname !== '/' && !pathname.startsWith('/assets/')) {
      await serveStandaloneAsset('/', standaloneDir, response)
      return
    }
  }

  response.statusCode = 404
  response.end('Not found')
}

function getContentType(pathValue: string) {
  switch (extname(pathValue)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return null
  }
}

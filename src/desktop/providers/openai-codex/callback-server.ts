import { createServer, type Server } from 'node:http'

export interface OpenAICodexCallbackServer {
  cancelWait: () => void
  close: () => Promise<void>
  redirectUri: string
  waitForCallback: () => Promise<string | null>
}

export interface OpenAICodexCallbackServerOptions {
  callbackPath?: string
  host?: string
  preferredPort?: number
  redirectHost?: string
  timeoutMs?: number
}

const DEFAULT_CALLBACK_PATH = '/auth/callback'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_REDIRECT_HOST = 'localhost'
const DEFAULT_PREFERRED_PORT = 1455
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export async function startOpenAICodexCallbackServer(
  options: OpenAICodexCallbackServerOptions = {},
): Promise<OpenAICodexCallbackServer> {
  const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH
  const host = options.host ?? DEFAULT_HOST
  const preferredPort = options.preferredPort ?? DEFAULT_PREFERRED_PORT
  const redirectHost = options.redirectHost ?? DEFAULT_REDIRECT_HOST
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let resolved = false
  let server: Server | null = null
  let resolveCallback!: (value: string | null) => void
  const callbackPromise = new Promise<string | null>((resolve) => {
    resolveCallback = resolve
  })

  const complete = (fn: () => void) => {
    if (resolved) {
      return
    }

    resolved = true
    fn()
  }

  const close = async () => {
    if (!server) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    }).catch(() => undefined)
  }

  const requestHandler = createServer((request, response) => {
    const requestUrl = request.url ? new URL(request.url, `http://${host}`) : null

    if (!requestUrl || request.method !== 'GET' || requestUrl.pathname !== callbackPath) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(buildErrorHtml('Callback route not found.'))
      return
    }

    const returnedState = requestUrl.searchParams.get('state')
    const code = requestUrl.searchParams.get('code')

    if (!returnedState) {
      response.statusCode = 400
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(buildErrorHtml('Missing OAuth state.'))
      return
    }

    if (!code) {
      response.statusCode = 400
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(buildErrorHtml('Missing authorization code.'))
      return
    }

    const socketAddress = server?.address()
    const port =
      socketAddress && typeof socketAddress === 'object'
        ? socketAddress.port
        : preferredPort
    const finalUrl = new URL(
      requestUrl.pathname + requestUrl.search,
      `http://${redirectHost}:${port}`,
    )

    response.statusCode = 200
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(buildSuccessHtml())

    complete(() => {
      resolveCallback(finalUrl.toString())
      void close()
    })
  })

  server = requestHandler

  let address: Awaited<ReturnType<typeof listen>> | null = null

  try {
    address = await listen(server, host, preferredPort)
  } catch (error) {
    console.error(
      '[openai-codex] Failed to bind http://127.0.0.1:1455/auth/callback. Falling back to manual paste.',
      error,
    )
  }

  const redirectUri = `http://${redirectHost}:${address?.port ?? preferredPort}${callbackPath}`
  const timeoutId = setTimeout(() => {
    complete(() => {
      resolveCallback(null)
      void close()
    })
  }, timeoutMs)

  return {
    cancelWait: () => {
      complete(() => {
        resolveCallback(null)
      })
    },
    close: async () => {
      clearTimeout(timeoutId)
      await close()
    },
    redirectUri,
    waitForCallback: async () => {
      try {
        return await callbackPromise
      } finally {
        clearTimeout(timeoutId)
      }
    },
  }
}

async function listen(server: Server, host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Failed to start the OpenAI callback server.')
  }

  return address
}

function buildSuccessHtml() {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>Semanticode Login</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>body{font-family:ui-sans-serif,system-ui,sans-serif;padding:32px;background:#f5efe3;color:#1b1a17}main{max-width:520px;margin:0 auto;background:#fff9ef;border-radius:16px;padding:24px;border:1px solid #ded6c5}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4d473b}</style>',
    '</head>',
    '<body><main><h1>Sign-in received</h1><p>OpenAI authentication completed. You can close this window and return to Semanticode.</p></main></body>',
    '</html>',
  ].join('')
}

function buildErrorHtml(message: string) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>Semanticode Login</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style>body{font-family:ui-sans-serif,system-ui,sans-serif;padding:32px;background:#f5efe3;color:#1b1a17}main{max-width:520px;margin:0 auto;background:#fff9ef;border-radius:16px;padding:24px;border:1px solid #ded6c5}h1{font-size:20px;margin:0 0 8px;color:#8b2e1d}p{margin:0;color:#4d473b}</style>',
    '</head>',
    `<body><main><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p></main></body>`,
    '</html>',
  ].join('')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

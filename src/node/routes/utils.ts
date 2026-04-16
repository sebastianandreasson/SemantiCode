import type { IncomingMessage, ServerResponse } from 'node:http'

export function buildRequestUrl(request: IncomingMessage) {
  const host = request.headers.host ?? '127.0.0.1'
  const protocol =
    host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http'
      : 'https'
  return `${protocol}://${host}${request.url ?? '/'}`
}

export function buildBrokerCallbackHtml(ok: boolean, message: string) {
  const statusLabel = ok ? 'Sign-in complete' : 'Sign-in failed'
  const accent = ok ? '#255034' : '#8a2d19'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${statusLabel}</title>
    <style>
      :root {
        color: #271f17;
        background: linear-gradient(180deg, #f6f0e5 0%, #efe7d8 100%);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
      }

      main {
        width: min(32rem, 100%);
        border: 1px solid #dfd6c8;
        border-radius: 1rem;
        background: rgba(255, 250, 243, 0.96);
        padding: 1.4rem 1.5rem;
        box-shadow: 0 20px 40px rgba(39, 31, 23, 0.08);
      }

      h1 {
        margin: 0 0 0.75rem;
        color: ${accent};
        font-size: 1.2rem;
      }

      p {
        margin: 0;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${statusLabel}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`
}

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export async function readJsonBody<T>(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

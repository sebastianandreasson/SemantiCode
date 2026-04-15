import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  acceptLayoutDraft,
  listLayoutDrafts,
  listSavedLayouts,
  rejectLayoutDraft,
} from '../planner'
import type {
  AgentBrokerCompleteRequest,
  AgentCodexImportResponse,
  AgentBrokerLoginStartResponse,
  AgentBrokerSessionResponse,
  AgentPromptRequest,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  DraftMutationResponse,
  LayoutStateResponse,
  ReadProjectSnapshotOptions,
} from '../types'
import { readProjectSnapshot } from './readProjectSnapshot'
import {
  CODEBASE_VISUALIZER_AGENT_AUTH_COMPLETE_ROUTE,
  CODEBASE_VISUALIZER_AGENT_AUTH_CALLBACK_ROUTE,
  CODEBASE_VISUALIZER_AGENT_AUTH_IMPORT_CODEX_ROUTE,
  CODEBASE_VISUALIZER_AGENT_AUTH_LOGIN_START_ROUTE,
  CODEBASE_VISUALIZER_AGENT_AUTH_LOGOUT_ROUTE,
  CODEBASE_VISUALIZER_AGENT_AUTH_SESSION_ROUTE,
  CODEBASE_VISUALIZER_AGENT_CANCEL_ROUTE,
  CODEBASE_VISUALIZER_AGENT_MESSAGE_ROUTE,
  CODEBASE_VISUALIZER_AGENT_SETTINGS_ROUTE,
  CODEBASE_VISUALIZER_AGENT_SESSION_ROUTE,
  CODEBASE_VISUALIZER_DRAFTS_ROUTE,
  CODEBASE_VISUALIZER_LAYOUTS_ROUTE,
  CODEBASE_VISUALIZER_ROUTE,
} from '../shared/constants'

export interface AgentRuntimeRequestBridge {
  beginBrokeredLogin: () => Promise<AgentBrokerLoginStartResponse>
  cancelWorkspaceSession: (workspaceRootDir: string) => Promise<boolean>
  completeManualBrokeredLogin: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  completeBrokeredLoginCallback: (callbackUrl: string) => Promise<{ ok: boolean; message: string }>
  getBrokerSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  importCodexAuthSession: () => Promise<AgentCodexImportResponse>
  ensureWorkspaceSession: (workspaceRootDir: string) => Promise<AgentStateResponse['session']>
  getSettings: () => Promise<AgentSettingsResponse['settings']>
  getWorkspaceMessages: (workspaceRootDir: string) => AgentStateResponse['messages']
  getWorkspaceSessionSummary: (workspaceRootDir: string) => AgentStateResponse['session']
  logoutBrokeredAuthSession: () => Promise<AgentBrokerSessionResponse['brokerSession']>
  promptWorkspaceSession: (workspaceRootDir: string, message: string) => Promise<void>
  saveSettings: (settings: AgentSettingsUpdateRequest) => Promise<AgentSettingsResponse['settings']>
}

export interface CodebaseVisualizerRequestHandlerOptions
  extends ReadProjectSnapshotOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  rootDir: string
  route?: string
}

export async function handleCodebaseVisualizerRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: CodebaseVisualizerRequestHandlerOptions,
) {
  const route = options.route ?? CODEBASE_VISUALIZER_ROUTE
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (!pathname?.startsWith('/__codebase-visualizer/')) {
    return false
  }

  try {
    if (pathname === route && method === 'GET') {
      const snapshot = await readProjectSnapshot({
        ...options,
        rootDir: options.rootDir,
      })

      sendJson(response, 200, snapshot)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_LAYOUTS_ROUTE && method === 'GET') {
      const state: LayoutStateResponse = {
        layouts: await listSavedLayouts(options.rootDir),
        draftLayouts: await listLayoutDrafts(options.rootDir),
        activeLayoutId: null,
        activeDraftId: null,
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_SESSION_ROUTE) {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      if (method === 'GET') {
        const state: AgentStateResponse = {
          session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
          messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        }

        sendJson(response, 200, state)
        return true
      }

      if (method === 'POST') {
        const session = await options.agentRuntime.ensureWorkspaceSession(options.rootDir)
        const state: AgentStateResponse = {
          session,
          messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        }

        sendJson(response, 200, state)
        return true
      }
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_MESSAGE_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const payload = await readJsonBody<AgentPromptRequest>(request)

      if (!payload?.message?.trim()) {
        sendJson(response, 400, {
          message: 'A non-empty message is required.',
        })
        return true
      }

      void options.agentRuntime.promptWorkspaceSession(options.rootDir, payload.message).catch((error) => {
        console.error(
          '[codebase-visualizer][agent] Background prompt failed:',
          error instanceof Error ? error.message : error,
        )
      })
      const state: AgentStateResponse = {
        session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_CANCEL_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      await options.agentRuntime.cancelWorkspaceSession(options.rootDir)
      const state: AgentStateResponse = {
        session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_SETTINGS_ROUTE) {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      if (method === 'GET') {
        const result: AgentSettingsResponse = {
          settings: await options.agentRuntime.getSettings(),
        }

        sendJson(response, 200, result)
        return true
      }

      if (method === 'POST') {
        const payload = await readJsonBody<AgentSettingsUpdateRequest>(request)

        if (!payload?.provider || !payload?.modelId) {
          sendJson(response, 400, {
            message: 'Provider and model are required.',
          })
          return true
        }

        const result: AgentSettingsResponse = {
          settings: await options.agentRuntime.saveSettings(payload),
        }

        sendJson(response, 200, result)
        return true
      }
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_SESSION_ROUTE && method === 'GET') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const result: AgentBrokerSessionResponse = {
        brokerSession: await options.agentRuntime.getBrokerSession(),
      }

      sendJson(response, 200, result)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_LOGIN_START_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const result = await options.agentRuntime.beginBrokeredLogin()
      sendJson(response, 200, result)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_COMPLETE_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const payload = await readJsonBody<AgentBrokerCompleteRequest>(request)

      if (!payload?.callbackUrl?.trim()) {
        sendJson(response, 400, {
          message: 'A callback URL is required.',
        })
        return true
      }

      const result = await options.agentRuntime.completeManualBrokeredLogin(payload.callbackUrl)
      sendJson(response, result.ok ? 200 : 400, result)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_IMPORT_CODEX_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const result = await options.agentRuntime.importCodexAuthSession()
      sendJson(response, 200, result)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_LOGOUT_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const result: AgentBrokerSessionResponse = {
        brokerSession: await options.agentRuntime.logoutBrokeredAuthSession(),
      }

      sendJson(response, 200, result)
      return true
    }

    if (pathname === CODEBASE_VISUALIZER_AGENT_AUTH_CALLBACK_ROUTE && method === 'GET') {
      if (!options.agentRuntime) {
        response.statusCode = 503
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(buildBrokerCallbackHtml(false, 'The embedded PI runtime is not available for this host.'))
        return true
      }

      const callbackUrl = buildRequestUrl(request)
      const result = await options.agentRuntime.completeBrokeredLoginCallback(callbackUrl)

      response.statusCode = result.ok ? 200 : 400
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(buildBrokerCallbackHtml(result.ok, result.message))
      return true
    }

    const draftMatch = pathname.match(
      new RegExp(`^${CODEBASE_VISUALIZER_DRAFTS_ROUTE}/([^/]+)/(accept|reject)$`),
    )

    if (draftMatch && method === 'POST') {
      const [, encodedDraftId, action] = draftMatch
      const draftId = decodeURIComponent(encodedDraftId)

      if (action === 'accept') {
        const layout = await acceptLayoutDraft(options.rootDir, draftId)
        const result: DraftMutationResponse = {
          ok: true,
          draftId,
          layout,
        }

        sendJson(response, 200, result)
        return true
      }

      await rejectLayoutDraft(options.rootDir, draftId)
      const result: DraftMutationResponse = {
        ok: true,
        draftId,
      }

      sendJson(response, 200, result)
      return true
    }

    return false
  } catch (error) {
    sendJson(response, 500, {
      message:
        error instanceof Error
          ? error.message
          : 'Failed to process codebase visualizer request.',
    })
    return true
  }
}

function buildRequestUrl(request: IncomingMessage) {
  const host = request.headers.host ?? '127.0.0.1'
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1')
    ? 'http'
    : 'https'
  return `${protocol}://${host}${request.url ?? '/'}`
}

function buildBrokerCallbackHtml(ok: boolean, message: string) {
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function readJsonBody<T>(request: IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return null
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ensureAgentInstructions } from '../cli/agentInstructions'
import { embedSemanticTexts } from './semanticEmbeddingService'
import {
  readPersistedPreprocessedWorkspaceContext,
  writePersistedPreprocessedWorkspaceContext,
} from './preprocessingPersistence'
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
  PreprocessingEmbeddingRequest,
  PreprocessingEmbeddingResponse,
  PreprocessingContextResponse,
  PreprocessingSummaryRequest,
  PreprocessingSummaryResponse,
  PreprocessingContextUpdateRequest,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  DraftMutationResponse,
  LayoutStateResponse,
  ReadProjectSnapshotOptions,
} from '../types'
import { readProjectSnapshot } from './readProjectSnapshot'
import {
  SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE,
  SEMANTICODE_AGENT_AUTH_CALLBACK_ROUTE,
  SEMANTICODE_AGENT_AUTH_IMPORT_CODEX_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE,
  SEMANTICODE_AGENT_AUTH_SESSION_ROUTE,
  SEMANTICODE_AGENT_CANCEL_ROUTE,
  SEMANTICODE_AGENT_MESSAGE_ROUTE,
  SEMANTICODE_AGENT_SETTINGS_ROUTE,
  SEMANTICODE_AGENT_SESSION_ROUTE,
  SEMANTICODE_DRAFTS_ROUTE,
  SEMANTICODE_LAYOUTS_ROUTE,
  SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE,
  SEMANTICODE_PREPROCESSING_ROUTE,
  SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE,
  SEMANTICODE_ROUTE,
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
  runOneOffPrompt: (
    workspaceRootDir: string,
    input: { message: string; systemPrompt?: string },
  ) => Promise<string>
  saveSettings: (settings: AgentSettingsUpdateRequest) => Promise<AgentSettingsResponse['settings']>
}

export interface SemanticodeRequestHandlerOptions
  extends ReadProjectSnapshotOptions {
  agentRuntime?: AgentRuntimeRequestBridge
  rootDir: string
  route?: string
}

export async function handleSemanticodeRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const route = options.route ?? SEMANTICODE_ROUTE
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (!pathname?.startsWith('/__semanticode/')) {
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

    if (pathname === SEMANTICODE_LAYOUTS_ROUTE && method === 'GET') {
      const state: LayoutStateResponse = {
        layouts: await listSavedLayouts(options.rootDir),
        draftLayouts: await listLayoutDrafts(options.rootDir),
        activeLayoutId: null,
        activeDraftId: null,
      }

      sendJson(response, 200, state)
      return true
    }

    if (pathname === SEMANTICODE_PREPROCESSING_ROUTE) {
      if (method === 'GET') {
        const result: PreprocessingContextResponse = {
          context: await readPersistedPreprocessedWorkspaceContext(options.rootDir),
        }

        sendJson(response, 200, result)
        return true
      }

      if (method === 'POST') {
        const payload = await readJsonBody<PreprocessingContextUpdateRequest>(request)

        if (!payload?.context?.snapshotId) {
          sendJson(response, 400, {
            message: 'A preprocessing context payload is required.',
          })
          return true
        }

        await writePersistedPreprocessedWorkspaceContext(options.rootDir, payload.context)

        const result: PreprocessingContextResponse = {
          context: payload.context,
        }

        sendJson(response, 200, result)
        return true
      }
    }

    if (pathname === SEMANTICODE_PREPROCESSING_SUMMARY_ROUTE && method === 'POST') {
      if (!options.agentRuntime) {
        sendJson(response, 503, {
          message: 'The embedded PI runtime is not available for this host.',
        })
        return true
      }

      const payload = await readJsonBody<PreprocessingSummaryRequest>(request)

      if (!payload?.message?.trim()) {
        sendJson(response, 400, {
          message: 'A preprocessing prompt is required.',
        })
        return true
      }

      const result: PreprocessingSummaryResponse = {
        text: await options.agentRuntime.runOneOffPrompt(options.rootDir, {
          message: payload.message,
          systemPrompt: payload.systemPrompt,
        }),
      }

      sendJson(response, 200, result)
      return true
    }

    if (pathname === SEMANTICODE_PREPROCESSING_EMBEDDINGS_ROUTE && method === 'POST') {
      const payload = await readJsonBody<PreprocessingEmbeddingRequest>(request)

      if (!payload?.texts?.length) {
        sendJson(response, 400, {
          message: 'A preprocessing embedding payload is required.',
        })
        return true
      }

      const result: PreprocessingEmbeddingResponse = {
        embeddings: await embedSemanticTexts({
          modelId: payload.modelId,
          texts: payload.texts,
        }),
      }

      sendJson(response, 200, result)
      return true
    }

    if (pathname === SEMANTICODE_AGENT_SESSION_ROUTE) {
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

    if (pathname === SEMANTICODE_AGENT_MESSAGE_ROUTE && method === 'POST') {
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

      await ensureAgentInstructions(options.rootDir)
      void options.agentRuntime.promptWorkspaceSession(options.rootDir, payload.message).catch((error) => {
        console.error(
          '[semanticode][agent] Background prompt failed:',
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

    if (pathname === SEMANTICODE_AGENT_CANCEL_ROUTE && method === 'POST') {
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

    if (pathname === SEMANTICODE_AGENT_SETTINGS_ROUTE) {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_SESSION_ROUTE && method === 'GET') {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE && method === 'POST') {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE && method === 'POST') {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_IMPORT_CODEX_ROUTE && method === 'POST') {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE && method === 'POST') {
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

    if (pathname === SEMANTICODE_AGENT_AUTH_CALLBACK_ROUTE && method === 'GET') {
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
      new RegExp(`^${SEMANTICODE_DRAFTS_ROUTE}/([^/]+)/(accept|reject)$`),
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
          : 'Failed to process semanticode request.',
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

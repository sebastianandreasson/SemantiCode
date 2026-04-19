import type { IncomingMessage, ServerResponse } from 'node:http'

import { ensureAgentInstructions } from '../../cli/agentInstructions'
import {
  SEMANTICODE_AGENT_AUTH_CALLBACK_ROUTE,
  SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE,
  SEMANTICODE_AGENT_AUTH_IMPORT_CODEX_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE,
  SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE,
  SEMANTICODE_AGENT_AUTH_SESSION_ROUTE,
  SEMANTICODE_AGENT_CANCEL_ROUTE,
  SEMANTICODE_AGENT_COMPACT_ROUTE,
  SEMANTICODE_AGENT_MESSAGE_ROUTE,
  SEMANTICODE_AGENT_SESSIONS_ROUTE,
  SEMANTICODE_AGENT_SESSION_NEW_ROUTE,
  SEMANTICODE_AGENT_SESSION_RESUME_ROUTE,
  SEMANTICODE_AGENT_SETTINGS_ROUTE,
  SEMANTICODE_AGENT_SESSION_ROUTE,
  SEMANTICODE_AGENT_THINKING_ROUTE,
} from '../../shared/constants'
import type {
  AgentCompactionRequest,
  AgentResumeSessionRequest,
  AgentBrokerCompleteRequest,
  AgentBrokerSessionResponse,
  AgentPromptRequest,
  AgentSessionListResponse,
  AgentSettingsResponse,
  AgentSettingsUpdateRequest,
  AgentStateResponse,
  AgentThinkingLevelRequest,
} from '../../types'
import type { SemanticodeRequestHandlerOptions } from './types'
import {
  buildBrokerCallbackHtml,
  buildRequestUrl,
  readJsonBody,
  sendJson,
} from './utils'

export async function handleAgentRoute(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: SemanticodeRequestHandlerOptions,
) {
  const pathname = request.url?.split('?')[0]
  const method = request.method ?? 'GET'

  if (
    pathname?.startsWith('/__semanticode/agent/') &&
    !options.agentRuntime
  ) {
    if (pathname === SEMANTICODE_AGENT_AUTH_CALLBACK_ROUTE && method === 'GET') {
      response.statusCode = 503
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(
        buildBrokerCallbackHtml(false, 'The embedded PI runtime is not available for this host.'),
      )
      return true
    }

    sendJson(response, 503, {
      message: 'The embedded PI runtime is not available for this host.',
    })
    return true
  }

  if (!options.agentRuntime) {
    return false
  }

  if (pathname === SEMANTICODE_AGENT_SESSION_ROUTE) {
    if (method === 'GET') {
      const state: AgentStateResponse = {
        session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }

    if (method === 'POST') {
      const session = await options.agentRuntime.ensureWorkspaceSession(options.rootDir)
      const state: AgentStateResponse = {
        session,
        messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
        timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
      }

      sendJson(response, 200, state)
      return true
    }
  }

  if (pathname === SEMANTICODE_AGENT_MESSAGE_ROUTE && method === 'POST') {
    const payload = await readJsonBody<AgentPromptRequest>(request)

    if (!payload?.message?.trim()) {
      sendJson(response, 400, {
        message: 'A non-empty message is required.',
      })
      return true
    }

    await ensureAgentInstructions(options.rootDir)
    void options.agentRuntime.promptWorkspaceSession(
      options.rootDir,
      payload.message,
      payload.metadata,
      payload.mode,
    ).catch((error) => {
      console.error(
        '[semanticode][agent] Background prompt failed:',
        error instanceof Error ? error.message : error,
      )
    })
    const state: AgentStateResponse = {
      session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_CANCEL_ROUTE && method === 'POST') {
    await options.agentRuntime.cancelWorkspaceSession(options.rootDir)
    const state: AgentStateResponse = {
      session: options.agentRuntime.getWorkspaceSessionSummary(options.rootDir),
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_SESSIONS_ROUTE && method === 'GET') {
    const result: AgentSessionListResponse = {
      sessions: await options.agentRuntime.listWorkspaceSessions(options.rootDir),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_SESSION_NEW_ROUTE && method === 'POST') {
    const session = await options.agentRuntime.startNewWorkspaceSession(options.rootDir)
    const state: AgentStateResponse = {
      session,
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_SESSION_RESUME_ROUTE && method === 'POST') {
    const payload = await readJsonBody<AgentResumeSessionRequest>(request)

    if (!payload?.sessionFile?.trim()) {
      sendJson(response, 400, {
        message: 'A session file is required.',
      })
      return true
    }

    const session = await options.agentRuntime.resumeWorkspaceSession(
      options.rootDir,
      payload.sessionFile,
    )
    const state: AgentStateResponse = {
      session,
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_THINKING_ROUTE && method === 'POST') {
    const payload = await readJsonBody<AgentThinkingLevelRequest>(request)
    const thinkingLevel = payload?.thinkingLevel

    if (
      thinkingLevel !== 'off' &&
      thinkingLevel !== 'minimal' &&
      thinkingLevel !== 'low' &&
      thinkingLevel !== 'medium' &&
      thinkingLevel !== 'high' &&
      thinkingLevel !== 'xhigh'
    ) {
      sendJson(response, 400, {
        message: 'A valid thinking level is required.',
      })
      return true
    }

    const session = await options.agentRuntime.setWorkspaceThinkingLevel(
      options.rootDir,
      thinkingLevel,
    )
    const state: AgentStateResponse = {
      session,
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_COMPACT_ROUTE && method === 'POST') {
    const payload = await readJsonBody<AgentCompactionRequest>(request)
    const session = await options.agentRuntime.compactWorkspaceSession(
      options.rootDir,
      payload?.instructions,
    )
    const state: AgentStateResponse = {
      session,
      messages: options.agentRuntime.getWorkspaceMessages(options.rootDir),
      timeline: options.agentRuntime.getWorkspaceTimeline(options.rootDir),
    }

    sendJson(response, 200, state)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_SETTINGS_ROUTE) {
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
    const result: AgentBrokerSessionResponse = {
      brokerSession: await options.agentRuntime.getBrokerSession(),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_AUTH_LOGIN_START_ROUTE && method === 'POST') {
    const result = await options.agentRuntime.beginBrokeredLogin()
    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_AUTH_COMPLETE_ROUTE && method === 'POST') {
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
    const result = await options.agentRuntime.importCodexAuthSession()
    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_AUTH_LOGOUT_ROUTE && method === 'POST') {
    const result: AgentBrokerSessionResponse = {
      brokerSession: await options.agentRuntime.logoutBrokeredAuthSession(),
    }

    sendJson(response, 200, result)
    return true
  }

  if (pathname === SEMANTICODE_AGENT_AUTH_CALLBACK_ROUTE && method === 'GET') {
    const callbackUrl = buildRequestUrl(request)
    const result = await options.agentRuntime.completeBrokeredLoginCallback(callbackUrl)

    response.statusCode = result.ok ? 200 : 400
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(buildBrokerCallbackHtml(result.ok, result.message))
    return true
  }

  return false
}

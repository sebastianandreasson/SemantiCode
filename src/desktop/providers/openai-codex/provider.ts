import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentBrokerCallbackResult, AgentBrokerLoginStartResponse } from '../../../schema/api'
import type { AgentBrokerSessionSummary } from '../../../schema/agent'
import { OpenAICodexAuthClient, type OpenAICodexAuthClientConfig } from './auth'
import { startOpenAICodexCallbackServer, type OpenAICodexCallbackServer } from './callback-server'
import { refreshOpenAICodexTokenIfNeeded } from './refresh'
import { OpenAICodexAuthStorage } from './storage'

export interface OpenAICodexProviderOptions {
  getClientConfig: () => Promise<OpenAICodexAuthClientConfig>
  logger?: Pick<Console, 'error' | 'info' | 'warn'>
  onAuthStateChanged?: () => Promise<void> | void
  openExternal?: (url: string) => Promise<void> | void
}

export class OpenAICodexProvider {
  private callbackServer: OpenAICodexCallbackServer | null = null
  private readonly authClient = new OpenAICodexAuthClient()
  private readonly getClientConfig: () => Promise<OpenAICodexAuthClientConfig>
  private readonly logger: Pick<Console, 'error' | 'info' | 'warn'>
  private readonly onAuthStateChanged?: () => Promise<void> | void
  private readonly openExternal?: (url: string) => Promise<void> | void
  private readonly storage = new OpenAICodexAuthStorage()

  constructor(options: OpenAICodexProviderOptions) {
    this.getClientConfig = options.getClientConfig
    this.logger = options.logger ?? console
    this.onAuthStateChanged = options.onAuthStateChanged
    this.openExternal = options.openExternal
  }

  async getAuthState(): Promise<AgentBrokerSessionSummary> {
    const summary = await this.storage.getAuthSummary()

    return {
      accountLabel: summary.accountLabel,
      hasAppSessionToken: summary.hasAccessToken,
      state: summary.state === 'signed_out'
        ? 'signed_out'
        : summary.state === 'pending'
          ? 'pending'
          : 'authenticated',
    }
  }

  async startLogin(): Promise<AgentBrokerLoginStartResponse> {
    await this.closeCallbackServer()

    const clientConfig = await this.getClientConfig()
    const callbackServer = await startOpenAICodexCallbackServer()
    const authorizationRequest = await this.authClient.createAuthorizationRequest(
      callbackServer.redirectUri,
      clientConfig,
    )

    await this.storage.savePendingLogin({
      codeVerifier: authorizationRequest.codeVerifier,
      redirectUri: callbackServer.redirectUri,
      state: authorizationRequest.state,
    })

    this.callbackServer = callbackServer
    void this.waitForAutomaticCallback(callbackServer)

    if (this.openExternal) {
      await this.openExternal(authorizationRequest.authorizationUrl)
    }

    await this.notifyAuthStateChanged()

    return {
      brokerSession: await this.getAuthState(),
      implemented: true,
      loginUrl: authorizationRequest.authorizationUrl,
      message: 'Opened the browser for ChatGPT sign-in.',
    }
  }

  async handleCallback(callbackUrl: string): Promise<AgentBrokerCallbackResult> {
    const pendingLogin = await this.storage.getPendingLogin()

    if (!pendingLogin) {
      return {
        ok: false,
        message: 'No OpenAI Codex sign-in is currently pending.',
      }
    }

    try {
      const clientConfig = await this.getClientConfig()
      const tokenSet = await this.authClient.exchangeAuthorizationCode({
        callbackUrl,
        codeVerifier: pendingLogin.codeVerifier,
        expectedState: pendingLogin.state,
        redirectUri: pendingLogin.redirectUri,
      }, clientConfig)

      await this.storage.saveAuthenticatedSession({
        ...tokenSet,
        accountId: extractOpenAiAccountId(tokenSet),
        accountLabel: extractOpenAiAccountLabel(tokenSet),
      })
      await this.closeCallbackServer()
      await this.notifyAuthStateChanged()

      return {
        ok: true,
        message: 'Sign-in completed. Return to Semanticode.',
      }
    } catch (error) {
      this.logger.warn(
        `[semanticode][openai-codex] Login callback failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
      )
      await this.storage.clear()
      await this.closeCallbackServer()
      await this.notifyAuthStateChanged()

      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : 'OpenAI Codex sign-in failed.',
      }
    }
  }

  async completeManualRedirect(callbackUrl: string) {
    return this.handleCallback(callbackUrl)
  }

  async refreshIfNeeded() {
    return this.refreshTokenSetIfNeeded(true)
  }

  async logout() {
    await this.storage.clear()
    await this.closeCallbackServer()
    await this.notifyAuthStateChanged()
    return this.getAuthState()
  }

  async getAccessToken() {
    const tokenSet = await this.refreshTokenSetIfNeeded(true)
    return tokenSet?.accessToken ?? null
  }

  async importCodexAuthSession() {
    const authFilePath = join(homedir(), '.codex', 'auth.json')
    const raw = await readFile(authFilePath, 'utf8').catch(() => null)

    if (!raw) {
      throw new Error('No local Codex auth session was found at ~/.codex/auth.json.')
    }

    const parsed = JSON.parse(raw) as {
      auth_mode?: string
      tokens?: {
        access_token?: string
        account_id?: string
        id_token?: string
        refresh_token?: string
      }
    }

    if (parsed.auth_mode !== 'chatgpt') {
      throw new Error('The local Codex auth cache is not using ChatGPT login.')
    }

    const accessToken = parsed.tokens?.access_token?.trim()

    if (!accessToken) {
      throw new Error('The local Codex auth cache does not contain an access token.')
    }

    await this.storage.saveAuthenticatedSession({
      accessToken,
      accountId: parsed.tokens?.account_id?.trim() || undefined,
      accountLabel: parsed.tokens?.account_id?.trim() || 'Codex ChatGPT session',
      idToken: parsed.tokens?.id_token?.trim() || undefined,
      refreshToken: parsed.tokens?.refresh_token?.trim() || undefined,
    })
    await this.notifyAuthStateChanged()

    return {
      brokerSession: await this.getAuthState(),
      message: 'Imported the local Codex ChatGPT session.',
    }
  }

  async materializeCodexCliAuth(targetDir: string) {
    await this.refreshTokenSetIfNeeded(false)
    const tokenSet = await this.storage.getTokenSet()

    if (!tokenSet?.accessToken) {
      throw new Error('No OpenAI Codex auth session is currently available.')
    }

    const authFilePath = join(targetDir, 'auth.json')
    const authFile = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: tokenSet.accessToken,
        account_id: tokenSet.accountId ?? null,
        id_token: tokenSet.idToken ?? null,
        refresh_token: tokenSet.refreshToken ?? null,
      },
      last_refresh: new Date().toISOString(),
    }

    await mkdir(targetDir, { recursive: true })
    await writeFile(authFilePath, JSON.stringify(authFile, null, 2), 'utf8')
    return authFilePath
  }

  private async refreshTokenSetIfNeeded(notifyAuthStateChanged: boolean) {
    const refreshed = await refreshOpenAICodexTokenIfNeeded({
      authClient: this.authClient,
      clientConfig: await this.getClientConfig(),
      logger: this.logger,
      storage: this.storage,
    })

    if (refreshed && notifyAuthStateChanged) {
      await this.notifyAuthStateChanged()
    }

    return refreshed
  }

  private async waitForAutomaticCallback(callbackServer: OpenAICodexCallbackServer) {
    try {
      const callbackUrl = await callbackServer.waitForCallback()

      if (!callbackUrl) {
        return
      }

      await this.handleCallback(callbackUrl)
    } catch (error) {
      this.logger.warn(
        `[semanticode][openai-codex] Automatic callback handling failed: ${error instanceof Error ? error.message : 'Unknown error.'}`,
      )
    }
  }

  private async closeCallbackServer() {
    if (!this.callbackServer) {
      return
    }

    const activeServer = this.callbackServer
    this.callbackServer = null
    await activeServer.close().catch(() => undefined)
  }

  private async notifyAuthStateChanged() {
    await this.onAuthStateChanged?.()
  }
}

function extractOpenAiAccountId(tokenSet: {
  accessToken: string
  idToken?: string
}) {
  const tokenCandidates = [tokenSet.idToken, tokenSet.accessToken]

  for (const token of tokenCandidates) {
    const payload = parseJwtPayload(token)
    const authClaim = payload?.['https://api.openai.com/auth']

    if (!authClaim || typeof authClaim !== 'object') {
      continue
    }

    const candidate = (authClaim as Record<string, unknown>).chatgpt_account_id

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return undefined
}

function extractOpenAiAccountLabel(tokenSet: {
  accessToken: string
  idToken?: string
}) {
  const tokenCandidates = [tokenSet.idToken, tokenSet.accessToken]

  for (const token of tokenCandidates) {
    const payload = parseJwtPayload(token)

    if (!payload) {
      continue
    }

    const email = payload.email

    if (typeof email === 'string' && email.trim().length > 0) {
      return email.trim()
    }

    const name = payload.name

    if (typeof name === 'string' && name.trim().length > 0) {
      return name.trim()
    }

    const subject = payload.sub

    if (typeof subject === 'string' && subject.trim().length > 0) {
      return subject.trim()
    }
  }

  return extractOpenAiAccountId(tokenSet) ?? 'OpenAI account'
}

function parseJwtPayload(token: string | undefined) {
  if (!token) {
    return null
  }

  const [, payloadSegment] = token.split('.')

  if (!payloadSegment) {
    return null
  }

  try {
    const normalizedSegment = payloadSegment.replace(/-/g, '+').replace(/_/g, '/')
    const padding = (4 - (normalizedSegment.length % 4)) % 4
    const paddedSegment = normalizedSegment.padEnd(
      normalizedSegment.length + padding,
      '=',
    )

    return JSON.parse(Buffer.from(paddedSegment, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

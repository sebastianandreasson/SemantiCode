import type { OpenAICodexAuthClient, OpenAICodexAuthClientConfig } from './auth'
import type { OpenAICodexAuthStorage } from './storage'

export interface OpenAICodexRefreshOptions {
  authClient: OpenAICodexAuthClient
  clientConfig: OpenAICodexAuthClientConfig
  logger?: Pick<Console, 'warn'>
  refreshWindowMs?: number
  storage: OpenAICodexAuthStorage
}

const DEFAULT_REFRESH_WINDOW_MS = 60_000

export async function refreshOpenAICodexTokenIfNeeded(
  options: OpenAICodexRefreshOptions,
) {
  const refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS
  const tokenSet = await options.storage.getTokenSet()

  if (!tokenSet) {
    return null
  }

  if (!tokenSet.expiresAt || Date.now() < Date.parse(tokenSet.expiresAt) - refreshWindowMs) {
    return tokenSet
  }

  if (!tokenSet.refreshToken) {
    options.logger?.warn?.('[codebase-visualizer][openai-codex] Access token expired and no refresh token is available.')
    return tokenSet
  }

  const refreshed = await options.authClient.refreshAccessToken(
    tokenSet.refreshToken,
    options.clientConfig,
  )

  await options.storage.saveAuthenticatedSession({
    ...refreshed,
    accountId: tokenSet.accountId,
    accountLabel: (await options.storage.getAuthSummary()).accountLabel,
  })

  return refreshed
}

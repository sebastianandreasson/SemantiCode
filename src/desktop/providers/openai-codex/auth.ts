import { createHash, randomBytes } from 'node:crypto'

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
]
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

export interface OpenAICodexAuthClientConfig {
  clientId?: string
  clientSecret?: string
}

export interface OpenAICodexAuthorizationRequest {
  authorizationUrl: string
  codeVerifier: string
  state: string
}

export interface OpenAICodexTokenSet {
  accessToken: string
  expiresAt?: string
  idToken?: string
  refreshToken?: string
}

export class OpenAICodexAuthClient {
  async createAuthorizationRequest(
    redirectUri: string,
    config: OpenAICodexAuthClientConfig,
  ): Promise<OpenAICodexAuthorizationRequest> {
    const clientId = getRequiredClientId(config)
    const codeVerifier = base64UrlEncode(randomBytes(32))
    const state = randomBytes(16).toString('hex')
    const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
    const authorizationUrl = new URL(OPENAI_AUTHORIZE_URL)

    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('scope', OPENAI_DEFAULT_SCOPES.join(' '))
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('id_token_add_organizations', 'true')
    authorizationUrl.searchParams.set('codex_cli_simplified_flow', 'true')
    authorizationUrl.searchParams.set('originator', 'pi')

    return {
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
      state,
    }
  }

  async exchangeAuthorizationCode(input: {
    callbackUrl: string
    codeVerifier: string
    expectedState: string
    redirectUri: string
  }, config: OpenAICodexAuthClientConfig): Promise<OpenAICodexTokenSet> {
    const parsedInput = parseAuthorizationInput(input.callbackUrl)
    const returnedState = parsedInput.state
    const authorizationCode = parsedInput.code
    const error = parsedInput.error

    if (returnedState && returnedState !== input.expectedState) {
      throw new Error('OpenAI OAuth callback state verification failed.')
    }

    if (error) {
      throw new Error(`Sign-in failed: ${error}`)
    }

    if (!authorizationCode) {
      throw new Error('OpenAI OAuth callback returned no authorization code.')
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: getRequiredClientId(config),
      code: authorizationCode,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    })
    const clientSecret = config.clientSecret?.trim()

    if (clientSecret) {
      params.set('client_secret', clientSecret)
    }

    const response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!response.ok) {
      throw new Error(await readErrorResponse(
        response,
        `OpenAI OAuth token exchange failed with status ${response.status}.`,
      ))
    }

    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
      id_token?: string
      refresh_token?: string
    }

    if (!payload.access_token) {
      throw new Error('OpenAI OAuth token exchange returned no access token.')
    }

    return normalizeTokenSet(payload)
  }

  async refreshAccessToken(
    refreshToken: string,
    config: OpenAICodexAuthClientConfig,
  ): Promise<OpenAICodexTokenSet> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getRequiredClientId(config),
      refresh_token: refreshToken,
    })
    const clientSecret = config.clientSecret?.trim()

    if (clientSecret) {
      params.set('client_secret', clientSecret)
    }

    const response = await fetch(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!response.ok) {
      throw new Error(await readErrorResponse(
        response,
        `OpenAI OAuth token refresh failed with status ${response.status}.`,
      ))
    }

    const payload = (await response.json()) as {
      access_token?: string
      expires_in?: number
      id_token?: string
      refresh_token?: string
    }

    if (!payload.access_token) {
      throw new Error('OpenAI OAuth token refresh returned no access token.')
    }

    return normalizeTokenSet(payload)
  }

}

function getRequiredClientId(config: OpenAICodexAuthClientConfig) {
  return config.clientId?.trim() || OPENAI_CODEX_CLIENT_ID
}

function normalizeTokenSet(payload: {
  access_token?: string
  expires_in?: number
  id_token?: string
  refresh_token?: string
}): OpenAICodexTokenSet {
  return {
    accessToken: payload.access_token!,
    expiresAt:
      typeof payload.expires_in === 'number'
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : undefined,
    idToken: payload.id_token,
    refreshToken: payload.refresh_token,
  }
}

function base64UrlEncode(value: Buffer) {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function parseAuthorizationInput(input: string) {
  const trimmedInput = input.trim()

  if (!trimmedInput) {
    return {
      code: undefined,
      error: undefined,
      state: undefined,
    }
  }

  try {
    const parsedUrl = new URL(trimmedInput)
    return {
      code: parsedUrl.searchParams.get('code') ?? undefined,
      error: parsedUrl.searchParams.get('error') ?? undefined,
      state: parsedUrl.searchParams.get('state') ?? undefined,
    }
  } catch {
    // Fall back to the simpler formats Codex accepts in manual mode.
  }

  if (trimmedInput.includes('#')) {
    const [code, state] = trimmedInput.split('#', 2)

    return {
      code: code?.trim() || undefined,
      error: undefined,
      state: state?.trim() || undefined,
    }
  }

  if (trimmedInput.includes('code=')) {
    const params = new URLSearchParams(trimmedInput)

    return {
      code: params.get('code') ?? undefined,
      error: params.get('error') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  return {
    code: trimmedInput,
    error: undefined,
    state: undefined,
  }
}

async function readErrorResponse(response: Response, fallbackMessage: string) {
  try {
    const payload = (await response.json()) as {
      error?: string
      error_description?: string
      message?: string
    }

    return payload.error_description || payload.message || payload.error || fallbackMessage
  } catch {
    return fallbackMessage
  }
}

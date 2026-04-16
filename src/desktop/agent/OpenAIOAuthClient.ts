import { createHash, randomBytes } from 'node:crypto'

const OPENAI_OAUTH_CLIENT_ID_ENV_NAME = 'SEMANTICODE_OPENAI_OAUTH_CLIENT_ID'
const OPENAI_OAUTH_CLIENT_SECRET_ENV_NAME = 'SEMANTICODE_OPENAI_OAUTH_CLIENT_SECRET'
const OPENAI_OPENID_CONFIGURATION_URL = 'https://auth.openai.com/.well-known/openid-configuration'
const OPENAI_OAUTH_DEFAULT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
]

interface OpenIdConfiguration {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
}

export interface OpenAIOAuthAuthorizationRequest {
  authorizationUrl: string
  codeVerifier: string
  state: string
}

export interface OpenAIOAuthTokenSet {
  accessToken: string
  expiresAt?: string
  idToken?: string
  refreshToken?: string
}

export interface OpenAIOAuthUserInfo {
  email?: string
  name?: string
  sub?: string
}

export interface OpenAIOAuthClientConfig {
  clientId?: string
  clientSecret?: string
}

export class OpenAIOAuthClient {
  async createAuthorizationRequest(redirectUri: string, config?: OpenAIOAuthClientConfig) {
    const configuration = await this.getConfiguration()
    const clientId = this.getClientId(config)
    const codeVerifier = createPkceCodeVerifier()
    const state = randomBytes(16).toString('hex')
    const codeChallenge = createPkceCodeChallenge(codeVerifier)
    const authorizationUrl = new URL(configuration.authorization_endpoint)

    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', clientId)
    authorizationUrl.searchParams.set('redirect_uri', redirectUri)
    authorizationUrl.searchParams.set('scope', OPENAI_OAUTH_DEFAULT_SCOPES.join(' '))
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('id_token_add_organizations', 'true')
    authorizationUrl.searchParams.set('originator', 'semanticode')

    return {
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
      state,
    } satisfies OpenAIOAuthAuthorizationRequest
  }

  async exchangeAuthorizationCode(input: {
    code: string
    codeVerifier: string
    redirectUri: string
  }, config?: OpenAIOAuthClientConfig) {
    const configuration = await this.getConfiguration()
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.getClientId(config),
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    })
    const clientSecret = this.getClientSecret(config)

    if (clientSecret) {
      params.set('client_secret', clientSecret)
    }

    const response = await fetch(configuration.token_endpoint, {
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

  async refreshAccessToken(refreshToken: string, config?: OpenAIOAuthClientConfig) {
    const configuration = await this.getConfiguration()
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.getClientId(config),
      refresh_token: refreshToken,
    })
    const clientSecret = this.getClientSecret(config)

    if (clientSecret) {
      params.set('client_secret', clientSecret)
    }

    const response = await fetch(configuration.token_endpoint, {
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

  async fetchUserInfo(accessToken: string) {
    const configuration = await this.getConfiguration()
    const response = await fetch(configuration.userinfo_endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      throw new Error(await readErrorResponse(
        response,
        `OpenAI OAuth userinfo request failed with status ${response.status}.`,
      ))
    }

    return (await response.json()) as OpenAIOAuthUserInfo
  }

  getClientId(config?: OpenAIOAuthClientConfig) {
    const clientId = config?.clientId?.trim() || process.env[OPENAI_OAUTH_CLIENT_ID_ENV_NAME]?.trim()

    if (!clientId) {
      throw new Error(
        'No OpenAI OAuth client id is configured. Set SEMANTICODE_OPENAI_OAUTH_CLIENT_ID.',
      )
    }

    return clientId
  }

  private getClientSecret(config?: OpenAIOAuthClientConfig) {
    return config?.clientSecret?.trim() || process.env[OPENAI_OAUTH_CLIENT_SECRET_ENV_NAME]?.trim() || undefined
  }

  private async getConfiguration() {
    const response = await fetch(OPENAI_OPENID_CONFIGURATION_URL)

    if (!response.ok) {
      throw new Error(
        `Failed to load OpenAI OAuth discovery metadata with status ${response.status}.`,
      )
    }

    return (await response.json()) as OpenIdConfiguration
  }
}

function normalizeTokenSet(payload: {
  access_token?: string
  expires_in?: number
  id_token?: string
  refresh_token?: string
}) {
  return {
    accessToken: payload.access_token!,
    expiresAt:
      typeof payload.expires_in === 'number'
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : undefined,
    idToken: payload.id_token,
    refreshToken: payload.refresh_token,
  } satisfies OpenAIOAuthTokenSet
}

function createPkceCodeVerifier() {
  return base64UrlEncode(randomBytes(32))
}

function createPkceCodeChallenge(codeVerifier: string) {
  return base64UrlEncode(createHash('sha256').update(codeVerifier).digest())
}

function base64UrlEncode(value: Buffer) {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
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

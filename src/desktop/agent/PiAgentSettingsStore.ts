import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'
import { getModels, type KnownProvider } from '@mariozechner/pi-ai'
import {
  AuthStorage,
  getAgentDir,
  ModelRegistry,
  type ModelRegistry as PiModelRegistry,
} from '@mariozechner/pi-coding-agent'

import type {
  AgentAuthMode,
  AgentBrokerSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
  AgentToolProfile,
} from '../../schema/agent'

const DEFAULT_AUTH_MODE: AgentAuthMode = 'brokered_oauth'
const DEFAULT_PROVIDER = 'openai'
export const CODEX_PROVIDER = 'openai-codex'
const DEFAULT_MODEL_ID = 'gpt-4.1-mini'
const DEFAULT_CODEX_MODEL_ID = 'gpt-5.4'
const DEFAULT_TOOL_PROFILE: AgentToolProfile = 'symbol_first'
const SETTINGS_FILENAME = 'agent-settings.json'
const APP_SERVER_URL_ENV_NAME = 'SEMANTICODE_PI_APP_SERVER_URL'
export const CODEX_OPENAI_MODELS = [
  'gpt-5.4',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.1-codex-mini',
] as const

interface PersistedSecret {
  encrypted: boolean
  value: string
}

interface PersistedSettings {
  authMode?: AgentAuthMode
  apiKeys?: Record<string, PersistedSecret>
  brokerAccountLabel?: string
  brokerAccessToken?: PersistedSecret
  brokerAuthState?: AgentBrokerSessionSummary['state']
  brokerIdToken?: PersistedSecret
  brokerPendingCodeVerifier?: PersistedSecret
  brokerPendingState?: string
  brokerRefreshToken?: PersistedSecret
  brokerTokenExpiresAt?: string
  modelId?: string
  toolProfile?: AgentToolProfile
  appServerUrl?: string
  openAiOAuthClientId?: string
  openAiOAuthClientSecret?: PersistedSecret
  provider?: string
}

export interface PiAgentSettingsStoreOptions {
  logger?: Pick<Console, 'warn'>
}

export class PiAgentSettingsStore {
  private readonly logger: Pick<Console, 'warn'>

  constructor(options: PiAgentSettingsStoreOptions = {}) {
    this.logger = options.logger ?? console
  }

  async getSettings(): Promise<AgentSettingsState> {
    const persisted = await this.readPersistedSettings()
    const authMode = this.normalizeAuthMode(persisted.authMode)
    const modelRegistry = this.createPiModelRegistry(persisted)
    const provider = this.normalizeProvider(persisted.provider, authMode, modelRegistry)
    const modelId = this.normalizeModelId(authMode, provider, persisted.modelId, modelRegistry)

    return {
      authMode,
      brokerSession: this.getBrokerSessionSummary(persisted),
      provider,
      modelId,
      toolProfile: this.normalizeToolProfile(persisted.toolProfile),
      hasApiKey: Boolean(await this.getStoredApiKey(provider)),
      appServerUrl: this.resolveAppServerUrl(persisted),
      hasAppServerUrl: Boolean(this.resolveAppServerUrl(persisted)),
      canEditAppServerUrl: !app.isPackaged,
      openAiOAuthClientId: this.getOpenAiOAuthClientId(persisted),
      hasOpenAiOAuthClientId: Boolean(this.getOpenAiOAuthClientId(persisted)),
      hasOpenAiOAuthClientSecret: Boolean(this.getOpenAiOAuthClientSecret(persisted)),
      canEditOpenAiOAuthConfig: !app.isPackaged,
      storageKind: this.getStorageKind(),
      availableProviders: this.getAvailableProviders(authMode, modelRegistry),
      availableModelsByProvider: this.getAvailableModelsByProvider(authMode, modelRegistry),
    }
  }

  async saveSettings(input: AgentSettingsInput): Promise<AgentSettingsState> {
    const persisted = await this.readPersistedSettings()
    const modelRegistry = this.createPiModelRegistry(persisted)
    const authMode = this.normalizeAuthMode(input.authMode ?? persisted.authMode)
    const provider = this.normalizeProvider(input.provider, authMode, modelRegistry)
    const modelId = this.normalizeModelId(authMode, provider, input.modelId, modelRegistry)
    const nextSettings: PersistedSettings = {
      ...persisted,
      authMode,
      provider,
      modelId,
      toolProfile: this.normalizeToolProfile(input.toolProfile ?? persisted.toolProfile),
      apiKeys: {
        ...(persisted.apiKeys ?? {}),
      },
    }

    if (input.clearAppServerUrl) {
      delete nextSettings.appServerUrl
    } else if (typeof input.appServerUrl === 'string') {
      const nextAppServerUrl = input.appServerUrl.trim()

      if (nextAppServerUrl.length > 0) {
        nextSettings.appServerUrl = nextAppServerUrl
      }
    }

    if (input.clearApiKey) {
      delete nextSettings.apiKeys?.[provider]
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
      nextSettings.apiKeys![provider] = this.serializeSecret(input.apiKey.trim())
    }

    if (input.clearOpenAiOAuthClientId) {
      delete nextSettings.openAiOAuthClientId
    } else if (typeof input.openAiOAuthClientId === 'string') {
      const nextClientId = input.openAiOAuthClientId.trim()

      if (nextClientId.length > 0) {
        nextSettings.openAiOAuthClientId = nextClientId
      }
    }

    if (input.clearOpenAiOAuthClientSecret) {
      delete nextSettings.openAiOAuthClientSecret
    } else if (typeof input.openAiOAuthClientSecret === 'string') {
      const nextClientSecret = input.openAiOAuthClientSecret.trim()

      if (nextClientSecret.length > 0) {
        nextSettings.openAiOAuthClientSecret = this.serializeSecret(nextClientSecret)
      }
    }

    await this.writePersistedSettings(nextSettings)
    return this.getSettings()
  }

  async getBrokerSession() {
    const persisted = await this.readPersistedSettings()
    return this.getBrokerSessionSummary(persisted)
  }

  async getBrokerAppSessionToken() {
    const persisted = await this.readPersistedSettings()
    const secret = persisted.brokerAccessToken

    if (!secret) {
      return null
    }

    return this.deserializeSecret(secret)
  }

  async getBrokerPendingState() {
    const persisted = await this.readPersistedSettings()
    return persisted.brokerPendingState ?? null
  }

  async getBrokerPendingCodeVerifier() {
    const persisted = await this.readPersistedSettings()
    const secret = persisted.brokerPendingCodeVerifier

    if (!secret) {
      return null
    }

    return this.deserializeSecret(secret)
  }

  async beginBrokerLogin(input: { codeVerifier: string; state: string }) {
    const persisted = await this.readPersistedSettings()
    const nextSettings: PersistedSettings = {
      ...persisted,
      brokerAuthState: 'pending',
      brokerPendingCodeVerifier: this.serializeSecret(input.codeVerifier),
      brokerPendingState: input.state,
    }

    delete nextSettings.brokerAccessToken
    delete nextSettings.brokerIdToken
    delete nextSettings.brokerRefreshToken
    delete nextSettings.brokerTokenExpiresAt
    delete nextSettings.brokerAccountLabel
    await this.writePersistedSettings(nextSettings)
  }

  async completeBrokerLogin(input: {
    accessToken: string
    accountLabel?: string
    expiresAt?: string
    idToken?: string
    refreshToken?: string
  }) {
    const persisted = await this.readPersistedSettings()
    const nextSettings: PersistedSettings = {
      ...persisted,
      brokerAccessToken: this.serializeSecret(input.accessToken),
      brokerAccountLabel: input.accountLabel,
      brokerAuthState: 'authenticated',
      brokerIdToken: input.idToken ? this.serializeSecret(input.idToken) : undefined,
      brokerRefreshToken: input.refreshToken
        ? this.serializeSecret(input.refreshToken)
        : persisted.brokerRefreshToken,
      brokerTokenExpiresAt: input.expiresAt,
    }

    delete nextSettings.brokerPendingCodeVerifier
    delete nextSettings.brokerPendingState
    await this.writePersistedSettings(nextSettings)
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

    await this.completeBrokerLogin({
      accessToken,
      accountLabel: parsed.tokens?.account_id?.trim() || 'Codex ChatGPT session',
      idToken: parsed.tokens?.id_token?.trim() || undefined,
      refreshToken: parsed.tokens?.refresh_token?.trim() || undefined,
    })
  }

  async updateBrokerTokens(input: {
    accessToken: string
    expiresAt?: string
    idToken?: string
    refreshToken?: string
  }) {
    const persisted = await this.readPersistedSettings()
    const nextSettings: PersistedSettings = {
      ...persisted,
      brokerAccessToken: this.serializeSecret(input.accessToken),
      brokerAuthState: 'authenticated',
      brokerIdToken: input.idToken ? this.serializeSecret(input.idToken) : persisted.brokerIdToken,
      brokerRefreshToken: input.refreshToken
        ? this.serializeSecret(input.refreshToken)
        : persisted.brokerRefreshToken,
      brokerTokenExpiresAt: input.expiresAt ?? persisted.brokerTokenExpiresAt,
    }

    await this.writePersistedSettings(nextSettings)
  }

  async getBrokerRefreshToken() {
    const persisted = await this.readPersistedSettings()
    const secret = persisted.brokerRefreshToken

    if (!secret) {
      return null
    }

    return this.deserializeSecret(secret)
  }

  async getBrokerTokenExpiry() {
    const persisted = await this.readPersistedSettings()
    return persisted.brokerTokenExpiresAt ?? null
  }

  async getOpenAIOAuthClientConfig() {
    const persisted = await this.readPersistedSettings()
    return {
      clientId: this.getOpenAiOAuthClientId(persisted) || undefined,
      clientSecret: this.getOpenAiOAuthClientSecret(persisted) || undefined,
    }
  }

  async getAppServerUrl() {
    const persisted = await this.readPersistedSettings()
    return this.resolveAppServerUrl(persisted)
  }

  async setBrokerSession(session: Partial<AgentBrokerSessionSummary>) {
    const persisted = await this.readPersistedSettings()
    const current = this.getBrokerSessionSummary(persisted)
    const nextSettings: PersistedSettings = {
      ...persisted,
      brokerAccountLabel: session.accountLabel ?? current.accountLabel,
      brokerAuthState: session.state ?? current.state,
    }

    if (nextSettings.brokerAuthState === 'signed_out') {
      delete nextSettings.brokerAccountLabel
      delete nextSettings.brokerAccessToken
      delete nextSettings.brokerIdToken
      delete nextSettings.brokerPendingState
      delete nextSettings.brokerPendingCodeVerifier
      delete nextSettings.brokerRefreshToken
      delete nextSettings.brokerTokenExpiresAt
    }

    await this.writePersistedSettings(nextSettings)
  }

  private getBrokerSessionSummary(
    persisted: PersistedSettings,
  ): AgentBrokerSessionSummary {
    return {
      accountLabel: persisted.brokerAccountLabel,
      hasAppSessionToken: Boolean(persisted.brokerAccessToken),
      state: persisted.brokerAuthState ?? 'signed_out',
    }
  }

  private getOpenAiOAuthClientId(persisted: PersistedSettings) {
    return persisted.openAiOAuthClientId?.trim() || process.env.SEMANTICODE_OPENAI_OAUTH_CLIENT_ID?.trim() || ''
  }

  private resolveAppServerUrl(persisted: PersistedSettings) {
    return persisted.appServerUrl?.trim() || process.env[APP_SERVER_URL_ENV_NAME]?.trim() || ''
  }

  private getOpenAiOAuthClientSecret(persisted: PersistedSettings) {
    const persistedSecret = persisted.openAiOAuthClientSecret

    if (persistedSecret) {
      return this.deserializeSecret(persistedSecret)
    }

    return process.env.SEMANTICODE_OPENAI_OAUTH_CLIENT_SECRET?.trim() || ''
  }

  async getStoredApiKey(provider: string) {
    const persisted = await this.readPersistedSettings()
    const secret = persisted.apiKeys?.[provider]

    if (!secret) {
      return null
    }

    return this.deserializeSecret(secret)
  }

  async getStoredApiKeys() {
    const persisted = await this.readPersistedSettings()
    const entries = Object.entries(persisted.apiKeys ?? {})
    const apiKeys: Record<string, string> = {}

    for (const [provider, secret] of entries) {
      const apiKey = this.deserializeSecret(secret)

      if (apiKey) {
        apiKeys[provider] = apiKey
      }
    }

    return apiKeys
  }

  private getAvailableProviders(
    authMode: AgentAuthMode = 'api_key',
    modelRegistry = this.createPiModelRegistry(),
  ) {
    const providers = authMode === 'brokered_oauth'
      ? [CODEX_PROVIDER]
      : [...new Set(modelRegistry.getAll().map((model) => String(model.provider)))]

    if (authMode !== 'brokered_oauth' && !providers.includes(DEFAULT_PROVIDER)) {
      providers.unshift(DEFAULT_PROVIDER)
    }

    return providers
  }

  private getAvailableModelsByProvider(
    authMode: AgentAuthMode,
    modelRegistry: PiModelRegistry,
  ) {
    return Object.fromEntries(
      this.getAvailableProviders(authMode, modelRegistry).map((provider) => [
        provider,
        this.getAvailableModelsForProvider(authMode, provider, modelRegistry),
      ]),
    )
  }

  private getAvailableModelsForProvider(
    authMode: AgentAuthMode,
    provider: string,
    modelRegistry = this.createPiModelRegistry(),
  ) {
    const registryModels = modelRegistry
      .getAll()
      .filter((model) => String(model.provider) === provider)
      .map((model) => ({
        authMode,
        id: model.id,
      }))

    if (registryModels.length > 0) {
      return registryModels
    }

    if (authMode === 'brokered_oauth' && provider === CODEX_PROVIDER) {
      return CODEX_OPENAI_MODELS.map((id) => ({
        authMode: 'brokered_oauth' as const,
        id,
      }))
    }

    return getModels(provider as KnownProvider).map((model) => ({
      authMode,
      id: model.id,
    }))
  }

  private normalizeProvider(
    provider: string | undefined,
    authMode: AgentAuthMode,
    modelRegistry: PiModelRegistry,
  ) {
    const availableProviders = this.getAvailableProviders(authMode, modelRegistry)

    if (authMode === 'brokered_oauth' && provider === DEFAULT_PROVIDER) {
      return CODEX_PROVIDER
    }

    if (provider && availableProviders.some((candidate) => candidate === provider)) {
      return provider
    }

    return authMode === 'brokered_oauth' ? CODEX_PROVIDER : DEFAULT_PROVIDER
  }

  private normalizeAuthMode(authMode: AgentAuthMode | undefined): AgentAuthMode {
    if (authMode === 'api_key' || authMode === 'brokered_oauth') {
      return authMode
    }

    return DEFAULT_AUTH_MODE
  }

  private normalizeModelId(
    authMode: AgentAuthMode,
    provider: string,
    modelId: string | undefined,
    modelRegistry: PiModelRegistry,
  ) {
    const models = this.getAvailableModelsForProvider(authMode, provider, modelRegistry)

    if (modelId && models.some((model) => model.id === modelId)) {
      return modelId
    }

    if (authMode === 'brokered_oauth' && provider === CODEX_PROVIDER) {
      return models[0]?.id ?? DEFAULT_CODEX_MODEL_ID
    }

    return models[0]?.id ?? DEFAULT_MODEL_ID
  }

  private createPiModelRegistry(persisted?: PersistedSettings) {
    const agentDir = getAgentDir()
    const authStorage = AuthStorage.create(join(agentDir, 'auth.json'))

    for (const [provider, secret] of Object.entries(persisted?.apiKeys ?? {})) {
      const apiKey = this.deserializeSecret(secret)

      if (apiKey) {
        authStorage.setRuntimeApiKey(provider, apiKey)
      }
    }

    return ModelRegistry.create(authStorage, join(agentDir, 'models.json'))
  }

  private getStorageKind(): AgentSettingsState['storageKind'] {
    return safeStorage.isEncryptionAvailable() ? 'safe_storage' : 'plaintext'
  }

  private normalizeToolProfile(value: unknown): AgentToolProfile {
    return value === 'standard' || value === 'symbol_first'
      ? value
      : DEFAULT_TOOL_PROFILE
  }

  private serializeSecret(value: string): PersistedSecret {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        encrypted: true,
        value: safeStorage.encryptString(value).toString('base64'),
      }
    }

    return {
      encrypted: false,
      value,
    }
  }

  private deserializeSecret(secret: PersistedSecret) {
    try {
      if (!secret.encrypted) {
        return secret.value
      }

      return safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
    } catch (error) {
      this.logger.warn(
        `[semanticode][pi] Failed to decrypt stored API key: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      )
      return null
    }
  }

  private async readPersistedSettings(): Promise<PersistedSettings> {
    try {
      const contents = await readFile(this.getSettingsPath(), 'utf8')
      return JSON.parse(contents) as PersistedSettings
    } catch {
      return {}
    }
  }

  private async writePersistedSettings(settings: PersistedSettings) {
    const path = this.getSettingsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(settings, null, 2), 'utf8')
  }

  private getSettingsPath() {
    return join(app.getPath('userData'), SETTINGS_FILENAME)
  }
}

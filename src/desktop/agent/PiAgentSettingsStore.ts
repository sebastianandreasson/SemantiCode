import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'
import { getModels, getProviders, setApiKey, type KnownProvider } from '@mariozechner/pi-ai'

import type {
  AgentAuthMode,
  AgentBrokerSessionSummary,
  AgentSettingsInput,
  AgentSettingsState,
} from '../../schema/agent'

const AGENT_BROKER_URL_ENV_NAME = 'CODEBASE_VISUALIZER_AGENT_BROKER_URL'
const DEFAULT_AUTH_MODE: AgentAuthMode = 'brokered_oauth'
const DEFAULT_PROVIDER = 'openai'
const DEFAULT_MODEL_ID = 'gpt-4.1-mini'
const SETTINGS_FILENAME = 'agent-settings.json'

interface PersistedSecret {
  encrypted: boolean
  value: string
}

interface PersistedSettings {
  authMode?: AgentAuthMode
  apiKeys?: Record<string, PersistedSecret>
  modelId?: string
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
    const provider = this.normalizeProvider(persisted.provider)
    const modelId = this.normalizeModelId(provider, persisted.modelId)

    return {
      authMode,
      brokerSession: this.getBrokerSessionSummary(),
      provider,
      modelId,
      hasApiKey: Boolean(await this.getStoredApiKey(provider)),
      storageKind: this.getStorageKind(),
      availableProviders: this.getAvailableProviders(),
      availableModelsByProvider: this.getAvailableModelsByProvider(),
    }
  }

  async saveSettings(input: AgentSettingsInput): Promise<AgentSettingsState> {
    const persisted = await this.readPersistedSettings()
    const authMode = this.normalizeAuthMode(input.authMode ?? persisted.authMode)
    const provider = this.normalizeProvider(input.provider)
    const modelId = this.normalizeModelId(provider, input.modelId)
    const nextSettings: PersistedSettings = {
      ...persisted,
      authMode,
      provider,
      modelId,
      apiKeys: {
        ...(persisted.apiKeys ?? {}),
      },
    }

    if (input.clearApiKey) {
      delete nextSettings.apiKeys?.[provider]
      setApiKey(provider, '')
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
      nextSettings.apiKeys![provider] = this.serializeSecret(input.apiKey.trim())
    }

    await this.writePersistedSettings(nextSettings)
    await this.applyConfiguredApiKeys()
    return this.getSettings()
  }

  private getBrokerSessionSummary(): AgentBrokerSessionSummary {
    const backendUrl = process.env[AGENT_BROKER_URL_ENV_NAME]?.trim()

    if (!backendUrl) {
      return {
        state: 'unconfigured',
      }
    }

    return {
      backendUrl,
      state: 'signed_out',
    }
  }

  async applyConfiguredApiKeys() {
    const persisted = await this.readPersistedSettings()
    const providers = this.getAvailableProviders()

    for (const provider of providers) {
      setApiKey(provider, '')
    }

    const entries = Object.entries(persisted.apiKeys ?? {})

    for (const [provider, secret] of entries) {
      const apiKey = this.deserializeSecret(secret)

      if (!apiKey) {
        continue
      }

      setApiKey(provider, apiKey)
    }
  }

  async getStoredApiKey(provider: string) {
    const persisted = await this.readPersistedSettings()
    const secret = persisted.apiKeys?.[provider]

    if (!secret) {
      return null
    }

    return this.deserializeSecret(secret)
  }

  private getAvailableProviders() {
    const providers = [...getProviders()]

    if (!providers.includes(DEFAULT_PROVIDER)) {
      providers.unshift(DEFAULT_PROVIDER)
    }

    return providers
  }

  private getAvailableModelsByProvider() {
    return Object.fromEntries(
      this.getAvailableProviders().map((provider) => [
        provider,
        getModels(provider).map((model) => ({ id: model.id })),
      ]),
    )
  }

  private normalizeProvider(provider: string | undefined) {
    const availableProviders = this.getAvailableProviders()

    if (provider && availableProviders.some((candidate) => candidate === provider)) {
      return provider as KnownProvider
    }

    return DEFAULT_PROVIDER
  }

  private normalizeAuthMode(authMode: AgentAuthMode | undefined): AgentAuthMode {
    if (authMode === 'api_key' || authMode === 'brokered_oauth') {
      return authMode
    }

    return DEFAULT_AUTH_MODE
  }

  private normalizeModelId(provider: string, modelId: string | undefined) {
    const models = getModels(provider as KnownProvider)

    if (modelId && models.some((model) => model.id === modelId)) {
      return modelId
    }

    return models[0]?.id ?? DEFAULT_MODEL_ID
  }

  private getStorageKind(): AgentSettingsState['storageKind'] {
    return safeStorage.isEncryptionAvailable() ? 'safe_storage' : 'plaintext'
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
        `[codebase-visualizer][pi] Failed to decrypt stored API key: ${
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

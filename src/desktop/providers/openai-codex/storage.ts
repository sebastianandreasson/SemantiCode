import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'

export type OpenAICodexAuthState = 'signed_out' | 'pending' | 'authenticated'

export interface OpenAICodexAuthSummary {
  accountId?: string
  accountLabel?: string
  expiresAt?: string
  hasAccessToken: boolean
  hasRefreshToken: boolean
  state: OpenAICodexAuthState
}

export interface OpenAICodexPendingLogin {
  codeVerifier: string
  redirectUri: string
  state: string
}

export interface OpenAICodexTokenSet {
  accessToken: string
  accountId?: string
  expiresAt?: string
  idToken?: string
  refreshToken?: string
}

interface PersistedSecret {
  encrypted: boolean
  value: string
}

interface PersistedOpenAICodexAuth {
  accessToken?: PersistedSecret
  accountId?: string
  accountLabel?: string
  expiresAt?: string
  idToken?: PersistedSecret
  pendingCodeVerifier?: PersistedSecret
  pendingRedirectUri?: string
  pendingState?: string
  refreshToken?: PersistedSecret
  state: OpenAICodexAuthState
  version: 1
}

const STORAGE_FILENAME = 'auth.json'

export class OpenAICodexAuthStorage {
  async getAuthSummary(): Promise<OpenAICodexAuthSummary> {
    const persisted = await this.readPersisted()

    return {
      accountId: persisted.accountId,
      accountLabel: persisted.accountLabel,
      expiresAt: persisted.expiresAt,
      hasAccessToken: Boolean(persisted.accessToken),
      hasRefreshToken: Boolean(persisted.refreshToken),
      state: persisted.state,
    }
  }

  async getPendingLogin(): Promise<OpenAICodexPendingLogin | null> {
    const persisted = await this.readPersisted()

    if (!persisted.pendingCodeVerifier || !persisted.pendingRedirectUri || !persisted.pendingState) {
      return null
    }

    return {
      codeVerifier: this.deserializeSecret(persisted.pendingCodeVerifier),
      redirectUri: persisted.pendingRedirectUri,
      state: persisted.pendingState,
    }
  }

  async getTokenSet(): Promise<OpenAICodexTokenSet | null> {
    const persisted = await this.readPersisted()

    if (!persisted.accessToken) {
      return null
    }

    return {
      accessToken: this.deserializeSecret(persisted.accessToken),
      accountId: persisted.accountId,
      expiresAt: persisted.expiresAt,
      idToken: persisted.idToken ? this.deserializeSecret(persisted.idToken) : undefined,
      refreshToken: persisted.refreshToken ? this.deserializeSecret(persisted.refreshToken) : undefined,
    }
  }

  async savePendingLogin(input: OpenAICodexPendingLogin) {
    const persisted = await this.readPersisted()
    const nextPersisted: PersistedOpenAICodexAuth = {
      ...persisted,
      pendingCodeVerifier: this.serializeSecret(input.codeVerifier),
      pendingRedirectUri: input.redirectUri,
      pendingState: input.state,
      state: 'pending',
    }

    delete nextPersisted.accessToken
    delete nextPersisted.accountLabel
    delete nextPersisted.expiresAt
    delete nextPersisted.idToken
    delete nextPersisted.refreshToken

    await this.writePersisted(nextPersisted)
  }

  async saveAuthenticatedSession(input: OpenAICodexTokenSet & { accountLabel?: string }) {
    const nextPersisted: PersistedOpenAICodexAuth = {
      accessToken: this.serializeSecret(input.accessToken),
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      expiresAt: input.expiresAt,
      idToken: input.idToken ? this.serializeSecret(input.idToken) : undefined,
      refreshToken: input.refreshToken ? this.serializeSecret(input.refreshToken) : undefined,
      state: 'authenticated',
      version: 1,
    }

    await this.writePersisted(nextPersisted)
  }

  async clear() {
    await this.writePersisted({
      state: 'signed_out',
      version: 1,
    })
  }

  private async getStoragePath() {
    return join(
      app.getPath('userData'),
      'providers',
      'openai-codex',
      STORAGE_FILENAME,
    )
  }

  private async readPersisted(): Promise<PersistedOpenAICodexAuth> {
    const storagePath = await this.getStoragePath()
    const raw = await readFile(storagePath, 'utf8').catch(() => null)

    if (!raw) {
      return {
        state: 'signed_out',
        version: 1,
      }
    }

    const parsed = JSON.parse(raw) as PersistedOpenAICodexAuth
    return {
      state: parsed.state ?? 'signed_out',
      version: 1,
      accessToken: parsed.accessToken,
      accountId: parsed.accountId,
      accountLabel: parsed.accountLabel,
      expiresAt: parsed.expiresAt,
      idToken: parsed.idToken,
      pendingCodeVerifier: parsed.pendingCodeVerifier,
      pendingRedirectUri: parsed.pendingRedirectUri,
      pendingState: parsed.pendingState,
      refreshToken: parsed.refreshToken,
    }
  }

  private async writePersisted(persisted: PersistedOpenAICodexAuth) {
    const storagePath = await this.getStoragePath()
    await mkdir(dirname(storagePath), { recursive: true })
    await writeFile(storagePath, JSON.stringify(persisted, null, 2), 'utf8')
  }

  private serializeSecret(value: string): PersistedSecret {
    if (this.canUseSafeStorage()) {
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
    if (!secret.encrypted) {
      return secret.value
    }

    return safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
  }

  private canUseSafeStorage() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
}

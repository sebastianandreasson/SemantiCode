import { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentSessionSummary, AgentSettingsState } from '../schema/agent'

const bridgeInfo = {
  hasAgentBridge: false,
  hasDesktopHost: true,
}

type MockClientShape = {
  beginBrokeredLogin: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  createSession: ReturnType<typeof vi.fn>
  getBridgeInfo: ReturnType<typeof vi.fn>
  getBrokerSession: ReturnType<typeof vi.fn>
  getHttpState: ReturnType<typeof vi.fn>
  getSettings: ReturnType<typeof vi.fn>
  importCodexAuthSession: ReturnType<typeof vi.fn>
  logoutBrokeredAuthSession: ReturnType<typeof vi.fn>
  saveSettings: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  completeBrokeredLogin: ReturnType<typeof vi.fn>
}

const mockClient: MockClientShape = {
  beginBrokeredLogin: vi.fn(),
  cancel: vi.fn(),
  createSession: vi.fn(),
  getBridgeInfo: vi.fn(),
  getBrokerSession: vi.fn(),
  getHttpState: vi.fn(),
  getSettings: vi.fn(),
  importCodexAuthSession: vi.fn(),
  logoutBrokeredAuthSession: vi.fn(),
  saveSettings: vi.fn(),
  sendMessage: vi.fn(),
  subscribe: vi.fn(),
  completeBrokeredLogin: vi.fn(),
}

vi.mock('../agent/DesktopAgentClient', () => {
  return {
    DesktopAgentClient: vi.fn(() => mockClient),
  }
})

import { AgentPanel } from './AgentPanel'

describe('AgentPanel OAuth reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockClient.getBridgeInfo.mockReturnValue(bridgeInfo)
    mockClient.subscribe.mockReturnValue(() => undefined)
    mockClient.cancel.mockResolvedValue(true)
    mockClient.sendMessage.mockResolvedValue(true)
    mockClient.beginBrokeredLogin.mockResolvedValue({
      brokerSession: { state: 'pending' },
      implemented: true,
      loginUrl: 'https://auth.openai.com/oauth/authorize?fake=true',
      message: 'Opened the browser for ChatGPT sign-in.',
    })
    mockClient.getBrokerSession.mockResolvedValue({ state: 'pending' })
    mockClient.importCodexAuthSession.mockResolvedValue({
      brokerSession: { state: 'authenticated', accountLabel: 'tester@example.com' },
      message: 'Imported the local Codex ChatGPT session.',
    })
    mockClient.logoutBrokeredAuthSession.mockResolvedValue({ state: 'signed_out' })
    mockClient.completeBrokeredLogin.mockResolvedValue({
      ok: true,
      message: 'Sign-in completed. Return to Semanticode.',
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('recreates the session after polled OAuth completion and enables sending', async () => {
    const signedOutSettings = buildSettings({ brokerState: 'signed_out' })
    const authenticatedSettings = buildSettings({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
    })

    const disabledSession = buildSession({
      brokerState: 'signed_out',
      id: 'session-disabled',
      runState: 'disabled',
    })
    const readySession = buildSession({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
      id: 'session-ready',
      runState: 'ready',
    })

    let settingsCallCount = 0
    mockClient.getSettings.mockImplementation(async () => {
      settingsCallCount += 1
      return settingsCallCount === 1 ? signedOutSettings : authenticatedSettings
    })

    let httpStateCallCount = 0
    mockClient.getHttpState.mockImplementation(async () => {
      httpStateCallCount += 1
      return httpStateCallCount === 1
        ? { messages: [], session: disabledSession, timeline: [] }
        : { messages: [], session: readySession, timeline: [] }
    })

    mockClient.createSession
      .mockResolvedValue(disabledSession)
      .mockResolvedValueOnce(disabledSession)
      .mockResolvedValueOnce(readySession)

    render(<AgentPanel desktopHostAvailable />)

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1100))
    })

    await waitFor(() => {
      expect(screen.getAllByText('ready').length).toBeGreaterThan(0)
    })

    const sendButton = screen.getByRole('button', { name: 'Send' })
    const composer = screen.getByRole('textbox')

    expect(mockClient.createSession.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(sendButton.hasAttribute('disabled')).toBe(true)
    expect(sendButton.getAttribute('title')).toBe('Enter a prompt to send.')
    expect(composer).not.toBeNull()
  })

  it('persists the selected Codex-safe model before starting brokered sign-in', async () => {
    const user = userEvent.setup()
    const authenticatedSettings = buildSettings({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
    })
    const readySession = buildSession({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
      id: 'session-ready',
      runState: 'ready',
    })
    const refreshedSession = {
      ...readySession,
      id: 'session-after-save',
      modelId: 'gpt-5.4-mini',
    }

    mockClient.getSettings.mockResolvedValue(authenticatedSettings)
    mockClient.getHttpState
      .mockResolvedValueOnce({ messages: [], session: readySession, timeline: [] })
      .mockResolvedValueOnce({ messages: [], session: refreshedSession, timeline: [] })
    mockClient.createSession
      .mockResolvedValueOnce(readySession)
      .mockResolvedValueOnce(refreshedSession)
    mockClient.saveSettings.mockResolvedValue({
      ...authenticatedSettings,
      modelId: 'gpt-5.4-mini',
    })

    mockClient.beginBrokeredLogin.mockResolvedValue({
      brokerSession: { state: 'pending' },
      implemented: true,
      loginUrl: 'https://auth.openai.com/oauth/authorize?fake=true',
      message: 'Opened the browser for ChatGPT sign-in.',
    })

    render(<AgentPanel desktopHostAvailable settingsOnly />)

    await waitFor(() => {
      expect(screen.getAllByText('ready').length).toBeGreaterThan(0)
    })

    const modelSelect = screen.getByLabelText('Model')
    const signInButton = screen.getByRole('button', { name: 'Sign In With OpenAI' })

    expect(screen.queryByRole('option', { name: 'gpt-4.1-nano' })).toBeNull()
    expect(screen.getByRole('option', { name: 'gpt-5.4' })).not.toBeNull()

    await user.selectOptions(modelSelect, 'gpt-5.4-mini')
    await user.click(signInButton)

    await waitFor(() => {
      expect(mockClient.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          authMode: 'brokered_oauth',
          modelId: 'gpt-5.4-mini',
          provider: 'openai',
        }),
      )
    })
  })

  it('renders timeline rows and keeps live tool events visible', async () => {
    const readySession = buildSession({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
      id: 'session-ready',
      runState: 'ready',
    })
    let listener: ((event: AgentEvent) => void) | null = null

    mockClient.getBridgeInfo.mockReturnValue({
      hasAgentBridge: true,
      hasDesktopHost: true,
    })
    mockClient.subscribe.mockImplementation((nextListener) => {
      listener = nextListener
      return () => undefined
    })
    mockClient.getSettings.mockResolvedValue(buildSettings({
      accountLabel: 'tester@example.com',
      brokerState: 'authenticated',
    }))
    mockClient.getHttpState.mockResolvedValue({
      messages: [],
      session: readySession,
      timeline: [
        {
          blockKind: 'text',
          createdAt: '2026-04-15T00:00:00.000Z',
          id: 'timeline:user',
          messageId: 'message:user',
          role: 'user',
          text: 'Change the panel',
          type: 'message',
        },
        {
          createdAt: '2026-04-15T00:00:01.000Z',
          event: 'turn_start',
          id: 'timeline:turn',
          label: 'turn start',
          status: 'running',
          type: 'lifecycle',
        },
      ],
    })

    render(<AgentPanel desktopHostAvailable />)

    await waitFor(() => {
      expect(screen.getByText('Change the panel')).not.toBeNull()
    })
    await waitFor(() => {
      expect(listener).not.toBeNull()
    })

    await act(async () => {
      listener?.({
        invocation: {
          args: { path: 'src/App.tsx' },
          startedAt: '2026-04-15T00:00:02.000Z',
          toolCallId: 'call-1',
          toolName: 'read',
        },
        sessionId: readySession.id,
        type: 'tool',
      })
    })

    expect(screen.getByText('tool read src/App.tsx')).not.toBeNull()
  })
})

function buildSettings(input: {
  accountLabel?: string
  brokerState: AgentSettingsState['brokerSession']['state']
}): AgentSettingsState {
  return {
    authMode: 'brokered_oauth',
    availableModelsByProvider: {
      openai: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }],
    },
    availableProviders: ['openai'],
    brokerSession: {
      accountLabel: input.accountLabel,
      hasAppSessionToken: input.brokerState === 'authenticated',
      state: input.brokerState,
    },
    canEditAppServerUrl: true,
    canEditOpenAiOAuthConfig: true,
    hasApiKey: false,
    hasAppServerUrl: false,
    hasOpenAiOAuthClientId: false,
    hasOpenAiOAuthClientSecret: false,
    modelId: 'gpt-5.4',
    openAiOAuthClientId: '',
    provider: 'openai',
    storageKind: 'plaintext',
  }
}

function buildSession(input: {
  accountLabel?: string
  brokerState: NonNullable<AgentSessionSummary['brokerSession']>['state']
  id: string
  runState: AgentSessionSummary['runState']
}): AgentSessionSummary {
  return {
    authMode: 'brokered_oauth',
    bootPromptEnabled: false,
    brokerSession: {
      accountLabel: input.accountLabel,
      hasAppSessionToken: input.brokerState === 'authenticated',
      state: input.brokerState,
    },
    createdAt: '2026-04-15T00:00:00.000Z',
    hasProviderApiKey: false,
    id: input.id,
    modelId: 'gpt-5.4',
    provider: 'openai',
    runState: input.runState,
    transport: 'codex_cli',
    updatedAt: '2026-04-15T00:00:00.000Z',
    workspaceRootDir: '/tmp/workspace',
  }
}

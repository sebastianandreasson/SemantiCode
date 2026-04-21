import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getRequestTelemetryPaths } from '@sebastianandreasson/pi-autonomous-agents'
import { describe, expect, it } from 'vitest'

import { AgentTelemetryService } from './telemetryService'

describe('AgentTelemetryService symbol attribution', () => {
  it('projects symbol ids from request telemetry spans into activity and heatmap events', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-telemetry-'))
    const telemetryPaths = getRequestTelemetryPaths({ cwd: rootDir })
    await mkdir(dirname(telemetryPaths.requestsFile), { recursive: true })

    await writeFile(
      telemetryPaths.requestsFile,
      `${JSON.stringify({
        files: ['src/app.ts'],
        requestId: 'request-1',
        runId: 'run-1',
        sessionId: 'session-1',
        source: 'pi-autonomous',
        timestamp: '2026-04-18T10:00:00.000Z',
        toolNames: ['readSymbolSlice'],
        totalTokens: 120,
        usageSource: 'provider',
      })}\n`,
      'utf8',
    )
    await writeFile(
      telemetryPaths.spansFile,
      `${JSON.stringify({
        paths: ['src/app.ts'],
        primaryPath: 'src/app.ts',
        requestId: 'request-1',
        sessionId: 'session-1',
        spanKind: 'tool_result',
        text: JSON.stringify({
          result: {
            symbolNodeIds: ['symbol:src/app.ts:useApp'],
          },
        }),
        timestamp: '2026-04-18T10:00:00.000Z',
        toolName: 'readSymbolSlice',
      })}\n`,
      'utf8',
    )

    const service = new AgentTelemetryService()
    const activity = await service.getTelemetryActivity({
      mode: 'symbols',
      rootDir,
      source: 'all',
      window: 'workspace',
    })
    const heatmap = await service.getTelemetryHeatmap({
      mode: 'symbols',
      rootDir,
      source: 'all',
      window: 'workspace',
    })

    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      confidence: 'exact',
      path: 'src/app.ts',
      symbolNodeIds: ['symbol:src/app.ts:useApp'],
    })
    expect(heatmap[0]).toMatchObject({
      nodeIds: ['symbol:src/app.ts:useApp'],
      path: 'src/app.ts',
      symbolNodeIds: ['symbol:src/app.ts:useApp'],
    })
  })

  it('persists interactive tool symbol references into request span text', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-telemetry-'))
    const service = new AgentTelemetryService()

    await service.recordInteractivePrompt({
      finishedAt: '2026-04-18T10:00:01.000Z',
      kind: 'workspace_chat',
      message: 'Describe useApp',
      modelId: 'gpt-5.4',
      promptSequence: 1,
      provider: 'openai',
      rootDir,
      sessionId: 'session-1',
      startedAt: '2026-04-18T10:00:00.000Z',
      toolInvocations: [
        {
          args: { path: 'src/app.ts' },
          paths: ['src/app.ts'],
          resultPreview: '{"ok":true}',
          symbolNodeIds: ['symbol:src/app.ts:useApp'],
          toolCallId: 'call-1',
          toolName: 'readSymbolSlice',
        },
      ],
    })

    const telemetryPaths = getRequestTelemetryPaths({ cwd: rootDir })
    const spansJsonl = await readFile(telemetryPaths.spansFile, 'utf8')

    expect(spansJsonl).toContain('symbol:src/app.ts:useApp')
  })

  it('limits telemetry to the active chat session boundary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-telemetry-'))
    const telemetryPaths = getRequestTelemetryPaths({ cwd: rootDir })
    await mkdir(dirname(telemetryPaths.requestsFile), { recursive: true })

    await writeFile(
      telemetryPaths.requestsFile,
      [
        {
          files: ['src/old.ts'],
          requestId: 'request-old-session',
          runId: 'session-1',
          sessionId: 'session-1',
          source: 'pi-autonomous',
          timestamp: '2026-04-18T10:00:00.000Z',
          toolNames: ['read_file'],
          totalTokens: 25,
          usageSource: 'provider',
        },
        {
          files: ['src/current.ts'],
          requestId: 'request-current-session',
          runId: 'session-1',
          sessionId: 'session-1',
          source: 'pi-autonomous',
          timestamp: '2026-04-18T10:02:00.000Z',
          toolNames: ['read_file'],
          totalTokens: 50,
          usageSource: 'provider',
        },
        {
          files: ['src/other.ts'],
          requestId: 'request-other-session',
          runId: 'session-2',
          sessionId: 'session-2',
          source: 'pi-autonomous',
          timestamp: '2026-04-18T10:03:00.000Z',
          toolNames: ['read_file'],
          totalTokens: 75,
          usageSource: 'provider',
        },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    )
    await writeFile(telemetryPaths.spansFile, '', 'utf8')

    const service = new AgentTelemetryService()
    const activity = await service.getTelemetryActivity({
      mode: 'symbols',
      rootDir,
      sessionId: 'session-1',
      sinceMs: Date.parse('2026-04-18T10:01:00.000Z'),
      source: 'all',
      window: 'session',
    })
    const overview = await service.getTelemetryOverview({
      mode: 'symbols',
      rootDir,
      sessionId: 'session-1',
      sinceMs: Date.parse('2026-04-18T10:01:00.000Z'),
      source: 'all',
      window: 'session',
    })

    expect(activity.map((event) => event.path)).toEqual(['src/current.ts'])
    expect(overview.requestCount).toBe(1)
    expect(overview.totalTokens).toBe(50)
  })
})

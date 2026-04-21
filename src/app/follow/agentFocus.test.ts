import { describe, expect, it } from 'vitest'

import type {
  AgentFileOperation,
  LayoutSpec,
  ProjectSnapshot,
  TelemetryActivityEvent,
} from '../../types'
import {
  buildAgentFocusSemanticLayout,
  buildAgentTouchedSymbolRecords,
} from './agentFocus'

describe('agent focus semantic layout', () => {
  it('prefers explicit symbol references and keeps them exact', () => {
    const snapshot = createSnapshot()
    const { touchedSymbols } = buildAgentTouchedSymbolRecords({
      dirtyFileEditSignals: [],
      fileOperations: [
        createFileOperation({
          id: 'operation:read:bar',
          kind: 'file_read',
          path: 'src/a.ts',
          symbolNodeIds: ['symbol:bar'],
          timestamp: '2026-04-20T10:00:59.000Z',
          toolName: 'readSymbolSlice',
        }),
      ],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      snapshot,
      telemetryActivityEvents: [],
      telemetryWindow: 60,
    })

    expect(touchedSymbols).toEqual([
      expect.objectContaining({
        confidence: 'exact_symbol',
        intent: 'read',
        path: 'src/a.ts',
        symbolId: 'symbol:bar',
        toolNames: ['readSymbolSlice'],
      }),
    ])
  })

  it('uses operation ranges before file-wide fallback', () => {
    const snapshot = createSnapshot()
    const { touchedSymbols } = buildAgentTouchedSymbolRecords({
      dirtyFileEditSignals: [],
      fileOperations: [
        createFileOperation({
          id: 'operation:edit:foo',
          kind: 'file_write',
          operationRanges: [
            {
              kind: 'edit',
              label: 'replacement',
              range: {
                start: { column: 0, line: 4 },
                end: { column: 12, line: 6 },
              },
              source: 'args',
            },
          ],
          path: 'src/a.ts',
          timestamp: '2026-04-20T10:00:50.000Z',
          toolName: 'apply_patch',
        }),
      ],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      snapshot,
      telemetryActivityEvents: [],
      telemetryWindow: 60,
    })

    expect(touchedSymbols).toEqual([
      expect.objectContaining({
        confidence: 'range_overlap',
        intent: 'edit',
        symbolId: 'symbol:foo',
      }),
    ])
  })

  it('filters live operations by the active numeric window', () => {
    const snapshot = createSnapshot()
    const { touchedSymbols } = buildAgentTouchedSymbolRecords({
      dirtyFileEditSignals: [],
      fileOperations: [
        createFileOperation({
          id: 'operation:read:recent',
          kind: 'file_read',
          path: 'src/b.ts',
          timestamp: '2026-04-20T10:00:50.000Z',
          toolName: 'sed',
        }),
        createFileOperation({
          id: 'operation:read:old',
          kind: 'file_read',
          path: 'src/a.ts',
          timestamp: '2026-04-20T09:58:00.000Z',
          toolName: 'sed',
        }),
      ],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      snapshot,
      telemetryActivityEvents: [],
      telemetryWindow: 60,
    })

    expect(touchedSymbols.map((record) => record.symbolId)).toEqual(['symbol:baz'])
    expect(touchedSymbols[0]).toEqual(
      expect.objectContaining({
        confidence: 'file_wide',
        intent: 'read',
      }),
    )
  })

  it('treats the chat session window as an externally scoped event set', () => {
    const snapshot = createSnapshot()
    const { touchedSymbols } = buildAgentTouchedSymbolRecords({
      dirtyFileEditSignals: [],
      fileOperations: [
        createFileOperation({
          id: 'operation:read:session',
          kind: 'file_read',
          path: 'src/a.ts',
          symbolNodeIds: ['symbol:bar'],
          timestamp: '2026-04-20T09:58:00.000Z',
          toolName: 'readSymbolSlice',
        }),
      ],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      snapshot,
      telemetryActivityEvents: [],
      telemetryWindow: 'session',
    })

    expect(touchedSymbols.map((record) => record.symbolId)).toEqual(['symbol:bar'])
  })

  it('derives a hidden-node semantic layout for only visible touched symbols', () => {
    const snapshot = createSnapshot()
    const result = buildAgentFocusSemanticLayout({
      dirtyFileEditSignals: [],
      fileOperations: [
        createFileOperation({
          id: 'operation:read:bar',
          kind: 'file_read',
          path: 'src/a.ts',
          symbolNodeIds: ['symbol:bar'],
          timestamp: '2026-04-20T10:00:59.000Z',
          toolName: 'readSymbolSlice',
        }),
        createFileOperation({
          id: 'operation:read:missing-placement',
          kind: 'file_read',
          path: 'src/b.ts',
          symbolNodeIds: ['symbol:baz'],
          timestamp: '2026-04-20T10:00:58.000Z',
          toolName: 'readSymbolSlice',
        }),
      ],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      semanticLayout: createSemanticLayout(),
      snapshot,
      telemetryActivityEvents: [],
      telemetryWindow: 60,
    })

    expect(result?.layout.title).toBe('Agent focus')
    expect(result?.layout.hiddenNodeIds).toContain('symbol:foo')
    expect(result?.layout.hiddenNodeIds).not.toContain('symbol:bar')
    expect(result?.touchedSymbols.map((record) => record.symbolId)).toEqual(['symbol:bar'])
    expect(result?.summary).toEqual({
      editCount: 0,
      fileCount: 1,
      readCount: 1,
      symbolCount: 1,
      unresolvedCount: 1,
    })
    expect(result?.unresolvedFileTouches[0]).toEqual(
      expect.objectContaining({
        reason: 'missing_placement',
        path: 'src/b.ts',
      }),
    )
  })

  it('reports unresolved paths that cannot map to a file or symbol', () => {
    const snapshot = createSnapshot()
    const { unresolvedFileTouches } = buildAgentTouchedSymbolRecords({
      dirtyFileEditSignals: [],
      fileOperations: [],
      nowMs: Date.parse('2026-04-20T10:01:00.000Z'),
      observedAtMs: Date.parse('2026-04-20T10:01:00.000Z'),
      snapshot,
      telemetryActivityEvents: [
        createTelemetryEvent({
          key: 'missing:file',
          path: 'src/missing.ts',
          timestamp: '2026-04-20T10:00:59.000Z',
        }),
        createTelemetryEvent({
          key: 'no:symbols',
          path: 'src/empty.ts',
          timestamp: '2026-04-20T10:00:58.000Z',
        }),
      ],
      telemetryWindow: 60,
    })

    expect(unresolvedFileTouches.map((touch) => touch.reason)).toEqual([
      'missing_file',
      'no_symbols',
    ])
  })
})

function createSnapshot(): ProjectSnapshot {
  return {
    detectedPlugins: [],
    edges: [],
    entryFileIds: ['file:a'],
    facetDefinitions: [],
    generatedAt: '2026-04-20T10:00:00.000Z',
    nodes: {
      'dir:src': {
        childIds: ['file:a', 'file:b', 'file:empty'],
        depth: 0,
        facets: [],
        id: 'dir:src',
        kind: 'directory',
        name: 'src',
        parentId: null,
        path: 'src',
        tags: [],
      },
      'file:a': {
        content: '',
        extension: '.ts',
        facets: [],
        id: 'file:a',
        kind: 'file',
        language: 'typescript',
        name: 'a.ts',
        parentId: 'dir:src',
        path: 'src/a.ts',
        size: 120,
        tags: [],
      },
      'file:b': {
        content: '',
        extension: '.ts',
        facets: [],
        id: 'file:b',
        kind: 'file',
        language: 'typescript',
        name: 'b.ts',
        parentId: 'dir:src',
        path: 'src/b.ts',
        size: 80,
        tags: [],
      },
      'file:empty': {
        content: '',
        extension: '.ts',
        facets: [],
        id: 'file:empty',
        kind: 'file',
        language: 'typescript',
        name: 'empty.ts',
        parentId: 'dir:src',
        path: 'src/empty.ts',
        size: 12,
        tags: [],
      },
      'symbol:foo': {
        facets: [],
        fileId: 'file:a',
        id: 'symbol:foo',
        kind: 'symbol',
        language: 'typescript',
        name: 'foo',
        parentSymbolId: null,
        path: 'src/a.ts:foo',
        range: {
          start: { column: 0, line: 1 },
          end: { column: 1, line: 10 },
        },
        symbolKind: 'function',
        tags: [],
      },
      'symbol:bar': {
        facets: [],
        fileId: 'file:a',
        id: 'symbol:bar',
        kind: 'symbol',
        language: 'typescript',
        name: 'bar',
        parentSymbolId: null,
        path: 'src/a.ts:bar',
        range: {
          start: { column: 0, line: 20 },
          end: { column: 1, line: 30 },
        },
        symbolKind: 'function',
        tags: [],
      },
      'symbol:baz': {
        facets: [],
        fileId: 'file:b',
        id: 'symbol:baz',
        kind: 'symbol',
        language: 'typescript',
        name: 'baz',
        parentSymbolId: null,
        path: 'src/b.ts:baz',
        range: {
          start: { column: 0, line: 3 },
          end: { column: 1, line: 8 },
        },
        symbolKind: 'class',
        tags: [],
      },
    },
    rootDir: '/workspace',
    rootIds: ['dir:src'],
    schemaVersion: 2,
    tags: [],
    totalFiles: 3,
  }
}

function createSemanticLayout(): LayoutSpec {
  return {
    annotations: [],
    createdAt: '2026-04-20T10:00:00.000Z',
    groups: [],
    hiddenNodeIds: [],
    id: 'layout:semantic:/workspace',
    lanes: [],
    nodeScope: 'symbols',
    placements: {
      'symbol:foo': { nodeId: 'symbol:foo', x: 0, y: 0 },
      'symbol:bar': { nodeId: 'symbol:bar', x: 240, y: 0 },
    },
    strategy: 'semantic',
    title: 'Semantic symbols',
    updatedAt: '2026-04-20T10:00:00.000Z',
  }
}

function createFileOperation(
  input: Partial<AgentFileOperation> & {
    id: string
    kind: AgentFileOperation['kind']
    path: string
    timestamp: string
    toolName: string
  },
): AgentFileOperation {
  return {
    confidence: 'exact',
    paths: [input.path],
    sessionId: 'session:agent',
    source: 'agent-tool',
    status: 'completed',
    ...input,
  }
}

function createTelemetryEvent(
  input: Partial<TelemetryActivityEvent> & Pick<TelemetryActivityEvent, 'key' | 'path' | 'timestamp'>,
): TelemetryActivityEvent {
  return {
    confidence: 'exact',
    requestCount: 1,
    runId: 'run:test',
    sessionId: 'session:test',
    source: 'autonomous',
    symbolNodeIds: [],
    toolNames: ['read_file'],
    totalTokens: 100,
    ...input,
  }
}

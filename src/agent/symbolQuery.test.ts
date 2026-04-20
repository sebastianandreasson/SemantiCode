import { describe, expect, it } from 'vitest'

import type { ProjectSnapshot, SymbolNode } from '../schema/snapshot'
import {
  createSymbolQuerySession,
  type SymbolQuerySessionResult,
} from './symbolQuery'

describe('symbol query session', () => {
  it('summarizes and finds symbols with compact refs', async () => {
    const session = createTestSession()
    const summary = unwrap(await session.execute({
      operation: 'getSymbolWorkspaceSummary',
    }))
    const matches = unwrap(await session.execute({
      args: {
        nameContains: 'agent',
        symbolKind: 'function',
      },
      operation: 'findSymbols',
    }))

    expect(summary).toMatchObject({
      capabilities: {
        calls: true,
        imports: true,
        symbols: true,
      },
      totalFiles: 2,
      totalSymbols: 4,
    })
    expect(matches).toMatchObject({
      symbols: [
        expect.objectContaining({
          filePath: 'src/agent.ts',
          id: 'symbol:agent',
          name: 'runAgent',
          symbolKind: 'function',
        }),
      ],
      symbolNodeIds: ['symbol:agent'],
      total: 1,
    })
  })

  it('sorts symbols by LOC for top-N requests', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        limit: 2,
        sortBy: 'loc',
        sortDirection: 'desc',
      },
      operation: 'findSymbols',
    }))

    expect(result).toMatchObject({
      limit: 2,
      sortBy: 'loc',
      sortDirection: 'desc',
      symbols: [
        expect.objectContaining({
          id: 'symbol:agent',
          loc: 4,
          name: 'runAgent',
        }),
        expect.objectContaining({
          id: 'symbol:helper',
          loc: 3,
          name: 'helper',
        }),
      ],
      symbolNodeIds: ['symbol:agent', 'symbol:helper'],
      truncated: true,
      total: 4,
    })
  })

  it('outlines large symbols without returning the whole body', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        previewLines: 2,
        symbolId: 'symbol:agent',
      },
      operation: 'getSymbolOutline',
    }))

    expect(result).toMatchObject({
      outlines: [
        expect.objectContaining({
          loc: 4,
          nestedSymbolCount: 1,
          nestedSymbols: [
            expect.objectContaining({
              id: 'symbol:normalized',
              name: 'normalized',
            }),
          ],
          sourcePreview: expect.objectContaining({
            hasMoreAfter: true,
            lineCount: 2,
            nextStartLine: 5,
            totalSymbolLines: 4,
          }),
          symbol: expect.objectContaining({
            id: 'symbol:agent',
          }),
        }),
      ],
      symbolNodeIds: ['symbol:agent'],
      total: 1,
    })
    expect(
      ((result.outlines as Array<{ sourcePreview: { text: string } }>)[0]).sourcePreview.text,
    ).toContain('export function runAgent')
  })

  it('expands bounded symbol neighborhoods', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        depth: 1,
        edgeKinds: ['calls'],
        seedSymbolIds: ['symbol:agent'],
      },
      operation: 'getSymbolNeighborhood',
    }))

    expect(result).toMatchObject({
      depth: 1,
      edges: [
        expect.objectContaining({
          kind: 'calls',
          source: 'symbol:agent',
          target: 'symbol:helper',
        }),
      ],
      symbolNodeIds: ['symbol:agent', 'symbol:helper'],
    })
  })

  it('reads exact symbol slices with optional context', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        afterLines: 1,
        beforeLines: 1,
        symbolId: 'symbol:agent',
      },
      operation: 'readSymbolSlice',
    }))

    expect(result).toMatchObject({
      contextRange: {
        start: { line: 2 },
        end: { line: 7 },
      },
      file: {
        path: 'src/agent.ts',
      },
      symbolNodeIds: ['symbol:agent'],
      truncated: false,
    })
    expect((result as { text: string }).text).toContain('export function runAgent')
    expect((result as { text: string }).text).toContain('return helper(normalized)')
  })

  it('pages through large symbol slices without falling back to file windows', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        maxLines: 2,
        symbolId: 'symbol:agent',
      },
      operation: 'readSymbolSlice',
    }))

    expect(result).toMatchObject({
      contextRange: {
        start: { line: 3 },
        end: { line: 4 },
      },
      hasMoreAfter: true,
      maxLines: 2,
      nextRelativeStartLine: 3,
      nextStartLine: 5,
      truncated: true,
    })

    const nextResult = unwrap(await session.execute({
      args: {
        maxLines: 2,
        relativeStartLine: result.nextRelativeStartLine,
        symbolId: 'symbol:agent',
      },
      operation: 'readSymbolSlice',
    }))

    expect(nextResult).toMatchObject({
      contextRange: {
        start: { line: 5 },
        end: { line: 6 },
      },
      hasMoreAfter: false,
      hasMoreBefore: true,
      truncated: true,
    })
    expect((nextResult as { text: string }).text).toContain('return helper(normalized)')
  })

  it('resolves a file path to the largest symbol when reading a symbol slice', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        path: 'src/agent.ts',
      },
      operation: 'readSymbolSlice',
    }))

    expect(result).toMatchObject({
      file: {
        path: 'src/agent.ts',
      },
      symbol: expect.objectContaining({
        id: 'symbol:agent',
      }),
      symbolNodeIds: ['symbol:agent'],
    })
  })

  it('reads bounded file windows from symbol paths', async () => {
    const session = createTestSession()
    const result = unwrap(await session.execute({
      args: {
        maxLines: 2,
        path: 'src/agent.ts#runAgent@3:0',
        reason: 'Need import and function header.',
        startLine: 1,
      },
      operation: 'readFileWindow',
    }))

    expect(result).toMatchObject({
      file: {
        path: 'src/agent.ts',
      },
      lineCount: 2,
      range: {
        start: { line: 1 },
        end: { line: 2 },
      },
      reason: 'Need import and function header.',
      windowHash: expect.any(String),
    })
    expect((result as { text: string }).text).toBe([
      "import { helper } from './helper'",
      '',
    ].join('\n'))
  })

  it('requires an explicit reason for file window fallbacks', async () => {
    const session = createTestSession()
    const result = await session.execute({
      args: {
        path: 'src/agent.ts',
      },
      operation: 'readFileWindow',
    })

    expect(result).toMatchObject({
      ok: false,
      warning: 'readFileWindow requires a reason explaining why symbol slices are insufficient.',
    })
  })

  it('replaces a bounded file window when the expected window hash matches', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    let invalidationCount = 0
    const session = createTestSession({
      fileWriter: async (filePath, content) => {
        writes.push({ content, filePath })
      },
      snapshotInvalidator: () => {
        invalidationCount += 1
      },
    })
    const window = unwrap(await session.execute({
      args: {
        maxLines: 1,
        path: 'src/agent.ts',
        reason: 'Need to update an import outside any symbol.',
        startLine: 1,
      },
      operation: 'readFileWindow',
    }))
    const replacementText = "import { helper, normalize } from './helper'"
    const result = unwrap(await session.execute({
      args: {
        endLine: 1,
        expectedWindowHash: window.windowHash,
        path: 'src/agent.ts',
        reason: 'Need to update an import outside any symbol.',
        replacementText,
        startLine: 1,
      },
      operation: 'replaceFileWindow',
    }))

    expect(result).toMatchObject({
      file: {
        path: 'src/agent.ts',
      },
      previousWindowHash: window.windowHash,
      reason: 'Need to update an import outside any symbol.',
      replacedRange: {
        start: { line: 1 },
        end: { line: 1 },
      },
      replacementLineCount: 1,
    })
    expect(writes).toEqual([
      {
        filePath: 'src/agent.ts',
        content: [
          replacementText,
          '',
          'export function runAgent(input: string) {',
          '  const normalized = input.trim()',
          '  return helper(normalized)',
          '}',
          '',
          'export const agentName = "semanticode"',
        ].join('\n'),
      },
    ])
    expect(invalidationCount).toBe(1)
  })

  it('rejects stale file window edits when the window hash changed', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    const session = createTestSession({
      fileWriter: async (filePath, content) => {
        writes.push({ content, filePath })
      },
    })
    const result = await session.execute({
      args: {
        endLine: 1,
        expectedWindowHash: 'stale-hash',
        path: 'src/agent.ts',
        reason: 'Need to update an import outside any symbol.',
        replacementText: "import { helper, normalize } from './helper'",
        startLine: 1,
      },
      operation: 'replaceFileWindow',
    })

    expect(result).toMatchObject({
      ok: false,
      result: {
        expectedWindowHash: 'stale-hash',
      },
      warning: expect.stringContaining('changed since it was read'),
    })
    expect(writes).toEqual([])
  })

  it('replaces a symbol range when the expected slice hash matches', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    let invalidationCount = 0
    const session = createTestSession({
      fileWriter: async (filePath, content) => {
        writes.push({ content, filePath })
      },
      snapshotInvalidator: () => {
        invalidationCount += 1
      },
    })
    const slice = unwrap(await session.execute({
      args: {
        symbolId: 'symbol:agent',
      },
      operation: 'readSymbolSlice',
    }))
    const replacementText = [
      'export function runAgent(input: string) {',
      '  return helper(input.trim().toUpperCase())',
      '}',
    ].join('\n')
    const result = unwrap(await session.execute({
      args: {
        expectedSliceHash: slice.sliceHash,
        replacementText,
        symbolId: 'symbol:agent',
      },
      operation: 'replaceSymbolRange',
    }))

    expect(result).toMatchObject({
      file: {
        path: 'src/agent.ts',
      },
      previousSliceHash: slice.sliceHash,
      replacementLineCount: 3,
      symbolNodeIds: ['symbol:agent'],
    })
    expect(writes).toEqual([
      {
        filePath: 'src/agent.ts',
        content: [
          "import { helper } from './helper'",
          '',
          replacementText,
          '',
          'export const agentName = "semanticode"',
        ].join('\n'),
      },
    ])
    expect(invalidationCount).toBe(1)
  })

  it('rejects stale symbol edits when the slice hash changed', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    const session = createTestSession({
      fileWriter: async (filePath, content) => {
        writes.push({ content, filePath })
      },
    })
    const result = await session.execute({
      args: {
        expectedSliceHash: 'stale-hash',
        replacementText: 'export function runAgent() {}',
        symbolId: 'symbol:agent',
      },
      operation: 'replaceSymbolRange',
    })

    expect(result).toMatchObject({
      ok: false,
      result: {
        expectedSliceHash: 'stale-hash',
        symbolNodeIds: ['symbol:agent'],
      },
      warning: expect.stringContaining('changed since it was read'),
    })
    expect(writes).toEqual([])
  })

  it('requires a configured file writer for symbol edits', async () => {
    const session = createTestSession()
    const result = await session.execute({
      args: {
        expectedSliceHash: 'hash',
        replacementText: 'export function runAgent() {}',
        symbolId: 'symbol:agent',
      },
      operation: 'replaceSymbolRange',
    })

    expect(result).toMatchObject({
      ok: false,
      warning: 'replaceSymbolRange is unavailable because no file writer is configured.',
    })
  })
})

function createTestSession(input: {
  fileWriter?: (filePath: string, content: string) => Promise<void>
  snapshotInvalidator?: () => void
} = {}) {
  const snapshot = createSnapshot()

  return createSymbolQuerySession({
    fileWriter: input.fileWriter,
    rootDir: '/workspace',
    snapshotInvalidator: input.snapshotInvalidator,
    snapshotProvider: async () => snapshot,
  })
}

function unwrap(result: SymbolQuerySessionResult) {
  expect(result.ok).toBe(true)
  return result.result as Record<string, unknown>
}

function createSnapshot(): ProjectSnapshot {
  const agentContent = [
    "import { helper } from './helper'",
    '',
    'export function runAgent(input: string) {',
    '  const normalized = input.trim()',
    '  return helper(normalized)',
    '}',
    '',
    'export const agentName = "semanticode"',
  ].join('\n')
  const helperContent = [
    'export function helper(value: string) {',
    '  return value.toUpperCase()',
    '}',
  ].join('\n')
  const nodes: ProjectSnapshot['nodes'] = {
    'src/agent.ts': {
      kind: 'file',
      id: 'src/agent.ts',
      name: 'agent.ts',
      path: 'src/agent.ts',
      tags: [],
      facets: [],
      parentId: null,
      language: 'typescript',
      extension: '.ts',
      size: agentContent.length,
      content: agentContent,
    },
    'src/helper.ts': {
      kind: 'file',
      id: 'src/helper.ts',
      name: 'helper.ts',
      path: 'src/helper.ts',
      tags: [],
      facets: [],
      parentId: null,
      language: 'typescript',
      extension: '.ts',
      size: helperContent.length,
      content: helperContent,
    },
    'symbol:agent': createSymbol({
      fileId: 'src/agent.ts',
      id: 'symbol:agent',
      name: 'runAgent',
      range: {
        start: { line: 3, column: 1 },
        end: { line: 6, column: 1 },
      },
      symbolKind: 'function',
    }),
    'symbol:normalized': createSymbol({
      fileId: 'src/agent.ts',
      id: 'symbol:normalized',
      name: 'normalized',
      parentSymbolId: 'symbol:agent',
      range: {
        start: { line: 4, column: 8 },
        end: { line: 4, column: 39 },
      },
      symbolKind: 'variable',
    }),
    'symbol:agentName': createSymbol({
      fileId: 'src/agent.ts',
      id: 'symbol:agentName',
      name: 'agentName',
      range: {
        start: { line: 8, column: 1 },
        end: { line: 8, column: 37 },
      },
      symbolKind: 'constant',
    }),
    'symbol:helper': createSymbol({
      fileId: 'src/helper.ts',
      id: 'symbol:helper',
      name: 'helper',
      range: {
        start: { line: 1, column: 1 },
        end: { line: 3, column: 1 },
      },
      symbolKind: 'function',
    }),
  }

  return {
    schemaVersion: 2,
    rootDir: '/workspace',
    generatedAt: '2026-04-20T12:00:00.000Z',
    totalFiles: 2,
    rootIds: ['src/agent.ts', 'src/helper.ts'],
    entryFileIds: ['src/agent.ts'],
    nodes,
    edges: [
      {
        id: 'contains:agent',
        kind: 'contains',
        source: 'src/agent.ts',
        target: 'symbol:agent',
      },
      {
        id: 'contains:agentName',
        kind: 'contains',
        source: 'src/agent.ts',
        target: 'symbol:agentName',
      },
      {
        id: 'contains:normalized',
        kind: 'contains',
        source: 'symbol:agent',
        target: 'symbol:normalized',
      },
      {
        id: 'contains:helper',
        kind: 'contains',
        source: 'src/helper.ts',
        target: 'symbol:helper',
      },
      {
        id: 'imports:agent-helper',
        kind: 'imports',
        source: 'src/agent.ts',
        target: 'src/helper.ts',
      },
      {
        id: 'calls:agent-helper',
        kind: 'calls',
        source: 'symbol:agent',
        target: 'symbol:helper',
      },
    ],
    tags: [],
    facetDefinitions: [],
    detectedPlugins: [],
  }
}

function createSymbol(input: {
  fileId: string
  id: string
  name: string
  range: SymbolNode['range']
  parentSymbolId?: string | null
  symbolKind: SymbolNode['symbolKind']
}): SymbolNode {
  return {
    kind: 'symbol',
    id: input.id,
    name: input.name,
    path: `${input.fileId}#${input.name}@${input.range?.start.line}:${
      input.range?.start.column
    }`,
    tags: [],
    facets: [],
    fileId: input.fileId,
    parentSymbolId: input.parentSymbolId ?? null,
    language: 'typescript',
    symbolKind: input.symbolKind,
    range: input.range,
  }
}

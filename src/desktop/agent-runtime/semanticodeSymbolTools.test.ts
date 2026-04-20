import { describe, expect, it } from 'vitest'

import type { ProjectSnapshot, SymbolNode } from '../../schema/snapshot'
import {
  createSymbolQueryToolDefinitions,
  SEMANTICODE_SYMBOL_TOOL_NAMES,
} from './semanticodeSymbolTools'

describe('Semanticode symbol PI tools', () => {
  it('registers SDK custom tool definitions with prompt metadata', () => {
    const tools = createSymbolQueryToolDefinitions('/workspace', async () => createSnapshot())

    expect(tools.map((tool) => tool.name)).toEqual([...SEMANTICODE_SYMBOL_TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.promptSnippet).toEqual(expect.any(String))
      expect(tool.promptSnippet).not.toHaveLength(0)
      expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
    }
  })

  it('executes symbol queries through SDK custom tool definitions', async () => {
    const tools = createSymbolQueryToolDefinitions('/workspace', async () => createSnapshot())
    const findSymbols = tools.find((tool) => tool.name === 'findSymbols')

    expect(findSymbols).toBeDefined()

    const result = await findSymbols!.execute(
      'call-1',
      { nameContains: 'agent' } as never,
      undefined,
      undefined,
      {} as never,
    )
    const parsed = JSON.parse(
      result.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(parsed).toMatchObject({
      ok: true,
      result: {
        symbolNodeIds: ['symbol:agent'],
        symbols: [
          expect.objectContaining({
            id: 'symbol:agent',
            name: 'runAgent',
          }),
        ],
      },
    })
  })

  it('normalizes command-style string params into symbol filters', async () => {
    const tools = createSymbolQueryToolDefinitions('/workspace', async () => createSnapshot())
    const findSymbols = tools.find((tool) => tool.name === 'findSymbols')
    const outlineSymbols = tools.find((tool) => tool.name === 'getSymbolOutline')
    const readSymbolSlice = tools.find((tool) => tool.name === 'readSymbolSlice')

    expect(findSymbols).toBeDefined()
    expect(outlineSymbols).toBeDefined()
    expect(readSymbolSlice).toBeDefined()

    const result = await findSymbols!.execute(
      'call-1',
      'src/agent.ts' as never,
      undefined,
      undefined,
      {} as never,
    )
    const parsed = JSON.parse(
      result.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(parsed).toMatchObject({
      ok: true,
      result: {
        symbolNodeIds: ['symbol:agent'],
        symbols: [
          expect.objectContaining({
            filePath: 'src/agent.ts',
            id: 'symbol:agent',
          }),
        ],
        total: 1,
      },
    })

    const mixedResult = await findSymbols!.execute(
      'call-2',
      'src/agent.ts sortBy=loc limit=1' as never,
      undefined,
      undefined,
      {} as never,
    )
    const mixedParsed = JSON.parse(
      mixedResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(mixedParsed).toMatchObject({
      ok: true,
      result: {
        limit: 1,
        sortBy: 'loc',
        symbolNodeIds: ['symbol:agent'],
        total: 1,
      },
    })

    const outlineResult = await outlineSymbols!.execute(
      'call-3',
      'src/agent.ts previewLines=1' as never,
      undefined,
      undefined,
      {} as never,
    )
    const outlineParsed = JSON.parse(
      outlineResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(outlineParsed).toMatchObject({
      ok: true,
      result: {
        outlines: [
          expect.objectContaining({
            sourcePreview: expect.objectContaining({
              lineCount: 1,
            }),
            symbol: expect.objectContaining({
              id: 'symbol:agent',
            }),
          }),
        ],
      },
    })

    const sliceResult = await readSymbolSlice!.execute(
      'call-4',
      'src/agent.ts maxLines=1' as never,
      undefined,
      undefined,
      {} as never,
    )
    const sliceParsed = JSON.parse(
      sliceResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(sliceParsed).toMatchObject({
      ok: true,
      result: {
        maxLines: 1,
        symbol: expect.objectContaining({
          id: 'symbol:agent',
        }),
        symbolNodeIds: ['symbol:agent'],
      },
    })
  })

  it('executes symbol range replacements through SDK custom tool definitions', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    let invalidationCount = 0
    const tools = createSymbolQueryToolDefinitions(
      '/workspace',
      async () => createSnapshot(),
      async (filePath, content) => {
        writes.push({ content, filePath })
      },
      () => {
        invalidationCount += 1
      },
    )
    const readSymbolSlice = tools.find((tool) => tool.name === 'readSymbolSlice')
    const replaceSymbolRange = tools.find((tool) => tool.name === 'replaceSymbolRange')

    expect(readSymbolSlice).toBeDefined()
    expect(replaceSymbolRange).toBeDefined()

    const sliceResult = await readSymbolSlice!.execute(
      'call-1',
      { symbolId: 'symbol:agent' } as never,
      undefined,
      undefined,
      {} as never,
    )
    const sliceParsed = JSON.parse(
      sliceResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )
    const editResult = await replaceSymbolRange!.execute(
      'call-2',
      {
        expectedSliceHash: sliceParsed.result.sliceHash,
        replacementText: [
          'export function runAgent() {',
          '  return false',
          '}',
        ].join('\n'),
        symbolId: 'symbol:agent',
      } as never,
      undefined,
      undefined,
      {} as never,
    )
    const editParsed = JSON.parse(
      editResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(editParsed).toMatchObject({
      ok: true,
      result: {
        file: {
          path: 'src/agent.ts',
        },
        symbolNodeIds: ['symbol:agent'],
      },
    })
    expect(writes).toEqual([
      {
        filePath: 'src/agent.ts',
        content: [
          'export function runAgent() {',
          '  return false',
          '}',
        ].join('\n'),
      },
    ])
    expect(invalidationCount).toBe(1)
  })

  it('executes bounded file window replacements through SDK custom tool definitions', async () => {
    const writes: Array<{ content: string; filePath: string }> = []
    let invalidationCount = 0
    const tools = createSymbolQueryToolDefinitions(
      '/workspace',
      async () => createSnapshot(),
      async (filePath, content) => {
        writes.push({ content, filePath })
      },
      () => {
        invalidationCount += 1
      },
    )
    const readFileWindow = tools.find((tool) => tool.name === 'readFileWindow')
    const replaceFileWindow = tools.find((tool) => tool.name === 'replaceFileWindow')

    expect(readFileWindow).toBeDefined()
    expect(replaceFileWindow).toBeDefined()

    const windowResult = await readFileWindow!.execute(
      'call-1',
      {
        endLine: 1,
        path: 'src/agent.ts',
        reason: 'Need to update a file header.',
        startLine: 1,
      } as never,
      undefined,
      undefined,
      {} as never,
    )
    const windowParsed = JSON.parse(
      windowResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )
    const editResult = await replaceFileWindow!.execute(
      'call-2',
      {
        endLine: 1,
        expectedWindowHash: windowParsed.result.windowHash,
        path: 'src/agent.ts',
        reason: 'Need to update a file header.',
        replacementText: 'export function runAgent() {',
        startLine: 1,
      } as never,
      undefined,
      undefined,
      {} as never,
    )
    const editParsed = JSON.parse(
      editResult.content.find((entry) => entry.type === 'text')?.text ?? '{}',
    )

    expect(editParsed).toMatchObject({
      ok: true,
      result: {
        file: {
          path: 'src/agent.ts',
        },
        previousWindowHash: windowParsed.result.windowHash,
      },
    })
    expect(writes).toEqual([
      {
        filePath: 'src/agent.ts',
        content: [
          'export function runAgent() {',
          '  return true',
          '}',
        ].join('\n'),
      },
    ])
    expect(invalidationCount).toBe(1)
  })
})

function createSnapshot(): ProjectSnapshot {
  const agentContent = [
    'export function runAgent() {',
    '  return true',
    '}',
  ].join('\n')
  const otherContent = [
    'export function otherThing() {',
    '  return false',
    '}',
  ].join('\n')

  return {
    schemaVersion: 2,
    rootDir: '/workspace',
    generatedAt: '2026-04-20T12:00:00.000Z',
    totalFiles: 1,
    rootIds: ['src/agent.ts'],
    entryFileIds: ['src/agent.ts'],
    nodes: {
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
      'src/other.ts': {
        kind: 'file',
        id: 'src/other.ts',
        name: 'other.ts',
        path: 'src/other.ts',
        tags: [],
        facets: [],
        parentId: null,
        language: 'typescript',
        extension: '.ts',
        size: otherContent.length,
        content: otherContent,
      },
      'symbol:agent': createSymbol(),
      'symbol:other': createOtherSymbol(),
    },
    edges: [
      {
        id: 'contains:agent',
        kind: 'contains',
        source: 'src/agent.ts',
        target: 'symbol:agent',
      },
      {
        id: 'contains:other',
        kind: 'contains',
        source: 'src/other.ts',
        target: 'symbol:other',
      },
    ],
    tags: [],
    facetDefinitions: [],
    detectedPlugins: [],
  }
}

function createOtherSymbol(): SymbolNode {
  return {
    kind: 'symbol',
    id: 'symbol:other',
    name: 'otherThing',
    path: 'src/other.ts#otherThing@1:1',
    tags: [],
    facets: [],
    fileId: 'src/other.ts',
    parentSymbolId: null,
    language: 'typescript',
    symbolKind: 'function',
    range: {
      start: { line: 1, column: 1 },
      end: { line: 3, column: 1 },
    },
  }
}

function createSymbol(): SymbolNode {
  return {
    kind: 'symbol',
    id: 'symbol:agent',
    name: 'runAgent',
    path: 'src/agent.ts#runAgent@1:1',
    tags: [],
    facets: [],
    fileId: 'src/agent.ts',
    parentSymbolId: null,
    language: 'typescript',
    symbolKind: 'function',
    range: {
      start: { line: 1, column: 1 },
      end: { line: 3, column: 1 },
    },
  }
}

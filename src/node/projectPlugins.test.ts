import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { PROJECT_SNAPSHOT_SCHEMA_VERSION, type ProjectSnapshot } from '../schema/snapshot'
import { buildLayoutPlannerContext } from '../planner'
import { readProjectSnapshot } from './readProjectSnapshot'
import { createReactProjectPlugin } from './project-plugins/react'

describe('React project plugin', () => {
  it('detects React from scoped package.json files without leaking into backend paths', async () => {
    const plugin = createReactProjectPlugin()
    const snapshot = createSnapshot({
      nodes: {
        'web/package.json': createFileNode('web/package.json', 'package.json', '{"dependencies":{"react":"^19.0.0"}}'),
        'api/requirements.txt': createFileNode('api/requirements.txt', 'requirements.txt', 'fastapi'),
      },
    })

    const detections = await plugin.detect({
      snapshot,
      fileNodes: Object.values(snapshot.nodes).filter((node) => node.kind === 'file'),
      facts: [],
      options: { rootDir: snapshot.rootDir },
    })

    expect(detections).toEqual([
      expect.objectContaining({
        pluginId: 'react',
        scopeRoot: 'web',
      }),
    ])
  })

  it('falls back to JSX + React facts when package metadata is missing', async () => {
    const plugin = createReactProjectPlugin()
    const snapshot = createSnapshot({
      nodes: {
        'src/App.tsx': createFileNode('src/App.tsx', 'App.tsx', ''),
      },
    })

    const detections = await plugin.detect({
      snapshot,
      fileNodes: Object.values(snapshot.nodes).filter((node) => node.kind === 'file'),
      facts: [
        createFact('imports_package', 'src/App.tsx', 'src/App.tsx', { packageName: 'react' }),
        createFact('contains_jsx', 'src/App.tsx', 'src/App.tsx'),
      ],
      options: { rootDir: snapshot.rootDir },
    })

    expect(detections).toEqual([
      expect.objectContaining({
        pluginId: 'react',
        scopeRoot: 'src',
      }),
    ])
  })

  it('classifies components, hooks, and client components without misclassifying utilities', async () => {
    const plugin = createReactProjectPlugin()
    const fileNode = createFileNode('web/src/App.tsx', 'App.tsx', '')
    const appSymbol = createSymbolNode('web/src/App.tsx', 'symbol:app', 'App')
    const hookSymbol = createSymbolNode('web/src/App.tsx', 'symbol:hook', 'useCounter')
    const utilitySymbol = createSymbolNode('web/src/App.tsx', 'symbol:utility', 'helper')
    const snapshot = createSnapshot({
      nodes: {
        [fileNode.id]: fileNode,
        [appSymbol.id]: appSymbol,
        [hookSymbol.id]: hookSymbol,
        [utilitySymbol.id]: utilitySymbol,
      },
    })

    const result = await plugin.analyze({
      snapshot,
      fileNodes: [fileNode],
      scopedFileNodes: [fileNode],
      facts: [],
      scopedFacts: [
        createFact('file_directive', fileNode.path, fileNode.id, { value: 'use client' }),
        createFact('symbol_exported', fileNode.path, appSymbol.id),
        createFact('symbol_returns_jsx', fileNode.path, appSymbol.id),
        createFact('symbol_calls_hook', fileNode.path, hookSymbol.id, { hookName: 'useState' }),
      ],
      options: { rootDir: snapshot.rootDir },
      detection: {
        pluginId: 'react',
        displayName: 'React',
        scopeRoot: 'web',
      },
    })

    expect(result.facetDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'react:component' }),
        expect.objectContaining({ id: 'react:hook' }),
        expect.objectContaining({ id: 'react:client-component' }),
      ]),
    )
    expect(result.nodes?.[appSymbol.id]).toEqual(
      expect.objectContaining({
        facets: expect.arrayContaining(['react:component', 'react:client-component']),
      }),
    )
    expect(result.nodes?.[hookSymbol.id]).toEqual(
      expect.objectContaining({
        facets: expect.arrayContaining(['react:hook']),
      }),
    )
    expect(result.nodes?.[utilitySymbol.id]).toEqual(
      expect.objectContaining({
        facets: [],
      }),
    )
    expect(result.nodes?.[fileNode.id]).toEqual(
      expect.objectContaining({
        facets: expect.arrayContaining(['react:component', 'react:hook', 'react:client-component']),
      }),
    )
  })

  it('applies React facets only inside frontend scopes in a mixed workspace and exposes them to the planner', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-project-plugins-'))

    try {
      await mkdir(join(rootDir, 'web', 'src'), { recursive: true })
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'web', 'package.json'),
        JSON.stringify({
          name: 'web',
          dependencies: {
            react: '^19.0.0',
          },
        }),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'web', 'src', 'App.tsx'),
        [
          "'use client'",
          "import React, { useState } from 'react'",
          '',
          'export function App() {',
          '  const [count] = useState(0)',
          '  return <button>{count}</button>',
          '}',
          '',
          'export function useCounter() {',
          '  const [count] = useState(0)',
          '  return count',
          '}',
          '',
          'const helper = () => 1',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'api', 'server.py'),
        [
          'def handle_request():',
          '    return {"ok": True}',
          '',
        ].join('\n'),
        'utf8',
      )

      const snapshot = await readProjectSnapshot({
        rootDir,
        analyzeCalls: false,
        analyzeImports: true,
        analyzeSymbols: true,
      })
      const plannerContext = buildLayoutPlannerContext(snapshot, {
        prompt: 'Group React concepts',
        constraints: {
          nodeScope: 'symbols',
        },
      })

      const appFile = snapshot.nodes['web/src/App.tsx']
      const apiFile = snapshot.nodes['api/server.py']
      const appSymbol = findSymbolByName(snapshot, 'App')
      const hookSymbol = findSymbolByName(snapshot, 'useCounter')

      expect(snapshot.detectedPlugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'react',
            scopeRoot: 'web',
          }),
        ]),
      )
      expect(snapshot.facetDefinitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'react:component' }),
        ]),
      )
      expect(appFile).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['react:component', 'react:hook', 'react:client-component']),
        }),
      )
      expect(apiFile).toEqual(
        expect.objectContaining({
          facets: [],
        }),
      )
      expect(appSymbol).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['react:component', 'react:client-component']),
        }),
      )
      expect(hookSymbol).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['react:hook']),
        }),
      )
      expect(plannerContext.availableFacets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'react:component' }),
        ]),
      )
      expect(plannerContext.nodes.find((node) => node.id === appSymbol?.id)).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['react:component']),
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function createSnapshot(input: {
  nodes: ProjectSnapshot['nodes']
}): ProjectSnapshot {
  const fileNodes = Object.values(input.nodes).filter((node) => node.kind === 'file')

  return {
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    rootDir: '/tmp/repo',
    generatedAt: '2026-04-18T12:00:00.000Z',
    totalFiles: fileNodes.length,
    rootIds: fileNodes.map((node) => node.id),
    entryFileIds: [],
    nodes: input.nodes,
    edges: [],
    tags: [],
    facetDefinitions: [],
    detectedPlugins: [],
  }
}

function createFileNode(path: string, name: string, content: string) {
  return {
    id: path,
    kind: 'file' as const,
    name,
    path,
    tags: [],
    facets: [],
    parentId: null,
    extension: path.split('.').pop() ?? '',
    size: content.length,
    content,
    language: path.endsWith('.tsx') ? 'typescript' : undefined,
  }
}

function createSymbolNode(fileId: string, id: string, name: string) {
  return {
    id,
    kind: 'symbol' as const,
    name,
    path: `${fileId}#${name}`,
    tags: [],
    facets: [],
    fileId,
    parentSymbolId: null,
    language: 'typescript',
    symbolKind: 'function' as const,
  }
}

function createFact(
  kind: string,
  path: string,
  subjectId: string,
  data?: Record<string, boolean | number | string | null>,
) {
  return {
    id: `${kind}:${subjectId}:${JSON.stringify(data ?? {})}`,
    namespace: 'ts-js',
    kind,
    subjectId,
    path,
    data,
  }
}

function findSymbolByName(snapshot: ProjectSnapshot, name: string) {
  return Object.values(snapshot.nodes).find(
    (node) => node.kind === 'symbol' && node.name === name,
  )
}

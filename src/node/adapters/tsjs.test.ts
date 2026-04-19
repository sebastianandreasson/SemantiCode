import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { ProjectSnapshot, SymbolNode } from '../../schema/snapshot'
import { readProjectSnapshot } from '../readProjectSnapshot'

describe('TypeScript / JavaScript adapter call edges', () => {
  it('adds AST call edges for local, imported, namespace, and JSX component calls', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-tsjs-calls-'))

    try {
      await mkdir(join(rootDir, 'src'), { recursive: true })
      await writeFile(
        join(rootDir, 'src', 'App.tsx'),
        [
          "import { Button as PrimaryButton } from './Button'",
          "import { formatName } from './format'",
          "import * as helpers from './helpers'",
          '',
          'export function App() {',
          "  const label = formatName('Semanticode')",
          '  const value = localHelper()',
          '  helpers.track(value)',
          '  return <PrimaryButton label={label} />',
          '}',
          '',
          'function localHelper() {',
          '  return 1',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'src', 'Button.tsx'),
        [
          'export function Button(props: { label: string }) {',
          '  return <button>{props.label}</button>',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'src', 'format.ts'),
        [
          'export function formatName(name: string) {',
          '  return name.trim()',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'src', 'helpers.ts'),
        [
          'export function track(value: number) {',
          '  return value',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )

      const snapshot = await readProjectSnapshot({
        rootDir,
        analyzeCalls: true,
        analyzeImports: true,
        analyzeSymbols: true,
      })
      const app = findSymbol(snapshot, 'App')

      expect(hasAstCall(snapshot, app, findSymbol(snapshot, 'formatName'))).toBe(true)
      expect(hasAstCall(snapshot, app, findSymbol(snapshot, 'localHelper'))).toBe(true)
      expect(hasAstCall(snapshot, app, findSymbol(snapshot, 'track'))).toBe(true)
      expect(hasAstCall(snapshot, app, findSymbol(snapshot, 'Button'))).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('attributes nested function calls to the nested symbol and resolves this.method calls', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-tsjs-nested-calls-'))

    try {
      await mkdir(join(rootDir, 'src'), { recursive: true })
      await writeFile(
        join(rootDir, 'src', 'service.ts'),
        [
          'function parent() {',
          '  function inner() {',
          '    target()',
          '  }',
          '  inner()',
          '}',
          '',
          'function target() {',
          '  return true',
          '}',
          '',
          'export class Service {',
          '  run() {',
          '    return this.format()',
          '  }',
          '',
          '  format() {',
          "    return 'ok'",
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )

      const snapshot = await readProjectSnapshot({
        rootDir,
        analyzeCalls: true,
        analyzeImports: true,
        analyzeSymbols: true,
      })
      const parent = findSymbol(snapshot, 'parent')
      const inner = findSymbol(snapshot, 'inner')
      const target = findSymbol(snapshot, 'target')
      const run = findSymbol(snapshot, 'run')
      const format = findSymbol(snapshot, 'format')

      expect(hasAstCall(snapshot, parent, inner)).toBe(true)
      expect(hasAstCall(snapshot, inner, target)).toBe(true)
      expect(hasAstCall(snapshot, parent, target)).toBe(false)
      expect(hasAstCall(snapshot, run, format)).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function findSymbol(snapshot: ProjectSnapshot, name: string) {
  const symbol = Object.values(snapshot.nodes).find(
    (node): node is SymbolNode => node.kind === 'symbol' && node.name === name,
  )

  expect(symbol, `Expected symbol "${name}" to exist`).toBeTruthy()

  return symbol as SymbolNode
}

function hasAstCall(
  snapshot: ProjectSnapshot,
  source: SymbolNode,
  target: SymbolNode,
) {
  return snapshot.edges.some(
    (edge) =>
      edge.kind === 'calls' &&
      edge.source === source.id &&
      edge.target === target.id &&
      edge.metadata?.analyzer === 'ts-js-ast',
  )
}

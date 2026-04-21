import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { ApiEndpointNode, ProjectSnapshot, SymbolNode } from '../schema/snapshot'
import { readProjectSnapshot } from './readProjectSnapshot'

describe('API endpoint graph analysis', () => {
  it('links TS client requests to Python route handlers through endpoint nodes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-api-graph-'))

    try {
      await mkdir(join(rootDir, 'web', 'src'), { recursive: true })
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'web', 'src', 'client.ts'),
        [
          'export async function getUser(id: string) {',
          '  return fetch(`/api/users/${id}`)',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'api', 'main.py'),
        [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/api")',
          '',
          '@router.get("/users/{user_id}")',
          'def read_user(user_id: str):',
          '    return {"id": user_id}',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/api/users/{}')
      const clientSymbol = findSymbol(snapshot, 'getUser')
      const handlerSymbol = findSymbol(snapshot, 'read_user')

      expect(endpoint).toEqual(
        expect.objectContaining({
          confidence: 0.9,
          facets: expect.arrayContaining(['api:endpoint', 'api:matched']),
          source: 'merged',
        }),
      )
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'api_calls',
            source: clientSymbol.id,
            target: endpoint.id,
          }),
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: handlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('links TS client requests to Go route handlers through endpoint nodes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-go-api-graph-'))

    try {
      await mkdir(join(rootDir, 'web', 'src'), { recursive: true })
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'web', 'src', 'client.ts'),
        [
          'export async function getUser(id: string) {',
          '  return fetch(`/api/users/${id}`)',
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'api', 'main.go'),
        [
          'package main',
          '',
          'func RegisterRoutes(r Router) {',
          '  r.Get("/api/users/{id}", GetUser)',
          '}',
          '',
          'func GetUser(w ResponseWriter, r Request) {',
          '}',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/api/users/{}')
      const clientSymbol = findSymbol(snapshot, 'getUser')
      const handlerSymbol = findSymbol(snapshot, 'GetUser')

      expect(endpoint.facets).toEqual(expect.arrayContaining(['api:endpoint', 'api:matched']))
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'api_calls',
            source: clientSymbol.id,
            target: endpoint.id,
          }),
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: handlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates server-only endpoint nodes for Express routes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-express-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'server.ts'),
        [
          "import express from 'express'",
          '',
          'const app = express()',
          '',
          "app.get('/health', health)",
          '',
          'function health(req: unknown, res: unknown) {',
          '  return res',
          '}',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/health')
      const handlerSymbol = findSymbol(snapshot, 'health')

      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          framework: 'express',
          source: 'server',
        }),
      )
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: handlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates endpoint nodes for inline Express router factories', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-express-router-factory-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'routes.mts'),
        [
          "import express from 'express'",
          '',
          "export const router = express.Router().get('/factory-health', health)",
          '',
          'function health(req: unknown, res: unknown) {',
          '  return res',
          '}',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/factory-health')

      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          source: 'server',
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates endpoint nodes for Fastify route objects', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-fastify-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'server.ts'),
        [
          "import fastify from 'fastify'",
          '',
          'const app = fastify()',
          '',
          'app.route({',
          "  method: 'POST',",
          "  url: '/sessions',",
          '  handler: createSession,',
          '})',
          '',
          'function createSession() {',
          '  return {}',
          '}',
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
      const endpoint = findEndpoint(snapshot, 'POST', '/sessions')

      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          framework: 'fastify',
          source: 'server',
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('links Flutter Dart HTTP requests to Express route handlers through endpoint nodes', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-flutter-express-api-'))

    try {
      await mkdir(join(rootDir, 'app', 'lib'), { recursive: true })
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'app', 'lib', 'user_api.dart'),
        [
          "import 'package:http/http.dart' as http;",
          '',
          'Future<void> getUser(String id) async {',
          "  await http.get(Uri.parse('/api/users/$id'));",
          '}',
          '',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        join(rootDir, 'api', 'server.ts'),
        [
          "import express from 'express'",
          '',
          'const app = express()',
          '',
          "app.get('/api/users/:id', getUser)",
          '',
          'function getUser(req: unknown, res: unknown) {',
          '  return res',
          '}',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/api/users/{}')
      const dartClientSymbol = findSymbol(snapshot, 'getUser', 'dart')
      const expressHandlerSymbol = findSymbol(snapshot, 'getUser', 'typescript')

      expect(endpoint.facets).toEqual(expect.arrayContaining(['api:endpoint', 'api:matched']))
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'api_calls',
            source: dartClientSymbol.id,
            target: endpoint.id,
          }),
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: expressHandlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates Python decorator endpoint nodes even when symbol extraction is disabled', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-python-server-only-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'main.py'),
        [
          'from fastapi import FastAPI',
          '',
          'app = FastAPI()',
          '',
          '@app.get("/health")',
          'def health():',
          '    return {"ok": True}',
          '',
        ].join('\n'),
        'utf8',
      )

      const snapshot = await readProjectSnapshot({
        rootDir,
        analyzeCalls: false,
        analyzeImports: true,
        analyzeSymbols: false,
      })
      const endpoint = findEndpoint(snapshot, 'GET', '/health')

      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          framework: 'fastapi',
          source: 'server',
        }),
      )
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: 'api/main.py',
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('marks Flask route handler functions as API handlers', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-flask-upload-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'main.py'),
        [
          'from flask import Flask, jsonify, request',
          '',
          'app = Flask(__name__)',
          '',
          "@app.route('/simulate/upload', methods=['POST'])",
          'def upload_files():',
          '    print("Request files:", request.files)',
          '    if "texture" not in request.files or "depth" not in request.files:',
          '        return jsonify({"error": "Missing required files"}), 400',
          '    return jsonify({"id": "simulation"}), 200',
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
      const endpoint = findEndpoint(snapshot, 'POST', '/simulate/upload')
      const handlerSymbol = findSymbol(snapshot, 'upload_files', 'python')

      expect(handlerSymbol.facets).toEqual(expect.arrayContaining(['api:handler']))
      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          framework: 'flask',
          source: 'server',
        }),
      )
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: handlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('applies Python router prefixes to programmatic route registrations', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-python-router-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'main.py'),
        [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/api")',
          '',
          'def health():',
          '    return {"ok": True}',
          '',
          'router.add_api_route("/health", health, methods=["GET"])',
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
      const endpoint = findEndpoint(snapshot, 'GET', '/api/health')
      const handlerSymbol = findSymbol(snapshot, 'health', 'python')

      expect(endpoint.framework).toBe('fastapi')
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'handles',
            source: endpoint.id,
            target: handlerSymbol.id,
          }),
        ]),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('creates Python endpoint nodes for Flask-RESTful resources', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'semanticode-python-resource-api-'))

    try {
      await mkdir(join(rootDir, 'api'), { recursive: true })
      await writeFile(
        join(rootDir, 'api', 'main.py'),
        [
          'from flask_restful import Api, Resource',
          '',
          'api = Api()',
          '',
          'class Health(Resource):',
          '    def get(self):',
          '        return {"ok": True}',
          '',
          'api.add_resource(Health, "/health")',
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
      const endpoint = findEndpoint(snapshot, 'ANY', '/health')

      expect(endpoint).toEqual(
        expect.objectContaining({
          facets: expect.arrayContaining(['api:endpoint', 'api:server-only']),
          framework: 'flask-restful',
          source: 'server',
        }),
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

function findEndpoint(snapshot: ProjectSnapshot, method: string, route: string) {
  const endpoint = Object.values(snapshot.nodes).find(
    (node): node is ApiEndpointNode =>
      node.kind === 'api_endpoint' &&
      node.method === method &&
      node.normalizedRoutePattern === route,
  )

  expect(endpoint, `Expected endpoint "${method} ${route}" to exist`).toBeTruthy()

  return endpoint as ApiEndpointNode
}

function findSymbol(snapshot: ProjectSnapshot, name: string, language?: string) {
  const symbol = Object.values(snapshot.nodes).find(
    (node): node is SymbolNode =>
      node.kind === 'symbol' &&
      node.name === name &&
      (language ? node.language === language : true),
  )

  expect(symbol, `Expected symbol "${name}" to exist`).toBeTruthy()

  return symbol as SymbolNode
}

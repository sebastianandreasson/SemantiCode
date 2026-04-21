import type { AnalysisFact, ProjectFacetDefinition } from '../schema/projectPlugin'
import type {
  ApiEndpointNode,
  GraphEdge,
  NodeTag,
  ProjectNode,
  ProjectSnapshot,
} from '../schema/snapshot'

const API_ENDPOINT_FACETS: ProjectFacetDefinition[] = [
  {
    id: 'api:endpoint',
    label: 'API Endpoint',
    category: 'runtime',
    description: 'An HTTP, GraphQL, or RPC boundary exposed or consumed by the project.',
  },
  {
    id: 'api:handler',
    label: 'API Handler',
    category: 'runtime',
    description: 'A function or method that handles an HTTP route.',
  },
  {
    id: 'api:matched',
    label: 'Matched API',
    category: 'analysis',
    description: 'An endpoint with both client and server evidence.',
  },
  {
    id: 'api:client-only',
    label: 'Client Only API',
    category: 'analysis',
    description: 'A client request that does not currently match a server route.',
  },
  {
    id: 'api:server-only',
    label: 'Server Only API',
    category: 'analysis',
    description: 'A server route that does not currently match a client request.',
  },
]

const API_TAGS: NodeTag[] = [
  {
    id: 'api_endpoint',
    label: 'API Endpoint',
    category: 'analysis',
    description: 'A route or contract boundary between client and server code.',
  },
]

interface ApiFactRecord {
  analyzer: string
  confidence: number
  fact: AnalysisFact
  framework?: string
  method: string
  normalizedRoutePattern: string
  routePattern: string
  scopeId: string
  serviceName?: string
  subjectId: string
  type: 'client' | 'server'
}

export interface ApiEndpointGraphResult {
  edges: GraphEdge[]
  facetDefinitions: ProjectFacetDefinition[]
  nodes: Record<string, ProjectNode>
  tags: NodeTag[]
}

export function buildApiEndpointGraph(
  snapshot: ProjectSnapshot,
  facts: AnalysisFact[],
): ApiEndpointGraphResult {
  const records = facts.flatMap((fact) => toApiFactRecords(snapshot, fact))

  if (records.length === 0) {
    return {
      edges: [],
      facetDefinitions: [],
      nodes: {},
      tags: [],
    }
  }

  const recordsByEndpointKey = new Map<string, ApiFactRecord[]>()

  for (const record of records) {
    const endpointKey = getEndpointKey(record)
    const existing = recordsByEndpointKey.get(endpointKey) ?? []
    existing.push(record)
    recordsByEndpointKey.set(endpointKey, existing)
  }

  const nodes: Record<string, ProjectNode> = {}
  const edges: GraphEdge[] = []

  for (const [endpointKey, endpointRecords] of recordsByEndpointKey) {
    const serverRecords = endpointRecords.filter((record) => record.type === 'server')
    const clientRecords = endpointRecords.filter((record) => record.type === 'client')
    const representative = serverRecords[0] ?? clientRecords[0]

    if (!representative) {
      continue
    }

    const endpointNode = createEndpointNode(endpointKey, representative, {
      hasClient: clientRecords.length > 0,
      hasServer: serverRecords.length > 0,
      records: endpointRecords,
    })

    nodes[endpointNode.id] = endpointNode

    for (const clientRecord of clientRecords) {
      if (!snapshot.nodes[clientRecord.subjectId]) {
        continue
      }

      edges.push({
        id: `api_calls:${clientRecord.subjectId}->${endpointNode.id}:${clientRecord.fact.id}`,
        kind: 'api_calls',
        source: clientRecord.subjectId,
        target: endpointNode.id,
        label: `${clientRecord.method} ${clientRecord.normalizedRoutePattern}`,
        inferred: true,
        metadata: {
          analyzer: clientRecord.analyzer,
          confidence: clientRecord.confidence,
          method: clientRecord.method,
          route: clientRecord.normalizedRoutePattern,
        },
      })
    }

    for (const serverRecord of serverRecords) {
      const serverSubjectNode = nodes[serverRecord.subjectId] ?? snapshot.nodes[serverRecord.subjectId]

      if (!serverSubjectNode) {
        continue
      }

      const apiHandlerNode = markApiHandlerNode(serverSubjectNode)

      if (apiHandlerNode) {
        nodes[apiHandlerNode.id] = apiHandlerNode
      }

      edges.push({
        id: `handles:${endpointNode.id}->${serverRecord.subjectId}:${serverRecord.fact.id}`,
        kind: 'handles',
        source: endpointNode.id,
        target: serverRecord.subjectId,
        label: serverRecord.framework ?? serverRecord.method,
        inferred: true,
        metadata: {
          analyzer: serverRecord.analyzer,
          confidence: serverRecord.confidence,
          framework: serverRecord.framework ?? null,
          method: serverRecord.method,
          route: serverRecord.normalizedRoutePattern,
        },
      })
    }
  }

  return {
    edges: dedupeEdges(edges),
    facetDefinitions: API_ENDPOINT_FACETS,
    nodes,
    tags: API_TAGS,
  }
}

function toApiFactRecords(
  snapshot: ProjectSnapshot,
  fact: AnalysisFact,
): ApiFactRecord[] {
  if (fact.kind === 'http_client_request') {
    const method = readString(fact.data?.method, 'GET').toUpperCase()
    const routePattern = readString(
      fact.data?.pathTemplate,
      readString(fact.data?.normalizedPath, ''),
    )
    const normalizedRoutePattern = normalizeRoutePattern(
      readString(fact.data?.normalizedPath, routePattern),
    )

    if (!normalizedRoutePattern) {
      return []
    }

    return [
      {
        analyzer: fact.namespace,
        confidence: readNumber(fact.data?.confidence, 0.72),
        fact,
        method,
        normalizedRoutePattern,
        routePattern: routePattern || normalizedRoutePattern,
        scopeId: inferScopeId(snapshot, fact.path, 'client'),
        serviceName: inferScopeId(snapshot, fact.path, 'client'),
        subjectId: fact.subjectId,
        type: 'client',
      },
    ]
  }

  if (fact.kind === 'http_server_endpoint') {
    const method = readString(fact.data?.method, 'ANY').toUpperCase()
    const routePattern = readString(
      fact.data?.routePattern,
      readString(fact.data?.normalizedRoutePattern, ''),
    )
    const normalizedRoutePattern = normalizeRoutePattern(
      readString(fact.data?.normalizedRoutePattern, routePattern),
    )

    if (!normalizedRoutePattern) {
      return []
    }

    return [
      {
        analyzer: fact.namespace,
        confidence: readNumber(fact.data?.confidence, 0.88),
        fact,
        framework: readOptionalString(fact.data?.framework),
        method,
        normalizedRoutePattern,
        routePattern: routePattern || normalizedRoutePattern,
        scopeId: inferScopeId(snapshot, fact.path, 'server'),
        serviceName: inferScopeId(snapshot, fact.path, 'server'),
        subjectId: fact.subjectId,
        type: 'server',
      },
    ]
  }

  return []
}

function createEndpointNode(
  endpointKey: string,
  representative: ApiFactRecord,
  input: {
    hasClient: boolean
    hasServer: boolean
    records: ApiFactRecord[]
  },
): ApiEndpointNode {
  const source =
    input.hasClient && input.hasServer
      ? 'merged'
      : input.hasServer
        ? 'server'
        : 'client'
  const facets = ['api:endpoint']

  if (input.hasClient && input.hasServer) {
    facets.push('api:matched')
  } else if (input.hasClient) {
    facets.push('api:client-only')
  } else {
    facets.push('api:server-only')
  }

  const confidence = input.hasClient && input.hasServer
    ? Math.max(0.9, ...input.records.map((record) => record.confidence))
    : Math.max(...input.records.map((record) => record.confidence))

  return {
    id: `api:endpoint:${endpointKey}`,
    kind: 'api_endpoint',
    name: `${representative.method} ${representative.normalizedRoutePattern}`,
    path: `api://${representative.scopeId}${representative.normalizedRoutePattern}`,
    tags: ['api_endpoint'],
    facets,
    parentId: null,
    protocol: 'http',
    method: representative.method,
    routePattern: representative.routePattern,
    normalizedRoutePattern: representative.normalizedRoutePattern,
    scopeId: representative.scopeId,
    serviceName: representative.serviceName,
    framework: representative.framework,
    source,
    confidence: roundConfidence(confidence),
  }
}

function markApiHandlerNode(node: ProjectNode) {
  if (node.kind !== 'symbol') {
    return null
  }

  return {
    ...node,
    facets: [...new Set([...node.facets, 'api:handler'])],
  }
}

function getEndpointKey(record: ApiFactRecord) {
  return `${record.method}:${record.normalizedRoutePattern}`
}

export function normalizeRoutePattern(routePattern: string) {
  const rawRoute = routePattern.trim()

  if (!rawRoute) {
    return ''
  }

  const pathname = extractPathname(rawRoute)
  const normalized = pathname
    .replace(/\$\{[^}]+\}/g, '{}')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
    .replace(/<([A-Za-z_][A-Za-z0-9_]*)>/g, '{$1}')
    .replace(/\{[^}/]+\}/g, '{}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')

  return normalized.startsWith('/') ? normalized || '/' : `/${normalized}`
}

function extractPathname(routePattern: string) {
  if (/^https?:\/\//.test(routePattern)) {
    try {
      return new URL(routePattern).pathname
    } catch {
      return routePattern
    }
  }

  return routePattern
}

function inferScopeId(snapshot: ProjectSnapshot, path: string, fallback: string) {
  const firstSegment = path.split('/')[0]

  if (firstSegment && firstSegment !== path) {
    return firstSegment
  }

  const node = snapshot.nodes[path]

  if (node?.kind === 'file' && node.parentId) {
    return node.parentId.split('/')[0] ?? fallback
  }

  return fallback
}

function readString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function roundConfidence(confidence: number) {
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map<string, GraphEdge>()

  for (const edge of edges) {
    uniqueEdges.set(edge.id, edge)
  }

  return [...uniqueEdges.values()]
}

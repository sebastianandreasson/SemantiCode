import { extname } from 'node:path'

import type {
  LanguageAdapter,
  LanguageAdapterInput,
  LanguageAdapterResult,
} from '../../schema/analysis'
import type { AnalysisFact } from '../../schema/projectPlugin'
import type {
  FileNode,
  GraphEdge,
  ProjectSnapshot,
  SourceRange,
  SymbolKind,
  SymbolNode,
} from '../../schema/snapshot'

import { normalizeRoutePattern } from '../apiEndpointResolver'
import { createEmptySymbolIndex, registerSymbolNodes } from '../symbolIndex'

const PYTHON_SOURCE_EXTENSION = '.py'
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

interface MutablePythonContext {
  edges: GraphEdge[]
  nodes: ProjectSnapshot['nodes']
}

interface PythonSymbolDeclaration {
  indent: number
  kind: SymbolKind
  lineIndex: number
  name: string
  parentSymbolId: string | null
  symbolNode: SymbolNode
}

interface PendingDecorator {
  expression: string
  line: number
}

interface RouteDecorator {
  framework: string
  methods: string[]
  routePattern: string
}

interface PythonRouteRegistration extends RouteDecorator {
  handlerName?: string
  line: number
}

export function createPythonLanguageAdapter(): LanguageAdapter {
  return {
    id: 'python',
    displayName: 'Python',
    supports: {
      symbols: true,
      imports: false,
      calls: false,
    },
    matches(fileNode) {
      return extname(fileNode.path).toLowerCase() === PYTHON_SOURCE_EXTENSION
    },
    async analyze({
      fileNodes,
      options,
    }: LanguageAdapterInput): Promise<LanguageAdapterResult> {
      const context: MutablePythonContext = {
        edges: [],
        nodes: {},
      }
      const symbolIndex = createEmptySymbolIndex()
      const facts: AnalysisFact[] = []

      for (const fileNode of fileNodes) {
        context.nodes[fileNode.id] = {
          ...fileNode,
          language: 'python',
        }

        if (!fileNode.content) {
          continue
        }

        const fileSymbols = options.analyzeSymbols === false
          ? []
          : extractPythonSymbols(fileNode, context)

        if (fileSymbols.length > 0) {
          registerSymbolNodes(fileSymbols, symbolIndex)
        }

        facts.push(...extractPythonRouteFacts(fileNode, fileSymbols))
      }

      return {
        nodes: context.nodes,
        edges: dedupeEdges(context.edges),
        facts: dedupeFacts(facts),
      }
    },
  }
}

function extractPythonSymbols(
  fileNode: FileNode,
  context: MutablePythonContext,
) {
  const lines = fileNode.content?.split(/\r?\n/) ?? []
  const declarations: PythonSymbolDeclaration[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const declaration = parseDeclaration(line)

    if (!declaration) {
      continue
    }

    const parent = findParentDeclaration(declarations, declaration.indent)
    const range = getDeclarationRange(lines, lineIndex, declaration.indent)
    const symbolNode = createSymbolNode(
      fileNode,
      declaration.name,
      declaration.kind,
      range,
      parent?.symbolNode.id ?? null,
    )

    declarations.push({
      ...declaration,
      lineIndex,
      parentSymbolId: parent?.symbolNode.id ?? null,
      symbolNode,
    })
    context.nodes[symbolNode.id] = symbolNode
    context.edges.push({
      id: `contains:${symbolNode.parentSymbolId ?? fileNode.id}->${symbolNode.id}`,
      kind: 'contains',
      source: symbolNode.parentSymbolId ?? fileNode.id,
      target: symbolNode.id,
    })
  }

  return declarations.map((declaration) => declaration.symbolNode)
}

function extractPythonRouteFacts(fileNode: FileNode, fileSymbols: SymbolNode[]) {
  const lines = fileNode.content?.split(/\r?\n/) ?? []
  const symbolsByStartLine = new Map(
    fileSymbols
      .filter((symbol) => symbol.range)
      .map((symbol) => [symbol.range?.start.line ?? 0, symbol]),
  )
  const symbolsByName = new Map(fileSymbols.map((symbol) => [symbol.name, symbol]))
  const objectPrefixes = collectRouteObjectPrefixes(lines)
  const facts: AnalysisFact[] = []
  let pendingDecorators: PendingDecorator[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const trimmed = line.trim()

    if (trimmed.startsWith('@')) {
      pendingDecorators.push({
        expression: trimmed.slice(1),
        line: lineIndex + 1,
      })
      continue
    }

    const declaration = parseDeclaration(line)

    if (!declaration) {
      if (trimmed && !trimmed.startsWith('#')) {
        pendingDecorators = []
      }
      continue
    }

    const symbolNode = symbolsByStartLine.get(lineIndex + 1)
    const subjectId = symbolNode?.id ?? fileNode.id

    for (const decorator of pendingDecorators) {
      const routeDecorator = parseRouteDecorator(decorator.expression, objectPrefixes)

      if (!routeDecorator) {
        continue
      }

      facts.push(
        ...createRouteFacts({
          fileNode,
          framework: routeDecorator.framework,
          line: decorator.line,
          methods: routeDecorator.methods,
          routePattern: routeDecorator.routePattern,
          subjectId,
          confidence: symbolNode ? 0.9 : 0.68,
        }),
      )
    }

    pendingDecorators = []
  }

  for (const registration of collectPythonRouteRegistrations(lines, objectPrefixes)) {
    const handlerSymbol = registration.handlerName
      ? symbolsByName.get(registration.handlerName)
      : null

    facts.push(
      ...createRouteFacts({
        fileNode,
        framework: registration.framework,
        line: registration.line,
        methods: registration.methods,
        routePattern: registration.routePattern,
        subjectId: handlerSymbol?.id ?? fileNode.id,
        confidence: handlerSymbol ? 0.84 : 0.68,
      }),
    )
  }

  return facts
}

function collectRouteObjectPrefixes(lines: string[]) {
  const prefixes = new Map<string, string>()

  for (const line of lines) {
    const apirouterMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:fastapi\.)?APIRouter\((.*)\)\s*$/,
    )

    if (apirouterMatch) {
      const [, objectName, args = ''] = apirouterMatch
      const prefix = extractKeywordString(args, 'prefix')

      if (objectName && prefix) {
        prefixes.set(objectName, prefix)
      }
      continue
    }

    const blueprintMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Blueprint\((.*)\)\s*$/,
    )

    if (blueprintMatch) {
      const [, objectName, args = ''] = blueprintMatch
      const prefix = extractKeywordString(args, 'url_prefix')

      if (objectName && prefix) {
        prefixes.set(objectName, prefix)
      }
      continue
    }

    const includeRouterMatch = line.match(
      /^\s*[A-Za-z_][A-Za-z0-9_]*\.include_router\(\s*([A-Za-z_][A-Za-z0-9_]*)(.*)\)\s*$/,
    )

    if (includeRouterMatch) {
      const [, objectName, args = ''] = includeRouterMatch
      const prefix = extractKeywordString(args, 'prefix')

      if (objectName && prefix) {
        prefixes.set(objectName, joinRoutePaths(prefix, prefixes.get(objectName) ?? ''))
      }
    }
  }

  return prefixes
}

function parseRouteDecorator(
  expression: string,
  objectPrefixes: Map<string, string>,
): RouteDecorator | null {
  const methodDecoratorMatch = expression.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|patch|delete|head|options|api_route)\((.*)\)\s*$/,
  )

  if (methodDecoratorMatch) {
    const [, objectName = '', methodName = '', args = ''] = methodDecoratorMatch
    const routePath = extractFirstString(args)

    if (!routePath) {
      return null
    }

    return {
      framework: objectName === 'app' ? 'fastapi' : 'fastapi-router',
      methods:
        methodName === 'api_route'
          ? extractMethods(args, ['GET'])
          : [methodName.toUpperCase()],
      routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
    }
  }

  const routeDecoratorMatch = expression.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\.route\((.*)\)\s*$/,
  )

  if (routeDecoratorMatch) {
    const [, objectName = '', args = ''] = routeDecoratorMatch
    const routePath = extractFirstString(args)

    if (!routePath) {
      return null
    }

    return {
      framework: objectName === 'app' ? 'flask' : 'flask-blueprint',
      methods: extractMethods(args, ['GET']),
      routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
    }
  }

  const bareRouteDecoratorMatch = expression.match(
    /^(get|post|put|patch|delete|head|options|route)\((.*)\)\s*$/,
  )

  if (!bareRouteDecoratorMatch) {
    return null
  }

  const [, methodName = '', args = ''] = bareRouteDecoratorMatch
  const routePath = extractFirstString(args)

  if (!routePath) {
    return null
  }

  return {
    framework: 'python-router',
    methods:
      methodName === 'route'
        ? extractMethods(args, extractMethodKeyword(args, ['GET']))
        : [methodName.toUpperCase()],
    routePattern: routePath,
  }
}

function collectPythonRouteRegistrations(
  lines: string[],
  objectPrefixes: Map<string, string>,
) {
  const registrations: PythonRouteRegistration[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const addApiRouteMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\.add_api_route\((.*)\)\s*$/,
    )

    if (addApiRouteMatch) {
      const objectName = addApiRouteMatch[1] ?? ''
      const args = addApiRouteMatch[2] ?? ''
      const routePath = extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'fastapi',
          handlerName: extractSecondIdentifierArgument(args) ?? undefined,
          line: lineIndex + 1,
          methods: extractMethods(args, ['GET']),
          routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
        })
      }
      continue
    }

    const addUrlRuleMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\.add_url_rule\((.*)\)\s*$/,
    )

    if (addUrlRuleMatch) {
      const objectName = addUrlRuleMatch[1] ?? ''
      const args = addUrlRuleMatch[2] ?? ''
      const routePath = extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'flask',
          handlerName: extractKeywordIdentifier(args, 'view_func') ??
            extractThirdIdentifierArgument(args) ??
            undefined,
          line: lineIndex + 1,
          methods: extractMethods(args, ['GET']),
          routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
        })
      }
      continue
    }

    const djangoPathMatch = line.match(/^\s*(?:path|re_path)\((.*)\)\s*,?\s*$/)

    if (djangoPathMatch) {
      const args = djangoPathMatch[1] ?? ''
      const routePath = extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'django',
          handlerName: extractSecondIdentifierArgument(args) ?? undefined,
          line: lineIndex + 1,
          methods: ['ANY'],
          routePattern: joinRoutePaths('', routePath),
        })
      }
      continue
    }

    const addResourceMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\.add_resource\((.*)\)\s*$/,
    )

    if (addResourceMatch) {
      const objectName = addResourceMatch[1] ?? ''
      const args = addResourceMatch[2] ?? ''
      const routePath = extractSecondString(args) ?? extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'flask-restful',
          line: lineIndex + 1,
          methods: extractMethods(args, ['ANY']),
          routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
        })
      }
      continue
    }

    const addRouteMatch = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\.add_route\((.*)\)\s*$/,
    )

    if (addRouteMatch) {
      const objectName = addRouteMatch[1] ?? ''
      const args = addRouteMatch[2] ?? ''
      const routePath = extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'python-router',
          handlerName: extractSecondIdentifierArgument(args) ?? undefined,
          line: lineIndex + 1,
          methods: extractMethods(args, ['ANY']),
          routePattern: joinRoutePaths(objectPrefixes.get(objectName) ?? '', routePath),
        })
      }
      continue
    }

    const starletteRouteMatch = line.match(/^\s*Route\((.*)\)\s*,?\s*$/)

    if (starletteRouteMatch) {
      const args = starletteRouteMatch[1] ?? ''
      const routePath = extractFirstString(args)

      if (routePath) {
        registrations.push({
          framework: 'starlette',
          handlerName: extractKeywordIdentifier(args, 'endpoint') ??
            extractSecondIdentifierArgument(args) ??
            undefined,
          line: lineIndex + 1,
          methods: extractMethods(args, ['GET']),
          routePattern: routePath,
        })
      }
    }
  }

  return registrations
}

function createRouteFacts(input: {
  confidence?: number
  fileNode: FileNode
  framework: string
  line: number
  methods: string[]
  routePattern: string
  subjectId: string
}) {
  return input.methods.map((method) =>
    createFact(input.fileNode.path, 'http_server_endpoint', input.subjectId, {
      confidence: input.confidence ?? 0.9,
      framework: input.framework,
      line: input.line,
      method,
      normalizedRoutePattern: normalizeRoutePattern(input.routePattern),
      routePattern: input.routePattern,
    }),
  )
}

function parseDeclaration(line: string):
  | { indent: number; kind: SymbolKind; name: string }
  | null {
  const match = line.match(/^(\s*)(?:(async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/)

  if (!match) {
    return null
  }

  const [, indentation = '', , declarationType, name] = match

  if (!declarationType || !name) {
    return null
  }

  return {
    indent: indentation.replace(/\t/g, '    ').length,
    kind: declarationType === 'class' ? 'class' : 'function',
    name,
  }
}

function findParentDeclaration(
  declarations: PythonSymbolDeclaration[],
  indent: number,
) {
  for (let index = declarations.length - 1; index >= 0; index -= 1) {
    const declaration = declarations[index]

    if (declaration && declaration.indent < indent) {
      return declaration
    }
  }

  return null
}

function getDeclarationRange(
  lines: string[],
  startLineIndex: number,
  indent: number,
): SourceRange {
  let endLineIndex = startLineIndex

  for (let index = startLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      endLineIndex = index
      continue
    }

    const nextIndent = line.match(/^\s*/)?.[0].replace(/\t/g, '    ').length ?? 0

    if (nextIndent <= indent) {
      break
    }

    endLineIndex = index
  }

  return {
    start: {
      line: startLineIndex + 1,
      column: indent,
    },
    end: {
      line: endLineIndex + 1,
      column: lines[endLineIndex]?.length ?? 0,
    },
  }
}

function createSymbolNode(
  fileNode: FileNode,
  name: string,
  kind: SymbolKind,
  range: SourceRange,
  parentSymbolId: string | null,
): SymbolNode {
  const rangeId = `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`

  return {
    id: `symbol:${fileNode.id}:${name}:${rangeId}`,
    kind: 'symbol',
    name,
    path: `${fileNode.path}#${name}@${range.start.line}:${range.start.column}`,
    tags: [],
    facets: [],
    fileId: fileNode.id,
    parentSymbolId,
    language: 'python',
    symbolKind: kind,
    nativeSymbolKind: kind,
    visibility: name.startsWith('_') ? 'private' : 'unknown',
    signature: name,
    range,
  }
}

function extractFirstString(value: string) {
  const match = value.match(/["']([^"']+)["']/)
  return match?.[1] ?? null
}

function extractSecondString(value: string) {
  const matches = Array.from(value.matchAll(/["']([^"']+)["']/g))
  return matches[1]?.[1] ?? null
}

function extractKeywordString(value: string, keyword: string) {
  const pattern = new RegExp(`${keyword}\\s*=\\s*["']([^"']+)["']`)
  const match = value.match(pattern)
  return match?.[1] ?? null
}

function extractMethodKeyword(value: string, fallback: string[] = []) {
  const methodMatch = value.match(/method\s*=\s*["']([A-Za-z]+)["']/)
  const method = methodMatch?.[1]?.toUpperCase()

  return method && HTTP_METHODS.has(method) ? [method] : fallback
}

function extractMethods(value: string, fallback: string[] = []) {
  const methodsMatch = value.match(/methods\s*=\s*\[([^\]]+)\]/)

  if (!methodsMatch) {
    return fallback
  }

  const methods = Array.from(methodsMatch[1].matchAll(/["']([A-Za-z]+)["']/g))
    .map((match) => match[1]?.toUpperCase())
    .filter((method): method is string => Boolean(method && HTTP_METHODS.has(method)))

  return methods.length > 0 ? methods : fallback
}

function extractSecondIdentifierArgument(value: string) {
  return extractIdentifierArgument(value, 1)
}

function extractThirdIdentifierArgument(value: string) {
  return extractIdentifierArgument(value, 2)
}

function extractIdentifierArgument(value: string, index: number) {
  const args = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate = args[index]

  if (!candidate) {
    return null
  }

  const match = candidate.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/)
  const identifier = match?.[1]

  if (!identifier) {
    return null
  }

  const segments = identifier.split('.')
  return segments[segments.length - 1] ?? identifier
}

function extractKeywordIdentifier(value: string, keyword: string) {
  const pattern = new RegExp(`${keyword}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)`)
  const match = value.match(pattern)
  return match?.[1] ?? null
}

function joinRoutePaths(prefix: string, routePath: string) {
  const normalizedPrefix = prefix.trim().replace(/\/+$/, '')
  const normalizedPath = routePath.trim().replace(/^\/+/, '')

  if (!normalizedPrefix && !normalizedPath) {
    return '/'
  }

  if (!normalizedPrefix) {
    return `/${normalizedPath}`
  }

  if (!normalizedPath) {
    return normalizedPrefix.startsWith('/') ? normalizedPrefix : `/${normalizedPrefix}`
  }

  return `${normalizedPrefix.startsWith('/') ? normalizedPrefix : `/${normalizedPrefix}`}/${normalizedPath}`
}

function createFact(
  path: string,
  kind: string,
  subjectId: string,
  data?: AnalysisFact['data'],
): AnalysisFact {
  return {
    id: `${kind}:${subjectId}:${JSON.stringify(data ?? {})}`,
    namespace: 'python',
    kind,
    subjectId,
    path,
    data,
  }
}

function dedupeEdges(edges: GraphEdge[]) {
  const uniqueEdges = new Map(edges.map((edge) => [edge.id, edge]))
  return [...uniqueEdges.values()]
}

function dedupeFacts(facts: AnalysisFact[]) {
  const uniqueFacts = new Map(facts.map((fact) => [fact.id, fact]))
  return [...uniqueFacts.values()]
}

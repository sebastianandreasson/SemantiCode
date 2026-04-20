import type {
  PreprocessedWorkspaceContext,
  SemanticPurposeSummaryRecord,
  WorkspaceProfile,
} from '../types'
import {
  areScopeContextsEquivalent,
  buildScopeContextLines,
  buildScopeMetadata,
  formatRange,
  getScopePaths,
  hasScopeContext,
  type AgentScopeContext,
} from './agentScopeContext'

const MAX_VISIBLE_PURPOSE_SUMMARIES = 8

export function buildWorkspaceContextInjection(
  workspaceProfile: WorkspaceProfile | null | undefined,
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  const sentinel = '__SEMANTICODE_USER_REQUEST__'
  const scopedPrompt = buildWorkspaceScopedPrompt(
    sentinel,
    workspaceProfile,
    preprocessedWorkspaceContext,
    workingSetContext,
    inspectorContext,
  )

  if (scopedPrompt === sentinel) {
    return undefined
  }

  const marker = `\n\nUser request:\n${sentinel}`
  const contextInjection = scopedPrompt.endsWith(marker)
    ? scopedPrompt.slice(0, -marker.length).trim()
    : scopedPrompt.replace(sentinel, '').trim()

  return contextInjection || undefined
}

export function buildInspectorScopedPrompt(
  prompt: string,
  inspectorContext: AgentScopeContext | undefined | null,
) {
  if (!hasScopeContext(inspectorContext)) {
    return prompt
  }

  const contextLines = [
    'Semanticode inspector context:',
    'Treat the current inspector selection as the primary target for this request.',
    'If the user is asking for an edit, inspect and modify this file or symbol first unless they clearly redirect you elsewhere.',
  ]

  if (inspectorContext.symbols.length > 1) {
    contextLines.push('Selected symbols (primary first):')

    for (const symbol of inspectorContext.symbols) {
      contextLines.push(`- ${symbol.path}`)
    }

    contextLines.push(
      'Treat this symbol set as the default edit scope for the request. Start with these symbols before searching elsewhere in the repository.',
    )
  } else if (inspectorContext.files.length > 1) {
    contextLines.push('Selected files (primary first):')

    for (const file of inspectorContext.files) {
      contextLines.push(`- ${file.path}`)
    }

    contextLines.push(
      'Treat this file set as the default edit scope for the request. Start with these files before searching elsewhere in the repository.',
    )
  } else if (inspectorContext.file) {
    contextLines.push(`Selected file: ${inspectorContext.file.path}`)
  }

  if (inspectorContext.symbol) {
    contextLines.push(`Selected symbol: ${inspectorContext.symbol.path}`)
    contextLines.push(`Selected symbol kind: ${inspectorContext.symbol.symbolKind}`)

    if (inspectorContext.symbol.range) {
      contextLines.push(
        `Selected symbol range: lines ${formatRange(inspectorContext.symbol.range)}`,
      )
    }
  } else if (inspectorContext.node) {
    contextLines.push(`Selected node: ${inspectorContext.node.path}`)
    contextLines.push(`Selected node kind: ${inspectorContext.node.kind}`)
  }

  return `${contextLines.join('\n')}\n\nUser request:\n${prompt}`
}

export function buildWorkspaceScopedPrompt(
  prompt: string,
  workspaceProfile: WorkspaceProfile | null | undefined,
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  const scopedPrompt = buildScopeAwarePrompt(prompt, workingSetContext, inspectorContext)
  const workspaceContextLines = workspaceProfile
    ? [
        'Workspace preprocessing context:',
        `- root: ${workspaceProfile.rootDir}`,
        `- summary: ${workspaceProfile.summary}`,
        workspaceProfile.languages.length > 0
          ? `- languages: ${workspaceProfile.languages.join(', ')}`
          : '',
        workspaceProfile.topDirectories.length > 0
          ? `- dominant directories: ${workspaceProfile.topDirectories.join(', ')}`
          : '',
        workspaceProfile.entryFiles.length > 0
          ? `- likely entry files: ${workspaceProfile.entryFiles.join(', ')}`
          : '',
        workspaceProfile.notableTags.length > 0
          ? `- notable tags: ${workspaceProfile.notableTags.join(', ')}`
          : '',
      ].filter(Boolean)
    : []
  const purposeSummaryLines = buildPurposeSummaryContext(
    preprocessedWorkspaceContext,
    workingSetContext,
    inspectorContext,
  )

  if (workspaceContextLines.length === 0 && purposeSummaryLines.length === 0) {
    return scopedPrompt
  }

  return [
    ...workspaceContextLines,
    ...purposeSummaryLines,
    'Use this preprocessed workspace context first. When symbol query tools are available, prefer getSymbolWorkspaceSummary, findSymbols, getSymbolOutline, getSymbolNeighborhood, and readSymbolSlice before broad file reads. For single-symbol edits, read the symbol first and use replaceSymbolRange with the returned sliceHash as expectedSliceHash. Use readFileWindow and replaceFileWindow only for imports, module headers, configs, tests, multi-symbol edits, or other code that cannot be represented as one symbol, and include a reason.',
    '',
    scopedPrompt,
  ].join('\n')
}

export function buildAgentPromptMetadata(
  prompt: string,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  const workingSetScope = hasScopeContext(workingSetContext)
    ? buildScopeMetadata(workingSetContext)
    : null
  const inspectorPaths = hasScopeContext(inspectorContext)
    ? getScopePaths(inspectorContext)
    : []
  const workingSetPaths = workingSetScope?.paths ?? []

  return {
    kind: 'workspace_chat',
    paths: [...new Set([...workingSetPaths, ...inspectorPaths])],
    scope: workingSetScope,
    task: prompt.trim().replace(/\s+/g, ' ').slice(0, 160),
  }
}

export function buildScopeAwarePrompt(
  prompt: string,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  if (hasScopeContext(workingSetContext)) {
    const contextLines = [
      'Semanticode working set:',
      'Treat this pinned working set as the primary scope for the request.',
      'Inspect and modify these files or symbols before searching elsewhere in the repository.',
      'Only leave this working set when you need external dependency context or the user clearly redirects you.',
      'If you leave scope, state briefly why.',
      ...buildScopeContextLines(workingSetContext),
    ]

    if (hasScopeContext(inspectorContext) && !areScopeContextsEquivalent(workingSetContext, inspectorContext)) {
      contextLines.push(
        '',
        'Current transient inspector selection:',
        ...buildScopeContextLines(inspectorContext),
      )
    }

    return `${contextLines.join('\n')}\n\nUser request:\n${prompt}`
  }

  return buildInspectorScopedPrompt(prompt, inspectorContext)
}

export function buildPurposeSummaryContext(
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null | undefined,
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  if (!preprocessedWorkspaceContext?.purposeSummaries.length) {
    return []
  }

  const selectedSummaries = selectRelevantPurposeSummaries(
    preprocessedWorkspaceContext.purposeSummaries,
    workingSetContext,
    inspectorContext,
  )

  if (selectedSummaries.length === 0) {
    return []
  }

  return [
    'Relevant preprocessed purpose summaries:',
    ...selectedSummaries.map((summary) => {
      const domains =
        summary.domainHints.length > 0 ? ` domains=${summary.domainHints.join(', ')}` : ''
      const sideEffects =
        summary.sideEffects.length > 0 ? ` side_effects=${summary.sideEffects.join(', ')}` : ''
      return `- ${summary.path}: ${summary.summary}${domains}${sideEffects}`
    }),
  ]
}

export function selectRelevantPurposeSummaries(
  summaries: SemanticPurposeSummaryRecord[],
  workingSetContext: AgentScopeContext | null | undefined,
  inspectorContext: AgentScopeContext | null | undefined,
) {
  const workingSetFileIds = new Set(
    workingSetContext?.files.map((file) => file.id) ??
      (workingSetContext?.file ? [workingSetContext.file.id] : []),
  )
  const workingSetSymbolIds = new Set(
    workingSetContext?.symbols.map((symbol) => symbol.id) ??
      (workingSetContext?.symbol ? [workingSetContext.symbol.id] : []),
  )
  const selectedFileIds = new Set(
    inspectorContext?.files.map((file) => file.id) ??
      (inspectorContext?.file ? [inspectorContext.file.id] : []),
  )
  const selectedSymbolIds = new Set(
    inspectorContext?.symbols.map((symbol) => symbol.id) ??
      (inspectorContext?.symbol ? [inspectorContext.symbol.id] : []),
  )
  const selectedNodePath = inspectorContext?.node?.path ?? ''
  const selectedSymbolId = inspectorContext?.symbol?.id ?? ''
  const selectedSymbolPath = inspectorContext?.symbol?.path ?? ''

  return [...summaries]
    .map((summary) => ({
      summary,
      score: scorePurposeSummary(summary, {
        workingSetFileIds,
        workingSetSymbolIds,
        selectedFileIds,
        selectedSymbolIds,
        selectedNodePath,
        selectedSymbolId,
        selectedSymbolPath,
      }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return left.summary.path.localeCompare(right.summary.path)
    })
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_VISIBLE_PURPOSE_SUMMARIES)
    .map((entry) => entry.summary)
}

export function scorePurposeSummary(
  summary: SemanticPurposeSummaryRecord,
  input: {
    workingSetFileIds: Set<string>
    workingSetSymbolIds: Set<string>
    selectedFileIds: Set<string>
    selectedSymbolIds: Set<string>
    selectedNodePath: string
    selectedSymbolId: string
    selectedSymbolPath: string
  },
) {
  let score = 0

  if (input.workingSetFileIds.has(summary.fileId)) {
    score += 12
  }

  if (input.workingSetSymbolIds.has(summary.symbolId)) {
    score += 14
  }

  if (input.selectedFileIds.has(summary.fileId)) {
    score += 8
  }

  if (input.selectedSymbolId && summary.symbolId === input.selectedSymbolId) {
    score += 12
  }

  if (input.selectedSymbolIds.has(summary.symbolId)) {
    score += 10
  }

  if (input.selectedSymbolPath && summary.path === input.selectedSymbolPath) {
    score += 10
  }

  if (input.selectedNodePath && summary.path.startsWith(input.selectedNodePath)) {
    score += 6
  }

  score += Math.min(summary.sideEffects.length, 3)
  score += Math.min(summary.domainHints.length, 2)

  if (
    score === 0 &&
    (summary.sideEffects.length > 0 || summary.domainHints.length > 0)
  ) {
    score = 1
  }

  return score
}

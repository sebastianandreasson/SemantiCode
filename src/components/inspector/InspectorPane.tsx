import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Edge } from '@xyflow/react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorState, type Extension } from '@uiw/react-codemirror'
import { RangeSetBuilder, StateField, type RangeSet } from '@codemirror/state'
import { EditorView, GutterMarker, gutterLineClass } from '@codemirror/view'
import { css as cssLanguage } from '@codemirror/lang-css'
import { html as htmlLanguage } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json as jsonLanguage } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'

import { type ResolvedCanvasOverlay } from '../../visualizer/canvasScene'
import {
  type WorkingSetState,
  type CodebaseFile,
  type GitFileDiff,
  type InspectorTab,
  type LayoutGroup,
  type LayoutDraft,
  type PreprocessedWorkspaceContext,
  type ProjectNode,
  type SourceRange,
  type SymbolNode,
  type WorkspaceProfile,
} from '../../types'
import { fetchGitFileDiff } from '../../app/apiClient'
import { AgentPanel, type AgentScopeContext } from '../AgentPanel'
import type { ThemeMode } from '../settings/GeneralSettingsPanel'
import type { GroupPrototypeRecord } from '../../semantic/groups/groupPrototypes'

const MAX_VISIBLE_SELECTED_FILES = 8

interface GraphSummary {
  incoming: number
  outgoing: number
  neighbors: ProjectNode[]
}

interface InspectorPaneProps {
  activeDraft: LayoutDraft | null
  compareOverlayActive: boolean
  desktopHostAvailable: boolean
  draftActionError?: string | null
  graphSummary: GraphSummary
  header: {
    eyebrow: string
    title: string
  }
  inspectorBodyRef: RefObject<HTMLDivElement | null>
  inspectorTab: InspectorTab
  onAgentRunSettled?: () => Promise<void>
  onAdoptInspectorContextAsWorkingSet?: () => void
  onClearCompareOverlay: () => void
  onClearWorkingSet?: () => void
  onClose: () => void
  onOpenAgentSettings: () => void
  onSetInspectorTab: (tab: InspectorTab) => void
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  resolvedCompareOverlay: ResolvedCanvasOverlay | null
  selectedEdge: Edge | null
  selectedFile: CodebaseFile | null
  selectedFiles: CodebaseFile[]
  selectedLayoutGroup: LayoutGroup | null
  selectedLayoutGroupNearbySymbols: {
    score: number
    symbol: SymbolNode
  }[]
  selectedLayoutGroupPrototype: GroupPrototypeRecord | null
  selectedNodeTelemetry: {
    confidence: 'exact' | 'attributed' | 'fallback'
    lastSeenAt: string | null
    requestCount: number
    source: 'interactive' | 'autonomous' | 'all'
    toolNames: string[]
    totalTokens: number
  } | null
  selectedNode: ProjectNode | null
  selectedSymbol: SymbolNode | null
  selectedSymbols: SymbolNode[]
  themeMode: ThemeMode
  workingSet: WorkingSetState | null
  workingSetContext: AgentScopeContext | null
  workspaceProfile: WorkspaceProfile | null
}

export function InspectorPane({
  activeDraft,
  compareOverlayActive,
  desktopHostAvailable,
  draftActionError = null,
  graphSummary,
  header,
  inspectorBodyRef,
  inspectorTab,
  onAgentRunSettled,
  onAdoptInspectorContextAsWorkingSet,
  onClearCompareOverlay,
  onClearWorkingSet,
  onClose,
  onOpenAgentSettings,
  onSetInspectorTab,
  preprocessedWorkspaceContext,
  resolvedCompareOverlay,
  selectedEdge,
  selectedFile,
  selectedFiles,
  selectedLayoutGroup,
  selectedLayoutGroupNearbySymbols,
  selectedLayoutGroupPrototype,
  selectedNodeTelemetry,
  selectedNode,
  selectedSymbol,
  selectedSymbols,
  themeMode,
  workingSet,
  workingSetContext,
  workspaceProfile,
}: InspectorPaneProps) {
  const showContextSummary =
    !selectedEdge &&
    !selectedLayoutGroup &&
    !selectedNode &&
    !selectedFile &&
    selectedFiles.length === 0 &&
    selectedSymbols.length === 0

  return (
    <aside className="cbv-inspector">
      <div className="cbv-panel-header">
        <div className="cbv-panel-header-copy">
          <p className="cbv-eyebrow">{header.eyebrow ?? 'Inspector'}</p>
          <strong title={header.title}>{header.title}</strong>
        </div>
        <button
          aria-label="Close inspector"
          className="cbv-inspector-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>

      <div className="cbv-inspector-tabs">
        <button
          className={inspectorTab === 'file' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('file')}
          type="button"
        >
          File
        </button>
        <button
          className={inspectorTab === 'agent' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('agent')}
          type="button"
        >
          Agent
        </button>
        <button
          className={inspectorTab === 'graph' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('graph')}
          type="button"
        >
          Graph
        </button>
      </div>

      <div className="cbv-inspector-body" ref={inspectorBodyRef}>
        {inspectorTab === 'agent' ? (
          <AgentPanel
            desktopHostAvailable={desktopHostAvailable}
            inspectorContext={{
              file: selectedFile,
              files: selectedFiles,
              node: selectedNode,
              symbol: selectedSymbol,
              symbols: selectedSymbols,
            }}
            onOpenSettings={onOpenAgentSettings}
            onRunSettled={onAgentRunSettled}
            onAdoptInspectorContextAsWorkingSet={onAdoptInspectorContextAsWorkingSet}
            onClearWorkingSet={onClearWorkingSet}
            preprocessedWorkspaceContext={preprocessedWorkspaceContext}
            workingSet={workingSet}
            workingSetContext={workingSetContext}
            workspaceProfile={workspaceProfile}
          />
        ) : inspectorTab === 'graph' ? (
          <GraphInspector
            selectedEdge={selectedEdge}
            selectedNode={selectedNode}
            summary={graphSummary}
          />
        ) : selectedSymbols.length > 1 ? (
          <MultiSymbolInspector
            preprocessedWorkspaceContext={preprocessedWorkspaceContext}
            primarySymbol={selectedSymbol}
            selectedSymbols={selectedSymbols}
          />
        ) : selectedFiles.length > 1 ? (
          <MultiFileInspector
            primaryFile={selectedFile}
            selectedFiles={selectedFiles}
            themeMode={themeMode}
          />
        ) : selectedLayoutGroup ? (
          <LayoutGroupInspector
            group={selectedLayoutGroup}
            nearbySymbols={selectedLayoutGroupNearbySymbols}
            prototype={selectedLayoutGroupPrototype}
          />
        ) : selectedFile ? (
          <>
            {selectedSymbol ? (
              <SemanticPurposeSummaryCard
                summary={findPurposeSummary(preprocessedWorkspaceContext, selectedSymbol.id)}
              />
            ) : null}
            <div className="cbv-preview-meta">
              <span>{formatFileSize(selectedFile.size)}</span>
              <span>{selectedFile.extension || 'no extension'}</span>
              <span>{describeContentState(selectedFile)}</span>
              {selectedSymbol ? (
                <span>
                  {selectedSymbol.symbolKind}
                  {selectedSymbol.range ? ` · line ${selectedSymbol.range.start.line}` : ''}
                </span>
              ) : null}
            </div>
            <CodePreview
              file={selectedFile}
              highlightedRange={selectedSymbol?.range}
              themeMode={themeMode}
            />
          </>
        ) : showContextSummary && (activeDraft || (compareOverlayActive && resolvedCompareOverlay)) ? (
          <InspectorContextSummary
            activeDraft={activeDraft}
            compareOverlayActive={compareOverlayActive}
            draftActionError={draftActionError}
            onClearCompareOverlay={onClearCompareOverlay}
            resolvedCompareOverlay={resolvedCompareOverlay}
          />
        ) : (
          <div className="cbv-empty">
            <h2>No file selected</h2>
            <p>Select a node on the canvas to inspect its contents.</p>
          </div>
        )}
        {selectedNodeTelemetry ? (
          <TelemetrySummaryCard telemetry={selectedNodeTelemetry} />
        ) : null}
      </div>
    </aside>
  )
}

function TelemetrySummaryCard({
  telemetry,
}: {
  telemetry: {
    confidence: 'exact' | 'attributed' | 'fallback'
    lastSeenAt: string | null
    requestCount: number
    source: 'interactive' | 'autonomous' | 'all'
    toolNames: string[]
    totalTokens: number
  }
}) {
  return (
    <section className="cbv-telemetry-summary">
      <p className="cbv-eyebrow">Recent agent activity</p>
      <div className="cbv-telemetry-summary-row">
        <strong>{telemetry.requestCount} requests</strong>
        <span>{Math.round(telemetry.totalTokens)} tokens</span>
      </div>
      <p>
        {telemetry.source === 'all' ? 'Interactive + autonomous' : telemetry.source}{' '}
        · {telemetry.confidence}
        {telemetry.lastSeenAt
          ? ` · ${new Date(telemetry.lastSeenAt).toLocaleTimeString()}`
          : ''}
      </p>
      {telemetry.toolNames.length > 0 ? (
        <div className="cbv-purpose-summary-tags">
          {telemetry.toolNames.map((toolName) => (
            <span className="cbv-purpose-summary-tag" key={toolName}>
              {toolName}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function InspectorContextSummary({
  activeDraft,
  compareOverlayActive,
  draftActionError,
  onClearCompareOverlay,
  resolvedCompareOverlay,
}: {
  activeDraft: LayoutDraft | null
  compareOverlayActive: boolean
  draftActionError: string | null
  onClearCompareOverlay: () => void
  resolvedCompareOverlay: ResolvedCanvasOverlay | null
}) {
  return (
    <div className="cbv-inspector-context-summary">
      {activeDraft ? (
        <div className="cbv-draft-summary">
          <strong>Draft Layout</strong>
          <p>{activeDraft.proposalEnvelope.rationale}</p>
          {activeDraft.proposalEnvelope.warnings[0] ? (
            <p className="cbv-draft-warning">{activeDraft.proposalEnvelope.warnings[0]}</p>
          ) : null}
          {draftActionError ? <p className="cbv-draft-error">{draftActionError}</p> : null}
        </div>
      ) : null}

      {compareOverlayActive && resolvedCompareOverlay ? (
        <div className="cbv-compare-summary">
          <div className="cbv-compare-summary-header">
            <div>
              <p className="cbv-eyebrow">Semantic Compare</p>
              <strong>{resolvedCompareOverlay.sourceTitle}</strong>
            </div>
            <button
              className="cbv-toolbar-button is-secondary"
              onClick={onClearCompareOverlay}
              type="button"
            >
              Clear
            </button>
          </div>
          <p>
            {resolvedCompareOverlay.nodeIds.length} symbol
            {resolvedCompareOverlay.nodeIds.length === 1 ? '' : 's'} highlighted
            {resolvedCompareOverlay.missingNodeIds.length > 0
              ? ` · ${resolvedCompareOverlay.missingNodeIds.length} missing from projection`
              : ''}
          </p>
          {resolvedCompareOverlay.groupTitles[0] || resolvedCompareOverlay.laneTitles[0] ? (
            <p className="cbv-compare-summary-meta">
              {resolvedCompareOverlay.groupTitles[0]
                ? `${resolvedCompareOverlay.groupTitles.length} group${resolvedCompareOverlay.groupTitles.length === 1 ? '' : 's'}`
                : null}
              {resolvedCompareOverlay.groupTitles[0] &&
              resolvedCompareOverlay.laneTitles[0]
                ? ' · '
                : ''}
              {resolvedCompareOverlay.laneTitles[0]
                ? `${resolvedCompareOverlay.laneTitles.length} lane${resolvedCompareOverlay.laneTitles.length === 1 ? '' : 's'}`
                : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MultiFileInspector({
  primaryFile,
  selectedFiles,
  themeMode,
}: {
  primaryFile: CodebaseFile | null
  selectedFiles: CodebaseFile[]
  themeMode: ThemeMode
}) {
  const visibleFiles = selectedFiles.slice(0, MAX_VISIBLE_SELECTED_FILES)
  const hiddenFileCount = Math.max(0, selectedFiles.length - visibleFiles.length)
  const additionalFiles = primaryFile
    ? selectedFiles.filter((file) => file.id !== primaryFile.id)
    : selectedFiles

  return (
    <div className="cbv-multi-file-inspector">
      <div className="cbv-multi-file-summary">
        <strong>{selectedFiles.length} files selected</strong>
        <p>
          Cmd, Ctrl, or Shift-click files on the canvas to build an edit set for the
          agent.
        </p>
      </div>

      <div className="cbv-multi-file-list-card">
        <p className="cbv-eyebrow">Selected files</p>
        <ul className="cbv-multi-file-list">
          {visibleFiles.map((file, index) => (
            <li key={file.id}>
              <strong>{index === 0 ? 'Primary' : `File ${index + 1}`}</strong>
              <span>{file.path}</span>
            </li>
          ))}
        </ul>
        {hiddenFileCount > 0 ? (
          <p className="cbv-multi-file-overflow">
            + {hiddenFileCount} more selected file{hiddenFileCount === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>

      {primaryFile ? (
        <>
          <div className="cbv-preview-meta">
            <span>{formatFileSize(primaryFile.size)}</span>
            <span>{primaryFile.extension || 'no extension'}</span>
            <span>{describeContentState(primaryFile)}</span>
            <span>
              {additionalFiles.length > 0
                ? `${additionalFiles.length} additional files in scope`
                : 'Primary preview'}
            </span>
          </div>
          <CodePreview file={primaryFile} themeMode={themeMode} />
        </>
      ) : null}
    </div>
  )
}

function MultiSymbolInspector({
  preprocessedWorkspaceContext,
  primarySymbol,
  selectedSymbols,
}: {
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  primarySymbol: SymbolNode | null
  selectedSymbols: SymbolNode[]
}) {
  const visibleSymbols = selectedSymbols.slice(0, MAX_VISIBLE_SELECTED_FILES)
  const hiddenSymbolCount = Math.max(0, selectedSymbols.length - visibleSymbols.length)
  const primarySummary = primarySymbol
    ? findPurposeSummary(preprocessedWorkspaceContext, primarySymbol.id)
    : null

  return (
    <div className="cbv-multi-file-inspector">
      <div className="cbv-multi-file-summary">
        <strong>{selectedSymbols.length} symbols selected</strong>
        <p>
          Cmd, Ctrl, or Shift-click symbols on the canvas to build a scoped edit set
          for the agent.
        </p>
      </div>

      <div className="cbv-multi-file-list-card">
        <p className="cbv-eyebrow">Selected symbols</p>
        <ul className="cbv-multi-file-list">
          {visibleSymbols.map((symbol, index) => (
            <li key={symbol.id}>
              <strong>{index === 0 ? 'Primary' : `Symbol ${index + 1}`}</strong>
              <span>{symbol.path}</span>
            </li>
          ))}
        </ul>
        {hiddenSymbolCount > 0 ? (
          <p className="cbv-multi-file-overflow">
            + {hiddenSymbolCount} more selected symbol{hiddenSymbolCount === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>

      {primarySymbol ? (
        <>
          <SemanticPurposeSummaryCard summary={primarySummary} />
          <div className="cbv-preview-meta">
            <span>{primarySymbol.symbolKind}</span>
            <span>{primarySymbol.language || 'unknown language'}</span>
            <span>
              {primarySymbol.range ? `lines ${formatRange(primarySymbol.range)}` : 'no range'}
            </span>
            <span>Primary symbol</span>
          </div>
        </>
      ) : null}
    </div>
  )
}

function SemanticPurposeSummaryCard({
  summary,
}: {
  summary:
    | PreprocessedWorkspaceContext['purposeSummaries'][number]
    | null
    | undefined
}) {
  if (!summary) {
    return null
  }

  return (
    <section className="cbv-purpose-summary">
      <p className="cbv-eyebrow">Semantic Summary</p>
      <strong>{summary.path}</strong>
      <p>{summary.summary}</p>
      {summary.domainHints.length > 0 ? (
        <div className="cbv-purpose-summary-tags">
          {summary.domainHints.map((hint) => (
            <span className="cbv-purpose-summary-tag" key={`hint:${hint}`}>
              {hint}
            </span>
          ))}
        </div>
      ) : null}
      {summary.sideEffects.length > 0 ? (
        <div className="cbv-purpose-summary-tags">
          {summary.sideEffects.map((effect) => (
            <span
              className="cbv-purpose-summary-tag is-side-effect"
              key={`effect:${effect}`}
            >
              {effect}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function findPurposeSummary(
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null,
  symbolId: string,
) {
  return (
    preprocessedWorkspaceContext?.purposeSummaries.find(
      (summary) => summary.symbolId === symbolId,
    ) ?? null
  )
}

function GraphInspector({
  selectedEdge,
  selectedNode,
  summary,
}: {
  selectedEdge: Edge | null
  selectedNode: ProjectNode | null
  summary: GraphSummary
}) {
  return (
    <div className="cbv-graph-inspector">
      {selectedEdge ? (
        <section className="cbv-graph-card">
          <p className="cbv-eyebrow">Selected edge</p>
          <strong>{selectedEdge.label ?? getFlowEdgeData(selectedEdge)?.kind ?? 'Graph edge'}</strong>
          <p>
            {selectedEdge.source} → {selectedEdge.target}
          </p>
        </section>
      ) : null}

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Selection</p>
        <strong>{selectedNode?.path ?? 'No node selected'}</strong>
        <p>
          {summary.incoming} incoming, {summary.outgoing} outgoing, {summary.neighbors.length}{' '}
          connected nodes
        </p>
      </section>

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Neighbors</p>
        {summary.neighbors.length ? (
          <ul className="cbv-neighbor-list">
            {summary.neighbors.slice(0, 12).map((neighbor) => (
              <li key={neighbor.id}>
                <strong>{neighbor.name}</strong>
                <span>{neighbor.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No visible graph neighbors for the current layer selection.</p>
        )}
      </section>
    </div>
  )
}

function LayoutGroupInspector({
  group,
  nearbySymbols,
  prototype,
}: {
  group: LayoutGroup
  nearbySymbols: {
    score: number
    symbol: SymbolNode
  }[]
  prototype: GroupPrototypeRecord | null
}) {
  return (
    <div className="cbv-group-inspector">
      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Custom folder</p>
        <strong>{group.title}</strong>
        <p>{group.nodeIds.length} symbols in this folder.</p>
      </section>

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Semantic prototype</p>
        {prototype ? (
          <>
            <strong>{prototype.usableMemberCount} embedded members</strong>
            <p>
              Cohesion:{' '}
              {prototype.cohesionScore != null
                ? `${(prototype.cohesionScore * 100).toFixed(0)}%`
                : 'Unavailable'}
            </p>
          </>
        ) : (
          <>
            <strong>Prototype unavailable</strong>
            <p>This group needs at least two embedded symbols to derive a usable semantic prototype.</p>
          </>
        )}
      </section>

      <section className="cbv-graph-card">
        <p className="cbv-eyebrow">Nearby symbols</p>
        {nearbySymbols.length ? (
          <ul className="cbv-neighbor-list">
            {nearbySymbols.map(({ score, symbol }) => (
              <li key={symbol.id}>
                <strong>{symbol.name}</strong>
                <span>{symbol.path}</span>
                <small>{Math.round(score * 100)}% match</small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No nearby non-member symbols surfaced for this folder yet.</p>
        )}
      </section>
    </div>
  )
}

function CodePreview({
  file,
  highlightedRange,
  themeMode,
}: {
  file: CodebaseFile
  highlightedRange?: SourceRange
  themeMode: ThemeMode
}) {
  const viewRef = useRef<EditorView | null>(null)
  const diffCacheRef = useRef(new Map<string, GitFileDiff | null>())
  const [fileDiff, setFileDiff] = useState<GitFileDiff | null>(null)
  const extensions = useMemo(
    () => [
      getLanguageExtension(file),
      themeMode === 'dark' ? codePreviewThemeDark : codePreviewThemeLight,
      createHighlightedLineExtension(highlightedRange),
      createDiffLineExtension(fileDiff),
    ].flatMap((extension) => (extension ? [extension] : [])),
    [file, fileDiff, highlightedRange, themeMode],
  )

  useEffect(() => {
    let cancelled = false
    const cachedDiff = diffCacheRef.current.get(file.path)

    if (cachedDiff !== undefined) {
      setFileDiff(cachedDiff)
      return () => {
        cancelled = true
      }
    }

    setFileDiff(null)
    void fetchGitFileDiff(file.path)
      .then((diff) => {
        diffCacheRef.current.set(file.path, diff)

        if (!cancelled) {
          setFileDiff(diff)
        }
      })
      .catch(() => {
        diffCacheRef.current.set(file.path, null)

        if (!cancelled) {
          setFileDiff(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [file.path])

  useEffect(() => {
    if (!viewRef.current || !highlightedRange) {
      return
    }

    const lineNumber = Math.max(
      1,
      Math.min(highlightedRange.start.line, viewRef.current.state.doc.lines),
    )
    const line = viewRef.current.state.doc.line(lineNumber)

    viewRef.current.dispatch({
      effects: EditorView.scrollIntoView(line.from, {
        y: 'start',
      }),
    })
  }, [file.id, highlightedRange])

  if (!file.content) {
    return (
      <>
        {fileDiff?.hasDiff ? <CodeDiffSummary diff={fileDiff} /> : null}
        <CodeMirror
          basicSetup={false}
          className="cbv-code-editor"
          editable={false}
          extensions={[themeMode === 'dark' ? codePreviewThemeDark : codePreviewThemeLight]}
          readOnly
          theme={themeMode}
          value="// File content unavailable."
        />
      </>
    )
  }

  return (
    <>
      {fileDiff?.hasDiff ? <CodeDiffSummary diff={fileDiff} /> : null}
      <CodeMirror
        basicSetup={{
          autocompletion: false,
          closeBrackets: false,
          completionKeymap: false,
          defaultKeymap: false,
          drawSelection: true,
          dropCursor: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          history: false,
          indentOnInput: false,
          lintKeymap: false,
          searchKeymap: false,
        }}
        className="cbv-code-editor"
        editable={false}
        extensions={extensions}
        onCreateEditor={(view) => {
          viewRef.current = view
        }}
        readOnly
        theme={themeMode}
        value={file.content}
      />
    </>
  )
}

function CodeDiffSummary({ diff }: { diff: GitFileDiff }) {
  return (
    <div className="cbv-code-diff-summary">
      <p className="cbv-eyebrow">Uncommitted edits</p>
      <div className="cbv-code-diff-summary-row">
        <span className="cbv-code-diff-pill is-added">+{diff.addedLineCount}</span>
        <span className="cbv-code-diff-pill is-modified">~{diff.modifiedLineCount}</span>
        <span className="cbv-code-diff-pill is-deleted">-{diff.deletedLineCount}</span>
        <strong>{diff.isUntracked ? 'New file' : 'Diff against HEAD'}</strong>
      </div>
    </div>
  )
}

const codePreviewThemeLight = EditorView.theme({
  '&': {
    backgroundColor: 'var(--app-code-bg)',
    border: '1px solid var(--app-code-border)',
    borderRadius: '16px',
    fontSize: '12px',
  },
  '.cm-content': {
    fontFamily:
      'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
    padding: '14px 0',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--app-code-gutter-bg)',
    border: 'none',
    color: 'var(--app-code-gutter-text)',
    paddingRight: '10px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-gutterElement.cm-semanticode-highlighted-gutter': {
    backgroundColor: 'var(--app-code-gutter-highlight-bg)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-lineNumbers .cm-gutterElement.cm-semanticode-highlighted-gutter': {
    borderRadius: '0.45rem',
  },
  '.cm-gutterElement.cm-semanticode-diff-added-gutter': {
    boxShadow: 'inset 3px 0 0 0 var(--app-success)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-gutterElement.cm-semanticode-diff-modified-gutter': {
    boxShadow: 'inset 3px 0 0 0 var(--app-warning)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-lineNumbers .cm-gutterElement.cm-semanticode-diff-added-gutter, .cm-lineNumbers .cm-gutterElement.cm-semanticode-diff-modified-gutter': {
    borderRadius: '0.45rem',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--app-code-selection) !important',
  },
})

const codePreviewThemeDark = EditorView.theme({
  '&': {
    backgroundColor: 'var(--app-code-bg)',
    border: '1px solid var(--app-code-border)',
    borderRadius: '16px',
    fontSize: '12px',
  },
  '.cm-content': {
    fontFamily:
      'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
    padding: '14px 0',
    color: 'var(--app-text)',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--app-code-gutter-bg)',
    border: 'none',
    color: 'var(--app-code-gutter-text)',
    paddingRight: '10px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-gutterElement.cm-semanticode-highlighted-gutter': {
    backgroundColor: 'var(--app-code-gutter-highlight-bg)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-lineNumbers .cm-gutterElement.cm-semanticode-highlighted-gutter': {
    borderRadius: '0.45rem',
  },
  '.cm-gutterElement.cm-semanticode-diff-added-gutter': {
    boxShadow: 'inset 3px 0 0 0 var(--app-success)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-gutterElement.cm-semanticode-diff-modified-gutter': {
    boxShadow: 'inset 3px 0 0 0 var(--app-warning)',
    color: 'var(--app-code-gutter-highlight-text)',
    fontWeight: '700',
  },
  '.cm-lineNumbers .cm-gutterElement.cm-semanticode-diff-added-gutter, .cm-lineNumbers .cm-gutterElement.cm-semanticode-diff-modified-gutter': {
    borderRadius: '0.45rem',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--app-code-selection) !important',
  },
})

function createHighlightedLineExtension(highlightedRange?: SourceRange): Extension | null {
  if (!highlightedRange) {
    return null
  }

  const { start, end } = highlightedRange
  const startLine = Math.max(1, Math.min(start.line, end.line))
  const endLine = Math.max(startLine, Math.max(start.line, end.line))

  return StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildHighlightedGutterMarkers(state, startLine, endLine)
    },
    update(value) {
      return value
    },
    provide(field) {
      return gutterLineClass.from(field)
    },
  })
}

function createDiffLineExtension(diff?: GitFileDiff | null): Extension | null {
  if (!diff?.changes.length) {
    return null
  }

  return StateField.define<RangeSet<GutterMarker>>({
    create(state) {
      return buildDiffGutterMarkers(state, diff.changes)
    },
    update(value) {
      return value
    },
    provide(field) {
      return gutterLineClass.from(field)
    },
  })
}

class HighlightedGutterMarker extends GutterMarker {
  elementClass = 'cm-semanticode-highlighted-gutter'
}

const highlightedGutterMarker = new HighlightedGutterMarker()

class AddedDiffGutterMarker extends GutterMarker {
  elementClass = 'cm-semanticode-diff-added-gutter'
}

class ModifiedDiffGutterMarker extends GutterMarker {
  elementClass = 'cm-semanticode-diff-modified-gutter'
}

const addedDiffGutterMarker = new AddedDiffGutterMarker()
const modifiedDiffGutterMarker = new ModifiedDiffGutterMarker()

function buildHighlightedGutterMarkers(
  state: EditorState,
  startLine: number,
  endLine: number,
) {
  const builder = new RangeSetBuilder<GutterMarker>()
  const maxLine = Math.min(endLine, state.doc.lines)

  for (let lineNumber = startLine; lineNumber <= maxLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    builder.add(line.from, line.from, highlightedGutterMarker)
  }

  return builder.finish()
}

function buildDiffGutterMarkers(
  state: EditorState,
  changes: GitFileDiff['changes'],
) {
  const builder = new RangeSetBuilder<GutterMarker>()

  for (const change of changes) {
    const marker =
      change.kind === 'added'
        ? addedDiffGutterMarker
        : modifiedDiffGutterMarker
    const startLine = Math.max(1, change.startLine)
    const endLine = Math.min(state.doc.lines, Math.max(startLine, change.endLine))

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber)
      builder.add(line.from, line.from, marker)
    }
  }

  return builder.finish()
}

function getLanguageExtension(file: CodebaseFile): Extension | null {
  const extension = file.extension?.toLowerCase()

  switch (extension) {
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'js':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
      return jsonLanguage()
    case 'css':
    case 'scss':
    case 'less':
      return cssLanguage()
    case 'html':
      return htmlLanguage()
    case 'md':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'rs':
      return rust()
    case 'sql':
      return sql()
    case 'xml':
    case 'svg':
      return xml()
    case 'yml':
    case 'yaml':
      return yaml()
    default:
      return null
  }
}

function getFlowEdgeData(edge: Edge | null | undefined) {
  if (!edge?.data || typeof edge.data !== 'object') {
    return null
  }

  return edge.data as {
    kind?: string
  }
}

function formatRange(range: SourceRange) {
  if (
    range.start.line === range.end.line &&
    range.start.column === range.end.column
  ) {
    return `${range.start.line}`
  }

  if (range.start.line === range.end.line) {
    return `${range.start.line}:${range.start.column}-${range.end.column}`
  }

  return `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function describeContentState(file: CodebaseFile) {
  if (!file.content) {
    return 'content unavailable'
  }

  const lineCount = file.content.split('\n').length
  return `${lineCount} lines`
}

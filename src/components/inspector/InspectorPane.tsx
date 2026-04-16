import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { Edge } from '@xyflow/react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorState, RangeSetBuilder, StateField, type Extension } from '@uiw/react-codemirror'
import { Decoration, EditorView, type DecorationSet } from '@uiw/react-codemirror'
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
  type CodebaseFile,
  type InspectorTab,
  type LayoutDraft,
  type PreprocessedWorkspaceContext,
  type ProjectNode,
  type SourceRange,
  type SymbolNode,
  type WorkspaceProfile,
} from '../../types'
import { AgentPanel } from '../AgentPanel'

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
  onClearCompareOverlay: () => void
  onClose: () => void
  onOpenAgentSettings: () => void
  onSetInspectorTab: (tab: InspectorTab) => void
  preprocessedWorkspaceContext: PreprocessedWorkspaceContext | null
  resolvedCompareOverlay: ResolvedCanvasOverlay | null
  selectedEdge: Edge | null
  selectedFile: CodebaseFile | null
  selectedFiles: CodebaseFile[]
  selectedNode: ProjectNode | null
  selectedSymbol: SymbolNode | null
  selectedSymbols: SymbolNode[]
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
  onClearCompareOverlay,
  onClose,
  onOpenAgentSettings,
  onSetInspectorTab,
  preprocessedWorkspaceContext,
  resolvedCompareOverlay,
  selectedEdge,
  selectedFile,
  selectedFiles,
  selectedNode,
  selectedSymbol,
  selectedSymbols,
  workspaceProfile,
}: InspectorPaneProps) {
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
            preprocessedWorkspaceContext={preprocessedWorkspaceContext}
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
          <MultiFileInspector primaryFile={selectedFile} selectedFiles={selectedFiles} />
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
            <CodePreview file={selectedFile} highlightedRange={selectedSymbol?.range} />
          </>
        ) : (
          <div className="cbv-empty">
            <h2>No file selected</h2>
            <p>Select a node on the canvas to inspect its contents.</p>
          </div>
        )}
      </div>
    </aside>
  )
}

function MultiFileInspector({
  primaryFile,
  selectedFiles,
}: {
  primaryFile: CodebaseFile | null
  selectedFiles: CodebaseFile[]
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
          <CodePreview file={primaryFile} />
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

function CodePreview({
  file,
  highlightedRange,
}: {
  file: CodebaseFile
  highlightedRange?: SourceRange
}) {
  const viewRef = useRef<EditorView | null>(null)
  const extensions = useMemo(
    () => [
      getLanguageExtension(file),
      codePreviewTheme,
      createHighlightedLineExtension(highlightedRange),
    ].flatMap((extension) => (extension ? [extension] : [])),
    [file, highlightedRange],
  )

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
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, {
        y: 'center',
      }),
    })
  }, [file.id, highlightedRange])

  if (!file.content) {
    return (
      <CodeMirror
        basicSetup={false}
        className="cbv-code-editor"
        editable={false}
        extensions={[codePreviewTheme]}
        readOnly
        theme="light"
        value="// File content unavailable."
      />
    )
  }

  return (
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
      theme="light"
      value={file.content}
    />
  )
}

const codePreviewTheme = EditorView.theme({
  '&': {
    backgroundColor: '#f7f1e5',
    border: '1px solid rgba(138, 119, 99, 0.16)',
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
    backgroundColor: '#efe4cf',
    border: 'none',
    color: '#8a7763',
    paddingRight: '10px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-line.cm-semanticode-highlighted-line': {
    backgroundColor: 'rgba(184, 122, 55, 0.12)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(73, 104, 139, 0.18) !important',
  },
})

function createHighlightedLineExtension(highlightedRange?: SourceRange): Extension | null {
  if (!highlightedRange) {
    return null
  }

  const { start, end } = highlightedRange
  const startLine = Math.max(1, Math.min(start.line, end.line))
  const endLine = Math.max(startLine, Math.max(start.line, end.line))

  return StateField.define<DecorationSet>({
    create(state) {
      return buildHighlightedLineDecorations(state, startLine, endLine)
    },
    update(value) {
      return value
    },
    provide(field) {
      return EditorView.decorations.from(field)
    },
  })
}

function buildHighlightedLineDecorations(
  state: EditorState,
  startLine: number,
  endLine: number,
) {
  const builder = new RangeSetBuilder<Decoration>()
  const maxLine = Math.min(endLine, state.doc.lines)

  for (let lineNumber = startLine; lineNumber <= maxLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    builder.add(
      line.from,
      line.from,
      Decoration.line({
        class: 'cm-semanticode-highlighted-line',
      }),
    )
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

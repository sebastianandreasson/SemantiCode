import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import type { Edge } from '@xyflow/react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorState, type Extension } from '@uiw/react-codemirror'
import { RangeSetBuilder, StateField, type RangeSet } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, gutterLineClass } from '@codemirror/view'
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
  formatFacetLabel,
  formatFileSize,
} from '../../visualizer/flowModel'
import {
  type WorkingSetState,
  type CodebaseFile,
  type FollowDebugState,
  type FollowInspectorActivity,
  type GitFileDiff,
  type InspectorTab,
  type LayoutGroup,
  type LayoutDraft,
  type PreprocessedWorkspaceContext,
  type ProjectFacetDefinition,
  type ProjectNode,
  type ProjectPluginDetection,
  type SourceRange,
  type SymbolNode,
  type WorkspaceProfile,
} from '../../types'
import { fetchGitFileDiff } from '../../app/apiClient'
import { type AgentScopeContext } from '../../agent/agentScopeContext'
import { AgentContextPane } from '../agent/AgentContextPane'
import type { ThemeMode } from '../../app/themeBootstrap'
import type { GroupPrototypeRecord } from '../../semantic/groups/groupPrototypes'
import type { AgentDebugFeedEntry } from '../../app/useAgentEventFeed'

const MAX_VISIBLE_SELECTED_FILES = 8

interface GraphSummary {
  incoming: number
  outgoing: number
  neighbors: ProjectNode[]
}

interface InspectorPaneProps {
  activeDraft: LayoutDraft | null
  agentEventFeedEntries: AgentDebugFeedEntry[]
  compareOverlayActive: boolean
  detectedPlugins: ProjectPluginDetection[]
  dockMoveHandle?: ReactNode
  draftActionError?: string | null
  facetDefinitions: ProjectFacetDefinition[]
  followDebugState: FollowDebugState
  followedInspectorActivity?: FollowInspectorActivity | null
  graphSummary: GraphSummary
  header: {
    eyebrow: string
    title: string
  }
  inspectorBodyRef: RefObject<HTMLDivElement | null>
  inspectorTab: InspectorTab
  layoutActionsPending?: boolean
  layoutSyncNote?: {
    label: string
    title: string
  } | null
  onAdoptInspectorContextAsWorkingSet?: () => void
  onAcceptDraft?: () => void | Promise<void>
  onClearCompareOverlay: () => void
  onClearWorkingSet?: () => void
  onClose: () => void
  onOpenAgentDrawer?: () => void
  onOpenAgentSettings: () => void
  onRejectDraft?: () => void | Promise<void>
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
  scrollToDiffRequestKey?: string | null
  themeMode: ThemeMode
  workingSet: WorkingSetState | null
  workingSetContext: AgentScopeContext | null
  workspaceProfile: WorkspaceProfile | null
}

export function InspectorPane({
  activeDraft,
  agentEventFeedEntries,
  compareOverlayActive,
  detectedPlugins,
  dockMoveHandle = null,
  draftActionError = null,
  facetDefinitions,
  followDebugState,
  followedInspectorActivity = null,
  graphSummary,
  header,
  inspectorBodyRef,
  inspectorTab,
  layoutActionsPending = false,
  layoutSyncNote = null,
  onAdoptInspectorContextAsWorkingSet,
  onAcceptDraft,
  onClearCompareOverlay,
  onClearWorkingSet,
  onClose,
  onOpenAgentDrawer,
  onOpenAgentSettings,
  onRejectDraft,
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
  scrollToDiffRequestKey = null,
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
  const selectedFileFollowActivity = getFollowActivityForFile(
    followedInspectorActivity,
    selectedFile,
  )
  const selectedFileOperationRange = getPrimaryFollowOperationRange(selectedFileFollowActivity)

  return (
    <aside className="cbv-inspector">
      <div className="cbv-panel-header">
        <div className="cbv-panel-header-copy">
          <p className="cbv-eyebrow">{header.eyebrow ?? 'Inspector'}</p>
          <strong title={header.title}>{header.title}</strong>
        </div>
        <div className="cbv-panel-header-actions">
          {dockMoveHandle}
          <button
            aria-label="Close inspector"
            className="cbv-inspector-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
      </div>

      <div className="cbv-inspector-tabs">
        <button
          className={inspectorTab === 'file' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('file')}
          type="button"
        >
          file
        </button>
        <button
          className={inspectorTab === 'agent' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('agent')}
          type="button"
        >
          agent
        </button>
        <button
          className={inspectorTab === 'graph' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('graph')}
          type="button"
        >
          graph
        </button>
        <button
          className={inspectorTab === 'events' ? 'is-active' : ''}
          onClick={() => onSetInspectorTab('events')}
          type="button"
        >
          events
        </button>
      </div>

      <div className="cbv-inspector-body" ref={inspectorBodyRef}>
        {inspectorTab === 'agent' ? (
          <AgentContextPane
            activeDraft={activeDraft}
            draftActionError={draftActionError}
            inspectorContext={{
              file: selectedFile,
              files: selectedFiles,
              node: selectedNode,
              symbol: selectedSymbol,
              symbols: selectedSymbols,
            }}
            layoutActionsPending={layoutActionsPending}
            layoutSyncNote={layoutSyncNote}
            onAcceptDraft={onAcceptDraft}
            onOpenDrawer={onOpenAgentDrawer}
            onOpenSettings={onOpenAgentSettings}
            onAdoptInspectorContextAsWorkingSet={onAdoptInspectorContextAsWorkingSet}
            onClearWorkingSet={onClearWorkingSet}
            onRejectDraft={onRejectDraft}
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
        ) : inspectorTab === 'events' ? (
          <AgentEventFeedInspector
            entries={agentEventFeedEntries}
            followDebugState={followDebugState}
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
            scrollToDiffRequestKey={scrollToDiffRequestKey}
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
          <div className="cbv-file-inspector">
            <FileIdentityHeader file={selectedFile} symbol={selectedSymbol} />
            <FollowInspectorActivityCard activity={selectedFileFollowActivity} />
            <CodePreview
              file={selectedFile}
              highlightedRange={selectedFileOperationRange?.range ?? selectedSymbol?.range}
              operationRange={selectedFileOperationRange?.range ?? null}
              scrollToDiffRequestKey={scrollToDiffRequestKey}
              themeMode={themeMode}
            />
            <InspectorRelatedSection
              label={selectedSymbol ? 'Callers' : 'Related'}
              neighbors={graphSummary.neighbors}
            />
            <InspectorFileActions
              onOpenAgentDrawer={onOpenAgentDrawer}
              selectedFile={selectedFile}
              selectedSymbol={selectedSymbol}
            />
            {selectedNodeTelemetry ? (
              <TelemetrySummaryCard telemetry={selectedNodeTelemetry} />
            ) : null}
            {selectedSymbol ? (
              <SemanticPurposeSummaryCard
                summary={findPurposeSummary(preprocessedWorkspaceContext, selectedSymbol.id)}
              />
            ) : null}
            <PluginSemanticsCard
              detectedPlugins={detectedPlugins}
              facetDefinitions={facetDefinitions}
              selectedFile={selectedFile}
              selectedNode={selectedNode}
              selectedSymbol={selectedSymbol}
            />
          </div>
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
        {!selectedFile && selectedNodeTelemetry ? (
          <TelemetrySummaryCard telemetry={selectedNodeTelemetry} />
        ) : null}
        {!selectedFile ? (
          <PluginSemanticsCard
          detectedPlugins={detectedPlugins}
          facetDefinitions={facetDefinitions}
          selectedFile={selectedFile}
          selectedNode={selectedNode}
          selectedSymbol={selectedSymbol}
        />
        ) : null}
      </div>
    </aside>
  )
}

function PluginSemanticsCard({
  detectedPlugins,
  facetDefinitions,
  selectedFile,
  selectedNode,
  selectedSymbol,
}: {
  detectedPlugins: ProjectPluginDetection[]
  facetDefinitions: ProjectFacetDefinition[]
  selectedFile: CodebaseFile | null
  selectedNode: ProjectNode | null
  selectedSymbol: SymbolNode | null
}) {
  const inspectableNode = selectedSymbol ?? selectedFile ?? selectedNode

  if (!inspectableNode) {
    return null
  }

  const scopePath =
    selectedSymbol?.path.split('#')[0] ??
    selectedFile?.path ??
    selectedNode?.path ??
    ''
  const facetLabelById = new Map(
    facetDefinitions.map((facetDefinition) => [facetDefinition.id, facetDefinition.label]),
  )
  const matchingPluginDetections = detectedPlugins.filter((detection) =>
    isPathWithinScope(scopePath, detection.scopeRoot),
  )

  if (inspectableNode.facets.length === 0 && matchingPluginDetections.length === 0) {
    return null
  }

  return (
    <section className="cbv-telemetry-summary">
      <p className="cbv-eyebrow">Project semantics</p>
      {inspectableNode.facets.length > 0 ? (
        <div className="cbv-purpose-summary-tags">
          {inspectableNode.facets.map((facetId) => (
            <span className="cbv-purpose-summary-tag" key={facetId}>
              {facetLabelById.get(facetId) ?? formatFacetLabel(facetId)}
            </span>
          ))}
        </div>
      ) : null}
      {matchingPluginDetections.length > 0 ? (
        <div className="cbv-telemetry-summary-row">
          <strong>{matchingPluginDetections.map((detection) => detection.displayName).join(', ')}</strong>
          <span>
            {matchingPluginDetections.map((detection) => detection.scopeRoot || '.').join(', ')}
          </span>
        </div>
      ) : null}
    </section>
  )
}

function isPathWithinScope(path: string, scopeRoot: string) {
  return scopeRoot === '' || path === scopeRoot || path.startsWith(`${scopeRoot}/`)
}

function AgentEventFeedInspector({
  entries,
  followDebugState,
}: {
  entries: AgentDebugFeedEntry[]
  followDebugState: FollowDebugState
}) {
  const latestTarget = followDebugState.currentTarget

  return (
    <div className="cbv-agent-event-feed">
      <section className="cbv-agent-event-summary">
        <div>
          <p className="cbv-eyebrow">Follow resolver</p>
          <strong>{followDebugState.currentMode}</strong>
        </div>
        <p>
          {latestTarget
            ? `${latestTarget.intent} · ${latestTarget.kind} · ${latestTarget.confidence} · ${latestTarget.path}`
            : 'No resolved target'}
        </p>
        <div className="cbv-agent-event-summary-grid">
          <span>queue {followDebugState.queueLength}</span>
          <span>{followDebugState.cameraLockActive ? 'camera lock' : 'camera idle'}</span>
          <span>
            {followDebugState.refreshInFlight
              ? 'refreshing'
              : followDebugState.refreshPending
                ? 'refresh pending'
                : 'refresh idle'}
          </span>
        </div>
      </section>

      {entries.length === 0 ? (
        <div className="cbv-empty">
          <h2>No events yet</h2>
          <p>Run an agent request with follow enabled to populate the event feed.</p>
        </div>
      ) : (
        <ol className="cbv-agent-event-list">
          {entries.map((entry) => (
            <li className={`cbv-agent-event-item is-${entry.source}`} key={entry.id}>
              <div className="cbv-agent-event-item-header">
                <time dateTime={entry.timestamp}>{formatEventFeedTime(entry.timestamp)}</time>
                <strong>{entry.title}</strong>
                <span>{entry.source}</span>
              </div>
              {entry.path ? <p className="cbv-agent-event-path">{entry.path}</p> : null}
              {entry.detail ? <p className="cbv-agent-event-detail">{entry.detail}</p> : null}
              {entry.symbolNodeIds?.length ? (
                <div className="cbv-agent-event-symbols">
                  {entry.symbolNodeIds.slice(0, 4).map((symbolNodeId) => (
                    <span key={symbolNodeId} title={symbolNodeId}>
                      {formatSymbolNodeId(symbolNodeId)}
                    </span>
                  ))}
                  {entry.symbolNodeIds.length > 4 ? (
                    <span>+{entry.symbolNodeIds.length - 4}</span>
                  ) : null}
                </div>
              ) : null}
              <div className="cbv-agent-event-meta">
                <span>{entry.type}</span>
                {entry.status ? <span>{entry.status}</span> : null}
              </div>
              {entry.payload !== undefined ? (
                <details className="cbv-agent-event-payload">
                  <summary>payload</summary>
                  <pre>{formatEventPayload(entry.payload)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function formatEventFeedTime(timestamp: string) {
  const date = new Date(timestamp)

  if (!Number.isFinite(date.getTime())) {
    return '--:--:--'
  }

  return date.toLocaleTimeString()
}

function formatEventPayload(payload: unknown) {
  try {
    const text = JSON.stringify(payload, null, 2)

    return text.length > 5000 ? `${text.slice(0, 5000)}\n...` : text
  } catch {
    return '[unserializable payload]'
  }
}

function formatSymbolNodeId(symbolNodeId: string) {
  const withoutPrefix = symbolNodeId.replace(/^symbol:/, '')
  const hashIndex = withoutPrefix.indexOf('#')
  const compactValue = hashIndex >= 0 ? withoutPrefix.slice(hashIndex + 1) : withoutPrefix

  return compactValue.length > 44 ? `${compactValue.slice(0, 41)}...` : compactValue
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

function FileIdentityHeader({
  file,
  symbol,
}: {
  file: CodebaseFile
  symbol: SymbolNode | null
}) {
  const title = symbol?.name ?? file.path.split('/').at(-1) ?? file.path
  const signature = symbol?.signature ?? `${file.extension || 'file'} · ${describeContentState(file)}`
  const codeMeta = [
    symbol?.range ? `L${formatRange(symbol.range)}` : null,
    symbol?.range
      ? `${Math.max(1, symbol.range.end.line - symbol.range.start.line + 1)} LOC`
      : `${Math.max(1, file.content?.split('\n').length ?? 0)} lines`,
    formatFileSize(file.size),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <section className="cbv-file-identity">
      <div className="cbv-file-identity-topline">
        <span className="cbv-node-kind">{formatKindTag(symbol)}</span>
        <span className="cbv-file-identity-path" title={file.path}>
          {file.path}
        </span>
      </div>
      <strong>{title}</strong>
      <p className="cbv-file-identity-signature">{signature}</p>
      <p className="cbv-file-identity-meta">Code · {codeMeta}</p>
    </section>
  )
}

function FollowInspectorActivityCard({
  activity,
}: {
  activity: FollowInspectorActivity | null
}) {
  if (!activity) {
    return null
  }

  const primaryRange = getPrimaryFollowOperationRange(activity)
  const title = activity.intent === 'edit' ? 'Agent edit' : 'Agent read'
  const rangeText = primaryRange
    ? `${primaryRange.label} · L${formatRange(primaryRange.range)}`
    : activity.symbolNodeIds.length > 0
      ? `${activity.symbolNodeIds.length} symbol${activity.symbolNodeIds.length === 1 ? '' : 's'}`
      : 'File-level activity'

  return (
    <section className={`cbv-follow-activity-card is-${activity.intent}`}>
      <div className="cbv-follow-activity-card-header">
        <p className="cbv-eyebrow">{title}</p>
        <span>{formatFollowActivityTime(activity.timestamp)}</span>
      </div>
      <strong>{rangeText}</strong>
      {activity.toolNames.length > 0 ? (
        <div className="cbv-purpose-summary-tags">
          {activity.toolNames.map((toolName) => (
            <span className="cbv-purpose-summary-tag" key={toolName}>
              {toolName}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function InspectorRelatedSection({
  label = 'Related',
  neighbors,
}: {
  label?: string
  neighbors: ProjectNode[]
}) {
  if (neighbors.length === 0) {
    return null
  }

  return (
    <section className="cbv-inspector-support-section">
      <div className="cbv-inspector-support-header">
        <p className="cbv-eyebrow">{label} · {neighbors.length}</p>
      </div>
      <div className="cbv-purpose-summary-tags">
        {neighbors.slice(0, 10).map((neighbor) => (
          <span className="cbv-purpose-summary-tag" key={neighbor.id}>
            {neighbor.name}
          </span>
        ))}
      </div>
    </section>
  )
}

function InspectorFileActions({
  onOpenAgentDrawer,
  selectedFile,
  selectedSymbol,
}: {
  onOpenAgentDrawer?: () => void
  selectedFile: CodebaseFile
  selectedSymbol: SymbolNode | null
}) {
  if (!onOpenAgentDrawer) {
    return null
  }

  return (
    <section className="cbv-inspector-actions">
      <button onClick={onOpenAgentDrawer} type="button">
        ask agent ↵
      </button>
      <span title={selectedFile.path}>
        {selectedSymbol ? `${selectedSymbol.name} · ${selectedFile.path}` : selectedFile.path}
      </span>
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
  scrollToDiffRequestKey,
  selectedFiles,
  themeMode,
}: {
  primaryFile: CodebaseFile | null
  scrollToDiffRequestKey?: string | null
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
          <CodePreview
            file={primaryFile}
            scrollToDiffRequestKey={scrollToDiffRequestKey}
            themeMode={themeMode}
          />
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
  operationRange,
  scrollToDiffRequestKey,
  themeMode,
}: {
  file: CodebaseFile
  highlightedRange?: SourceRange
  operationRange?: SourceRange | null
  scrollToDiffRequestKey?: string | null
  themeMode: ThemeMode
}) {
  const viewRef = useRef<EditorView | null>(null)
  const diffSummaryRef = useRef<HTMLDivElement | null>(null)
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
    let attemptCount = 0
    let intervalId: number | null = null
    const retryUntilDiff = Boolean(scrollToDiffRequestKey)

    const stopRetrying = () => {
      if (intervalId != null) {
        window.clearInterval(intervalId)
        intervalId = null
      }
    }

    const refreshDiff = async () => {
      attemptCount += 1

      try {
        const diff = await fetchGitFileDiff(file.path)

        if (cancelled) {
          return
        }

        setFileDiff(diff)

        if (!retryUntilDiff || diff?.hasDiff || attemptCount >= 8) {
          stopRetrying()
        }
      } catch {
        if (cancelled) {
          return
        }

        if (!retryUntilDiff) {
          setFileDiff(null)
        }

        if (!retryUntilDiff || attemptCount >= 8) {
          stopRetrying()
        }
      }
    }

    void refreshDiff()

    if (retryUntilDiff) {
      intervalId = window.setInterval(() => {
        void refreshDiff()
      }, 700)
    }

    return () => {
      cancelled = true
      stopRetrying()
    }
  }, [file.path, scrollToDiffRequestKey])

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

  useEffect(() => {
    if (
      !scrollToDiffRequestKey ||
      !viewRef.current ||
      !fileDiff?.hasDiff ||
      fileDiff.changes.length === 0
    ) {
      return
    }

    diffSummaryRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })

    if (operationRange) {
      return
    }

    const firstChangedLineNumber = Math.max(
      1,
      Math.min(fileDiff.changes[0].startLine, viewRef.current.state.doc.lines),
    )
    const firstChangedLine = viewRef.current.state.doc.line(firstChangedLineNumber)

    viewRef.current.dispatch({
      effects: EditorView.scrollIntoView(firstChangedLine.from, {
        y: 'start',
      }),
    })
  }, [file.id, fileDiff, operationRange, scrollToDiffRequestKey])

  if (!file.content) {
    return (
      <>
        {fileDiff?.hasDiff ? <CodeDiffSummary diff={fileDiff} summaryRef={diffSummaryRef} /> : null}
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
      {fileDiff?.hasDiff ? <CodeDiffSummary diff={fileDiff} summaryRef={diffSummaryRef} /> : null}
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

function CodeDiffSummary({
  diff,
  summaryRef,
}: {
  diff: GitFileDiff
  summaryRef?: RefObject<HTMLDivElement | null>
}) {
  return (
    <div className="cbv-code-diff-summary" ref={summaryRef}>
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
    borderRadius: '0',
    fontSize: '10.5px',
  },
  '.cm-content': {
    fontFamily:
      'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
    padding: '10px 0',
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
  '.cm-line.cm-semanticode-diff-added-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-success-soft) 88%, var(--app-code-bg))',
    boxShadow: 'inset 4px 0 0 0 var(--app-success)',
  },
  '.cm-line.cm-semanticode-diff-modified-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-warning-soft) 84%, var(--app-code-bg))',
    boxShadow: 'inset 4px 0 0 0 var(--app-warning)',
  },
  '.cm-line.cm-semanticode-highlight-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-accent-soft) 30%, transparent)',
  },
  '.cm-line.cm-semanticode-dim-line': {
    opacity: '0.44',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--app-code-selection) !important',
  },
})

const codePreviewThemeDark = EditorView.theme({
  '&': {
    backgroundColor: 'var(--app-code-bg)',
    border: '1px solid var(--app-code-border)',
    borderRadius: '0',
    fontSize: '10.5px',
  },
  '.cm-content': {
    fontFamily:
      'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
    padding: '10px 0',
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
  '.cm-line.cm-semanticode-diff-added-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-success-soft) 92%, var(--app-code-bg))',
    boxShadow: 'inset 4px 0 0 0 var(--app-success)',
  },
  '.cm-line.cm-semanticode-diff-modified-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-warning-soft) 88%, var(--app-code-bg))',
    boxShadow: 'inset 4px 0 0 0 var(--app-warning)',
  },
  '.cm-line.cm-semanticode-highlight-line': {
    backgroundColor: 'color-mix(in srgb, var(--app-accent-soft) 20%, transparent)',
  },
  '.cm-line.cm-semanticode-dim-line': {
    opacity: '0.44',
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

  return [
    StateField.define<RangeSet<GutterMarker>>({
      create(state) {
        return buildHighlightedGutterMarkers(state, startLine, endLine)
      },
      update(_value, transaction) {
        return buildHighlightedGutterMarkers(transaction.state, startLine, endLine)
      },
      provide(field) {
        return gutterLineClass.from(field)
      },
    }),
    StateField.define<RangeSet<Decoration>>({
      create(state) {
        return buildHighlightedLineDecorations(state, startLine, endLine)
      },
      update(_value, transaction) {
        return buildHighlightedLineDecorations(transaction.state, startLine, endLine)
      },
      provide(field) {
        return EditorView.decorations.from(field)
      },
    }),
  ]
}

function createDiffLineExtension(diff?: GitFileDiff | null): Extension | null {
  if (!diff?.changes.length) {
    return null
  }

  return [
    StateField.define<RangeSet<GutterMarker>>({
      create(state) {
        return buildDiffGutterMarkers(state, diff.changes)
      },
      update(_value, transaction) {
        return buildDiffGutterMarkers(transaction.state, diff.changes)
      },
      provide(field) {
        return gutterLineClass.from(field)
      },
    }),
    StateField.define<RangeSet<Decoration>>({
      create(state) {
        return buildDiffLineDecorations(state, diff.changes)
      },
      update(_value, transaction) {
        return buildDiffLineDecorations(transaction.state, diff.changes)
      },
      provide(field) {
        return EditorView.decorations.from(field)
      },
    }),
  ]
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
const highlightedLineDecoration = Decoration.line({
  attributes: {
    class: 'cm-semanticode-highlight-line',
  },
})
const dimmedLineDecoration = Decoration.line({
  attributes: {
    class: 'cm-semanticode-dim-line',
  },
})
const addedDiffLineDecoration = Decoration.line({
  attributes: {
    class: 'cm-semanticode-diff-added-line',
  },
})
const modifiedDiffLineDecoration = Decoration.line({
  attributes: {
    class: 'cm-semanticode-diff-modified-line',
  },
})

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

function buildHighlightedLineDecorations(
  state: EditorState,
  startLine: number,
  endLine: number,
) {
  const builder = new RangeSetBuilder<Decoration>()

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber)
    const decoration =
      lineNumber >= startLine && lineNumber <= endLine
        ? highlightedLineDecoration
        : dimmedLineDecoration
    builder.add(line.from, line.from, decoration)
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

function buildDiffLineDecorations(
  state: EditorState,
  changes: GitFileDiff['changes'],
) {
  const builder = new RangeSetBuilder<Decoration>()

  for (const change of changes) {
    const decoration =
      change.kind === 'added'
        ? addedDiffLineDecoration
        : modifiedDiffLineDecoration
    const startLine = Math.max(1, change.startLine)
    const endLine = Math.min(state.doc.lines, Math.max(startLine, change.endLine))

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber)
      builder.add(line.from, line.from, decoration)
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

function formatKindTag(symbol: SymbolNode | null) {
  if (!symbol) {
    return 'file'
  }

  if (symbol.facets.includes('react:component')) {
    return 'comp'
  }

  if (symbol.facets.includes('react:hook')) {
    return 'hook'
  }

  switch (symbol.symbolKind) {
    case 'class':
      return 'class'
    case 'constant':
      return 'const'
    case 'variable':
      return 'var'
    case 'method':
      return 'meth'
    case 'function':
    default:
      return 'fn'
  }
}

function getFollowActivityForFile(
  activity: FollowInspectorActivity | null,
  file: CodebaseFile | null,
) {
  if (!activity || !file || activity.path !== file.path) {
    return null
  }

  return activity
}

function getPrimaryFollowOperationRange(activity: FollowInspectorActivity | null) {
  if (!activity?.operationRanges?.length) {
    return null
  }

  const matchingRanges = activity.operationRanges
    .filter((range) => !range.path || range.path === activity.path)

  if (matchingRanges.length === 0) {
    return activity.operationRanges[0]
  }

  return matchingRanges.find((range) => range.kind === activity.intent) ??
    matchingRanges.find((range) => range.kind === 'read') ??
    matchingRanges[0]
}

function formatFollowActivityTime(timestamp: string) {
  const parsed = new Date(timestamp)

  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleTimeString()
    : timestamp
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

function describeContentState(file: CodebaseFile) {
  if (!file.content) {
    return 'content unavailable'
  }

  const lineCount = file.content.split('\n').length
  return `${lineCount} lines`
}

import { memo, type CSSProperties } from 'react'

import { Handle, Position, type NodeProps } from '@xyflow/react'

import { cx, getAgentHeatStyle } from './nodePresentation'

type CodebaseSymbolNodeData = Record<string, unknown> & {
  title: string
  subtitle: string
  kind: string
  kindClass?: string
  tags: string[]
  dimmed: boolean
  heatPulse?: boolean
  heatWeight?: number
  highlighted?: boolean
  loc?: number
  locScale?: number
  contentScale?: number
  clusterSize?: number
  sharedCallerCount?: number
  clusterExpanded?: boolean
  contained?: boolean
  compact?: boolean
  agentFocusConfidence?: string
  agentFocusEventCount?: number
  agentFocusIntent?: 'read' | 'edit' | 'mixed'
}

export const CodebaseSymbolNode = memo(function CodebaseSymbolNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as CodebaseSymbolNodeData
  const kindTag = formatSymbolKindTag(nodeData.kindClass ?? nodeData.kind)
  const tags = nodeData.tags.filter(
    (tag) => !matchesKindTag(tag, nodeData.kindClass ?? nodeData.kind),
  )
  const locScale = Math.max(0.56, Math.min(7.2, nodeData.locScale ?? 1))
  const contentScale = Math.max(
    0.56,
    Math.min(6.2, nodeData.contentScale ?? locScale),
  )
  const compact = Boolean(nodeData.compact)
  const nodeStyle = {
    '--cbv-symbol-scale': `${locScale}`,
    '--cbv-symbol-content-scale': `${contentScale}`,
    '--cbv-symbol-pad-y': `${(compact ? 0.375 : 0.4375) * contentScale}rem`,
    '--cbv-symbol-pad-x': `${0.625 * contentScale}rem`,
    '--cbv-symbol-pad-left': `${0.75 * contentScale}rem`,
    '--cbv-symbol-meta-gap': `${0.25 * contentScale}rem`,
    '--cbv-symbol-meta-margin': `${0.3125 * contentScale}rem`,
    '--cbv-symbol-chip-font-size': `${0.59375 * contentScale}rem`,
    '--cbv-symbol-chip-min-height': `${1 * contentScale}rem`,
    '--cbv-symbol-chip-pad-y': `${0.0625 * contentScale}rem`,
    '--cbv-symbol-chip-pad-x': `${0.3125 * contentScale}rem`,
    '--cbv-symbol-title-font-size': `${
      (compact ? 0.6875 : 0.71875) * contentScale
    }rem`,
    '--cbv-symbol-subtitle-font-size': `${
      (compact ? 0.59375 : 0.625) * contentScale
    }rem`,
    '--cbv-symbol-subtitle-margin': `${0.125 * contentScale}rem`,
    '--cbv-symbol-handle-size': `${0.375 * contentScale}rem`,
    '--cbv-symbol-stripe-width': `${Math.max(2, 2 * locScale)}px`,
    ...(getAgentHeatStyle(nodeData.heatWeight) ?? {}),
  } as CSSProperties

  return (
    <div
      className={cx(
        'cbv-node',
        'is-symbol',
        nodeData.kindClass && `is-kind-${nodeData.kindClass}`,
        nodeData.contained && 'is-contained',
        nodeData.clusterExpanded && 'is-cluster-expanded',
        nodeData.compact && 'is-compact',
        locScale > 1.08 && 'is-loc-scaled',
        selected && 'is-selected',
        nodeData.dimmed && 'is-dimmed',
        nodeData.highlighted && 'is-compare-highlighted',
        nodeData.agentFocusIntent && 'is-agent-focus',
        nodeData.agentFocusIntent && `is-agent-focus-${nodeData.agentFocusIntent}`,
        (nodeData.heatWeight ?? 0) > 0 && 'has-agent-heat',
        nodeData.heatPulse && 'is-agent-heat-pulse',
      )}
      style={nodeStyle}
    >
      <Handle
        className="cbv-node-handle"
        position={Position.Left}
        type="target"
      />
      <div className="cbv-node-meta">
        <span className="cbv-node-kind">{kindTag}</span>
        {tags.map((tag) => (
          <span className="cbv-node-tag" key={tag}>
            {tag}
          </span>
        ))}
        {nodeData.agentFocusIntent ? (
          <span className={`cbv-node-tag is-agent-focus is-${nodeData.agentFocusIntent}`}>
            {formatAgentFocusIntent(nodeData.agentFocusIntent)}
          </span>
        ) : null}
        {nodeData.agentFocusConfidence ? (
          <span className="cbv-node-tag is-agent-focus-confidence">
            {formatAgentFocusConfidence(nodeData.agentFocusConfidence)}
          </span>
        ) : null}
        {nodeData.agentFocusEventCount && nodeData.agentFocusEventCount > 1 ? (
          <span className="cbv-node-tag is-agent-focus-count">
            {nodeData.agentFocusEventCount} events
          </span>
        ) : null}
        {nodeData.loc ? (
          <span className="cbv-node-tag is-loc">
            {nodeData.loc} loc
          </span>
        ) : null}
        {nodeData.sharedCallerCount && nodeData.sharedCallerCount > 1 ? (
          <span className="cbv-node-tag is-shared">
            {nodeData.sharedCallerCount} callers
          </span>
        ) : null}
        {nodeData.clusterSize && nodeData.clusterSize > 0 ? (
          <span className="cbv-node-tag is-cluster">
            {nodeData.clusterSize} internal {nodeData.clusterExpanded ? 'open' : 'hidden'}
          </span>
        ) : null}
      </div>
      <strong className="cbv-node-title">{nodeData.title}</strong>
      <span className="cbv-node-subtitle">{nodeData.subtitle}</span>
      <Handle
        className="cbv-node-handle"
        position={Position.Right}
        type="source"
      />
    </div>
  )
})

function formatAgentFocusIntent(intent: NonNullable<CodebaseSymbolNodeData['agentFocusIntent']>) {
  switch (intent) {
    case 'edit':
      return 'edit'
    case 'mixed':
      return 'mixed'
    case 'read':
      return 'read'
  }
}

function formatAgentFocusConfidence(confidence: string) {
  switch (confidence) {
    case 'exact_symbol':
      return 'exact'
    case 'range_overlap':
      return 'range'
    case 'dirty_file':
      return 'dirty'
    case 'file_wide':
      return 'file'
    default:
      return confidence
  }
}

function formatSymbolKindTag(kind: string) {
  switch (kind) {
    case 'component':
      return 'comp'
    case 'hook':
      return 'hook'
    case 'class':
      return 'class'
    case 'constant':
      return 'const'
    case 'variable':
      return 'var'
    case 'unknown':
      return 'misc'
    case 'module':
      return 'mod'
    case 'function':
    case 'method':
    default:
      return 'fn'
  }
}

function matchesKindTag(tag: string, kind: string) {
  const normalizedTag = tag.trim().toLowerCase()

  switch (kind) {
    case 'component':
      return normalizedTag === 'component' || normalizedTag === 'react'
    case 'hook':
      return normalizedTag === 'hook'
    case 'class':
      return normalizedTag === 'class'
    case 'constant':
      return normalizedTag === 'constant'
    case 'variable':
      return normalizedTag === 'variable'
    case 'unknown':
      return normalizedTag === 'other' || normalizedTag === 'unknown'
    case 'module':
      return normalizedTag === 'module'
    case 'function':
    case 'method':
    default:
      return normalizedTag === 'function' || normalizedTag === 'method'
  }
}

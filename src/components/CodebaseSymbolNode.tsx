import { memo, type CSSProperties } from 'react'

import { Handle, Position, type NodeProps } from '@xyflow/react'

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
  clusterSize?: number
  sharedCallerCount?: number
  clusterExpanded?: boolean
  contained?: boolean
  compact?: boolean
}

export const CodebaseSymbolNode = memo(function CodebaseSymbolNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as CodebaseSymbolNodeData
  const kindTag = formatSymbolKindTag(nodeData.kindClass ?? nodeData.kind)
  const tags = nodeData.tags.filter((tag) => !matchesKindTag(tag, nodeData.kindClass ?? nodeData.kind))

  return (
    <div
      className={[
        'cbv-node',
        'is-symbol',
        nodeData.kindClass ? `is-kind-${nodeData.kindClass}` : '',
        nodeData.contained ? 'is-contained' : '',
        nodeData.clusterExpanded ? 'is-cluster-expanded' : '',
        nodeData.compact ? 'is-compact' : '',
        selected ? 'is-selected' : '',
        nodeData.dimmed ? 'is-dimmed' : '',
        nodeData.highlighted ? 'is-compare-highlighted' : '',
        (nodeData.heatWeight ?? 0) > 0 ? 'has-agent-heat' : '',
        nodeData.heatPulse ? 'is-agent-heat-pulse' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        (nodeData.heatWeight ?? 0) > 0
          ? ({
              '--cbv-agent-heat-strength': `${Math.max(0.28, Math.min(1, nodeData.heatWeight ?? 0))}`,
            } as CSSProperties)
          : undefined
      }
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

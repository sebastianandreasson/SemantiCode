import { memo, type CSSProperties } from 'react'

import { Handle, Position, type NodeProps } from '@xyflow/react'

type CodebaseCanvasNodeData = Record<string, unknown> & {
  title: string
  subtitle: string
  kind: 'directory' | 'file'
  tags: string[]
  dimmed: boolean
  highlighted?: boolean
  heatPulse?: boolean
  heatWeight?: number
  container?: boolean
  groupContainer?: boolean
  collapsible?: boolean
  collapsed?: boolean
  onToggleCollapse?: (() => void) | undefined
}

export const CodebaseCanvasNode = memo(function CodebaseCanvasNode({
  data,
  selected,
}: NodeProps) {
  const nodeData = data as CodebaseCanvasNodeData

  return (
    <div
      className={[
        'cbv-node',
        nodeData.kind === 'directory' ? 'is-directory' : 'is-file',
        nodeData.container ? 'is-folder-container' : '',
        nodeData.groupContainer ? 'is-group-container' : '',
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
      {nodeData.collapsible ? (
        <button
          className="cbv-node-collapse-toggle"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            nodeData.onToggleCollapse?.()
          }}
          title={nodeData.collapsed ? 'Expand folder' : 'Collapse folder'}
          type="button"
        >
          {nodeData.collapsed ? '▸' : '▾'}
        </button>
      ) : null}
      {nodeData.groupContainer ? null : (
        <Handle
          className="cbv-node-handle"
          position={Position.Left}
          type="target"
        />
      )}
      <div className="cbv-node-meta">
        <span className="cbv-node-kind">
          {nodeData.kind === 'directory' ? 'dir' : 'file'}
        </span>
        {nodeData.tags.map((tag) => (
          <span className="cbv-node-tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <strong className="cbv-node-title">{nodeData.title}</strong>
      <span className="cbv-node-subtitle">{nodeData.subtitle}</span>
      {nodeData.groupContainer ? null : (
        <Handle
          className="cbv-node-handle"
          position={Position.Right}
          type="source"
        />
      )}
    </div>
  )
})

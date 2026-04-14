import { Handle, Position, type NodeProps } from '@xyflow/react'

type CodebaseCanvasNodeData = Record<string, unknown> & {
  title: string
  subtitle: string
  kind: 'directory' | 'file'
  tags: string[]
  selected: boolean
  dimmed: boolean
}

export function CodebaseCanvasNode({
  data,
}: NodeProps) {
  const nodeData = data as CodebaseCanvasNodeData

  return (
    <div
      className={[
        'cbv-node',
        nodeData.kind === 'directory' ? 'is-directory' : 'is-file',
        nodeData.selected ? 'is-selected' : '',
        nodeData.dimmed ? 'is-dimmed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle
        className="cbv-node-handle"
        position={Position.Left}
        type="target"
      />
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
      <Handle
        className="cbv-node-handle"
        position={Position.Right}
        type="source"
      />
    </div>
  )
}

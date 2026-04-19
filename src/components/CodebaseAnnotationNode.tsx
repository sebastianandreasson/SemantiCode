import { memo } from 'react'

import type { NodeProps } from '@xyflow/react'

import { cx } from './nodePresentation'

type CodebaseAnnotationNodeData = Record<string, unknown> & {
  label: string
  dimmed: boolean
}

export const CodebaseAnnotationNode = memo(function CodebaseAnnotationNode({
  data,
}: NodeProps) {
  const annotation = data as CodebaseAnnotationNodeData

  return (
    <div
      className={cx('cbv-annotation-node', annotation.dimmed && 'is-dimmed')}
    >
      <span>{annotation.label}</span>
    </div>
  )
})

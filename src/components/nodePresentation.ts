import type { CSSProperties } from 'react'

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ')
}

export function getAgentHeatStyle(weight?: number): CSSProperties | undefined {
  const heatWeight = weight ?? 0

  return heatWeight > 0
    ? ({
        '--cbv-agent-heat-strength': `${Math.max(0.28, Math.min(1, heatWeight))}`,
      } as CSSProperties)
    : undefined
}

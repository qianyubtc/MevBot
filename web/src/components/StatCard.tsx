import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

interface Props {
  label: string
  value: string
  sub?: string
  trend?: 'up' | 'down' | 'neutral'
  icon?: ReactNode
  glow?: boolean
}

export default function StatCard({ label, value, sub, trend, icon, glow }: Props) {
  return (
    <div className={cn(
      'rounded-xl bg-bg-surface border border-bg-border p-4 flex flex-col gap-2',
      glow && trend === 'up' && 'glow-green',
      glow && trend === 'down' && 'border-danger/20',
    )}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">{label}</span>
        {icon && <span className="text-text-muted">{icon}</span>}
      </div>
      <div className={cn(
        'text-2xl font-mono font-semibold',
        trend === 'up' && 'text-success',
        trend === 'down' && 'text-danger',
        trend === 'neutral' && 'text-white',
        !trend && 'text-white',
      )}>
        {value}
      </div>
      {sub && <div className="text-xs text-text-muted">{sub}</div>}
    </div>
  )
}

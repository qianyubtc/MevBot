import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Sword, ArrowLeftRight, Droplets,
  Crosshair, Zap, Settings, Activity, Download,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'

const NAV = [
  { to: '/', icon: LayoutDashboard, label: '概览' },
  { to: '/sandwich', icon: Sword, label: '夹子' },
  { to: '/arbitrage', icon: ArrowLeftRight, label: '套利' },
  { to: '/lp', icon: Droplets, label: 'LP 套利' },
  { to: '/sniper', icon: Crosshair, label: '狙击' },
  { to: '/liquidation', icon: Zap, label: '清算' },
]

export default function Sidebar() {
  const { runnerConnected, activeStrategies, pnl } = useStore()
  const activeCount = Object.values(activeStrategies).filter(Boolean).length

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col bg-bg-surface border-r border-bg-border">
      {/* Logo */}
      <div className="h-14 flex items-center px-4 border-b border-bg-border">
        <Activity className="w-5 h-5 text-primary mr-2" />
        <span className="font-mono font-semibold text-white tracking-wider">MEV Terminal</span>
      </div>

      {/* Runner status */}
      <NavLink to="/download" className="mx-3 mt-3 px-3 py-2 rounded-lg bg-bg-elevated border border-bg-border flex items-center gap-2 hover:border-primary/30 transition-colors">
        <span className={cn(
          'w-2 h-2 rounded-full',
          runnerConnected ? 'bg-success animate-pulse-slow' : 'bg-warning animate-pulse'
        )} />
        <span className="text-xs text-text-muted flex-1">
          {runnerConnected ? 'Runner 已连接' : 'Runner 未连接'}
        </span>
        {!runnerConnected && <Download className="w-3 h-3 text-warning" />}
      </NavLink>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all',
                isActive
                  ? 'bg-primary-dim text-primary font-medium'
                  : 'text-text-dim hover:bg-bg-elevated hover:text-text'
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('w-4 h-4', isActive ? 'text-primary' : '')} />
                <span>{label}</span>
                {isActive && activeStrategies[label] && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom stats */}
      <div className="px-3 pb-3 space-y-2">
        {pnl && (
          <div className="px-3 py-2 rounded-lg bg-bg-elevated border border-bg-border">
            <div className="text-xs text-text-muted mb-1">今日收益</div>
            <div className={cn(
              'font-mono font-semibold text-sm',
              pnl.todayUSD >= 0 ? 'text-success' : 'text-danger'
            )}>
              {pnl.todayUSD >= 0 ? '+' : ''}${pnl.todayUSD.toFixed(2)}
            </div>
          </div>
        )}
        {activeCount > 0 && (
          <div className="px-3 py-2 rounded-lg bg-primary-dim border border-primary/20">
            <div className="text-xs text-primary">{activeCount} 个策略运行中</div>
          </div>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all w-full',
              isActive
                ? 'bg-primary-dim text-primary font-medium'
                : 'text-text-muted hover:bg-bg-elevated hover:text-text'
            )
          }
        >
          <Settings className="w-4 h-4" />
          <span>设置</span>
        </NavLink>
      </div>
    </aside>
  )
}

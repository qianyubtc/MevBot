import { useLocation } from 'react-router-dom'
import { Wifi, WifiOff, Clock } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { useState, useEffect } from 'react'

const TITLES: Record<string, string> = {
  '/': '系统概览',
  '/sandwich': '夹子机器人',
  '/arbitrage': '套利机器人',
  '/lp': 'LP 套利',
  '/sniper': '狙击机器人',
  '/liquidation': '清算机器人',
  '/settings': '系统设置',
  '/download': 'Runner 下载',
}

export default function TopBar() {
  const { pathname } = useLocation()
  const { runnerConnected, config } = useStore()
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="h-14 flex items-center px-6 border-b border-bg-border bg-bg-surface/50 backdrop-blur-sm flex-shrink-0">
      <div className="flex-1">
        <h1 className="text-sm font-semibold text-white">{TITLES[pathname] ?? 'MEV Terminal'}</h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Chain badge */}
        <div className="px-2.5 py-1 rounded-md bg-accent-dim border border-accent/30 text-xs font-mono text-accent">
          {config.chain}
        </div>

        {/* Runner connection */}
        <div className={cn(
          'flex items-center gap-1.5 text-xs',
          runnerConnected ? 'text-success' : 'text-text-muted'
        )}>
          {runnerConnected
            ? <Wifi className="w-3.5 h-3.5" />
            : <WifiOff className="w-3.5 h-3.5" />
          }
          <span className="font-mono">
            {runnerConnected ? 'ws://localhost:8765' : '未连接'}
          </span>
        </div>

        {/* Clock */}
        <div className="flex items-center gap-1.5 text-xs text-text-muted font-mono">
          <Clock className="w-3.5 h-3.5" />
          {time.toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>
    </header>
  )
}

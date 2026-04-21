import { useState } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import { Play, Square, Crosshair, TrendingUp, AlertTriangle } from 'lucide-react'
import { cn, formatUSD } from '@/lib/utils'

const MOCK_NEW_TOKENS = [
  { symbol: 'MOON', name: 'MoonCoin', liquidity: 85000, age: '2m', buyers: 124, score: 88 },
  { symbol: 'SAFE', name: 'SafeToken', liquidity: 42000, age: '8m', buyers: 67, score: 71 },
  { symbol: 'DOGE3', name: 'Doge3.0', liquidity: 210000, age: '15m', buyers: 389, score: 93 },
  { symbol: 'SHIB3', name: 'Shib3', liquidity: 31000, age: '3m', buyers: 45, score: 62 },
]

export default function Sniper() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['sniper'] ?? false
  const cfg = strategyConfig.sniper

  const handleStartStop = () => {
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'sniper' } })
    } else {
      wsClient.send({ type: 'start', payload: { strategy: 'sniper', config: cfg } })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">狙击机器人</h2>
          <p className="text-xs text-text-muted mt-0.5">监听新币上线事件，抢先买入获利</p>
        </div>
        <button
          onClick={handleStartStop}
          disabled={!runnerConnected}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50',
            isRunning
              ? 'bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20'
              : 'bg-primary text-bg hover:bg-primary-hover'
          )}
        >
          {isRunning ? <Square className="w-4 h-4" /> : <Crosshair className="w-4 h-4" />}
          {isRunning ? '停止狙击' : '开始狙击'}
        </button>
      </div>

      {/* Risk warning */}
      <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
        <div className="text-xs text-warning/80">
          狙击新币存在较高风险，包括蜜罐合约、Rug Pull 等。系统已内置合约检测，但无法保证 100% 安全，请合理设置止损。
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* New token feed */}
        <div className="lg:col-span-2 space-y-3">
          <div className="text-sm text-text-muted">新币监控（实时）</div>
          {MOCK_NEW_TOKENS.map((token) => (
            <div
              key={token.symbol}
              className={cn(
                'rounded-xl bg-bg-surface border p-4 transition-colors',
                token.liquidity >= cfg.minLiquidityUSD
                  ? 'border-success/20 hover:border-success/40'
                  : 'border-bg-border opacity-60'
              )}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-white">{token.symbol}</span>
                    <span className="text-xs text-text-muted">{token.name}</span>
                    <span className="text-xs bg-bg-elevated px-1.5 py-0.5 rounded text-text-muted">{token.age}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                    <span>流动性 <span className="text-white font-mono">{formatUSD(token.liquidity)}</span></span>
                    <span>买入 <span className="text-white font-mono">{token.buyers}</span> 笔</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className={cn(
                    'px-2 py-0.5 rounded text-xs font-mono font-semibold border',
                    token.score >= 85 ? 'bg-success/10 border-success/20 text-success' :
                    token.score >= 70 ? 'bg-warning/10 border-warning/20 text-warning' :
                    'bg-danger/10 border-danger/20 text-danger'
                  )}>
                    {token.score}分
                  </div>
                  {token.liquidity >= cfg.minLiquidityUSD && (
                    <div className="px-2 py-0.5 rounded text-xs bg-success/10 text-success border border-success/20">
                      符合条件
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Config */}
        <div className="space-y-4">
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4">
            <div className="text-sm font-medium text-white">狙击参数</div>
            {[
              { label: '最小流动性 (USD)', key: 'minLiquidityUSD', min: 10000, max: 500000, step: 5000 },
              { label: '最大买入 (USD)', key: 'maxBuyUSD', min: 10, max: 1000, step: 10 },
              { label: '目标盈利 (%)', key: 'targetGainPct', min: 10, max: 200, step: 5 },
              { label: '止损线 (%)', key: 'stopLossPct', min: 5, max: 50, step: 5 },
            ].map(({ label, key, min, max, step }) => (
              <div key={key}>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-text-muted">{label}</span>
                  <span className={cn(
                    'font-mono',
                    key === 'stopLossPct' ? 'text-danger' :
                    key === 'targetGainPct' ? 'text-success' : 'text-white'
                  )}>
                    {(cfg as any)[key]}{key.includes('Pct') ? '%' : key.includes('USD') ? ' USD' : ''}
                  </span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={(cfg as any)[key]}
                  onChange={(e) =>
                    updateStrategyConfig('sniper', { [key]: Number(e.target.value) } as any)
                  }
                  className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
                />
              </div>
            ))}
          </div>

          {isRunning && (
            <div className="rounded-xl bg-success/5 border border-success/20 p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="text-sm text-success font-medium">狙击模式激活</span>
              </div>
              <div className="text-xs text-text-muted">监听新流动性添加事件...</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

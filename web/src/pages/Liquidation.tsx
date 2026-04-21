import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import { Play, Square, Zap, RefreshCw } from 'lucide-react'
import { cn, formatUSD, formatPercent } from '@/lib/utils'
import { useState } from 'react'

const MOCK_POSITIONS = [
  { protocol: 'Venus', user: '0xabc...111', collateral: 'BNB', debt: 'USDT', healthFactor: 1.02, debtUSD: 8400, bonus: 8.5 },
  { protocol: 'Alpaca', user: '0xdef...222', collateral: 'ETH', debt: 'BUSD', healthFactor: 1.05, debtUSD: 3200, bonus: 5.0 },
  { protocol: 'Venus', user: '0xghi...333', collateral: 'BTCB', debt: 'USDT', healthFactor: 0.98, debtUSD: 15600, bonus: 10.0 },
  { protocol: 'Cream', user: '0xjkl...444', collateral: 'CAKE', debt: 'BNB', healthFactor: 1.08, debtUSD: 1800, bonus: 6.5 },
]

export default function Liquidation() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['liquidation'] ?? false
  const cfg = strategyConfig.liquidation
  const [scanning, setScanning] = useState(false)

  const handleStartStop = () => {
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'liquidation' } })
    } else {
      wsClient.send({ type: 'start', payload: { strategy: 'liquidation', config: cfg } })
    }
  }

  const liquidatable = MOCK_POSITIONS.filter(
    (p) => p.healthFactor <= 1.1 && p.bonus >= cfg.minBonusPct && cfg.protocols.includes(p.protocol)
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">清算机器人</h2>
          <p className="text-xs text-text-muted mt-0.5">监控借贷协议抵押率，抢先执行清算获取奖励</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setScanning(true); setTimeout(() => setScanning(false), 2000) }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated transition-colors"
          >
            <RefreshCw className={cn('w-4 h-4', scanning && 'animate-spin')} />
            扫描头寸
          </button>
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
            {isRunning ? <Square className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
            {isRunning ? '停止' : '启动'}
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4">
          <div className="text-xs text-text-muted">可清算头寸</div>
          <div className="text-2xl font-mono font-semibold text-warning mt-1">{liquidatable.length}</div>
        </div>
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4">
          <div className="text-xs text-text-muted">最高奖励</div>
          <div className="text-2xl font-mono font-semibold text-success mt-1">
            {formatPercent(Math.max(...MOCK_POSITIONS.map(p => p.bonus)))}
          </div>
        </div>
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4">
          <div className="text-xs text-text-muted">监控协议</div>
          <div className="text-2xl font-mono font-semibold text-white mt-1">{cfg.protocols.length}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Position list */}
        <div className="lg:col-span-2 space-y-3">
          <div className="text-sm text-text-muted">危险头寸监控</div>
          {MOCK_POSITIONS.map((pos, i) => (
            <div
              key={i}
              className={cn(
                'rounded-xl bg-bg-surface border p-4',
                pos.healthFactor < 1 ? 'border-danger/30' :
                pos.healthFactor < 1.05 ? 'border-warning/30' : 'border-bg-border'
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-accent-dim text-accent text-xs border border-accent/20">{pos.protocol}</span>
                  <span className="font-mono text-xs text-text-muted">{pos.user}</span>
                </div>
                <div className={cn(
                  'px-2.5 py-1 rounded-lg text-xs font-mono font-semibold border',
                  pos.healthFactor < 1 ? 'bg-danger/10 border-danger/30 text-danger' :
                  pos.healthFactor < 1.05 ? 'bg-warning/10 border-warning/30 text-warning' :
                  'bg-bg-elevated border-bg-border text-text-muted'
                )}>
                  HF: {pos.healthFactor.toFixed(2)}
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div>
                  <div className="text-text-muted">抵押品</div>
                  <div className="font-mono text-white">{pos.collateral}</div>
                </div>
                <div>
                  <div className="text-text-muted">债务</div>
                  <div className="font-mono text-white">{pos.debt}</div>
                </div>
                <div>
                  <div className="text-text-muted">债务价值</div>
                  <div className="font-mono text-white">{formatUSD(pos.debtUSD)}</div>
                </div>
                <div>
                  <div className="text-text-muted">清算奖励</div>
                  <div className="font-mono text-success">{formatPercent(pos.bonus)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Config */}
        <div className="space-y-4">
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4">
            <div className="text-sm font-medium text-white">清算参数</div>
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-text-muted">最小清算奖励 (%)</span>
                <span className="font-mono text-success">{cfg.minBonusPct}%</span>
              </div>
              <input
                type="range"
                min={3}
                max={20}
                step={0.5}
                value={cfg.minBonusPct}
                onChange={(e) => updateStrategyConfig('liquidation', { minBonusPct: Number(e.target.value) })}
                className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
              />
            </div>
            <div>
              <div className="text-xs text-text-muted mb-2">监控协议</div>
              <div className="flex flex-wrap gap-2">
                {['Venus', 'Alpaca', 'Cream', 'Fortress'].map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      const current = cfg.protocols
                      const next = current.includes(p)
                        ? current.filter((x) => x !== p)
                        : [...current, p]
                      updateStrategyConfig('liquidation', { protocols: next })
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs border transition-colors',
                      cfg.protocols.includes(p)
                        ? 'bg-primary-dim border-primary/40 text-primary'
                        : 'border-bg-border text-text-muted hover:border-primary/30'
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

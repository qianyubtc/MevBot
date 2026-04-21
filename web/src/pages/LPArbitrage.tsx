import { useState } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import { Play, Square, RefreshCw, Droplets } from 'lucide-react'
import { cn, formatUSD, formatPercent } from '@/lib/utils'

const MOCK_POOLS = [
  { pair: 'BNB/USDT', dex: 'PancakeSwap', tvl: 48000000, apr: 12.4, fee: 0.25, score: 94, imbalance: 2.3 },
  { pair: 'ETH/BNB', dex: 'BiSwap', tvl: 22000000, apr: 18.7, fee: 0.1, score: 88, imbalance: 4.1 },
  { pair: 'CAKE/BNB', dex: 'PancakeSwap', tvl: 11000000, apr: 34.2, fee: 0.25, score: 81, imbalance: 6.8 },
  { pair: 'BUSD/USDT', dex: 'MDEX', tvl: 85000000, apr: 4.2, fee: 0.04, score: 76, imbalance: 0.8 },
  { pair: 'BTCB/ETH', dex: 'PancakeSwap', tvl: 16000000, apr: 9.8, fee: 0.25, score: 85, imbalance: 3.2 },
]

export default function LPArbitrage() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['lp'] ?? false
  const cfg = strategyConfig.lp
  const [scanning, setScanning] = useState(false)

  const handleStartStop = () => {
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'lp' } })
    } else {
      wsClient.send({ type: 'start', payload: { strategy: 'lp', config: cfg } })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">LP 套利</h2>
          <p className="text-xs text-text-muted mt-0.5">捕获流动性池价格失衡，执行再平衡套利</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setScanning(true); setTimeout(() => setScanning(false), 3000) }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated transition-colors"
          >
            <RefreshCw className={cn('w-4 h-4', scanning && 'animate-spin')} />
            扫描流动池
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
            {isRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isRunning ? '停止' : '启动'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pool list */}
        <div className="lg:col-span-2 space-y-3">
          <div className="text-sm text-text-muted">优质流动性池 ({MOCK_POOLS.length})</div>
          {MOCK_POOLS.filter((p) => p.tvl >= cfg.minTvlUSD).map((pool) => (
            <div
              key={pool.pair}
              className="rounded-xl bg-bg-surface border border-bg-border p-4 hover:border-primary/30 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Droplets className="w-4 h-4 text-accent" />
                  <div>
                    <div className="font-mono font-semibold text-white">{pool.pair}</div>
                    <div className="text-xs text-text-muted">{pool.dex} · {pool.fee}% 手续费</div>
                  </div>
                </div>
                <div className={cn(
                  'px-2 py-0.5 rounded text-xs font-mono font-semibold border',
                  pool.score >= 85 ? 'bg-success/10 border-success/20 text-success' :
                  pool.score >= 70 ? 'bg-warning/10 border-warning/20 text-warning' :
                  'bg-danger/10 border-danger/20 text-danger'
                )}>
                  {pool.score}分
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div>
                  <div className="text-text-muted">TVL</div>
                  <div className="font-mono text-white">{formatUSD(pool.tvl)}</div>
                </div>
                <div>
                  <div className="text-text-muted">APR</div>
                  <div className="font-mono text-success">{pool.apr}%</div>
                </div>
                <div>
                  <div className="text-text-muted">失衡度</div>
                  <div className={cn('font-mono', pool.imbalance > 3 ? 'text-warning' : 'text-text-dim')}>
                    {formatPercent(pool.imbalance)}
                  </div>
                </div>
                <div>
                  <div className="text-text-muted">状态</div>
                  <div className={cn('', pool.imbalance > 2 ? 'text-success' : 'text-text-muted')}>
                    {pool.imbalance > 2 ? '可套利' : '已平衡'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Config */}
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4 h-fit">
          <div className="text-sm font-medium text-white">策略参数</div>
          {[
            { label: '最小利润 (USD)', key: 'minProfitUSD', min: 5, max: 200, step: 5 },
            { label: '最大 Gas (Gwei)', key: 'maxGasGwei', min: 1, max: 30, step: 1 },
            { label: '最小 TVL (USD)', key: 'minTvlUSD', min: 50000, max: 5000000, step: 50000 },
          ].map(({ label, key, min, max, step }) => (
            <div key={key}>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-text-muted">{label}</span>
                <span className="font-mono text-white">{formatUSD((cfg as any)[key])}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={(cfg as any)[key]}
                onChange={(e) =>
                  updateStrategyConfig('lp', { [key]: Number(e.target.value) } as any)
                }
                className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

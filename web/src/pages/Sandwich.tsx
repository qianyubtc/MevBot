import { useState, useEffect } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import TokenCard from '@/components/TokenCard'
import type { Token } from '@/lib/ws'
import { Play, Square, Search, RefreshCw, Loader2, WifiOff } from 'lucide-react'
import { cn, formatUSD } from '@/lib/utils'

export default function Sandwich() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, tokens, runnerConnected, lastTokensAt } = useStore()
  const isRunning = activeStrategies['sandwich'] ?? false
  const cfg = strategyConfig.sandwich
  const tokenList: Token[] = tokens['sandwich'] ?? []
  const [selected, setSelected] = useState<Token | null>(null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => { setScanning(false) }, [lastTokensAt])

  const handleStartStop = () => {
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'sandwich' } })
    } else if (selected) {
      wsClient.send({
        type: 'start',
        payload: { strategy: 'sandwich', token: selected, config: cfg },
      })
    }
  }

  const handleScan = () => {
    if (!runnerConnected) return
    setScanning(true)
    wsClient.send({ type: 'scan', payload: { strategy: 'sandwich', params: cfg } })
    // Runner will respond with 'tokens' message; fallback timeout
    setTimeout(() => setScanning(false), 30000)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">夹子机器人</h2>
          <p className="text-xs text-text-muted mt-0.5">监听 Mempool 大额 Swap，前后夹击获利</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScan}
            disabled={scanning || !runnerConnected}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={cn('w-4 h-4', scanning && 'animate-spin')} />
            扫描币种
          </button>
          <button
            onClick={handleStartStop}
            disabled={(!selected && !isRunning) || !runnerConnected}
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
        {/* Token list */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-text-muted" />
            <span className="text-sm text-text-muted">
              {scanning ? '链上扫描中...' : `优质可夹币种 (${tokenList.length})`}
            </span>
            {tokenList.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-success/10 text-success border border-success/20">
                真实数据
              </span>
            )}
          </div>

          {/* Loading state */}
          {scanning && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-bg-surface border border-bg-border p-4 animate-pulse">
                  <div className="flex justify-between mb-3">
                    <div className="space-y-1.5">
                      <div className="h-4 w-16 bg-bg-elevated rounded" />
                      <div className="h-3 w-24 bg-bg-elevated rounded" />
                    </div>
                    <div className="h-6 w-12 bg-bg-elevated rounded" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[...Array(4)].map((_, j) => <div key={j} className="h-8 bg-bg-elevated rounded" />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!scanning && tokenList.length === 0 && (
            <div className="rounded-xl bg-bg-surface border border-bg-border p-12 text-center">
              {runnerConnected ? (
                <>
                  <Search className="w-8 h-8 text-text-muted mx-auto mb-3" />
                  <div className="text-sm text-text-muted mb-2">暂无扫描结果</div>
                  <div className="text-xs text-text-muted">点击「扫描币种」从链上获取真实数据</div>
                </>
              ) : (
                <>
                  <WifiOff className="w-8 h-8 text-text-muted mx-auto mb-3" />
                  <div className="text-sm text-text-muted mb-2">Runner 未连接</div>
                  <div className="text-xs text-text-muted">启动本地 Runner 后可扫描真实链上数据</div>
                </>
              )}
            </div>
          )}

          {/* Token grid */}
          {!scanning && tokenList.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {tokenList.sort((a, b) => b.score - a.score).map((token) => (
                <TokenCard
                  key={token.address}
                  token={token}
                  selected={selected?.address === token.address}
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}
        </div>

        {/* Config panel */}
        <div className="space-y-4">
          {/* Selected token */}
          {selected && (
            <div className="rounded-xl bg-primary-dim border border-primary/30 p-4">
              <div className="text-xs text-primary mb-1">已选择目标</div>
              <div className="font-mono font-semibold text-white">{selected.symbol}</div>
              <div className="text-xs text-text-muted">{selected.dex} · {formatUSD(selected.liquidity)} 流动性</div>
            </div>
          )}

          {/* Parameters */}
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4">
            <div className="text-sm font-medium text-white">策略参数</div>

            {[
              { label: '最小利润 (USD)', key: 'minProfitUSD', min: 1, max: 100, step: 1 },
              { label: '最大 Gas (Gwei)', key: 'maxGasGwei', min: 1, max: 50, step: 1 },
              { label: '最小流动性 (USD)', key: 'minLiquidityUSD', min: 10000, max: 1000000, step: 10000 },
            ].map(({ label, key, min, max, step }) => (
              <div key={key}>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-text-muted">{label}</span>
                  <span className="font-mono text-white">{(cfg as any)[key]}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={(cfg as any)[key]}
                  onChange={(e) =>
                    updateStrategyConfig('sandwich', { [key]: Number(e.target.value) } as any)
                  }
                  className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
                />
              </div>
            ))}

            <div>
              <div className="text-xs text-text-muted mb-2">目标 DEX</div>
              <div className="flex flex-wrap gap-2">
                {['PancakeSwap', 'BiSwap', 'BabySwap', 'MDEX'].map((dex) => (
                  <button
                    key={dex}
                    onClick={() => {
                      const current = cfg.targetDexes
                      const next = current.includes(dex)
                        ? current.filter((d) => d !== dex)
                        : [...current, dex]
                      updateStrategyConfig('sandwich', { targetDexes: next })
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs border transition-colors',
                      cfg.targetDexes.includes(dex)
                        ? 'bg-primary-dim border-primary/40 text-primary'
                        : 'border-bg-border text-text-muted hover:border-primary/30'
                    )}
                  >
                    {dex}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Running status */}
          {isRunning && (
            <div className="rounded-xl bg-success/5 border border-success/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="text-sm text-success font-medium">夹子运行中</span>
              </div>
              <div className="text-xs text-text-muted">正在监听 Mempool，等待夹击机会...</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import TokenCard from '@/components/TokenCard'
import type { Token } from '@/lib/ws'
import { Play, Square, Search, RefreshCw, ChevronRight } from 'lucide-react'
import { cn, formatUSD } from '@/lib/utils'

const MOCK_TOKENS: Token[] = [
  { address: '0xabc...111', symbol: 'CAKE', name: 'PancakeSwap Token', chain: 'BSC', liquidity: 2400000, volume24h: 850000, score: 92, dex: 'PancakeSwap', pairAddress: '0x...' },
  { address: '0xabc...222', symbol: 'DOGE2', name: 'Doge2.0', chain: 'BSC', liquidity: 180000, volume24h: 320000, score: 78, dex: 'BiSwap', pairAddress: '0x...' },
  { address: '0xabc...333', symbol: 'PEPE', name: 'PepeCoin', chain: 'BSC', liquidity: 95000, volume24h: 210000, score: 65, dex: 'PancakeSwap', pairAddress: '0x...' },
  { address: '0xabc...444', symbol: 'SHIB2', name: 'Shib 2.0', chain: 'BSC', liquidity: 440000, volume24h: 670000, score: 85, dex: 'BiSwap', pairAddress: '0x...' },
  { address: '0xabc...555', symbol: 'FLOKI', name: 'FlokiInu', chain: 'BSC', liquidity: 120000, volume24h: 190000, score: 70, dex: 'PancakeSwap', pairAddress: '0x...' },
  { address: '0xabc...666', symbol: 'BABYDOGE', name: 'Baby Doge Coin', chain: 'BSC', liquidity: 310000, volume24h: 480000, score: 81, dex: 'PancakeSwap', pairAddress: '0x...' },
]

export default function Sandwich() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, tokens, runnerConnected } = useStore()
  const isRunning = activeStrategies['sandwich'] ?? false
  const cfg = strategyConfig.sandwich
  const tokenList: Token[] = tokens['sandwich'] ?? MOCK_TOKENS
  const [selected, setSelected] = useState<Token | null>(null)
  const [scanning, setScanning] = useState(false)

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
    setScanning(true)
    wsClient.send({ type: 'scan', payload: { strategy: 'sandwich', params: cfg } })
    setTimeout(() => setScanning(false), 3000)
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
            <span className="text-sm text-text-muted">优质可夹币种 ({tokenList.length})</span>
          </div>
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

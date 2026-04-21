import { useState } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import TokenCard from '@/components/TokenCard'
import type { Token } from '@/lib/ws'
import { Play, Square, RefreshCw, ArrowLeftRight } from 'lucide-react'
import { cn, formatUSD, formatPercent } from '@/lib/utils'

const MOCK_TOKENS: Token[] = [
  { address: '0xarb...111', symbol: 'BNB', name: 'BNB', chain: 'BSC', liquidity: 15000000, volume24h: 4200000, score: 95, dex: 'PancakeSwap↔BiSwap', pairAddress: '0x...' },
  { address: '0xarb...222', symbol: 'ETH', name: 'Ethereum', chain: 'BSC', liquidity: 8500000, volume24h: 2100000, score: 90, dex: 'BiSwap↔MDEX', pairAddress: '0x...' },
  { address: '0xarb...333', symbol: 'USDT', name: 'Tether', chain: 'BSC', liquidity: 22000000, volume24h: 9800000, score: 88, dex: 'PancakeSwap↔MDEX', pairAddress: '0x...' },
  { address: '0xarb...444', symbol: 'BUSD', name: 'Binance USD', chain: 'BSC', liquidity: 18000000, volume24h: 6700000, score: 85, dex: 'PancakeSwap↔BiSwap', pairAddress: '0x...' },
]

const SPREAD_MOCK = [
  { pair: 'BNB/USDT', dexA: 'PancakeSwap', dexB: 'BiSwap', priceA: 580.24, priceB: 581.92, spread: 0.29 },
  { pair: 'ETH/BNB', dexA: 'BiSwap', dexB: 'MDEX', priceA: 4.912, priceB: 4.939, spread: 0.55 },
  { pair: 'CAKE/USDT', dexA: 'MDEX', dexB: 'BabySwap', priceA: 2.184, priceB: 2.197, spread: 0.60 },
]

export default function Arbitrage() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['arbitrage'] ?? false
  const cfg = strategyConfig.arbitrage
  const [selected, setSelected] = useState<Token | null>(null)
  const [scanning, setScanning] = useState(false)

  const handleStartStop = () => {
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'arbitrage' } })
    } else {
      wsClient.send({ type: 'start', payload: { strategy: 'arbitrage', token: selected, config: cfg } })
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">套利机器人</h2>
          <p className="text-xs text-text-muted mt-0.5">跨 DEX 价差套利，零风险捕获价格偏差</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setScanning(true); setTimeout(() => setScanning(false), 3000) }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated transition-colors"
          >
            <RefreshCw className={cn('w-4 h-4', scanning && 'animate-spin')} />
            扫描价差
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

      {/* Live spread table */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-accent" />
          <span className="text-sm font-medium text-white">实时价差监控</span>
        </div>
        <div className="divide-y divide-bg-border">
          {SPREAD_MOCK.map((row) => (
            <div key={row.pair} className="px-4 py-3 flex items-center gap-4">
              <div className="w-28 font-mono text-sm text-white">{row.pair}</div>
              <div className="flex-1 flex items-center gap-2 text-xs text-text-muted">
                <span>{row.dexA}</span>
                <span className="font-mono text-white">${row.priceA}</span>
                <ArrowLeftRight className="w-3 h-3" />
                <span>{row.dexB}</span>
                <span className="font-mono text-white">${row.priceB}</span>
              </div>
              <div className={cn(
                'font-mono text-sm font-semibold',
                row.spread >= cfg.minSpreadPct ? 'text-success' : 'text-text-muted'
              )}>
                {formatPercent(row.spread)}
              </div>
              <div className={cn(
                'px-2 py-0.5 rounded text-xs',
                row.spread >= cfg.minSpreadPct
                  ? 'bg-success/10 text-success'
                  : 'bg-bg-elevated text-text-muted'
              )}>
                {row.spread >= cfg.minSpreadPct ? '可套利' : '价差不足'}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Token selection */}
        <div className="lg:col-span-2">
          <div className="text-sm text-text-muted mb-3">优质套利币种</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MOCK_TOKENS.map((token) => (
              <TokenCard
                key={token.address}
                token={token}
                selected={selected?.address === token.address}
                onSelect={setSelected}
              />
            ))}
          </div>
        </div>

        {/* Config */}
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4 h-fit">
          <div className="text-sm font-medium text-white">策略参数</div>
          {[
            { label: '最小利润 (USD)', key: 'minProfitUSD', min: 1, max: 50, step: 0.5 },
            { label: '最大 Gas (Gwei)', key: 'maxGasGwei', min: 1, max: 30, step: 1 },
            { label: '最小价差 (%)', key: 'minSpreadPct', min: 0.1, max: 3, step: 0.1 },
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
                  updateStrategyConfig('arbitrage', { [key]: Number(e.target.value) } as any)
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

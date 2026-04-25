import { useState, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import StrategyRpcCard from '@/components/StrategyRpcCard'
import { Play, Square, Loader2, WifiOff, AlertTriangle, ArrowLeftRight, Activity, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

// Default whitelist mirrors runner/src/strategies/arbitrage.ts. Keep in sync.
// Empty `tokens` in config ⇒ runner uses this same list, so what you see is
// what you get.
const DEFAULT_WHITELIST = [
  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE'  },
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT'  },
  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD'  },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH'   },
  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB'  },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC'  },
  { address: '0xfb6115445Bff7b52FeB98650C87f44907E58f802', symbol: 'AAVE'  },
  { address: '0xCC42724C6683B7E57334c4E856f4c9965ED682bD', symbol: 'MATIC' },
] as const

interface OppLine { id: string; sym: string; net: number; t: number }

function OppFeed() {
  const [lines, setLines] = useState<OppLine[]>([])
  useEffect(() => wsClient.on((msg) => {
    if (msg.type !== 'opportunity') return
    const p = msg.payload ?? {}
    if (p.strategy !== 'arbitrage') return
    setLines(prev => [{ id: String(p.id), sym: String(p.token ?? '?'), net: Number(p.profitUSD ?? 0), t: Date.now() }, ...prev].slice(0, 8))
  }), [])
  return (
    <div className="rounded-lg bg-bg-elevated border border-bg-border p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 mb-2">
        <Activity className="w-3 h-3 text-primary" />
        <span className="text-xs text-text-muted">实时套利机会</span>
      </div>
      {lines.length === 0 ? (
        <div className="text-xs text-text-muted opacity-40 font-mono py-1">等待跨 DEX 价差出现 …</div>
      ) : (
        lines.map(l => (
          <div key={l.id} className="flex items-center justify-between font-mono text-xs">
            <span className="text-white">{l.sym}</span>
            <span className={l.net >= 0 ? 'text-success' : 'text-danger'}>
              {l.net >= 0 ? '+' : ''}${l.net.toFixed(2)}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export default function Arbitrage() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['arbitrage'] ?? false
  const cfg = strategyConfig.arbitrage

  const [startError, setStartError] = useState('')
  const errClearer = useRef<number | null>(null)

  useEffect(() => {
    if (!startError) return
    if (errClearer.current) window.clearTimeout(errClearer.current)
    errClearer.current = window.setTimeout(() => setStartError(''), 5000)
    return () => { if (errClearer.current) window.clearTimeout(errClearer.current) }
  }, [startError])

  useEffect(() => wsClient.on((msg) => {
    if (msg.type === 'error' && typeof msg.payload?.message === 'string') {
      const m: string = msg.payload.message
      if (m.includes('Arbitrage') || m.includes('套利')) setStartError(m)
    }
  }), [])

  // Selected = (cfg.tokens ?? DEFAULT_WHITELIST). Toggle adds/removes.
  const selectedAddresses = new Set((cfg.tokens && cfg.tokens.length > 0
    ? cfg.tokens
    : DEFAULT_WHITELIST
  ).map(t => t.address.toLowerCase()))

  const toggleToken = (addr: string, sym: string) => {
    const current = (cfg.tokens && cfg.tokens.length > 0 ? cfg.tokens : [...DEFAULT_WHITELIST])
    const lc = addr.toLowerCase()
    const next = current.some(t => t.address.toLowerCase() === lc)
      ? current.filter(t => t.address.toLowerCase() !== lc)
      : [...current, { address: addr, symbol: sym }]
    updateStrategyConfig('arbitrage', { tokens: next })
  }

  const start = () => {
    if (!runnerConnected) { setStartError('Runner 未连接，请先启动桌面端'); return }
    if (selectedAddresses.size === 0) { setStartError('至少选一个 token'); return }
    setStartError('')
    wsClient.send({ type: 'start', payload: { strategy: 'arbitrage', config: cfg } })
  }
  const stop = () => wsClient.send({ type: 'stop', payload: { strategy: 'arbitrage' } })

  const sliderParams = [
    { label: '最小利润 (USD)',     key: 'minProfitUSD',       min: 0.1, max: 20,    step: 0.1, unit: '$'    },
    { label: '执行金额 (USD)',      key: 'executionAmountUSD', min: 5,   max: 2000,  step: 5,   unit: '$'    },
    { label: '最大 Gas (Gwei)',     key: 'maxGasGwei',         min: 1,   max: 50,    step: 1,   unit: 'Gwei' },
    { label: '滑点容忍 (%)',        key: 'slippageTolerance',  min: 0.1, max: 5,     step: 0.1, unit: '%'    },
    { label: '最小跨 DEX 价差 (%)', key: 'minSpreadPct',       min: 0.1, max: 3,     step: 0.1, unit: '%'    },
  ] as const

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold text-white">跨 DEX 套利</h1>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary">
              多 token · Puissant 私有打包
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            每个区块扫一遍白名单 token 在 Pancake / BiSwap 的价差，挑最好的那个直接打 bundle。
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!runnerConnected && (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <WifiOff className="w-3.5 h-3.5" /> Runner 未连接
            </span>
          )}
          {isRunning ? (
            <button onClick={stop}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-danger/20 border border-danger/40 text-danger hover:bg-danger/30 transition-colors text-sm font-medium">
              <Square className="w-3.5 h-3.5" /> 停止
            </button>
          ) : (
            <button onClick={start} disabled={!runnerConnected}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-bg hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm font-medium">
              {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              启动
            </button>
          )}
        </div>
      </div>

      {startError && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/30 text-danger text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="break-all">{startError}</span>
        </div>
      )}

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-bg-border text-text-muted text-xs leading-relaxed">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          原理：同一 token 在 PancakeSwap 和 BiSwap 上的瞬时价格不同步（任意一边发生大单都会让另一边滞后几秒）。
          策略每出一个区块就采一次价，差距大于阈值就用 Puissant 私有 bundle 同时买/卖。
          <span className="text-primary/80"> bundle 失败不亏 gas</span> — 中继发现亏损会直接丢弃。
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">监控的 token</span>
              <span className="text-xs text-text-muted">
                已选 <span className="font-mono text-primary">{selectedAddresses.size}</span> / {DEFAULT_WHITELIST.length}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {DEFAULT_WHITELIST.map(t => {
                const on = selectedAddresses.has(t.address.toLowerCase())
                return (
                  <button key={t.address}
                    onClick={() => toggleToken(t.address, t.symbol)}
                    className={cn(
                      'px-3 py-2 rounded-lg text-xs font-mono transition-colors',
                      on
                        ? 'bg-primary/10 border border-primary/40 text-primary'
                        : 'bg-bg-elevated border border-bg-border text-text-dim hover:border-primary/20'
                    )}>
                    {t.symbol}
                  </button>
                )
              })}
            </div>
            <div className="text-xs text-text-muted opacity-60 pt-1 border-t border-bg-border leading-relaxed">
              这些都是 BSC 上同时在 Pancake + BiSwap 都有活跃池子的主流币。点亮即纳入扫描，关掉则跳过。
            </div>
          </div>

          <OppFeed />
        </div>

        <div className="space-y-4">
          <StrategyRpcCard
            strategy="arbitrage"
            presets={[
              { label: 'BSC PublicNode', url: 'https://bsc-rpc.publicnode.com' },
              { label: 'Ankr',           url: 'https://rpc.ankr.com/bsc'        },
              { label: '48 Club RPC',    url: 'https://rpc-bsc.48.club'         },
            ]}
          />

          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4">
            <div className="text-sm font-medium text-white">策略参数</div>
            {sliderParams.map(({ label, key, min, max, step, unit }) => {
              const val = (cfg as any)[key] as number
              return (
                <div key={key}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-text-muted">{label}</span>
                    <span className="font-mono text-white">
                      {key === 'executionAmountUSD'
                        ? `$${val >= 1000 ? (val / 1000).toFixed(0) + 'K' : val}`
                        : key === 'minProfitUSD' ? `$${val}` : `${val}${unit}`}
                    </span>
                  </div>
                  <input type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => updateStrategyConfig('arbitrage', { [key]: Number(e.target.value) } as any)}
                    className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary" />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

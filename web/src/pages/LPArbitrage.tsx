import { useState, useEffect } from 'react'
import { wsClient } from '@/lib/ws'
import type { LpPool } from '@/lib/ws'
import { useStore } from '@/store'
import { Droplets, RefreshCw, ExternalLink, WifiOff, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── LP Yield Monitor ────────────────────────────────────────────────────
//
// v1: read-only TVL ranker for the top BSC LP pools. Auto-execution of LP
// arbitrage (JIT liquidity, LP token mispricing) is deferred to a later
// phase — at retail capital it's mostly vapor without flash loans + relay
// integration. This page surfaces the data so users can pick pools to
// manually LP into; the runner exposes `query_lp_pools` for the data feed.

function fmtUSD(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$—'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

export default function LPArbitrage() {
  const { runnerConnected } = useStore()
  const [pools, setPools] = useState<LpPool[]>([])
  const [bnbPrice, setBnbPrice] = useState(0)
  const [loading, setLoading] = useState(false)
  const [lastTs, setLastTs] = useState(0)

  useEffect(() => wsClient.on((msg) => {
    if (msg.type !== 'lp_pools') return
    setPools([...msg.payload.pools].sort((a, b) => b.tvlUSD - a.tvlUSD))
    setBnbPrice(msg.payload.bnbPrice)
    setLastTs(msg.payload.ts)
    setLoading(false)
  }), [])

  // Auto-fetch on mount when runner is connected.
  useEffect(() => {
    if (!runnerConnected) return
    setLoading(true)
    wsClient.send({ type: 'query_lp_pools', payload: {} })
  }, [runnerConnected])

  const refresh = () => {
    if (!runnerConnected) return
    setLoading(true)
    wsClient.send({ type: 'query_lp_pools', payload: {} })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Droplets className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold text-white">LP 池监控</h1>
            <span className="px-2 py-0.5 rounded-full bg-warning/10 border border-warning/20 text-xs text-warning">
              只读 · 阶段 1
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            扫 PancakeSwap 上的头部 LP 池，按 TVL 排序。链上数据现采，BNB 价格实时。
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!runnerConnected && (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <WifiOff className="w-3.5 h-3.5" /> Runner 未连接
            </span>
          )}
          {bnbPrice > 0 && (
            <span className="text-xs text-text-muted font-mono">
              BNB = ${bnbPrice.toFixed(2)}
            </span>
          )}
          <button onClick={refresh} disabled={!runnerConnected || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-elevated border border-bg-border text-sm text-text-muted hover:text-primary hover:border-primary/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-bg-border text-text-muted text-xs leading-relaxed">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          这一版是 <span className="text-white">LP 监控板</span> — 仅展示池子规模信息，不下单。
          自动执行的 LP 套利（JIT 流动性 / LP token 错价）放到下一阶段做，
          因为零售资金量做这个收益和闪电贷成本拉锯太紧，没把握我不上。
          目前你可以根据 TVL 排名手动决定去 PancakeSwap 上 LP 哪个池子。
        </span>
      </div>

      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated text-xs text-text-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">池子</th>
              <th className="text-right px-4 py-2 font-medium">TVL</th>
              <th className="text-right px-4 py-2 font-medium">BNB 储备</th>
              <th className="text-right px-4 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {pools.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-text-muted">
                  {runnerConnected ? '加载中 …' : '等待 Runner 连接 …'}
                </td>
              </tr>
            ) : pools.map((p, i) => (
              <tr key={p.pair} className="border-t border-bg-border hover:bg-bg-elevated/40">
                <td className="px-4 py-3 text-text-dim font-mono">{i + 1}</td>
                <td className="px-4 py-3 text-white font-medium">{p.sym}</td>
                <td className="px-4 py-3 text-right font-mono text-primary">
                  {p.error ? <span className="text-danger">读取失败</span> : fmtUSD(p.tvlUSD)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-text-muted">
                  {p.error ? '—' : `${p.reserveBNB.toFixed(2)} BNB`}
                </td>
                <td className="px-4 py-3 text-right">
                  <a href={`https://pancakeswap.finance/info/v2/pair/${p.pair}`}
                     target="_blank" rel="noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary">
                    Pancake <ExternalLink className="w-3 h-3" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lastTs > 0 && (
        <div className="text-xs text-text-muted text-right">
          最近一次刷新: {new Date(lastTs).toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}

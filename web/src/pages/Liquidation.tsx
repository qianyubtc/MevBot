import { useState, useEffect, useMemo } from 'react'
import { wsClient } from '@/lib/ws'
import type { VenusAccount } from '@/lib/ws'
import { useStore } from '@/store'
import { Gavel, RefreshCw, ExternalLink, WifiOff, Info, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Venus Liquidation Watchlist ─────────────────────────────────────────
//
// v1: read-only Venus account health monitor. The user pastes addresses
// they're tracking (max 50 / call), we ping Venus Comptroller for each
// account's liquidity/shortfall, render ranked by closest-to-liquidation.
// Auto-execution requires flashloan wiring + Comptroller.liquidateBorrow
// integration — deferred. This page is a signal feed.

const STORAGE_KEY = 'mevbot.liquidation.watchlist'

function parseAddresses(raw: string): string[] {
  return Array.from(new Set(
    raw.split(/[\s,]+/)
       .map(s => s.trim())
       .filter(s => /^0x[a-fA-F0-9]{40}$/.test(s))
  )).slice(0, 50)
}

function fmtUSD(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}

type Tier = 'liquidatable' | 'risky' | 'healthy'

function tierOf(a: VenusAccount): Tier {
  if (a.shortfall && a.shortfall > 0) return 'liquidatable'
  if (a.liquidity !== undefined && a.liquidity < 50) return 'risky'
  return 'healthy'
}

const tierStyle: Record<Tier, { label: string; cls: string }> = {
  liquidatable: { label: '可清算', cls: 'bg-danger/10 border-danger/30 text-danger'   },
  risky:        { label: '危险',   cls: 'bg-warning/10 border-warning/30 text-warning' },
  healthy:      { label: '健康',   cls: 'bg-success/10 border-success/30 text-success' },
}

export default function Liquidation() {
  const { runnerConnected } = useStore()
  const [raw, setRaw] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [accounts, setAccounts] = useState<VenusAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [lastTs, setLastTs] = useState(0)

  const addresses = useMemo(() => parseAddresses(raw), [raw])

  useEffect(() => wsClient.on((msg) => {
    if (msg.type !== 'venus_health') return
    const sorted = [...msg.payload.accounts].sort((a, b) => {
      const sa = a.shortfall ?? 0, sb = b.shortfall ?? 0
      if (sa !== sb) return sb - sa
      const la = a.liquidity ?? Infinity, lb = b.liquidity ?? Infinity
      return la - lb
    })
    setAccounts(sorted)
    setLastTs(msg.payload.ts)
    setLoading(false)
  }), [])

  const query = () => {
    if (!runnerConnected || addresses.length === 0) return
    localStorage.setItem(STORAGE_KEY, raw)
    setLoading(true)
    wsClient.send({ type: 'query_venus_health', payload: { addresses } })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gavel className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold text-white">清算监控</h1>
            <span className="px-2 py-0.5 rounded-full bg-warning/10 border border-warning/20 text-xs text-warning">
              只读 · 阶段 1
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            把你想盯的 Venus 借贷账户贴进来 — 实时查 Comptroller 的健康度，shortfall &gt; 0 即可清算。
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!runnerConnected && (
            <span className="flex items-center gap-1.5 text-xs text-warning">
              <WifiOff className="w-3.5 h-3.5" /> Runner 未连接
            </span>
          )}
          <button onClick={query} disabled={!runnerConnected || loading || addresses.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-bg hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm font-medium">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            查询 ({addresses.length})
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-bg-border text-text-muted text-xs leading-relaxed">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          这一版只看不打 — 需要清算时你自己上 Venus app 触发，或留着等下一阶段接闪电贷自动 <span className="font-mono">liquidateBorrow</span>。
          地址可以从 <a className="text-primary hover:underline" href="https://app.venus.io/governance" target="_blank" rel="noreferrer">Venus Analytics</a> 或
          BscScan 扫已借款的 vToken 持有人。每次最多查 50 个。
        </span>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/30 text-warning/90 text-xs leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
        <span>
          <span className="font-medium">风险提醒：</span>
          清算是<span className="text-warning"> 抢跑生意 </span>—
          人肉手动几乎抢不过链上守护机器人，本页面更适合当作研究 / 风控盯盘工具，不是赚钱产品。
        </span>
      </div>

      <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-2">
        <label className="text-xs text-text-muted">观察列表（每行一个地址，逗号 / 空格也行）</label>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={4}
          placeholder="0x...&#10;0x..."
          className="w-full bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-xs font-mono text-white placeholder:text-text-dim focus:outline-none focus:border-primary/50 resize-none" />
        <div className="text-xs text-text-muted">
          已识别 <span className="font-mono text-white">{addresses.length}</span> 个有效地址
          {addresses.length >= 50 && <span className="text-warning"> · 已达上限 50</span>}
        </div>
      </div>

      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-elevated text-xs text-text-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">状态</th>
              <th className="text-left px-4 py-2 font-medium">地址</th>
              <th className="text-right px-4 py-2 font-medium">健康余额</th>
              <th className="text-right px-4 py-2 font-medium">Shortfall</th>
              <th className="text-right px-4 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-text-muted">
                  {!runnerConnected ? '等待 Runner 连接 …' : addresses.length === 0 ? '上面贴几个地址，点查询' : '点上方"查询"按钮拉取数据'}
                </td>
              </tr>
            ) : accounts.map((a) => {
              const tier = tierOf(a)
              const style = tierStyle[tier]
              return (
                <tr key={a.address} className="border-t border-bg-border hover:bg-bg-elevated/40">
                  <td className="px-4 py-3">
                    <span className={cn('px-2 py-0.5 rounded-full border text-xs', style.cls)}>
                      {a.error ? '出错' : style.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white">
                    {a.address.slice(0, 10)}…{a.address.slice(-6)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-text-muted">
                    {a.error ? <span className="text-danger">{a.error.slice(0, 24)}</span> : fmtUSD(a.liquidity)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    <span className={a.shortfall && a.shortfall > 0 ? 'text-danger' : 'text-text-muted'}>
                      {a.error ? '—' : fmtUSD(a.shortfall)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <a href={`https://bscscan.com/address/${a.address}`}
                       target="_blank" rel="noreferrer"
                       className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary">
                      BscScan <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                </tr>
              )
            })}
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

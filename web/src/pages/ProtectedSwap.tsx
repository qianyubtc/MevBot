import { useState, useEffect } from 'react'
import { wsClient } from '@/lib/ws'
import { useStore } from '@/store'
import { ShieldCheck, WifiOff, Info, AlertTriangle, Loader2, CheckCircle2, XCircle, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── MEV-Protected Swap ──────────────────────────────────────────────────
//
// Single-tx swap routed through 48 Club Puissant bundle relay so the trade
// never touches the public mempool. Sandwich/front-run bots can't see it.
// Failed bundles cost zero gas (relay drops, doesn't include).
//
// This is a **utility** page — not a strategy. It's for the user to
// occasionally swap with privacy, e.g. exiting a large position without
// being sniped, or buying a thinly-traded token without being front-run.

type SwapStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; txHash: string; bundleId: string | null }
  | { kind: 'fail'; error: string }

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

export default function ProtectedSwap() {
  const { runnerConnected } = useStore()
  const [token, setToken] = useState('')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('0.05')
  const [slippagePct, setSlippagePct] = useState(1)
  const [gasGwei, setGasGwei] = useState(5)
  const [status, setStatus] = useState<SwapStatus>({ kind: 'idle' })

  const tokenValid = ADDR_RE.test(token.trim())
  const amountNum = Number(amount)
  const amountValid = Number.isFinite(amountNum) && amountNum > 0
  const canSubmit = runnerConnected && tokenValid && amountValid && status.kind !== 'pending'

  useEffect(() => wsClient.on((msg) => {
    if (msg.type !== 'protected_swap_result') return
    const p = msg.payload
    if (p.ok) {
      setStatus({ kind: 'ok', txHash: p.txHash ?? '', bundleId: p.bundleId ?? null })
    } else {
      setStatus({ kind: 'fail', error: p.error ?? '未知错误' })
    }
  }), [])

  const submit = () => {
    if (!canSubmit) return
    setStatus({ kind: 'pending' })
    wsClient.send({
      type: 'protected_swap',
      payload: {
        token: token.trim(),
        side,
        amount: amountNum,
        slippagePct,
        gasGwei,
      },
    })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold text-white">保护下单</h1>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary">
              Puissant 私有打包
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            把单笔买卖通过 48 Club Puissant bundle 提交 — 公开 mempool 看不到，夹子机器人无法夹你。
          </p>
        </div>
        {!runnerConnected && (
          <span className="flex items-center gap-1.5 text-xs text-warning">
            <WifiOff className="w-3.5 h-3.5" /> Runner 未连接
          </span>
        )}
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-bg-border text-text-muted text-xs leading-relaxed">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          原理：bundle 整包提交到 48 Club 验证人，不进公开 mempool。
          中继发现 tx 会回滚或者打不进就直接丢，<span className="text-primary/80">不上链就不烧 gas</span>。
          适用场景：大额买卖怕被夹、刚上线的 token 怕被狙击、想悄悄进出仓位。
          路由用 <span className="font-mono">PancakeSwap V2</span>，仅支持 BNB ↔ token。
        </span>
      </div>

      <div className="rounded-xl bg-bg-surface border border-bg-border p-5 space-y-5">
        {/* Side toggle */}
        <div>
          <label className="text-xs text-text-muted mb-2 block">方向</label>
          <div className="flex gap-2">
            {(['buy', 'sell'] as const).map(s => (
              <button key={s} onClick={() => setSide(s)}
                className={cn(
                  'flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors border',
                  side === s
                    ? s === 'buy'
                      ? 'bg-success/10 border-success/40 text-success'
                      : 'bg-danger/10 border-danger/40 text-danger'
                    : 'bg-bg-elevated border-bg-border text-text-muted hover:border-primary/20'
                )}>
                {s === 'buy' ? '买入 (BNB → Token)' : '卖出 (Token → BNB)'}
              </button>
            ))}
          </div>
        </div>

        {/* Token CA */}
        <div>
          <label className="text-xs text-text-muted mb-2 block">Token 合约地址</label>
          <input type="text" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="0x..."
            className={cn(
              'w-full bg-bg-elevated border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-text-dim focus:outline-none transition-colors',
              token === '' ? 'border-bg-border focus:border-primary/50'
              : tokenValid ? 'border-success/30 focus:border-success/50'
              : 'border-danger/30 focus:border-danger/50'
            )} />
          {token !== '' && !tokenValid && (
            <div className="text-xs text-danger mt-1">不是有效的 BSC 地址</div>
          )}
        </div>

        {/* Amount */}
        <div>
          <label className="text-xs text-text-muted mb-2 block">
            数量{' '}
            <span className="text-text-dim">
              ({side === 'buy' ? 'BNB' : '输入要卖出的 token 数量'})
            </span>
          </label>
          <input type="text" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={side === 'buy' ? '0.1' : '1000000'}
            className="w-full bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-text-dim focus:outline-none focus:border-primary/50" />
        </div>

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-text-muted">滑点容忍</span>
              <span className="font-mono text-white">{slippagePct.toFixed(1)}%</span>
            </div>
            <input type="range" min={0.1} max={10} step={0.1} value={slippagePct}
              onChange={(e) => setSlippagePct(Number(e.target.value))}
              className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary" />
          </div>
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-text-muted">Gas 上限</span>
              <span className="font-mono text-white">{gasGwei} Gwei</span>
            </div>
            <input type="range" min={1} max={20} step={1} value={gasGwei}
              onChange={(e) => setGasGwei(Number(e.target.value))}
              className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary" />
          </div>
        </div>

        <button onClick={submit} disabled={!canSubmit}
          className={cn(
            'w-full px-4 py-3 rounded-lg text-sm font-medium transition-colors',
            'bg-primary text-bg hover:bg-primary-hover',
            'disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2'
          )}>
          {status.kind === 'pending' ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> 提交 bundle 中 …</>
          ) : (
            <><ShieldCheck className="w-4 h-4" /> 通过 Puissant 提交</>
          )}
        </button>

        {/* Result */}
        {status.kind === 'ok' && (
          <div className="px-3 py-3 rounded-lg bg-success/10 border border-success/30 text-success text-sm space-y-1">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4" /> Bundle 已提交到中继
            </div>
            <div className="text-xs text-success/80 font-mono break-all">
              tx: {status.txHash}
              {' · '}
              <a href={`https://bscscan.com/tx/${status.txHash}`} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-0.5 underline hover:no-underline">
                BscScan <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="text-[10px] text-success/60 leading-relaxed">
              中继接受不等于上链 — 30 秒内若未被打包，bundle 自动作废，钱不动。
            </div>
          </div>
        )}
        {status.kind === 'fail' && (
          <div className="px-3 py-3 rounded-lg bg-danger/10 border border-danger/30 text-danger text-sm">
            <div className="flex items-start gap-2">
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="break-all">{status.error}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/30 text-warning/90 text-xs leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-warning" />
        <span>
          <span className="font-medium">提示：</span>
          首次卖出某个 token 会自动追加一笔 approve 进 bundle，gas 会比常规多一些。
          币种没有 PancakeSwap V2 流动性的会直接拒绝（V3-only 的 token 暂不支持，下个版本接）。
        </span>
      </div>
    </div>
  )
}

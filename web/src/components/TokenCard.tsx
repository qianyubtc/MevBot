import { cn, formatUSD, shortenAddress } from '@/lib/utils'
import type { Token } from '@/lib/ws'
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'

interface Props {
  token: Token
  onSelect?: (token: Token) => void
  selected?: boolean
  running?: boolean   // true = this token is the active sandwich target
}

const SCORE_COLOR = (s: number) => s >= 80 ? 'text-success' : s >= 60 ? 'text-warning' : 'text-danger'
const SCORE_BG    = (s: number) => s >= 80 ? 'bg-success/10 border-success/20' : s >= 60 ? 'bg-warning/10 border-warning/20' : 'bg-danger/10 border-danger/20'

function SafetyBadge({ token }: { token: Token }) {
  if (token.isHoneypot) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-danger/10 border border-danger/30 text-danger">
        <ShieldX className="w-3 h-3" />
        貔貅
      </span>
    )
  }
  const safety = token.safetyScore ?? 100
  if (safety >= 80) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-success/10 border border-success/20 text-success">
        <ShieldCheck className="w-3 h-3" />
        安全
      </span>
    )
  }
  if (safety >= 50) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-warning/10 border border-warning/20 text-warning">
        <ShieldAlert className="w-3 h-3" />
        注意
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-danger/10 border border-danger/20 text-danger">
      <ShieldAlert className="w-3 h-3" />
      风险
    </span>
  )
}

export default function TokenCard({ token, onSelect, selected, running }: Props) {
  const score = Math.round(token.score)
  const hasSafety = token.safetyScore !== undefined

  return (
    <div
      onClick={() => onSelect?.(token)}
      className={cn(
        'rounded-xl border p-4 cursor-pointer transition-all',
        running
          ? 'bg-success/5 border-success/40 hover:border-success/60 ring-1 ring-success/20'
          : selected
            ? 'bg-primary-dim border-primary/40 hover:border-primary/60'
            : 'bg-bg-surface border-bg-border hover:border-primary/40',
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <div className="font-mono font-semibold text-white text-sm">{token.symbol}</div>
            {running && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-success/15 border border-success/30 text-success">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse inline-block" />
                运行中
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">{token.name}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {hasSafety && <SafetyBadge token={token} />}
          <div className={cn('px-2 py-0.5 rounded-md border text-xs font-mono font-semibold', SCORE_BG(score), SCORE_COLOR(score))}>
            {score}
          </div>
        </div>
      </div>

      {/* Tax / safety row */}
      {hasSafety && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {token.buyTax !== undefined && token.buyTax > 0 && (
            <span className="text-xs text-text-muted">
              买税 <span className={cn('font-mono', token.buyTax > 10 ? 'text-danger' : 'text-warning')}>{token.buyTax.toFixed(1)}%</span>
            </span>
          )}
          {token.sellTax !== undefined && token.sellTax > 0 && (
            <span className="text-xs text-text-muted">
              卖税 <span className={cn('font-mono', token.sellTax > 10 ? 'text-danger' : 'text-warning')}>{token.sellTax.toFixed(1)}%</span>
            </span>
          )}
          {token.lpLocked && (
            <span className="text-xs text-success">🔒LP锁仓</span>
          )}
          {token.ownerRenounced && (
            <span className="text-xs text-success">✓弃权</span>
          )}
          {token.flags && token.flags.length > 0 && (
            <span className="text-xs text-danger truncate max-w-[120px]" title={token.flags.join(', ')}>
              ⚠ {token.flags[0]}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-text-muted">流动性</div>
          <div className="font-mono text-white">{formatUSD(token.liquidity)}</div>
        </div>
        <div>
          <div className="text-text-muted">估算日交易量</div>
          <div className="font-mono text-white">
            {token.volume24h > 0 ? formatUSD(token.volume24h) : '--'}
          </div>
        </div>
        <div>
          <div className="text-text-muted">DEX</div>
          <div className="text-accent">{token.dex}</div>
        </div>
        <div>
          <div className="text-text-muted">合约</div>
          <div className="font-mono text-text-dim">{shortenAddress(token.address)}</div>
        </div>
      </div>
    </div>
  )
}

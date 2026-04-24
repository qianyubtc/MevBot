import { cn, formatUSD, shortenAddress } from '@/lib/utils'
import type { Token } from '@/lib/ws'

interface Props {
  token: Token
  onSelect?: (token: Token) => void
  selected?: boolean
}

const SCORE_COLOR = (s: number) => s >= 80 ? 'text-success' : s >= 60 ? 'text-warning' : 'text-danger'
const SCORE_BG    = (s: number) => s >= 80 ? 'bg-success/10 border-success/20' : s >= 60 ? 'bg-warning/10 border-warning/20' : 'bg-danger/10 border-danger/20'

export default function TokenCard({ token, onSelect, selected }: Props) {
  const score = Math.round(token.score)

  return (
    <div
      onClick={() => onSelect?.(token)}
      className={cn(
        'rounded-xl border p-4 cursor-pointer transition-all hover:border-primary/40',
        selected ? 'bg-primary-dim border-primary/40' : 'bg-bg-surface border-bg-border',
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="font-mono font-semibold text-white text-sm">{token.symbol}</div>
          <div className="text-xs text-text-muted mt-0.5">{token.name}</div>
        </div>
        <div className={cn('px-2 py-0.5 rounded-md border text-xs font-mono font-semibold', SCORE_BG(score), SCORE_COLOR(score))}>
          {score} 分
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-text-muted">流动性</div>
          <div className="font-mono text-white">{formatUSD(token.liquidity)}</div>
        </div>
        <div>
          <div className="text-text-muted">价格</div>
          <div className="font-mono text-white">
            {(token.priceUSD ?? 0) > 0 ? `$${(token.priceUSD ?? 0) < 0.01 ? (token.priceUSD ?? 0).toExponential(2) : (token.priceUSD ?? 0).toFixed(4)}` : '--'}
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

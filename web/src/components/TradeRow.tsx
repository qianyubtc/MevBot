import { cn, formatUSD, shortenHash, timeAgo } from '@/lib/utils'
import type { Trade } from '@/lib/ws'
import { CheckCircle, XCircle, Clock } from 'lucide-react'

const STRATEGY_LABEL: Record<string, string> = {
  sandwich: '夹子',
  arbitrage: '套利',
  lp: 'LP',
  sniper: '狙击',
  liquidation: '清算',
}

export default function TradeRow({ trade }: { trade: Trade }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-bg-border last:border-0 hover:bg-bg-elevated/50 transition-colors">
      <div className="w-5 flex-shrink-0">
        {trade.status === 'success' && <CheckCircle className="w-4 h-4 text-success" />}
        {trade.status === 'failed' && <XCircle className="w-4 h-4 text-danger" />}
        {trade.status === 'pending' && <Clock className="w-4 h-4 text-warning animate-pulse" />}
      </div>

      <div className="w-16 flex-shrink-0">
        <span className="px-1.5 py-0.5 rounded text-xs bg-accent-dim text-accent border border-accent/20">
          {STRATEGY_LABEL[trade.strategy] ?? trade.strategy}
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-white truncate">{trade.token}</div>
        <div className="font-mono text-xs text-text-muted">{shortenHash(trade.txHash)}</div>
      </div>

      <div className="text-right flex-shrink-0">
        <div className={cn(
          'font-mono text-sm font-semibold',
          trade.profitUSD > 0 ? 'text-success' : 'text-danger'
        )}>
          {trade.profitUSD > 0 ? '+' : ''}{formatUSD(trade.profitUSD)}
        </div>
        <div className="text-xs text-text-muted">Gas {formatUSD(trade.gasUSD)}</div>
      </div>

      <div className="w-20 text-right flex-shrink-0 text-xs text-text-muted">
        {timeAgo(trade.timestamp)}
      </div>
    </div>
  )
}

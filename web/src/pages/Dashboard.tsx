import { useStore } from '@/store'
import StatCard from '@/components/StatCard'
import PnLChart from '@/components/PnLChart'
import TradeRow from '@/components/TradeRow'
import { TrendingUp, Activity, Zap, Target, DollarSign, Percent } from 'lucide-react'
import { formatUSD, formatPercent } from '@/lib/utils'

const MOCK_HISTORY = Array.from({ length: 24 }, (_, i) => ({
  t: Date.now() - (23 - i) * 3600000,
  v: Math.random() * 200 - 50 + i * 8,
}))

export default function Dashboard() {
  const { pnl, trades, activeStrategies, runnerConnected } = useStore()

  const displayPnL = pnl ?? {
    totalUSD: 0,
    todayUSD: 0,
    weekUSD: 0,
    totalTrades: 0,
    winRate: 0,
    history: MOCK_HISTORY,
  }

  const activeCount = Object.values(activeStrategies).filter(Boolean).length
  const recentTrades = trades.slice(0, 20)

  return (
    <div className="space-y-6">
      {/* Runner offline warning */}
      {!runnerConnected && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <div className="text-sm text-warning">
            本地 Runner 未连接 —— 请下载并启动 <span className="font-mono">mevbot-runner</span>
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="总收益"
          value={formatUSD(displayPnL.totalUSD)}
          sub="自创建以来"
          trend={displayPnL.totalUSD >= 0 ? 'up' : 'down'}
          icon={<DollarSign className="w-4 h-4" />}
          glow
        />
        <StatCard
          label="今日收益"
          value={formatUSD(displayPnL.todayUSD)}
          sub="UTC 00:00 起"
          trend={displayPnL.todayUSD >= 0 ? 'up' : 'down'}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <StatCard
          label="总交易数"
          value={displayPnL.totalTrades.toString()}
          sub={`胜率 ${formatPercent(displayPnL.winRate)}`}
          trend="neutral"
          icon={<Activity className="w-4 h-4" />}
        />
        <StatCard
          label="运行策略"
          value={`${activeCount} / 5`}
          sub={activeCount > 0 ? '策略运行中' : '所有策略已停止'}
          trend={activeCount > 0 ? 'up' : 'neutral'}
          icon={<Zap className="w-4 h-4" />}
        />
      </div>

      {/* PnL Chart */}
      <div className="rounded-xl bg-bg-surface border border-bg-border p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-medium text-white">收益曲线（今日）</div>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="w-3 h-0.5 bg-success rounded inline-block" />
            累计收益
          </div>
        </div>
        <PnLChart data={displayPnL.history} height={220} />
      </div>

      {/* Strategy status + Recent trades */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Strategy overview */}
        <div className="rounded-xl bg-bg-surface border border-bg-border p-4">
          <div className="text-sm font-medium text-white mb-4">策略状态</div>
          <div className="space-y-2">
            {[
              { key: 'sandwich', label: '夹子机器人' },
              { key: 'arbitrage', label: '套利机器人' },
              { key: 'lp', label: 'LP 套利' },
              { key: 'sniper', label: '狙击机器人' },
              { key: 'liquidation', label: '清算机器人' },
            ].map(({ key, label }) => (
              <div key={key} className="flex items-center justify-between py-2 border-b border-bg-border last:border-0">
                <span className="text-sm text-text-dim">{label}</span>
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${activeStrategies[key] ? 'bg-success animate-pulse' : 'bg-muted'}`} />
                  <span className={`text-xs ${activeStrategies[key] ? 'text-success' : 'text-text-muted'}`}>
                    {activeStrategies[key] ? '运行中' : '已停止'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent trades */}
        <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-border">
            <div className="text-sm font-medium text-white">最近交易</div>
          </div>
          {recentTrades.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-text-muted">
              暂无交易记录
            </div>
          ) : (
            <div>
              {recentTrades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

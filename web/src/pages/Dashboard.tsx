import { useState } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import StatCard from '@/components/StatCard'
import PnLChart from '@/components/PnLChart'
import TradeRow from '@/components/TradeRow'
import { TrendingUp, Activity, Zap, DollarSign, RotateCcw, AlertTriangle, X } from 'lucide-react'
import { formatUSD, formatPercent } from '@/lib/utils'

export default function Dashboard() {
  const { pnl, trades, activeStrategies, runnerConnected, resetLocalData } = useStore()
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)

  const displayPnL = pnl ?? {
    totalUSD: 0,
    todayUSD: 0,
    weekUSD: 0,
    totalTrades: 0,
    winRate: 0,
    history: [],
  }

  const activeCount = Object.values(activeStrategies).filter(Boolean).length
  const recentTrades = trades.slice(0, 20)

  const handleReset = () => {
    setResetting(true)
    // Tell runner to wipe its JSON files
    wsClient.send({ type: 'reset_data', payload: {} })
    // Wipe local state immediately
    resetLocalData()
    setResetting(false)
    setShowResetConfirm(false)
  }

  return (
    <div className="space-y-6">
      {/* Runner offline warning */}
      {!runnerConnected && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <div className="text-sm text-warning">
            本地 Runner 未连接 —— 请下载并启动 <span className="font-mono">OC SuperBot</span>
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
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <span className="w-3 h-0.5 bg-success rounded inline-block" />
              累计收益
            </div>
            <button
              onClick={() => setShowResetConfirm(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted border border-bg-border hover:border-danger/40 hover:text-danger transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              重置数据
            </button>
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

      {/* Reset confirmation modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-2xl bg-bg-surface border border-bg-border p-6 shadow-2xl">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-danger/10 border border-danger/20 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-4 h-4 text-danger" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">重置所有数据</div>
                  <div className="text-xs text-text-muted mt-0.5">此操作不可撤销</div>
                </div>
              </div>
              <button onClick={() => setShowResetConfirm(false)} className="text-text-muted hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-text-dim mb-5 leading-relaxed">
              将清空所有交易记录、PnL 快照和收益曲线数据。策略配置和钱包设置不受影响。
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleReset}
                disabled={resetting}
                className="flex-1 py-2 rounded-lg bg-danger/10 border border-danger/30 text-sm text-danger hover:bg-danger/20 transition-colors disabled:opacity-50"
              >
                {resetting ? '重置中...' : '确认重置'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

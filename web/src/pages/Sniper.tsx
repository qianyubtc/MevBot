import { useState, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import StrategyRpcCard from '@/components/StrategyRpcCard'
import { Play, Square, Loader2, WifiOff, AlertTriangle, Crosshair, Activity, Info, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FeedLine { id: string; sym: string; status: 'detected' | 'bought' | 'sold' | 'failed'; pnl?: number; t: number }

function ActivityFeed() {
  const [lines, setLines] = useState<FeedLine[]>([])
  useEffect(() => wsClient.on((msg) => {
    // Sniper signals come via two channels:
    //   • opportunity (when new pair passes screen and we buy)
    //   • trade      (when we exit — pending/success/failed)
    if (msg.type === 'opportunity' && msg.payload?.strategy === 'sniper') {
      const p = msg.payload
      setLines(prev => [{ id: String(p.id), sym: String(p.token ?? '?'), status: 'detected' as const, t: Date.now() }, ...prev].slice(0, 10))
      return
    }
    if (msg.type === 'trade' && msg.payload?.strategy === 'sniper') {
      const p = msg.payload
      const status: FeedLine['status'] =
        p.status === 'pending' ? 'bought' :
        p.status === 'success' ? 'sold'   : 'failed'
      setLines(prev => [{ id: String(p.id ?? Math.random()), sym: String(p.token ?? '?'), status, pnl: Number(p.profitUSD ?? 0), t: Date.now() }, ...prev].slice(0, 10))
    }
  }), [])

  const labelMap: Record<FeedLine['status'], { text: string; cls: string }> = {
    detected: { text: '检测中', cls: 'text-text-muted' },
    bought:   { text: '已入场', cls: 'text-primary'    },
    sold:     { text: '已出场', cls: 'text-success'    },
    failed:   { text: '失败',   cls: 'text-danger'     },
  }

  return (
    <div className="rounded-lg bg-bg-elevated border border-bg-border p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 mb-2">
        <Activity className="w-3 h-3 text-primary" />
        <span className="text-xs text-text-muted">实时狙击事件</span>
      </div>
      {lines.length === 0 ? (
        <div className="text-xs text-text-muted opacity-40 font-mono py-1">等待新池子上线 …</div>
      ) : (
        lines.map(l => {
          const lbl = labelMap[l.status]
          return (
            <div key={l.id + l.t} className="flex items-center justify-between font-mono text-xs">
              <span className="text-white">{l.sym}</span>
              <span className="flex items-center gap-2">
                <span className={lbl.cls}>{lbl.text}</span>
                {l.pnl !== undefined && (
                  <span className={l.pnl >= 0 ? 'text-success' : 'text-danger'}>
                    {l.pnl >= 0 ? '+' : ''}${l.pnl.toFixed(2)}
                  </span>
                )}
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}

export default function Sniper() {
  const { activeStrategies, strategyConfig, updateStrategyConfig, runnerConnected } = useStore()
  const isRunning = activeStrategies['sniper'] ?? false
  const cfg = strategyConfig.sniper

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
      if (m.includes('Sniper') || m.includes('狙击')) setStartError(m)
    }
  }), [])

  const start = () => {
    if (!runnerConnected) { setStartError('Runner 未连接，请先启动桌面端'); return }
    setStartError('')
    wsClient.send({ type: 'start', payload: { strategy: 'sniper', config: cfg } })
  }
  const stop = () => wsClient.send({ type: 'stop', payload: { strategy: 'sniper' } })

  const sliderParams = [
    { label: '最小流动性 (USD)', key: 'minLiquidityUSD', min: 5000, max: 500000, step: 1000, unit: '$' },
    { label: '单笔买入 (USD)',    key: 'maxBuyUSD',       min: 5,    max: 1000,   step: 5,    unit: '$' },
    { label: '止盈 (%)',          key: 'targetGainPct',   min: 10,   max: 500,    step: 5,    unit: '%' },
    { label: '止损 (%)',          key: 'stopLossPct',     min: 5,    max: 80,     step: 5,    unit: '%' },
    { label: '最大往返税率 (%)',  key: 'maxTaxPct',       min: 5,    max: 50,     step: 1,    unit: '%' },
  ] as const

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Crosshair className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold text-white">新池狙击</h1>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-xs text-primary">
              真链上 · 蜜罐预筛
            </span>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            监听 PancakeSwap 工厂 PairCreated 事件 — 流动性达标 + 蜜罐通过即买入，达到止盈/止损自动出场。
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

      {/* Risk warning — sniper is the most dangerous strategy of the bunch */}
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/30 text-warning text-xs leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span className="text-warning/90">
          <span className="font-medium">风险提醒：</span>
          狙击新币是<span className="text-warning"> 高风险 </span>策略，蜜罐检测能拦掉绝大多数显式陷阱，但无法完全防住「先放行后修改税率」「黑名单」等延迟陷阱。
          建议单笔金额控制在<span className="font-mono"> $5-50 </span>区间，<span className="text-warning">亏得起再开</span>。
        </span>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-bg-surface border border-bg-border text-text-muted text-xs leading-relaxed">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          原理：每当 PancakeSwap 创建一个新交易对，立刻读 reserves 算流动性，
          通过 router 的双向报价模拟一买一卖检测蜜罐 / 重税。流动性达标 + 模拟往返损耗低于阈值才下场。
          <span className="text-primary/80"> 入场后每 5 秒查一次链上现价</span>，触发止盈或止损就自动卖出。
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-white">入场前的安全过滤</span>
            </div>
            <ul className="text-xs text-text-muted space-y-1 leading-relaxed pl-5 list-disc">
              <li><span className="text-white">蜜罐</span>：router.getAmountsOut 双向报价 + 真买后余额验证（兼容反射税）</li>
              <li><span className="text-white">税率上限</span>：round-trip 损耗超过阈值就跳过，防重税 token</li>
              <li><span className="text-white">Owner 弃权</span>：读 owner() 检查是否 0x0/0xdead — 防 deployer 改税 / 拉黑（可选，默认关）</li>
              <li><span className="text-white">LP 燃毁</span>：pair token 在 0xdead/0x0 的占比 — 防 deployer 抽 LP 跑路（可选，默认关）</li>
            </ul>
          </div>

          <ActivityFeed />
        </div>

        <div className="space-y-4">
          <StrategyRpcCard
            strategy="sniper"
            presets={[
              { label: 'BSC PublicNode WSS', url: 'wss://bsc-rpc.publicnode.com' },
              { label: 'NodeReal WSS',       url: 'wss://bsc-mainnet.nodereal.io/ws/v1/YOUR_KEY' },
              { label: 'BSC HTTP',           url: 'https://bsc-rpc.publicnode.com' },
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
                      {key === 'minLiquidityUSD'
                        ? `$${val >= 1000 ? (val / 1000).toFixed(0) + 'K' : val}`
                        : key === 'maxBuyUSD'
                          ? `$${val}`
                          : `${val}${unit}`}
                    </span>
                  </div>
                  <input type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => updateStrategyConfig('sniper', { [key]: Number(e.target.value) } as any)}
                    className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary" />
                </div>
              )
            })}

            <div className="border-t border-bg-border pt-3 space-y-3">
              <div className="text-xs text-text-muted">防 rug 过滤（可选）</div>

              <label className="flex items-center justify-between text-xs cursor-pointer">
                <span className="text-text-muted">要求 owner 已弃权</span>
                <input type="checkbox" checked={cfg.requireRenounced}
                  onChange={(e) => updateStrategyConfig('sniper', { requireRenounced: e.target.checked })}
                  className="w-3.5 h-3.5 accent-primary cursor-pointer" />
              </label>

              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-text-muted">最低 LP 燃毁 (%)</span>
                  <span className="font-mono text-white">
                    {cfg.minLpBurnedPct === 0 ? '关闭' : `${cfg.minLpBurnedPct}%`}
                  </span>
                </div>
                <input type="range" min={0} max={100} step={5} value={cfg.minLpBurnedPct}
                  onChange={(e) => updateStrategyConfig('sniper', { minLpBurnedPct: Number(e.target.value) })}
                  className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary" />
                <div className="text-[10px] text-text-dim mt-1 leading-relaxed">
                  0 = 关闭。50%+ 即认为 LP 已锁，deployer 无法抽走流动性。
                </div>
              </div>
            </div>

            <div className="text-xs text-text-muted opacity-60 pt-2 border-t border-bg-border leading-relaxed">
              建议起步：流动性 $30K · 单笔 $20 · 止盈 50% · 止损 20% · 税率 25%。
              首次跑可以把单笔调到 $5 试水。
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

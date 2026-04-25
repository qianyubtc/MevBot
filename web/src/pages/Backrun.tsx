import { useState, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import TokenCard from '@/components/TokenCard'
import StrategyRpcCard from '@/components/StrategyRpcCard'
import type { Token } from '@/lib/ws'
import { Play, Square, Search, RefreshCw, Loader2, WifiOff, AlertTriangle, Crosshair, Activity, Zap } from 'lucide-react'
import { cn, formatUSD } from '@/lib/utils'

// ── Real block-swap feed (from Runner's BlockWatcher) ─────────────────────
//
// The Backrun strategy observes MINED swaps (not mempool), so this feed
// shows txs that already landed in the previous block. This is the signal
// the strategy reacts to — not a real-time preview of what's coming.
interface BlockLine { id: number; hash: string; bnb: string; usd: number; fresh: boolean }

function BlockSwapFeed() {
  const [lines, setLines] = useState<BlockLine[]>([])
  const [rxCount, setRxCount] = useState(0)
  const counter = useRef(0)

  useEffect(() => {
    const off = wsClient.on((msg) => {
      if (msg.type !== 'mempool_tx') return   // runner reuses this channel
      const p = msg.payload ?? {}
      const hash = String(p.hash ?? '')
      const bnb  = Number.isFinite(p.bnb) ? Number(p.bnb) : 0
      const usd  = Number.isFinite(p.usd) ? Number(p.usd) : 0
      if (!hash) return
      const id = ++counter.current
      const short = hash.slice(0, 10) + '…'
      setLines(prev => [{ id, hash: short, bnb: bnb.toFixed(3), usd, fresh: true }, ...prev].slice(0, 6))
      setRxCount(c => c + 1)
      setTimeout(() => setLines(prev => prev.map(l => l.id === id ? { ...l, fresh: false } : l)), 500)
    })
    return off
  }, [])

  return (
    <div className="rounded-lg bg-bg-elevated border border-bg-border p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 mb-2">
        <Activity className="w-3 h-3 text-primary" />
        <span className="text-xs text-text-muted">目标 Token 链上交易 (区块级)</span>
        <span className="ml-auto flex items-center gap-2">
          {rxCount > 0 && (
            <span className="text-xs font-mono text-text-muted opacity-60">{rxCount} 笔</span>
          )}
          <span className="flex gap-0.5">
            {[0,1,2].map(i => (
              <span key={i} className="inline-block w-1 bg-primary rounded-full animate-bounce"
                style={{ height: `${6 + i * 3}px`, animationDelay: `${i * 0.15}s` }} />
            ))}
          </span>
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="text-xs text-text-muted opacity-40 font-mono py-1">
          等待目标币种链上交易 (约每 3 秒一块)…
        </div>
      ) : (
        lines.map(({ id, hash, bnb, usd, fresh }) => (
          <div key={id} className={cn(
            'flex items-center justify-between font-mono text-xs transition-colors duration-300',
            fresh ? 'text-primary' : 'text-text-muted opacity-60'
          )}>
            <span>{hash}</span>
            <span className="flex items-center gap-1.5">
              <span>{bnb} BNB</span>
              <span className={cn('text-xs', fresh ? 'text-primary/70' : 'opacity-40')}>≈${usd}</span>
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export default function Backrun() {
  const {
    activeStrategies, strategyConfig, updateStrategyConfig,
    tokens, config, runnerConnected, lastTokensAt,
    backrunSelectedToken, setBackrunSelectedToken,
    backrunRunningToken, setBackrunRunningToken,
  } = useStore()
  const isRunning = activeStrategies['backrun'] ?? false
  const cfg = strategyConfig.backrun
  // Reuse the sandwich token list — tokens with liquid pools are good candidates
  // for both strategies.
  const tokenList: Token[] = tokens['sandwich'] ?? []

  const selected = backrunSelectedToken
  const setSelected = (t: Token | null) => setBackrunSelectedToken(t)
  const runningToken = backrunRunningToken

  const [scanning, setScanning] = useState(false)
  const [caInput, setCaInput] = useState('')
  const [caLoading, setCaLoading] = useState(false)
  const [caError, setCaError] = useState('')
  const [startError, setStartError] = useState('')

  const caLoadingRef = useRef(false)
  const caTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setScanning(false) }, [lastTokensAt])

  useEffect(() => {
    const off = wsClient.on((msg) => {
      if (msg.type === 'token_analyzed') {
        caLoadingRef.current = false
        setCaLoading(false)
        setCaError('')
        if (caTimeoutRef.current) clearTimeout(caTimeoutRef.current)

        const token = msg.payload
        const current = useStore.getState().tokens['sandwich'] ?? []
        const exists = current.some((t) => t.address.toLowerCase() === token.address.toLowerCase())
        if (!exists) {
          useStore.getState().setTokens('sandwich', [token, ...current])
        }
        setBackrunSelectedToken(token)
        setCaInput('')
      }

      if (msg.type === 'error') {
        if (caLoadingRef.current) {
          caLoadingRef.current = false
          setCaLoading(false)
          if (caTimeoutRef.current) clearTimeout(caTimeoutRef.current)
          setCaError(msg.payload.message)
        } else {
          setStartError(msg.payload.message)
        }
      }
    })
    return off
  }, [])

  const handleStartStop = () => {
    setStartError('')
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'backrun' } })
      setBackrunRunningToken(null)
      return
    }
    if (!config.privateKey) {
      setStartError('请先在「设置」页配置钱包私钥')
      return
    }
    if (!selected) return
    setBackrunRunningToken(selected)
    wsClient.send({ type: 'start', payload: { strategy: 'backrun', token: selected, config: cfg } })
  }

  const handleScan = () => {
    if (!runnerConnected) return
    setScanning(true)
    wsClient.send({ type: 'scan', payload: { strategy: 'sandwich', params: {} } })
    setTimeout(() => setScanning(false), 60000)
  }

  const handleAnalyzeCA = () => {
    const addr = caInput.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setCaError('请输入有效合约地址（0x + 40位十六进制）')
      return
    }
    if (!runnerConnected) { setCaError('Runner 未连接'); return }
    setCaError('')
    setCaLoading(true)
    caLoadingRef.current = true
    wsClient.send({ type: 'analyze_token', payload: { address: addr } })
    caTimeoutRef.current = setTimeout(() => {
      if (caLoadingRef.current) {
        caLoadingRef.current = false
        setCaLoading(false)
        setCaError('查询超时，请检查 RPC 或合约地址')
      }
    }, 20000)
  }

  const sliderParams = [
    { label: '最小利润 (USD)',        key: 'minProfitUSD',       min: 0.1, max: 20,    step: 0.1,  unit: '$' },
    { label: '执行金额 (USD)',         key: 'executionAmountUSD', min: 5,   max: 2000,  step: 5,    unit: '$' },
    { label: '最大 Gas (Gwei)',        key: 'maxGasGwei',         min: 1,   max: 50,    step: 1,    unit: 'Gwei' },
    { label: '滑点容忍 (%)',           key: 'slippageTolerance',  min: 0.1, max: 5,     step: 0.1,  unit: '%' },
    { label: '最小跨 DEX 价差 (%)',    key: 'minSpreadPct',       min: 0.1, max: 3,     step: 0.1,  unit: '%' },
  ] as const

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            区块反向套利 (Backrun)
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            轮询区块、监测跨 DEX 价差 → 通过 48 Club Puissant 私有通道原子套利 · 不依赖 Mempool，国内网络可用
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleScan}
            disabled={scanning || !runnerConnected}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-sm text-text-dim hover:bg-bg-elevated disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={cn('w-4 h-4', scanning && 'animate-spin')} />
            扫描币种
          </button>
          <button
            onClick={handleStartStop}
            disabled={(!selected && !isRunning) || !runnerConnected}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50',
              isRunning
                ? 'bg-danger/10 border border-danger/30 text-danger hover:bg-danger/20'
                : 'bg-primary text-bg hover:bg-primary-hover'
            )}
          >
            {isRunning ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isRunning ? '停止' : '启动'}
          </button>
        </div>
      </div>

      {startError && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-center gap-2 text-sm text-warning">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {startError}
        </div>
      )}

      {/* Info banner — what this does and how it's different from sandwich */}
      <div className="rounded-xl border border-primary/20 bg-primary-dim/30 p-4 text-xs space-y-1.5 text-text-dim">
        <div className="text-primary font-medium mb-1 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" />
          工作原理
        </div>
        <div>① 每 800ms 通过 HTTP RPC 拉取最新区块（不需要 WSS 订阅）</div>
        <div>② 发现目标 Token 在 PancakeSwap / BiSwap 之间存在价差时，自动计算套利方向</div>
        <div>③ 通过 48 Club Puissant 私有通道提交 bundle，目标区块 N+1 的最前位置</div>
        <div>④ Puissant 保证原子性 — 套利机会消失则整个 bundle 自动丢弃、<span className="text-success font-medium">不扣 gas</span></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: token list */}
        <div className="lg:col-span-2 space-y-4">
          {/* CA input */}
          <div className="rounded-xl bg-bg-surface border border-bg-border p-3 space-y-2">
            <div className="text-xs text-text-muted font-medium">自定义代币 — 输入合约地址 (CA) 查询</div>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-text-muted focus:outline-none focus:border-primary/50 transition-colors"
                placeholder="0x..."
                value={caInput}
                onChange={(e) => { setCaInput(e.target.value); setCaError('') }}
                onKeyDown={(e) => e.key === 'Enter' && !caLoading && handleAnalyzeCA()}
              />
              <button
                onClick={handleAnalyzeCA}
                disabled={caLoading || !caInput.trim() || !runnerConnected}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-bg text-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {caLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                查询
              </button>
            </div>
            <div className="text-xs text-text-muted opacity-60">
              需要 Token 在 PancakeSwap 和 BiSwap 上都有 WBNB 交易对
            </div>
            {caError && <div className="text-xs text-danger">{caError}</div>}
          </div>

          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-text-muted" />
            <span className="text-sm text-text-muted">
              {scanning ? '链上扫描中...' : `候选币种 (${tokenList.length})`}
            </span>
            {tokenList.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-success/10 text-success border border-success/20">链上数据</span>
            )}
          </div>

          {scanning && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl bg-bg-surface border border-bg-border p-4 animate-pulse">
                  <div className="flex justify-between mb-3">
                    <div className="space-y-1.5"><div className="h-4 w-16 bg-bg-elevated rounded" /><div className="h-3 w-24 bg-bg-elevated rounded" /></div>
                    <div className="h-6 w-12 bg-bg-elevated rounded" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">{[...Array(4)].map((_, j) => <div key={j} className="h-8 bg-bg-elevated rounded" />)}</div>
                </div>
              ))}
            </div>
          )}

          {!scanning && tokenList.length === 0 && (
            <div className="rounded-xl bg-bg-surface border border-bg-border p-12 text-center">
              {runnerConnected ? (
                <><Search className="w-8 h-8 text-text-muted mx-auto mb-3" /><div className="text-sm text-text-muted mb-2">暂无扫描结果</div><div className="text-xs text-text-muted">点击「扫描币种」或在 CA 框直接输入地址</div></>
              ) : (
                <><WifiOff className="w-8 h-8 text-text-muted mx-auto mb-3" /><div className="text-sm text-text-muted mb-2">Runner 未连接</div></>
              )}
            </div>
          )}

          {!scanning && tokenList.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(() => {
                const runningAddr = runningToken?.address?.toLowerCase()
                const sorted = [...tokenList].sort((a, b) => b.score - a.score)
                if (!runningAddr) return sorted
                const isInList = sorted.some(t => t.address.toLowerCase() === runningAddr)
                const rest = sorted.filter(t => t.address.toLowerCase() !== runningAddr)
                const pinnedToken = isInList
                  ? sorted.find(t => t.address.toLowerCase() === runningAddr)!
                  : runningToken!
                return [pinnedToken, ...rest]
              })().map((token) => (
                <TokenCard
                  key={token.address}
                  token={token}
                  selected={selected?.address === token.address}
                  running={runningToken?.address?.toLowerCase() === token.address.toLowerCase()}
                  onSelect={isRunning ? undefined : setSelected}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: config */}
        <div className="space-y-4">
          {isRunning && runningToken ? (
            <div className="rounded-xl border border-success/40 bg-success/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-success" />
                  </span>
                  <span className="text-sm font-semibold text-success">Backrun 运行中</span>
                </div>
                <span className="text-xs text-text-muted font-mono">${cfg.executionAmountUSD} / 笔</span>
              </div>

              <div className="rounded-lg bg-bg-elevated border border-success/20 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Crosshair className="w-3.5 h-3.5 text-success" />
                  <span className="text-xs text-success font-medium">正在监测目标</span>
                </div>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-mono font-bold text-white text-base">{runningToken.symbol}</div>
                    <div className="text-xs text-text-muted mt-0.5">{runningToken.dex}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-text-muted">流动性</div>
                    <div className="text-sm font-mono text-white">{formatUSD(runningToken.liquidity)}</div>
                  </div>
                </div>
                <div className="font-mono text-xs text-text-muted mt-2 break-all leading-relaxed">
                  {runningToken.address}
                </div>
              </div>

              <BlockSwapFeed />

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">最小价差</div>
                  <div className="font-mono text-white">{cfg.minSpreadPct}%</div>
                </div>
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">滑点</div>
                  <div className="font-mono text-white">{cfg.slippageTolerance}%</div>
                </div>
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">最小利润</div>
                  <div className="font-mono text-white">${cfg.minProfitUSD}</div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {selected && (
                <div className="rounded-xl bg-primary-dim border border-primary/30 p-4">
                  <div className="text-xs text-primary mb-1">已选择目标</div>
                  <div className="font-mono font-semibold text-white">{selected.symbol}</div>
                  <div className="text-xs text-text-muted">{selected.dex} · {formatUSD(selected.liquidity)} 流动性</div>
                  <div className="font-mono text-xs text-text-muted mt-1 break-all">{selected.address}</div>
                </div>
              )}
              {!config.privateKey && (
                <div className="rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs text-warning/80 flex gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>未配置钱包私钥 · 启动前需先在「设置」页配置</span>
                </div>
              )}
            </>
          )}

          <StrategyRpcCard
            strategy="backrun"
            presets={[
              { label: 'BSC PublicNode',  url: 'https://bsc-rpc.publicnode.com' },
              { label: 'Ankr 公共',       url: 'https://rpc.ankr.com/bsc' },
              { label: '48 Club RPC',     url: 'https://rpc-bsc.48.club' },
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
                        ? `$${val >= 1000 ? (val / 1000).toFixed(1) + 'K' : val}`
                        : key === 'minProfitUSD'
                          ? `$${val}`
                          : `${val}${unit}`}
                    </span>
                  </div>
                  <input
                    type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => updateStrategyConfig('backrun', { [key]: Number(e.target.value) } as any)}
                    className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
                  />
                </div>
              )
            })}

            <div className="pt-2 border-t border-bg-border">
              <div className="text-xs text-text-muted mb-2">提交通道</div>
              <div className="rounded-md bg-bg-elevated border border-bg-border px-3 py-2 text-xs font-mono text-text-dim">
                48 Club Puissant
                <span className="ml-2 text-success">✓ 国内可达</span>
              </div>
              <div className="text-xs text-text-muted opacity-60 mt-1.5 leading-relaxed">
                私有订单流 · 原子执行 · 套利机会消失时 bundle 被丢弃不扣 gas
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { wsClient } from '@/lib/ws'
import TokenCard from '@/components/TokenCard'
import type { Token } from '@/lib/ws'
import { Play, Square, Search, RefreshCw, Loader2, WifiOff, AlertTriangle, Crosshair, Activity } from 'lucide-react'
import { cn, formatUSD } from '@/lib/utils'

// ── Real mempool feed (data from Runner via WS) ───────────────────────────
interface MempoolLine { id: number; hash: string; bnb: string; usd: number; fresh: boolean }

function MempoolFeed() {
  const [lines, setLines] = useState<MempoolLine[]>([])
  const [rxCount, setRxCount] = useState(0)
  const counter = useRef(0)

  useEffect(() => {
    const off = wsClient.on((msg) => {
      if (msg.type !== 'mempool_tx') return
      const { hash, bnb, usd } = msg.payload
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
        <span className="text-xs text-text-muted">目标 Mempool 交易</span>
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
          等待目标币种交易进入 Mempool…
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

export default function Sandwich() {
  const {
    activeStrategies, strategyConfig, updateStrategyConfig,
    tokens, config, runnerConnected, lastTokensAt, setTokens,
    sandwichSelectedToken, setSandwichSelectedToken,
    sandwichRunningToken, setSandwichRunningToken,
  } = useStore()
  const isRunning = activeStrategies['sandwich'] ?? false
  const cfg = strategyConfig.sandwich
  const tokenList: Token[] = tokens['sandwich'] ?? []

  // "selected" = what the user highlights/previews (changes freely)
  // "runningToken" = snapshot of what was actually started (frozen while running)
  const selected = sandwichSelectedToken
  const setSelected = (token: Token | null) => setSandwichSelectedToken(token)
  const runningToken = sandwichRunningToken

  const [scanning, setScanning] = useState(false)
  const [caInput, setCaInput] = useState('')
  const [caLoading, setCaLoading] = useState(false)
  const [caError, setCaError] = useState('')
  const [startError, setStartError] = useState('')

  // Use refs so the stable WS listener can access latest state
  const caLoadingRef = useRef(false)
  const caTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setScanning(false) }, [lastTokensAt])

  // Register WS listener ONCE (stable, no dependency churn)
  useEffect(() => {
    const off = wsClient.on((msg) => {
      if (msg.type === 'token_analyzed') {
        caLoadingRef.current = false
        setCaLoading(false)
        setCaError('')
        if (caTimeoutRef.current) clearTimeout(caTimeoutRef.current)

        const token = msg.payload
        // Add to list if not already there
        const current = useStore.getState().tokens['sandwich'] ?? []
        const exists = current.some((t) => t.address.toLowerCase() === token.address.toLowerCase())
        if (!exists) {
          useStore.getState().setTokens('sandwich', [token, ...current])
        }
        useStore.getState().setSandwichSelectedToken(token)
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
  }, []) // register only once

  const handleStartStop = () => {
    setStartError('')
    if (isRunning) {
      wsClient.send({ type: 'stop', payload: { strategy: 'sandwich' } })
      setSandwichRunningToken(null)   // clear the running snapshot on stop
      return
    }
    if (!config.privateKey) {
      setStartError('请先在「设置」页配置钱包私钥，才能启动夹子')
      return
    }
    if (!selected) return
    setSandwichRunningToken(selected)  // freeze the target for the duration of this run
    wsClient.send({ type: 'start', payload: { strategy: 'sandwich', token: selected, config: cfg } })
  }

  const handleScan = () => {
    if (!runnerConnected) return
    setScanning(true)
    wsClient.send({ type: 'scan', payload: { strategy: 'sandwich', params: cfg } })
    setTimeout(() => setScanning(false), 60000) // 60s timeout
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
    { label: '最小利润 (USD)',        key: 'minProfitUSD',          min: 0.1,  max: 50,     step: 0.1,  unit: '$' },
    { label: '执行金额 (USD)',         key: 'executionAmountUSD',    min: 10,   max: 5000,   step: 10,   unit: '$' },
    { label: '最大 Gas (Gwei)',        key: 'maxGasGwei',            min: 1,    max: 100,    step: 1,    unit: 'Gwei' },
    { label: '前跑 Gas 溢价 (Gwei)',   key: 'priorityGasMultiplier', min: 0.5,  max: 5,      step: 0.5,  unit: 'Gwei' },
    { label: '滑点容忍 (%)',           key: 'slippageTolerance',     min: 0.1,  max: 5,      step: 0.1,  unit: '%' },
    { label: '最小流动性 (USD)',       key: 'minLiquidityUSD',       min: 10000,max: 2000000,step: 10000,unit: '$' },
    { label: '最大并发夹',             key: 'maxConcurrent',         min: 1,    max: 10,     step: 1,    unit: '' },
  ] as const

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">夹子机器人</h2>
          <p className="text-xs text-text-muted mt-0.5">监听 Mempool 大额 Swap，前后夹击获利</p>
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

      {/* Wallet warning */}
      {startError && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex items-center gap-2 text-sm text-warning">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {startError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left: token list ── */}
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
            {caError && <div className="text-xs text-danger">{caError}</div>}
          </div>

          {/* List header */}
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-text-muted" />
            <span className="text-sm text-text-muted">
              {scanning ? '链上扫描中...' : `优质可夹币种 (${tokenList.length})`}
            </span>
            {tokenList.length > 0 && (
              <span className="px-1.5 py-0.5 rounded text-xs bg-success/10 text-success border border-success/20">链上数据</span>
            )}
            <span className="ml-auto text-xs text-text-muted opacity-60">扫描为只读 · 启动需配置钱包</span>
          </div>

          {/* Skeletons */}
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

          {/* Empty */}
          {!scanning && tokenList.length === 0 && (
            <div className="rounded-xl bg-bg-surface border border-bg-border p-12 text-center">
              {runnerConnected ? (
                <><Search className="w-8 h-8 text-text-muted mx-auto mb-3" /><div className="text-sm text-text-muted mb-2">暂无扫描结果</div><div className="text-xs text-text-muted">点击「扫描币种」获取链上数据，或输入 CA 直接查询</div></>
              ) : (
                <><WifiOff className="w-8 h-8 text-text-muted mx-auto mb-3" /><div className="text-sm text-text-muted mb-2">Runner 未连接</div><div className="text-xs text-text-muted">启动本地 OC SuperBot 后可扫描链上数据</div></>
              )}
            </div>
          )}

          {/* Token grid */}
          {!scanning && tokenList.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(() => {
                // Always pin the running token to top; sort the rest by score
                const runningAddr = runningToken?.address?.toLowerCase()
                const sorted = [...tokenList].sort((a, b) => b.score - a.score)
                if (!runningAddr) return sorted
                const isInList = sorted.some(t => t.address.toLowerCase() === runningAddr)
                const rest = sorted.filter(t => t.address.toLowerCase() !== runningAddr)
                // If running token isn't in list at all (custom CA, pre-scan), prepend from store
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
                  onSelect={isRunning ? undefined : setSelected}  // block re-selection while running
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Right: config ── */}
        <div className="space-y-4">

          {/* ── Running state: big combined widget ── */}
          {isRunning && runningToken ? (
            <div className="rounded-xl border border-success/40 bg-success/5 p-4 space-y-3">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {/* Ping animation */}
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-success" />
                  </span>
                  <span className="text-sm font-semibold text-success">夹子运行中</span>
                </div>
                <span className="text-xs text-text-muted font-mono">${cfg.executionAmountUSD} / 笔</span>
              </div>

              {/* Target token */}
              <div className="rounded-lg bg-bg-elevated border border-success/20 p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Crosshair className="w-3.5 h-3.5 text-success" />
                  <span className="text-xs text-success font-medium">正在夹击目标</span>
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

              {/* Mempool feed */}
              <MempoolFeed />

              {/* Quick stats */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">Gas 溢价</div>
                  <div className="font-mono text-white">+{cfg.priorityGasMultiplier}G</div>
                </div>
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">滑点</div>
                  <div className="font-mono text-white">{cfg.slippageTolerance}%</div>
                </div>
                <div className="rounded-lg bg-bg-elevated border border-bg-border px-2 py-1.5 text-center">
                  <div className="text-text-muted mb-0.5">最大并发</div>
                  <div className="font-mono text-white">{cfg.maxConcurrent}</div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Selected token (not running) */}
              {selected && (
                <div className="rounded-xl bg-primary-dim border border-primary/30 p-4">
                  <div className="text-xs text-primary mb-1">已选择目标</div>
                  <div className="font-mono font-semibold text-white">{selected.symbol}</div>
                  <div className="text-xs text-text-muted">{selected.dex} · {formatUSD(selected.liquidity)} 流动性</div>
                  <div className="font-mono text-xs text-text-muted mt-1 break-all">{selected.address}</div>
                </div>
              )}

              {/* No wallet warning */}
              {!config.privateKey && (
                <div className="rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs text-warning/80 flex gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>未配置钱包私钥，扫描正常，启动策略需先在设置页配置</span>
                </div>
              )}
            </>
          )}

          {/* Strategy parameters */}
          <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-4">
            <div className="text-sm font-medium text-white">策略参数</div>

            {sliderParams.map(({ label, key, min, max, step, unit }) => {
              const val = (cfg as any)[key] as number
              return (
                <div key={key}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-text-muted">{label}</span>
                    <span className="font-mono text-white">
                      {key === 'minLiquidityUSD' || key === 'executionAmountUSD'
                        ? `$${val >= 1000 ? (val / 1000).toFixed(0) + 'K' : val}`
                        : key === 'minProfitUSD'
                          ? `$${val}`
                          : `${val}${unit}`}
                    </span>
                  </div>
                  <input
                    type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => updateStrategyConfig('sandwich', { [key]: Number(e.target.value) } as any)}
                    className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
                  />
                </div>
              )
            })}

            {/* Target DEX */}
            <div>
              <div className="text-xs text-text-muted mb-2">目标 DEX</div>
              <div className="flex flex-wrap gap-2">
                {['PancakeSwap', 'BiSwap', 'BabySwap', 'MDEX'].map((dex) => (
                  <button
                    key={dex}
                    onClick={() => {
                      const next = cfg.targetDexes.includes(dex)
                        ? cfg.targetDexes.filter(d => d !== dex)
                        : [...cfg.targetDexes, dex]
                      updateStrategyConfig('sandwich', { targetDexes: next })
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs border transition-colors',
                      cfg.targetDexes.includes(dex)
                        ? 'bg-primary-dim border-primary/40 text-primary'
                        : 'border-bg-border text-text-muted hover:border-primary/30'
                    )}
                  >
                    {dex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

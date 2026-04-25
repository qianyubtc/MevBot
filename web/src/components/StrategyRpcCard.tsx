import { useState, useEffect } from 'react'
import { Network, Check } from 'lucide-react'
import { useStore, type StrategyConfig } from '@/store'

// Per-strategy RPC override card. Empty value ⇒ the strategy inherits the
// global RPC from Settings. A non-empty value gets passed to the runner on
// `start`, which builds a dedicated client for that strategy — so two bots
// configured with different RPCs end up on different sockets and can't
// step on each other's rate limits.

interface Props {
  strategy: keyof StrategyConfig
  /** Suggested presets shown as quick-fill chips. Optional. */
  presets?: { label: string; url: string }[]
}

export default function StrategyRpcCard({ strategy, presets }: Props) {
  const cfg = useStore((s) => s.strategyConfig[strategy])
  const globalRpc = useStore((s) => s.config.rpcUrl)
  const updateStrategyConfig = useStore((s) => s.updateStrategyConfig)

  const stored = (cfg as { rpcUrl?: string }).rpcUrl ?? ''
  const [draft, setDraft] = useState(stored)

  // Keep draft in sync when persisted state changes from another tab/page.
  useEffect(() => { setDraft(stored) }, [stored])

  const isOverride = stored.trim().length > 0
  const isDirty = draft.trim() !== stored.trim()

  const save = () => {
    updateStrategyConfig(strategy, { rpcUrl: draft.trim() } as Partial<StrategyConfig[typeof strategy]>)
  }

  return (
    <div className="rounded-xl bg-bg-surface border border-bg-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="w-3.5 h-3.5 text-primary" />
          <span className="text-sm font-medium text-white">专用节点</span>
        </div>
        <span className={
          isOverride
            ? 'text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20'
            : 'text-xs px-1.5 py-0.5 rounded bg-bg-elevated text-text-muted border border-bg-border'
        }>
          {isOverride ? '已独立' : '继承全局'}
        </span>
      </div>

      <div className="text-xs text-text-muted leading-relaxed">
        留空使用「设置」里的全局节点。<br />
        填写后该策略会走独立连接，与其他机器人 100% 隔离。
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && isDirty && save()}
          placeholder={`${globalRpc} (全局)`}
          className="flex-1 bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-xs text-white font-mono placeholder:text-text-muted/60 focus:outline-none focus:border-primary/50 transition-colors"
        />
        <button
          onClick={save}
          disabled={!isDirty}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-primary text-bg text-xs font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          保存
        </button>
      </div>

      {presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          <span className="text-xs text-text-muted">快速填入:</span>
          {presets.map((p) => (
            <button
              key={p.url}
              onClick={() => setDraft(p.url)}
              className="text-xs px-2 py-0.5 rounded bg-bg-elevated border border-bg-border text-text-dim hover:text-primary hover:border-primary/40 transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="text-xs text-text-muted opacity-60 pt-1 border-t border-bg-border leading-relaxed">
        修改在「下次启动」生效；正在跑的策略沿用启动时的连接，停止后再启动即应用新节点。
      </div>
    </div>
  )
}

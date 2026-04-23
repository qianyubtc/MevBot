import { useState, useEffect } from 'react'
import { useStore, type Chain } from '@/store'
import { wsClient } from '@/lib/ws'
import {
  Save, Eye, EyeOff, Shield, Wifi, Bell,
  AlertTriangle, RefreshCw, Sparkles, Copy, Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const CHAINS: { value: Chain; label: string; rpc: string }[] = [
  { value: 'BSC',      label: 'BNB Smart Chain', rpc: 'https://bsc-dataseed.binance.org'   },
  { value: 'ETH',      label: 'Ethereum',         rpc: 'https://mainnet.infura.io/v3/YOUR_KEY' },
  { value: 'Arbitrum', label: 'Arbitrum One',     rpc: 'https://arb1.arbitrum.io/rpc'      },
  { value: 'Base',     label: 'Base',             rpc: 'https://mainnet.base.org'           },
]

function Section({ title, icon, children }: {
  title: string; icon: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
      <div className="px-4 py-3 border-b border-bg-border flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <span className="text-sm font-medium text-white">{title}</span>
      </div>
      <div className="p-4 space-y-4">{children}</div>
    </div>
  )
}

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  )
}

// Generate a cryptographically secure random private key in browser
function generatePrivateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Derive ETH address from private key (simple keccak256 - uses SubtleCrypto)
// We send the key to runner and it returns the address, or we just show key + ask user to import
async function deriveAddress(privateKey: string): Promise<string> {
  // Send to runner for address derivation
  return new Promise((resolve) => {
    wsClient.send({ type: 'derive_address', payload: { privateKey } })
    const off = wsClient.on((msg: any) => {
      if (msg.type === 'address_derived') {
        off()
        resolve(msg.payload.address)
      }
    })
    // Fallback if runner not connected
    setTimeout(() => resolve(''), 2000)
  })
}

export default function Settings() {
  const { config, updateConfig, runnerConnected } = useStore()
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [synced, setSynced] = useState(false)
  const [copied, setCopied] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [newWallet, setNewWallet] = useState<{ privateKey: string; address: string } | null>(null)

  const inputCls = 'w-full bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors'

  // Sync config to runner
  const handleSyncToRunner = () => {
    if (!runnerConnected) return
    setSyncing(true)
    wsClient.send({ type: 'set_config', payload: config })
    setTimeout(() => { setSyncing(false); setSynced(true); setTimeout(() => setSynced(false), 2000) }, 800)
  }

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (runnerConnected) handleSyncToRunner()
  }

  // Generate new wallet
  const handleGenerateWallet = async () => {
    setGenerating(true)
    const pk = generatePrivateKey()
    // Derive address via runner or show placeholder
    let address = ''
    if (runnerConnected) {
      address = await deriveAddress(pk)
    }
    setNewWallet({ privateKey: pk, address })
    setGenerating(false)
  }

  const handleUseGeneratedWallet = () => {
    if (!newWallet) return
    updateConfig({ privateKey: newWallet.privateKey, walletAddress: newWallet.address })
    setNewWallet(null)
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Runner sync banner */}
      {runnerConnected && (
        <div className="rounded-xl border border-primary/20 bg-primary-dim px-4 py-3 flex items-center justify-between">
          <div className="text-sm text-primary">Runner 已连接，保存后自动同步配置</div>
          <button
            onClick={handleSyncToRunner}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-bg text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-60"
          >
            <RefreshCw className={cn('w-3 h-3', syncing && 'animate-spin')} />
            {synced ? '已同步' : '立即同步'}
          </button>
        </div>
      )}

      {/* Network */}
      <Section title="网络配置" icon={<Wifi className="w-4 h-4" />}>
        <Field label="目标链">
          <div className="grid grid-cols-2 gap-2">
            {CHAINS.map((c) => (
              <button
                key={c.value}
                onClick={() => updateConfig({ chain: c.value, rpcUrl: c.rpc })}
                className={cn(
                  'px-3 py-2 rounded-lg border text-sm text-left transition-colors',
                  config.chain === c.value
                    ? 'bg-primary-dim border-primary/40 text-primary'
                    : 'border-bg-border text-text-dim hover:border-primary/30'
                )}
              >
                <div className="font-medium">{c.value}</div>
                <div className="text-xs opacity-60">{c.label}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="RPC 节点" hint="建议使用 Alchemy / QuickNode 私有节点获取更快的 Mempool">
          <input
            className={inputCls}
            value={config.rpcUrl}
            onChange={(e) => updateConfig({ rpcUrl: e.target.value })}
            placeholder="https://..."
          />
        </Field>
      </Section>

      {/* Wallet */}
      <Section title="钱包配置" icon={<Shield className="w-4 h-4" />}>
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
          <p className="text-xs text-warning/80">私钥仅保存在本机，不会上传任何服务器。建议使用专用小额钱包。</p>
        </div>

        {/* Generate wallet */}
        <div className="rounded-lg border border-bg-border bg-bg-elevated p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">没有钱包？一键生成新钱包</span>
            <button
              onClick={handleGenerateWallet}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/40 bg-accent-dim text-accent text-xs font-medium hover:bg-accent/20 transition-colors disabled:opacity-60"
            >
              <Sparkles className={cn('w-3.5 h-3.5', generating && 'animate-spin')} />
              {generating ? '生成中...' : '生成钱包'}
            </button>
          </div>

          {newWallet && (
            <div className="space-y-2 pt-2 border-t border-bg-border">
              <div className="text-xs text-warning font-medium">⚠️ 请立即备份私钥，关闭后不再显示</div>
              <div>
                <div className="text-xs text-text-muted mb-1">私钥</div>
                <div className="flex items-center gap-2 bg-bg-surface border border-danger/20 rounded-lg px-3 py-2">
                  <code className="text-xs text-danger font-mono flex-1 break-all">{newWallet.privateKey}</code>
                  <button onClick={() => copyToClipboard(newWallet.privateKey)} className="flex-shrink-0">
                    {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-text-muted" />}
                  </button>
                </div>
              </div>
              {newWallet.address && (
                <div>
                  <div className="text-xs text-text-muted mb-1">地址</div>
                  <div className="font-mono text-xs text-white bg-bg-surface border border-bg-border rounded-lg px-3 py-2">{newWallet.address}</div>
                </div>
              )}
              <button
                onClick={handleUseGeneratedWallet}
                className="w-full py-2 rounded-lg bg-primary text-bg text-xs font-medium hover:bg-primary-hover transition-colors"
              >
                使用此钱包
              </button>
            </div>
          )}
        </div>

        <Field label="钱包地址">
          <input
            className={inputCls}
            value={config.walletAddress}
            onChange={(e) => updateConfig({ walletAddress: e.target.value })}
            placeholder="0x..."
          />
        </Field>
        <Field label="私钥" hint="仅在本地 Runner 中使用，用于签名交易">
          <div className="relative">
            <input
              className={cn(inputCls, 'pr-10')}
              type={showKey ? 'text' : 'password'}
              value={config.privateKey}
              onChange={(e) => updateConfig({ privateKey: e.target.value })}
              placeholder="0x..."
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </Field>
      </Section>

      {/* Risk */}
      <Section title="风险控制" icon={<AlertTriangle className="w-4 h-4" />}>
        {[
          { label: '最大 Gas 价格 (Gwei)',  key: 'maxGasGwei',      min: 1,  max: 100,  step: 1   },
          { label: '最大滑点 (%)',           key: 'maxSlippage',     min: 0.1,max: 5,    step: 0.1 },
          { label: '单笔最大仓位 (USD)',     key: 'maxPositionUSD',  min: 50, max: 5000, step: 50  },
          { label: '每日止损上限 (USD)',     key: 'dailyLossLimit',  min: 10, max: 1000, step: 10  },
        ].map(({ label, key, min, max, step }) => (
          <div key={key}>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-text-muted">{label}</span>
              <span className={cn('font-mono', key === 'dailyLossLimit' ? 'text-danger' : 'text-white')}>
                {(config as any)[key]}
              </span>
            </div>
            <input
              type="range" min={min} max={max} step={step}
              value={(config as any)[key]}
              onChange={(e) => updateConfig({ [key]: Number(e.target.value) } as any)}
              className="w-full h-1.5 bg-bg-border rounded-full appearance-none cursor-pointer accent-primary"
            />
          </div>
        ))}
      </Section>

      {/* Telegram */}
      <Section title="Telegram 通知" icon={<Bell className="w-4 h-4" />}>
        <Field label="Bot Token">
          <input className={inputCls} value={config.telegramToken}
            onChange={(e) => updateConfig({ telegramToken: e.target.value })}
            placeholder="123456789:AABBcc..." />
        </Field>
        <Field label="Chat ID">
          <input className={inputCls} value={config.telegramChatId}
            onChange={(e) => updateConfig({ telegramChatId: e.target.value })}
            placeholder="-100..." />
        </Field>
      </Section>

      {/* Save */}
      <button
        onClick={handleSave}
        className={cn(
          'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-all',
          saved ? 'bg-success/10 border border-success/30 text-success'
                : 'bg-primary text-bg hover:bg-primary-hover'
        )}
      >
        <Save className="w-4 h-4" />
        {saved ? '已保存' : '保存配置'}
      </button>
    </div>
  )
}

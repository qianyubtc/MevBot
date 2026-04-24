import { useState } from 'react'
import { useStore, type Chain } from '@/store'
import { wsClient } from '@/lib/ws'
import {
  Save, Eye, EyeOff, Shield, Wifi, Bell,
  AlertTriangle, RefreshCw, Sparkles, Copy, Check, ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getPublicKey } from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'

// ─── Chain & RPC data ────────────────────────────────────────────────────────

interface RpcPreset { label: string; url: string }

const CHAIN_CONFIG: Record<Chain, {
  label: string
  presets: RpcPreset[]
}> = {
  BSC: {
    label: 'BNB Smart Chain',
    presets: [
      { label: 'Binance Official',       url: 'https://bsc-dataseed.binance.org'           },
      { label: 'Binance Dataseed 1',     url: 'https://bsc-dataseed1.binance.org'          },
      { label: 'Binance Dataseed 2',     url: 'https://bsc-dataseed2.binance.org'          },
      { label: 'NodeReal Free',          url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3' },
      { label: 'Ankr Public',            url: 'https://rpc.ankr.com/bsc'                   },
      { label: '48Club (低延迟)',         url: 'https://rpc-bsc.48.club'                    },
      { label: 'BlastAPI',               url: 'https://bsc-mainnet.public.blastapi.io'     },
      { label: '自定义...',              url: ''                                             },
    ],
  },
  SOL: {
    label: 'Solana',
    presets: [
      { label: 'Solana Mainnet (官方)', url: 'https://api.mainnet-beta.solana.com'         },
      { label: 'Helius (推荐)',          url: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY' },
      { label: 'QuickNode',             url: 'https://YOUR_ENDPOINT.quiknode.pro/YOUR_KEY/' },
      { label: 'Triton One',            url: 'https://YOUR_ENDPOINT.rpcpool.com/YOUR_KEY'  },
      { label: 'Alchemy',               url: 'https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY' },
      { label: 'Ankr Public',           url: 'https://rpc.ankr.com/solana'                 },
      { label: '自定义...',             url: ''                                              },
    ],
  },
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function generateEVMKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function evmAddressFromPrivKey(hex: string): string {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex
  const privBytes = Uint8Array.from(raw.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
  const pub = getPublicKey(privBytes, false) // uncompressed 65 bytes
  const pubBody = pub.slice(1) // drop 04 prefix → 64 bytes
  const hash = keccak_256(pubBody)
  return '0x' + Array.from(hash.slice(-20)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateSOLKey(): { privateKey: string; address: string } {
  // SOL keypair: ed25519; for simplicity show hex private key + placeholder address
  // Full derivation needs @noble/ed25519 getPublicKey + base58
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const privHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return { privateKey: privHex, address: '(在 Phantom / Solflare 中导入后查看地址)' }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="flex-shrink-0 p-1 rounded hover:bg-bg-border transition-colors"
    >
      {copied
        ? <Check className="w-3.5 h-3.5 text-success" />
        : <Copy className="w-3.5 h-3.5 text-text-muted" />}
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Settings() {
  const { config, updateConfig, runnerConnected } = useStore()
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [synced, setSynced] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [newWallet, setNewWallet] = useState<{ privateKey: string; address: string } | null>(null)
  const [rpcOpen, setRpcOpen] = useState(false)

  const inputCls = 'w-full bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors'

  const chainCfg = CHAIN_CONFIG[config.chain]
  const isBSC = config.chain === 'BSC'

  // ── Sync ──
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

  // ── Chain switch ──
  const handleChainSwitch = (chain: Chain) => {
    const defaultRpc = CHAIN_CONFIG[chain].presets[0].url
    updateConfig({ chain, rpcUrl: defaultRpc })
  }

  // ── RPC preset select ──
  const handleRpcPreset = (preset: RpcPreset) => {
    setRpcOpen(false)
    if (preset.url) updateConfig({ rpcUrl: preset.url })
    // "自定义..." → just close dropdown so user can edit the input
  }

  // ── Generate wallet ──
  const handleGenerate = () => {
    setGenerating(true)
    setTimeout(() => {
      try {
        if (isBSC) {
          const pk = generateEVMKey()
          const address = evmAddressFromPrivKey(pk)
          setNewWallet({ privateKey: pk, address })
        } else {
          setNewWallet(generateSOLKey())
        }
      } catch (e) {
        console.error('wallet gen error', e)
      }
      setGenerating(false)
    }, 100)
  }

  const handleUseWallet = () => {
    if (!newWallet) return
    updateConfig({ privateKey: newWallet.privateKey, walletAddress: newWallet.address })
    setNewWallet(null)
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

      {/* ── Network ── */}
      <Section title="网络配置" icon={<Wifi className="w-4 h-4" />}>
        {/* Chain selector */}
        <Field label="目标链">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(CHAIN_CONFIG) as Chain[]).map((chain) => (
              <button
                key={chain}
                onClick={() => handleChainSwitch(chain)}
                className={cn(
                  'px-3 py-2.5 rounded-lg border text-sm text-left transition-colors',
                  config.chain === chain
                    ? 'bg-primary-dim border-primary/40 text-primary'
                    : 'border-bg-border text-text-dim hover:border-primary/30'
                )}
              >
                <div className="font-semibold">{chain}</div>
                <div className="text-xs opacity-60">{CHAIN_CONFIG[chain].label}</div>
              </button>
            ))}
          </div>
        </Field>

        {/* RPC with preset dropdown */}
        <Field
          label="RPC 节点"
          hint={isBSC
            ? '建议使用 48Club / NodeReal 私有节点获取更快的 Mempool'
            : '建议使用 Helius 私有节点，Solana 交易速度更快'}
        >
          <div className="space-y-2">
            {/* Preset picker */}
            <div className="relative">
              <button
                onClick={() => setRpcOpen(!rpcOpen)}
                className="w-full flex items-center justify-between px-3 py-2 bg-bg-elevated border border-bg-border rounded-lg text-xs text-text-muted hover:border-primary/40 transition-colors"
              >
                <span>
                  {chainCfg.presets.find(p => p.url === config.rpcUrl)?.label ?? '选择预设节点'}
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', rpcOpen && 'rotate-180')} />
              </button>
              {rpcOpen && (
                <div className="absolute z-20 top-full mt-1 w-full bg-bg-surface border border-bg-border rounded-xl shadow-xl overflow-hidden">
                  {chainCfg.presets.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => handleRpcPreset(p)}
                      className={cn(
                        'w-full text-left px-3 py-2.5 text-xs hover:bg-bg-elevated transition-colors border-b border-bg-border last:border-0',
                        p.url === config.rpcUrl ? 'text-primary' : 'text-text-dim'
                      )}
                    >
                      <div className="font-medium">{p.label}</div>
                      {p.url && <div className="text-text-muted mt-0.5 truncate">{p.url}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Manual input */}
            <input
              className={inputCls}
              value={config.rpcUrl}
              onChange={(e) => updateConfig({ rpcUrl: e.target.value })}
              placeholder="https://..."
            />
          </div>
        </Field>
      </Section>

      {/* ── Wallet ── */}
      <Section title="钱包配置" icon={<Shield className="w-4 h-4" />}>
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
          <p className="text-xs text-warning/80">私钥仅保存在本机，不会上传任何服务器。建议使用专用小额钱包。</p>
        </div>

        {/* Generate card */}
        <div className="rounded-lg border border-bg-border bg-bg-elevated p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted">没有钱包？一键生成新钱包</span>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent/40 bg-accent-dim text-accent text-xs font-medium hover:bg-accent/20 transition-colors disabled:opacity-60"
            >
              <Sparkles className={cn('w-3.5 h-3.5', generating && 'animate-spin')} />
              {generating ? '生成中...' : '生成钱包'}
            </button>
          </div>

          {newWallet && (
            <div className="space-y-3 pt-2 border-t border-bg-border">
              <div className="text-xs text-warning font-medium flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                请立即备份以下信息，关闭后不再显示
              </div>

              {/* Address */}
              <div>
                <div className="text-xs text-text-muted mb-1.5">钱包地址</div>
                <div className="flex items-center gap-2 bg-bg-surface border border-bg-border rounded-lg px-3 py-2">
                  <code className="text-xs text-white font-mono flex-1 break-all">{newWallet.address}</code>
                  {newWallet.address && !newWallet.address.startsWith('(') && (
                    <CopyBtn text={newWallet.address} />
                  )}
                </div>
              </div>

              {/* Private key */}
              <div>
                <div className="text-xs text-text-muted mb-1.5">私钥</div>
                <div className="flex items-center gap-2 bg-bg-surface border border-danger/30 rounded-lg px-3 py-2">
                  <code className="text-xs text-danger font-mono flex-1 break-all">{newWallet.privateKey}</code>
                  <CopyBtn text={newWallet.privateKey} />
                </div>
              </div>

              <button
                onClick={handleUseWallet}
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
            placeholder={isBSC ? '0x...' : 'Solana 地址'}
          />
        </Field>

        <Field label="私钥" hint="仅在本地 Runner 中使用，用于签名交易">
          <div className="relative">
            <input
              className={cn(inputCls, 'pr-10')}
              type={showKey ? 'text' : 'password'}
              value={config.privateKey}
              onChange={(e) => updateConfig({ privateKey: e.target.value })}
              placeholder={isBSC ? '0x...' : '64位十六进制'}
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

      {/* ── Risk ── */}
      <Section title="风险控制" icon={<AlertTriangle className="w-4 h-4" />}>
        {[
          { label: '最大 Gas 价格 (Gwei)',  key: 'maxGasGwei',      min: 1,   max: 100,  step: 1   },
          { label: '最大滑点 (%)',          key: 'maxSlippage',     min: 0.1, max: 5,    step: 0.1 },
          { label: '单笔最大仓位 (USD)',    key: 'maxPositionUSD',  min: 50,  max: 5000, step: 50  },
          { label: '每日止损上限 (USD)',    key: 'dailyLossLimit',  min: 10,  max: 1000, step: 10  },
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

      {/* ── Telegram ── */}
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
          saved
            ? 'bg-success/10 border border-success/30 text-success'
            : 'bg-primary text-bg hover:bg-primary-hover'
        )}
      >
        <Save className="w-4 h-4" />
        {saved ? '已保存' : '保存配置'}
      </button>
    </div>
  )
}

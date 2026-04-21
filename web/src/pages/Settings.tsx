import { useState } from 'react'
import { useStore, type Chain } from '@/store'
import { Save, Eye, EyeOff, Shield, Wifi, Bell, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

const CHAINS: { value: Chain; label: string; rpc: string }[] = [
  { value: 'BSC', label: 'BNB Smart Chain', rpc: 'https://bsc-dataseed.binance.org' },
  { value: 'ETH', label: 'Ethereum', rpc: 'https://mainnet.infura.io/v3/YOUR_KEY' },
  { value: 'Arbitrum', label: 'Arbitrum One', rpc: 'https://arb1.arbitrum.io/rpc' },
  { value: 'Base', label: 'Base', rpc: 'https://mainnet.base.org' },
]

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
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

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
    </div>
  )
}

export default function Settings() {
  const { config, updateConfig } = useStore()
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)

  const inputCls = 'w-full bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors'

  const handleSave = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="max-w-2xl space-y-6">
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
        <Field label="RPC 节点" hint="建议使用私有节点（Alchemy / QuickNode）以获取更快的 Mempool 数据">
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
          <p className="text-xs text-warning/80">私钥仅存储在本地浏览器，不会上传至任何服务器。请确保设备安全。</p>
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

      {/* Risk control */}
      <Section title="风险控制" icon={<AlertTriangle className="w-4 h-4" />}>
        {[
          { label: '最大 Gas 价格 (Gwei)', key: 'maxGasGwei', min: 1, max: 100, step: 1 },
          { label: '最大滑点 (%)', key: 'maxSlippage', min: 0.1, max: 5, step: 0.1 },
          { label: '单笔最大仓位 (USD)', key: 'maxPositionUSD', min: 50, max: 5000, step: 50 },
          { label: '每日止损上限 (USD)', key: 'dailyLossLimit', min: 10, max: 1000, step: 10 },
        ].map(({ label, key, min, max, step }) => (
          <div key={key}>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-text-muted">{label}</span>
              <span className={cn(
                'font-mono',
                key === 'dailyLossLimit' ? 'text-danger' : 'text-white'
              )}>
                {(config as any)[key]}
              </span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
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
          <input
            className={inputCls}
            value={config.telegramToken}
            onChange={(e) => updateConfig({ telegramToken: e.target.value })}
            placeholder="123456789:AABBcc..."
          />
        </Field>
        <Field label="Chat ID">
          <input
            className={inputCls}
            value={config.telegramChatId}
            onChange={(e) => updateConfig({ telegramChatId: e.target.value })}
            placeholder="-100..."
          />
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

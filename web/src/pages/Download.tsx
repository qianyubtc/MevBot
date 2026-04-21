import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  DownloadCloud, Terminal, CheckCircle,
  Apple, Monitor, Cpu, ExternalLink, Copy, Check, Wifi,
} from 'lucide-react'

type OS = 'mac-arm' | 'mac-intel' | 'windows' | 'linux'

const RELEASE_BASE = 'https://github.com/qianyubtc/MevBot/releases/latest/download'

interface DLEntry { label: string; file: string; Icon: React.FC<{ className?: string }> }
const DOWNLOADS: Record<OS, DLEntry> = {
  'mac-arm':   { label: 'macOS Apple Silicon', file: 'mevbot-runner-mac-arm64',   Icon: Apple   },
  'mac-intel': { label: 'macOS Intel',         file: 'mevbot-runner-mac-x64',     Icon: Apple   },
  'windows':   { label: 'Windows x64',          file: 'mevbot-runner-win-x64.exe', Icon: Monitor },
  'linux':     { label: 'Linux x64',            file: 'mevbot-runner-linux-x64',   Icon: Cpu     },
}

function detectOS(): OS {
  const ua = navigator.userAgent
  if (ua.includes('Win')) return 'windows'
  if (ua.includes('Mac')) {
    // Best effort: ARM detection via canvas or assume arm for modern macs
    return 'mac-arm'
  }
  return 'linux'
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="ml-2 p-1 rounded text-text-muted hover:text-primary transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="flex items-center bg-bg-elevated border border-bg-border rounded-lg px-4 py-2.5 font-mono text-sm text-success">
      <span className="flex-1">{children}</span>
      <CopyButton text={children} />
    </div>
  )
}

interface Step { label: string; desc?: string; cmd?: string }

const STEPS_MAC: Step[] = [
  { label: '下载可执行文件', desc: '点击上方按钮下载对应版本' },
  { label: '赋予执行权限', cmd: 'chmod +x ~/Downloads/mevbot-runner-mac-arm64' },
  { label: '配置环境变量', desc: '复制 .env.example 并填入 RPC 地址和私钥', cmd: 'cp .env.example .env && nano .env' },
  { label: '启动 Runner', cmd: './mevbot-runner-mac-arm64' },
]

const STEPS_WIN: Step[] = [
  { label: '下载可执行文件', desc: '点击上方按钮下载 .exe 文件' },
  { label: '创建配置文件', desc: '在 .exe 同目录下新建 .env 文件，填入 RPC 和私钥' },
  { label: '双击运行', desc: '双击 mevbot-runner-win-x64.exe 启动' },
]

export default function Download() {
  const { runnerConnected } = useStore()
  const [os, setOs] = useState<OS>('mac-arm')
  const [activeStep, setActiveStep] = useState(0)

  useEffect(() => { setOs(detectOS()) }, [])

  const dl = DOWNLOADS[os]
  const steps = os === 'windows' ? STEPS_WIN : STEPS_MAC
  const isWin = os === 'windows'

  return (
    <div className="max-w-2xl space-y-6">
      {/* Connection status banner */}
      <div className={cn(
        'rounded-xl border px-4 py-3 flex items-center gap-3',
        runnerConnected
          ? 'bg-success/5 border-success/30'
          : 'bg-warning/5 border-warning/30'
      )}>
        <Wifi className={cn('w-4 h-4', runnerConnected ? 'text-success' : 'text-warning')} />
        <span className={cn('text-sm', runnerConnected ? 'text-success' : 'text-warning')}>
          {runnerConnected
            ? 'Runner 已连接 — ws://localhost:8765'
            : 'Runner 未连接，请按下方步骤安装并启动'}
        </span>
        {runnerConnected && (
          <span className="ml-auto w-2 h-2 rounded-full bg-success animate-pulse" />
        )}
      </div>

      {/* Download card */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-5 py-4 border-b border-bg-border">
          <div className="text-sm font-medium text-white mb-1">下载 MEV Runner</div>
          <div className="text-xs text-text-muted">本地执行引擎，无需安装 Node.js，双击即可运行</div>
        </div>

        {/* OS tabs */}
        <div className="px-5 pt-4 flex gap-2 flex-wrap">
          {(Object.keys(DOWNLOADS) as OS[]).map((key) => {
            const { label, Icon } = DOWNLOADS[key]
            return (
              <button
                key={key}
                onClick={() => setOs(key)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors',
                  os === key
                    ? 'bg-primary-dim border-primary/40 text-primary'
                    : 'border-bg-border text-text-muted hover:border-primary/30'
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            )
          })}
        </div>

        <div className="px-5 py-4 space-y-3">
          <a
            href={`${RELEASE_BASE}/${dl.file}`}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-primary text-bg font-medium text-sm hover:bg-primary-hover transition-colors"
          >
            <DownloadCloud className="w-4 h-4" />
            下载 {dl.label}
          </a>

          <a
            href="https://github.com/qianyubtc/MevBot/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            查看所有版本 / 历史发布
          </a>
        </div>
      </div>

      {/* Setup steps */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-5 py-4 border-b border-bg-border flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-white">安装步骤</span>
        </div>
        <div className="px-5 py-4 space-y-5">
          {steps.map((step, i) => (
            <div key={i} className="flex gap-4">
              <div className="flex-shrink-0 mt-0.5">
                {activeStep > i
                  ? <CheckCircle className="w-5 h-5 text-success" />
                  : <div className={cn(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs font-mono',
                    activeStep === i ? 'border-primary text-primary' : 'border-bg-border text-text-muted'
                  )}>{i + 1}</div>
                }
              </div>
              <div className="flex-1 space-y-1.5">
                <div className="text-sm font-medium text-white">{step.label}</div>
                {step.desc && <div className="text-xs text-text-muted">{step.desc}</div>}
                {step.cmd && <CodeBlock>{step.cmd}</CodeBlock>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* .env config reference */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-5 py-4 border-b border-bg-border">
          <div className="text-sm font-medium text-white">.env 配置说明</div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {[
            { key: 'CHAIN', value: 'BSC', desc: '目标链：BSC / ETH / Arbitrum / Base' },
            { key: 'RPC_URL', value: 'https://bsc-dataseed.binance.org', desc: '推荐使用 Alchemy / QuickNode 私有节点' },
            { key: 'PRIVATE_KEY', value: '0x...', desc: '执行钱包私钥（本地存储，不上传）' },
            { key: 'TELEGRAM_TOKEN', value: '', desc: '可选：Telegram Bot Token，用于成交通知' },
            { key: 'TELEGRAM_CHAT_ID', value: '', desc: '可选：Telegram Chat ID' },
          ].map((item) => (
            <div key={item.key} className="flex items-start gap-3 py-2 border-b border-bg-border last:border-0">
              <code className="text-accent font-mono text-xs w-36 flex-shrink-0 mt-0.5">{item.key}</code>
              <div>
                <div className="font-mono text-xs text-text-dim mb-0.5">{item.value || '(空)'}</div>
                <div className="text-xs text-text-muted">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Security note */}
      <div className="rounded-xl border border-bg-border bg-bg-elevated px-4 py-3 text-xs text-text-muted space-y-1">
        <div className="font-medium text-text-dim">安全说明</div>
        <div>• 私钥仅存在本地 .env 文件，Runner 不连接任何第三方服务器</div>
        <div>• Runner 只与本机 Web 界面（localhost:8765）通信</div>
        <div>• 建议使用专用执行钱包，不要放大额资产</div>
        <div>• 源代码完全开源：<a href="https://github.com/qianyubtc/MevBot" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">github.com/qianyubtc/MevBot</a></div>
      </div>
    </div>
  )
}

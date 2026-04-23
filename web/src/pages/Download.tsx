import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import {
  DownloadCloud, CheckCircle, Apple, Monitor, Cpu,
  ExternalLink, Wifi, Settings, Play, Package,
} from 'lucide-react'

type OS = 'mac-arm' | 'mac-intel' | 'windows' | 'linux'

const APP_RELEASE = 'https://github.com/qianyubtc/MevBot/releases/latest/download'

interface DLEntry {
  label: string
  file: string
  Icon: React.FC<{ className?: string }>
  hint: string
}

const DOWNLOADS: Record<OS, DLEntry> = {
  'mac-arm':   { label: 'macOS Apple Silicon', file: 'MEV.Terminal-0.1.2-arm64.dmg', Icon: Apple,   hint: 'M1 / M2 / M3 芯片' },
  'mac-intel': { label: 'macOS Intel',         file: 'MEV.Terminal-0.1.2.dmg',        Icon: Apple,   hint: 'Intel 芯片（2019 年及以前）' },
  'windows':   { label: 'Windows x64',         file: 'MEV.Terminal.Setup.0.1.2.exe',  Icon: Monitor, hint: 'Windows 10 / 11' },
  'linux':     { label: 'Linux x64',           file: 'MEV.Terminal-0.1.2.AppImage',   Icon: Cpu,     hint: 'Ubuntu 20.04+' },
}

function detectOS(): OS {
  const ua = navigator.userAgent
  if (ua.includes('Win')) return 'windows'
  if (ua.includes('Mac')) {
    // Rough ARM detection: newer Safari on Apple Silicon reports different canvas
    try {
      const c = document.createElement('canvas').getContext('webgl')
      const r = c?.getExtension('WEBGL_debug_renderer_info')
      const renderer = r ? c?.getParameter(r.UNMASKED_RENDERER_WEBGL) as string : ''
      if (renderer.toLowerCase().includes('apple')) return 'mac-arm'
    } catch {}
    return 'mac-intel'
  }
  return 'linux'
}

interface StepItem { icon: React.FC<{ className?: string }>; title: string; desc: string }

const STEPS_APP: StepItem[] = [
  {
    icon: DownloadCloud,
    title: '下载安装包',
    desc: '点击上方按钮下载对应系统的安装包',
  },
  {
    icon: Package,
    title: '安装并打开应用',
    desc: 'macOS：拖入 Applications；Windows：双击安装向导；Linux：赋予执行权限后运行 .AppImage',
  },
  {
    icon: Settings,
    title: '在面板中配置',
    desc: '打开右侧"设置"页，填写 RPC 节点和钱包地址（可一键生成新钱包），点击"同步到 Runner"',
  },
  {
    icon: Play,
    title: '启动策略',
    desc: '进入夹子 / 套利页面，点击"开始扫描"，Runner 即开始监控链上机会',
  },
]

export default function Download() {
  const { runnerConnected } = useStore()
  const [os, setOs] = useState<OS>('mac-intel')

  useEffect(() => { setOs(detectOS()) }, [])

  const dl = DOWNLOADS[os]

  return (
    <div className="max-w-2xl space-y-6">
      {/* Connection status */}
      <div className={cn(
        'rounded-xl border px-4 py-3 flex items-center gap-3',
        runnerConnected
          ? 'bg-success/5 border-success/30'
          : 'bg-warning/5 border-warning/30'
      )}>
        <Wifi className={cn('w-4 h-4', runnerConnected ? 'text-success' : 'text-warning')} />
        <span className={cn('text-sm', runnerConnected ? 'text-success' : 'text-warning')}>
          {runnerConnected
            ? 'MEV Terminal 已连接 — ws://localhost:8765'
            : '未检测到 MEV Terminal，请按下方步骤下载安装'}
        </span>
        {runnerConnected && <span className="ml-auto w-2 h-2 rounded-full bg-success animate-pulse" />}
      </div>

      {/* Download card */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-5 py-4 border-b border-bg-border">
          <div className="text-sm font-medium text-white mb-0.5">下载 MEV Terminal</div>
          <div className="text-xs text-text-muted">桌面应用，双击打开即运行，内置日志面板，无需终端</div>
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
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            )
          })}
        </div>

        <div className="px-5 py-4 space-y-3">
          <a
            href={`${APP_RELEASE}/${dl.file}`}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-primary text-bg font-semibold text-sm hover:bg-primary-hover transition-colors"
          >
            <DownloadCloud className="w-4 h-4" />
            下载 {dl.label}
          </a>
          <p className="text-center text-xs text-text-muted">{dl.hint}</p>

          <a
            href="https://github.com/qianyubtc/MevBot/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors pt-1"
          >
            <ExternalLink className="w-3 h-3" />
            查看所有历史版本
          </a>
        </div>
      </div>

      {/* Setup steps */}
      <div className="rounded-xl bg-bg-surface border border-bg-border overflow-hidden">
        <div className="px-5 py-4 border-b border-bg-border">
          <span className="text-sm font-medium text-white">快速上手（4 步）</span>
        </div>
        <div className="px-5 py-5 space-y-5">
          {STEPS_APP.map((step, i) => {
            const Icon = step.icon
            return (
              <div key={i} className="flex gap-4">
                <div className="flex-shrink-0 mt-0.5 w-7 h-7 rounded-lg bg-primary-dim border border-primary/20 flex items-center justify-center">
                  <Icon className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-primary font-mono">0{i + 1}</span>
                    <span className="text-sm font-medium text-white">{step.title}</span>
                  </div>
                  <p className="text-xs text-text-muted leading-relaxed">{step.desc}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* macOS notice */}
      {(os === 'mac-arm' || os === 'mac-intel') && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning/90 space-y-1">
          <div className="font-medium">macOS 首次打开提示</div>
          <div>若系统提示"无法验证开发者"，右键 → 打开 → 仍要打开 即可。这是因为应用未经 Apple 公证（个人开发者，非商业签名）。</div>
        </div>
      )}

      {/* Security note */}
      <div className="rounded-xl border border-bg-border bg-bg-elevated px-4 py-3 text-xs text-text-muted space-y-1.5">
        <div className="font-medium text-text-dim">安全说明</div>
        <div className="flex items-start gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" /><span>私钥仅存储在本机 <code className="text-accent">~/.mevbot/config.json</code>，不上传任何服务器</span></div>
        <div className="flex items-start gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" /><span>Runner 只与本机 Web 界面（localhost:8765）通信，无外部依赖</span></div>
        <div className="flex items-start gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" /><span>建议使用专用执行钱包，不要存放大额资产</span></div>
        <div className="flex items-start gap-1.5"><CheckCircle className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5" />
          <span>完全开源：<a href="https://github.com/qianyubtc/MevBot" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">github.com/qianyubtc/MevBot</a></span>
        </div>
      </div>
    </div>
  )
}

import { Wrench } from 'lucide-react'

export default function Liquidation() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-bg-surface border border-bg-border flex items-center justify-center">
        <Wrench className="w-7 h-7 text-text-muted" />
      </div>
      <div>
        <div className="text-base font-semibold text-white mb-1">清算机器人</div>
        <div className="text-sm text-text-muted">功能开发中，即将上线</div>
      </div>
      <div className="px-3 py-1 rounded-full bg-warning/10 border border-warning/20 text-xs text-warning">
        敬请期待
      </div>
    </div>
  )
}

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import { format } from 'date-fns'

interface Props {
  data: { t: number; v: number }[]
  height?: number
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-bg-elevated border border-bg-border rounded-lg px-3 py-2 text-xs">
      <div className="text-text-muted mb-1">{label}</div>
      <div className={`font-mono font-semibold ${payload[0].value >= 0 ? 'text-success' : 'text-danger'}`}>
        ${payload[0].value.toFixed(2)}
      </div>
    </div>
  )
}

export default function PnLChart({ data, height = 200 }: Props) {
  const chartData = data.map((d) => ({
    t: format(new Date(d.t), 'HH:mm'),
    v: d.v,
  }))

  const isPositive = (data[data.length - 1]?.v ?? 0) >= 0

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor={isPositive ? '#00d4aa' : '#ff4757'}
              stopOpacity={0.25}
            />
            <stop
              offset="95%"
              stopColor={isPositive ? '#00d4aa' : '#ff4757'}
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2230" />
        <XAxis
          dataKey="t"
          tick={{ fontSize: 10, fill: '#64748b' }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: '#64748b' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `$${v}`}
          width={45}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="v"
          stroke={isPositive ? '#00d4aa' : '#ff4757'}
          strokeWidth={2}
          fill="url(#pnlGradient)"
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

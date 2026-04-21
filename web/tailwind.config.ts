import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0b0e',
          surface: '#111318',
          elevated: '#161a24',
          border: '#1e2230',
        },
        primary: {
          DEFAULT: '#00d4aa',
          dim: '#00d4aa22',
          hover: '#00eebf',
        },
        accent: {
          DEFAULT: '#6c7aff',
          dim: '#6c7aff22',
        },
        success: '#00d4aa',
        danger: '#ff4757',
        warning: '#ffa502',
        muted: '#4a5568',
        text: {
          DEFAULT: '#e2e8f0',
          muted: '#64748b',
          dim: '#94a3b8',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink': 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config

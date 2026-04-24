import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Trade, Opportunity, PnLSnapshot, Token } from '@/lib/ws'

export type Chain = 'BSC' | 'SOL'

export interface Config {
  chain: Chain
  rpcUrl: string
  privateKey: string
  walletAddress: string
  telegramToken: string
  telegramChatId: string
  maxGasGwei: number
  maxSlippage: number
  maxPositionUSD: number
  dailyLossLimit: number
}

export interface StrategyConfig {
  sandwich: {
    minProfitUSD: number
    maxGasGwei: number
    priorityGasMultiplier: number
    minLiquidityUSD: number
    executionAmountUSD: number
    slippageTolerance: number
    maxConcurrent: number
    targetDexes: string[]
    enabled: boolean
  }
  arbitrage: {
    minProfitUSD: number
    maxGasGwei: number
    minSpreadPct: number
    enabled: boolean
  }
  lp: {
    minProfitUSD: number
    maxGasGwei: number
    minTvlUSD: number
    enabled: boolean
  }
  sniper: {
    minLiquidityUSD: number
    maxBuyUSD: number
    targetGainPct: number
    stopLossPct: number
    enabled: boolean
  }
  liquidation: {
    minBonusPct: number
    protocols: string[]
    enabled: boolean
  }
}

interface AppState {
  runnerConnected: boolean
  activeStrategies: Record<string, boolean>
  pnl: PnLSnapshot | null
  trades: Trade[]
  opportunities: Opportunity[]
  tokens: Record<string, Token[]>
  config: Config
  strategyConfig: StrategyConfig
  lastTokensAt: number
  walletBalance: number | null
  setRunnerConnected: (v: boolean) => void
  setStrategyRunning: (strategy: string, running: boolean) => void
  setPnL: (pnl: PnLSnapshot) => void
  addTrade: (trade: Trade) => void
  addOpportunity: (opp: Opportunity) => void
  setTokens: (strategy: string, tokens: Token[]) => void
  setWalletBalance: (v: number | null) => void
  resetLocalData: () => void
  updateConfig: (patch: Partial<Config>) => void
  updateStrategyConfig: <K extends keyof StrategyConfig>(
    strategy: K,
    patch: Partial<StrategyConfig[K]>
  ) => void
}

const defaultConfig: Config = {
  chain: 'BSC',
  rpcUrl: 'https://bsc-dataseed.binance.org',
  privateKey: '',
  walletAddress: '',
  telegramToken: '',
  telegramChatId: '',
  maxGasGwei: 5,
  maxSlippage: 0.5,
  maxPositionUSD: 500,
  dailyLossLimit: 100,
}

const defaultStrategyConfig: StrategyConfig = {
  sandwich: {
    minProfitUSD: 5,
    maxGasGwei: 10,
    priorityGasMultiplier: 2,
    minLiquidityUSD: 50000,
    executionAmountUSD: 200,
    slippageTolerance: 0.5,
    maxConcurrent: 2,
    targetDexes: ['PancakeSwap', 'BiSwap'],
    enabled: false,
  },
  arbitrage: {
    minProfitUSD: 3,
    maxGasGwei: 8,
    minSpreadPct: 0.3,
    enabled: false,
  },
  lp: {
    minProfitUSD: 10,
    maxGasGwei: 8,
    minTvlUSD: 100000,
    enabled: false,
  },
  sniper: {
    minLiquidityUSD: 30000,
    maxBuyUSD: 100,
    targetGainPct: 50,
    stopLossPct: 20,
    enabled: false,
  },
  liquidation: {
    minBonusPct: 5,
    protocols: ['Venus', 'Alpaca'],
    enabled: false,
  },
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      runnerConnected: false,
      activeStrategies: {},
      pnl: null,
      trades: [],
      opportunities: [],
      tokens: {},
      lastTokensAt: 0,
      walletBalance: null,
      config: defaultConfig,
      strategyConfig: defaultStrategyConfig,

      setRunnerConnected: (v) => set({ runnerConnected: v }),
      setStrategyRunning: (strategy, running) =>
        set((s) => ({ activeStrategies: { ...s.activeStrategies, [strategy]: running } })),
      setPnL: (pnl) => set({ pnl }),
      addTrade: (trade) =>
        set((s) => ({ trades: [trade, ...s.trades].slice(0, 200) })),
      addOpportunity: (opp) =>
        set((s) => ({ opportunities: [opp, ...s.opportunities].slice(0, 100) })),
      setTokens: (strategy, tokens) =>
        set((s) => ({ tokens: { ...s.tokens, [strategy]: tokens }, lastTokensAt: Date.now() })),
      setWalletBalance: (v) => set({ walletBalance: v }),
      resetLocalData: () => set({ trades: [], opportunities: [], pnl: null }),
      updateConfig: (patch) =>
        set((s) => ({ config: { ...s.config, ...patch } })),
      updateStrategyConfig: (strategy, patch) =>
        set((s) => ({
          strategyConfig: {
            ...s.strategyConfig,
            [strategy]: { ...s.strategyConfig[strategy], ...patch },
          },
        })),
    }),
    {
      name: 'mevbot-store',
      partialize: (s) => ({ config: s.config, strategyConfig: s.strategyConfig }),
    }
  )
)

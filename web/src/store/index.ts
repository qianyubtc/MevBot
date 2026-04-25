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

// Each strategy may override the global RPC. Empty string ⇒ inherit `Config.rpcUrl`.
// We expose this as `rpcUrl?: string` rather than baking it into every concrete
// strategy interface, so the runner can read it uniformly via
// `strategyConfig[strategy].rpcUrl ?? globalConfig.rpcUrl`.
export interface StrategyConfig {
  sandwich: {
    rpcUrl?: string
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
    rpcUrl?: string
    minProfitUSD: number
    maxGasGwei: number
    executionAmountUSD: number
    slippageTolerance: number
    minSpreadPct: number
    /** Empty = use the runner's default whitelist (CAKE/USDT/BUSD/ETH/...). */
    tokens?: { address: string; symbol: string }[]
    enabled: boolean
  }
  backrun: {
    rpcUrl?: string
    minProfitUSD: number
    maxGasGwei: number
    executionAmountUSD: number
    slippageTolerance: number
    minSpreadPct: number
    enabled: boolean
  }
  lp: {
    rpcUrl?: string
    minProfitUSD: number
    maxGasGwei: number
    minTvlUSD: number
    enabled: boolean
  }
  sniper: {
    rpcUrl?: string
    minLiquidityUSD: number
    maxBuyUSD: number
    targetGainPct: number
    stopLossPct: number
    /** Reject if simulated round-trip tax exceeds this %. */
    maxTaxPct: number
    /** If true, reject tokens whose owner() is set and not 0x0/0xdead. */
    requireRenounced: boolean
    /** Reject if LP burned % below this threshold. 0 disables the check. */
    minLpBurnedPct: number
    enabled: boolean
  }
  liquidation: {
    rpcUrl?: string
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
  sandwichSelectedToken: Token | null   // user's current highlight/preview selection
  sandwichRunningToken: Token | null    // snapshot of what was actually started — never changes while running
  backrunSelectedToken: Token | null
  backrunRunningToken: Token | null
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
  setSandwichSelectedToken: (token: Token | null) => void
  setSandwichRunningToken: (token: Token | null) => void
  setBackrunSelectedToken: (token: Token | null) => void
  setBackrunRunningToken: (token: Token | null) => void
}

const defaultConfig: Config = {
  chain: 'BSC',
  rpcUrl: 'wss://bsc-rpc.publicnode.com',
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
    rpcUrl: '',
    minProfitUSD: 3,
    maxGasGwei: 5,
    priorityGasMultiplier: 1.5,
    minLiquidityUSD: 100000,
    executionAmountUSD: 5,
    slippageTolerance: 1,
    maxConcurrent: 1,
    targetDexes: ['PancakeSwap', 'BiSwap'],
    enabled: false,
  },
  arbitrage: {
    rpcUrl: '',
    minProfitUSD: 0.5,
    maxGasGwei: 5,
    executionAmountUSD: 5,
    slippageTolerance: 1,
    minSpreadPct: 0.3,
    enabled: false,
  },
  backrun: {
    rpcUrl: '',
    minProfitUSD: 0.5,
    maxGasGwei: 5,
    executionAmountUSD: 5,
    slippageTolerance: 1,
    minSpreadPct: 0.3,
    enabled: false,
  },
  lp: {
    rpcUrl: '',
    minProfitUSD: 10,
    maxGasGwei: 8,
    minTvlUSD: 100000,
    enabled: false,
  },
  sniper: {
    rpcUrl: '',
    minLiquidityUSD: 30000,
    maxBuyUSD: 5,
    targetGainPct: 50,
    stopLossPct: 20,
    maxTaxPct: 25,
    requireRenounced: false,
    minLpBurnedPct: 0,
    enabled: false,
  },
  liquidation: {
    rpcUrl: '',
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
      sandwichSelectedToken: null,
      sandwichRunningToken: null,
      backrunSelectedToken: null,
      backrunRunningToken: null,
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
      setSandwichSelectedToken: (token) => set({ sandwichSelectedToken: token }),
      setSandwichRunningToken: (token) => set({ sandwichRunningToken: token }),
      setBackrunSelectedToken: (token) => set({ backrunSelectedToken: token }),
      setBackrunRunningToken: (token) => set({ backrunRunningToken: token }),
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
      partialize: (s) => ({
        config: s.config,
        strategyConfig: s.strategyConfig,
        sandwichSelectedToken: s.sandwichSelectedToken,
        sandwichRunningToken: s.sandwichRunningToken,
        backrunSelectedToken: s.backrunSelectedToken,
        backrunRunningToken: s.backrunRunningToken,
      }),
    }
  )
)

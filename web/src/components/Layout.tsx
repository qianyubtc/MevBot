import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { useEffect } from 'react'
import { wsClient } from '@/lib/ws'
import { useStore } from '@/store'

export default function Layout() {
  const {
    setRunnerConnected,
    setStrategyRunning,
    setPnL,
    addTrade,
    addOpportunity,
    setTokens,
  } = useStore()

  useEffect(() => {
    wsClient.connect()

    const off = wsClient.on((msg) => {
      switch (msg.type) {
        case 'connected':
          setRunnerConnected(true)
          break
        case 'status':
          setStrategyRunning(msg.payload.strategy, msg.payload.running)
          break
        case 'pnl':
          setPnL(msg.payload)
          break
        case 'trade':
          addTrade(msg.payload)
          break
        case 'opportunity':
          addOpportunity(msg.payload)
          break
        case 'tokens':
          setTokens('scan', msg.payload)
          break
      }
    })

    const checkInterval = setInterval(() => {
      setRunnerConnected(wsClient.connected)
    }, 2000)

    return () => {
      off()
      clearInterval(checkInterval)
    }
  }, [])

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

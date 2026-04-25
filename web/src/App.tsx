import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import Dashboard from '@/pages/Dashboard'
import Sandwich from '@/pages/Sandwich'
import Backrun from '@/pages/Backrun'
import Arbitrage from '@/pages/Arbitrage'
import LPArbitrage from '@/pages/LPArbitrage'
import Sniper from '@/pages/Sniper'
import Liquidation from '@/pages/Liquidation'
import ProtectedSwap from '@/pages/ProtectedSwap'
import Settings from '@/pages/Settings'
import Download from '@/pages/Download'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="sandwich" element={<Sandwich />} />
          <Route path="backrun" element={<Backrun />} />
          <Route path="arbitrage" element={<Arbitrage />} />
          <Route path="lp" element={<LPArbitrage />} />
          <Route path="sniper" element={<Sniper />} />
          <Route path="liquidation" element={<Liquidation />} />
          <Route path="protected-swap" element={<ProtectedSwap />} />
          <Route path="settings" element={<Settings />} />
          <Route path="download" element={<Download />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

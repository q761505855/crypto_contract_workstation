import { useState } from 'react'
import { ChartWorkspace } from '../chart/ChartWorkspace'
import {
  ModeSwitch,
  type WorkstationMode,
} from '../components/ModeSwitch'
import {
  LiveStatus,
  ReplayControls,
  SimulationPanel,
} from '../components/panels'
import './app.css'

export default function App() {
  const [mode, setMode] = useState<WorkstationMode>('history')

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>加密货币合约回放工作站</h1>
        <ModeSwitch mode={mode} onChange={setMode} />
      </header>
      <div className="workspace-grid">
        <ChartWorkspace />
        {mode === 'history' ? <SimulationPanel /> : <LiveStatus />}
      </div>
      {mode === 'history' ? <ReplayControls /> : null}
      <footer className="status-footer">
        <span>KLineChart Pro</span>
        <span>{mode === 'history' ? '历史训练模拟' : '实时只读'}</span>
      </footer>
    </main>
  )
}

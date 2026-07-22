import { useEffect, useRef } from 'react'
import { createChartOptions } from './chart-config'
import { DemoDatafeed } from './demo-datafeed'
import {
  ProChartAdapter,
  type ChartAdapterPort,
} from './pro-chart-adapter'

export interface ChartWorkspaceProps {
  createAdapter?: () => ChartAdapterPort
}

const demoDatafeed = new DemoDatafeed()

export function ChartWorkspace({
  createAdapter = () => new ProChartAdapter(),
}: ChartWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const adapterRef = useRef<ChartAdapterPort | null>(null)

  if (adapterRef.current === null) {
    adapterRef.current = createAdapter()
  }

  useEffect(() => {
    if (hostRef.current === null) {
      throw new Error('Chart host was not mounted.')
    }
    adapterRef.current?.mount(createChartOptions(hostRef.current, demoDatafeed))
  }, [])

  return (
    <section className="chart-workspace" aria-label="行情图表">
      <div className="chart-host" data-testid="chart-host" ref={hostRef} />
    </section>
  )
}

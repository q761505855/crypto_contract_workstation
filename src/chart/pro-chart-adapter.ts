import {
  KLineChartPro,
  type ChartPro,
  type ChartProOptions,
  type Period,
  type SymbolInfo,
} from '@klinecharts/pro'

export interface ChartAdapterPort {
  mount(options: ChartProOptions): void
  setPeriod(period: Period): void
  setSymbol(symbol: SymbolInfo): void
  setTheme(theme: string): void
  setTimezone(timezone: string): void
}

export type ChartProFactory = (options: ChartProOptions) => ChartPro

const createProChart: ChartProFactory = (options) => new KLineChartPro(options)

export class ProChartAdapter implements ChartAdapterPort {
  private chart: ChartPro | null = null

  constructor(private readonly factory: ChartProFactory = createProChart) {}

  mount(options: ChartProOptions): void {
    if (this.chart !== null) {
      throw new Error('KLineChart Pro is already mounted.')
    }
    this.chart = this.factory(options)
  }

  setTheme(theme: string): void {
    this.requireChart().setTheme(theme)
  }

  setTimezone(timezone: string): void {
    this.requireChart().setTimezone(timezone)
  }

  setSymbol(symbol: SymbolInfo): void {
    this.requireChart().setSymbol(symbol)
  }

  setPeriod(period: Period): void {
    this.requireChart().setPeriod(period)
  }

  private requireChart(): ChartPro {
    if (this.chart === null) {
      throw new Error('KLineChart Pro is not mounted.')
    }
    return this.chart
  }
}

import { DomPosition, type Chart } from 'klinecharts'
import type { SimulationPriceLineData } from './simulation-price-line'

export interface PriceLabelText {
  name: string
  pnl?: string
  color: string
}

export interface PriceLabel extends PriceLabelText {
  id: string
  price: number
  side: 'left' | 'right'
  preview?: (price: number) => PriceLabelText
  commit?: (price: number) => void
}

interface LabelControl {
  label: PriceLabel
  element: HTMLElement
  name: HTMLSpanElement
  pnl: HTMLSpanElement
  y: number
  line: SimulationPriceLineData
}

interface Drag {
  control: LabelControl
  pointerId: number
  clientX: number
  clientY: number
  moved: boolean
  price?: number
}

const PANE = { paneId: 'candle_pane' }
const DRAG_THRESHOLD = 5

/** HTML hit targets sit above the chart, while the chart projects the actual price lines. */
export class SimulationPriceLabels {
  private readonly layer = document.createElement('div')
  private readonly events = new AbortController()
  private readonly controls: LabelControl[] = []
  private selection?: LabelControl
  private drag?: Drag
  private frame = 0

  constructor(private readonly chart: Chart, private readonly pane: HTMLElement) {
    this.layer.className = 'simulation-price-labels'
    pane.append(this.layer)
    const options = { signal: this.events.signal }
    // KLineChart listens to legacy touch and mouse events on an ancestor.
    this.layer.addEventListener('touchstart', event => event.stopPropagation(), options)
    this.layer.addEventListener('mousedown', event => event.stopPropagation(), options)
    this.layer.addEventListener('contextmenu', event => event.preventDefault(), options)
    document.addEventListener('pointerdown', event => {
      if (!this.drag && !event.composedPath().includes(this.layer)) this.select(undefined)
    }, { ...options, capture: true })
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.selection) return
      this.drag = undefined
      this.select(undefined)
    }, options)
  }

  clear(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
    this.selection = undefined
    this.drag = undefined
    this.controls.length = 0
    this.layer.replaceChildren()
  }

  dispose(): void {
    this.clear()
    this.events.abort()
    this.layer.remove()
  }

  add(label: PriceLabel): SimulationPriceLineData {
    const element = document.createElement(label.commit ? 'button' : 'span')
    element.id = label.id
    element.className = 'simulation-price-label'
    element.dataset.side = label.side
    element.hidden = true
    const name = document.createElement('span')
    name.className = 'simulation-label-name'
    const pnl = document.createElement('span')
    pnl.className = 'simulation-label-pnl'
    pnl.hidden = label.pnl === undefined
    const control: LabelControl = {
      label, element, name, pnl, y: NaN,
      line: {
        color: label.color,
        active: false,
        placeLabel: y => {
          control.y = y
          if (!this.frame) this.frame = requestAnimationFrame(() => this.layout())
        },
      },
    }
    if (element instanceof HTMLButtonElement) {
      element.type = 'button'
      element.setAttribute('aria-label', label.name)
      element.setAttribute('aria-pressed', 'false')
      if (label.pnl !== undefined) {
        pnl.id = `${label.id}-pnl`
        element.setAttribute('aria-describedby', pnl.id)
      }
      const handle = document.createElement('span')
      handle.className = 'simulation-label-handle'
      handle.setAttribute('aria-hidden', 'true')
      element.append(handle)
      element.addEventListener('click', event => {
        if (event.detail === 0) this.toggle(control)
      })
      element.addEventListener('pointerdown', event => this.startDrag(control, event))
      element.addEventListener('pointermove', event => this.moveDrag(event))
      element.addEventListener('pointerup', event => this.finishDrag(event, true))
      element.addEventListener('pointercancel', event => this.finishDrag(event, false))
      element.addEventListener('lostpointercapture', event => this.finishDrag(event, false))
    }
    element.append(name, pnl)
    this.show(control, label)
    this.controls.push(control)
    this.layer.append(element)
    return control.line
  }

  private show(control: LabelControl, text: PriceLabelText): void {
    control.element.style.setProperty('--label-color', text.color)
    control.name.textContent = text.name
    control.pnl.textContent = text.pnl ?? ''
  }

  private layout(): void {
    this.frame = 0
    const height = this.pane.clientHeight
    const axis = this.chart.getDom(PANE.paneId, DomPosition.YAxis)
    const inset = axis ? Math.max(0, this.pane.offsetLeft + this.pane.clientWidth - axis.offsetLeft) : 0
    this.layer.style.right = `${inset}px`
    for (const control of this.controls) {
      control.element.hidden = !(control.y >= 0 && control.y <= height)
    }
    for (const side of ['left', 'right']) {
      const visible = this.controls.filter(({ label, element }) => label.side === side && !element.hidden)
        .sort((a, b) => a.y - b.y)
      if (!visible.length) continue
      const rowHeight = visible[0].element.offsetHeight
      const spacing = Math.min(rowHeight + 3, (height - rowHeight) / Math.max(1, visible.length - 1))
      let previous = rowHeight / 2 - spacing
      let previousControl: LabelControl | undefined
      for (const [index, control] of visible.entries()) {
        const lastCenter = height - rowHeight / 2 - (visible.length - index - 1) * spacing
        const center = Math.min(lastCenter, Math.max(control.y, previous + spacing))
        control.element.style.top = `${center}px`
        const halfGap = previousControl ? Math.max(0, (center - previous - rowHeight) / 2) : 11
        control.element.style.setProperty('--label-hit-above', `${halfGap}px`)
        previousControl?.element.style.setProperty('--label-hit-below', `${halfGap}px`)
        control.element.style.removeProperty('--label-hit-below')
        const offset = control.y - center
        const direction = side === 'left' ? 8 : -8
        control.element.style.setProperty('--label-leader-length', `${Math.abs(offset) > 2 ? Math.hypot(direction, offset) : 0}px`)
        control.element.style.setProperty('--label-leader-angle', `${Math.atan2(offset, direction)}rad`)
        previous = center
        previousControl = control
      }
    }
  }

  private select(control: LabelControl | undefined): void {
    if (control === this.selection) return
    const previous = this.selection
    this.selection = control
    if (previous) this.draw(previous, previous.label.price)
    if (control) this.draw(control, control.label.price)
  }

  private toggle(control: LabelControl): void {
    this.select(this.selection === control ? undefined : control)
  }

  private draw(control: LabelControl, price: number, preview = false): void {
    const { label, line, element } = control
    const text = preview ? label.preview?.(price) ?? label : label
    const active = this.selection === control
    element.setAttribute('aria-pressed', String(active))
    this.show(control, text)
    this.chart.overrideOverlay({
      id: label.id,
      zLevel: active ? 1 : 0,
      points: [{ value: price }],
      extendData: { ...line, active, color: text.color } satisfies SimulationPriceLineData,
    })
  }

  private startDrag(control: LabelControl, event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || this.drag) return
    this.drag = {
      control, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      moved: false,
    }
    control.element.setPointerCapture(event.pointerId)
  }

  private moveDrag(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = event.clientY - drag.clientY
    drag.moved ||= Math.hypot(event.clientX - drag.clientX, delta) >= DRAG_THRESHOLD
    if (this.selection !== drag.control) return
    if (drag.price === undefined && Math.abs(delta) < DRAG_THRESHOLD) return
    // Replay can finish recalculating the price range while a gesture is active.
    const coordinate = this.chart.convertToPixel({ value: drag.control.label.price }, PANE)
    const lineY = Array.isArray(coordinate) ? coordinate[0]?.y : coordinate.y
    if (lineY === undefined) return
    const y = Math.max(0, Math.min(this.pane.clientHeight, lineY + delta))
    const result = this.chart.convertFromPixel([{ y }], PANE)
    const value = Array.isArray(result) ? result[0]?.value : result.value
    drag.price = Math.abs(delta) >= 1 && typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : drag.control.label.price
    this.draw(drag.control, drag.price, true)
  }

  private finishDrag(event: PointerEvent, commit: boolean): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.drag = undefined
    if (drag.price === undefined) {
      if (commit && !drag.moved) this.toggle(drag.control)
      return
    }
    const { label } = drag.control
    if (!commit) {
      this.draw(drag.control, label.price)
      return
    }
    this.select(undefined)
    if (drag.price !== label.price) label.commit?.(drag.price)
  }
}

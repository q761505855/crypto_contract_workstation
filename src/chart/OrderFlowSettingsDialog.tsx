import { createChartColorPicker } from '@klinecharts/pro'
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { orderFlowFieldEntries, orderFlowSettings, validateOrderFlowPreferences, type OrderFlowGroup, type OrderFlowPreferences } from './order-flow-preferences'
import { cvdTitle, footprintTitle } from './order-flow-indicators'
import { bigTradesTitle } from './order-flow-renderers'

const titles: Record<OrderFlowGroup, string> = {
  footprint: footprintTitle, bubbles: bigTradesTitle, cvd: cvdTitle, profile: '框选成交分布（Profile）',
}

function OrderFlowColorField({ label, value, onChange }: {
  label: string
  value: string
  onChange(value: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const picker = useRef<ReturnType<typeof createChartColorPicker> | null>(null)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  useLayoutEffect(() => {
    const control = createChartColorPicker(label, latest.current.value, color => latest.current.onChange(color))
    host.current?.append(control)
    picker.current = control
    return () => {
      control.remove()
      picker.current = null
    }
  }, [label])

  useLayoutEffect(() => {
    if (picker.current) picker.current.value = value
  }, [value])

  return <div className="order-flow-color-field">
    <span>{label}</span>
    <div ref={host} />
  </div>
}

export function OrderFlowSettingsDialog({ group, preferences, onClose, onSave }: {
  group: OrderFlowGroup
  preferences?: OrderFlowPreferences
  onClose(): void
  onSave(preferences: OrderFlowPreferences): void
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => orderFlowSettings(group, preferences))
  const [error, setError] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const next = validateOrderFlowPreferences({ [group]: values }, preferences)
      onSave(next)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return <WorkspaceDialog open title={`${titles[group]}设置`} onClose={onClose} className="order-flow-dialog">
    <form className="order-flow-form" noValidate onSubmit={submit}>
      {group === 'profile' && <p>这些设置适用于左侧绘图工具创建的成交分布选区。</p>}
      {group === 'footprint' && <p>放大图表可查看价位数值。缺少历史逐笔时，可从图表工具栏下载。</p>}
      <div className="order-flow-fields">
        {orderFlowFieldEntries(group).map(([key, field]) => {
          const setValue = (value: string | number | boolean) => setValues(current => ({ ...current, [key]: value }))
          const value = values[key]
          if (field.kind === 'color') {
            return <OrderFlowColorField key={key} label={field.label} value={String(value)} onChange={setValue} />
          }
          return <label key={key} className={field.kind === 'boolean' ? 'order-flow-toggle' : undefined}>
            <span>{field.label}</span>
            {field.kind === 'select' ? (
              <select aria-label={field.label} value={String(value)} onChange={event => setValue(event.target.value)}>
                {Object.entries(field.options).map(([option, label]) => <option key={option} value={option}>{label}</option>)}
              </select>
            ) : field.kind === 'boolean' ? (
              <input type="checkbox" checked={value === true} onChange={event => setValue(event.target.checked)} />
            ) : (
              <input type="number" min={field.min} max={field.max} step={field.step}
                value={Number.isNaN(value) ? '' : String(value)} onChange={event => setValue(event.target.valueAsNumber)} />
            )}
          </label>
        })}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>取消</button><button type="submit">保存</button></footer>
    </form>
  </WorkspaceDialog>
}

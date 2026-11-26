import { createChartColorPicker } from '@klinecharts/pro'
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { bubbleThresholdFields, isVolumeProfileGroup, orderFlowFieldEntries, orderFlowFields, orderFlowSettings, validateOrderFlowPreferences, volumeProfileColorFields, type OrderFlowGroup, type OrderFlowPreferences } from './order-flow-preferences'
import { volumeProfileDisplayType, type BigTradeThresholdUnit } from './order-flow'
import { candleProfileTitle, cvdTitle, footprintTitle, visibleProfileTitle } from './order-flow-indicators'
import { bigTradesTitle } from './order-flow-renderers'
import './order-flow-settings.css'

const titles: Record<OrderFlowGroup, string> = {
  footprint: footprintTitle, bubbles: bigTradesTitle, cvd: cvdTitle, profile: '框选成交分布（Profile）',
  visibleProfile: visibleProfileTitle, candleProfile: candleProfileTitle,
}

type Draft = Record<string, string | number | boolean>
type SettingsSection<G extends OrderFlowGroup> = {
  title: string
  open?: boolean
  fields: readonly (keyof (typeof orderFlowFields)[G])[]
}

const thresholdFields = Object.values(bubbleThresholdFields).flat()
const profileSections = [
  { title: '关键价位', fields: ['showPoc', 'showValueArea', 'valueArea', 'showLabels'] },
  { title: '配色', fields: volumeProfileColorFields },
] as const
const sections = {
  bubbles: [
    { title: '成交筛选', open: true, fields: ['mode', 'thresholdUnit', ...thresholdFields, 'maxBubbles'] },
    { title: '气泡样式', open: true, fields: ['marker', 'hollow', 'showText', 'sizeByVolume', 'opacityByVolume', 'minRadius', 'maxRadius', 'fixedRadius'] },
    { title: '配色', fields: ['buyFillColor', 'sellFillColor', 'buyOutlineColor', 'sellOutlineColor', 'textColor'] },
  ],
  footprint: [
    { title: '显示内容', open: true, fields: ['showText', 'type', 'plotType', 'layout', 'shading', 'fontSize'] },
    { title: '价位分组与筛选', fields: ['input', 'grouping', 'targetRows', 'ticksPerRow', 'columnWidth', 'minNotional', 'maxNotional'] },
    { title: 'POC 与失衡', fields: ['showPoc', 'showImbalance', 'imbalanceRatio'] },
    { title: '配色', fields: ['bidColor', 'askColor', 'textColor', 'pocColor', 'imbalanceColor'] },
  ],
  profile: [
    { title: '分布显示', open: true, fields: ['type', 'showDelta', 'width', 'showValues'] },
    ...profileSections,
  ],
  candleProfile: [
    { title: '分布显示', open: true, fields: ['type', 'showDelta', 'width', 'columnWidth', 'showValues'] },
    ...profileSections,
  ],
  visibleProfile: [
    { title: '位置与显示', open: true, fields: ['placement', 'offset', 'width', 'type', 'showDelta', 'showHeaders'] },
    { title: '关键价位', fields: ['showPoc', 'showValueArea', 'valueArea', 'showLabels'] },
    { title: '配色', fields: ['volumeColor', 'valueAreaColor', 'positiveColor', 'negativeColor', 'pocColor', 'levelColor'] },
  ],
  cvd: [
    { title: '累计与显示', open: true, fields: ['reset', 'plot', 'lineWidth', 'showZero'] },
    { title: '配色', fields: ['positiveColor', 'negativeColor', 'zeroColor'] },
  ],
} satisfies { [G in OrderFlowGroup]: readonly SettingsSection<G>[] }

const thresholdFieldSet = new Set<string>(thresholdFields)
const effectiveProfileType = (values: Draft) => volumeProfileDisplayType(String(values.type), !!values.showDelta)
const hasVolumeColumn = (values: Draft) => ['volume', 'volumeDelta'].includes(effectiveProfileType(values))
const selectionProfileVisibility = {
  valueArea: (values: Draft) => !!values.showValueArea,
  showLabels: (values: Draft) => !!(values.showPoc || values.showValueArea),
  volumeColor: hasVolumeColumn,
  valueAreaColor: (values: Draft) => !!values.showValueArea && hasVolumeColumn(values),
  bidColor: (values: Draft) => effectiveProfileType(values) !== 'volume',
  askColor: (values: Draft) => effectiveProfileType(values) !== 'volume',
  pocColor: (values: Draft) => !!values.showPoc,
}
const visibility: Record<OrderFlowGroup, Readonly<Record<string, (values: Draft) => boolean>>> = {
  bubbles: {
    fixedRadius: values => !values.sizeByVolume,
    minRadius: values => !!values.sizeByVolume,
    maxRadius: values => !!values.sizeByVolume,
    textColor: values => !!values.showText,
    buyFillColor: values => !values.hollow,
    sellFillColor: values => !values.hollow,
  },
  footprint: {
    type: values => !!values.showText || values.plotType === 'matchText',
    targetRows: values => values.grouping === 'auto',
    ticksPerRow: values => values.grouping === 'manual',
    fontSize: values => !!values.showText,
    textColor: values => !!values.showText,
    pocColor: values => !!values.showPoc,
    imbalanceRatio: values => !!values.showImbalance,
    imbalanceColor: values => !!values.showImbalance,
  },
  profile: selectionProfileVisibility,
  candleProfile: { ...selectionProfileVisibility, valueAreaColor: values => !!values.showValueArea },
  visibleProfile: {
    volumeColor: hasVolumeColumn,
    valueAreaColor: values => !!values.showValueArea && hasVolumeColumn(values),
    positiveColor: values => effectiveProfileType(values) !== 'volume',
    negativeColor: values => effectiveProfileType(values) !== 'volume',
    valueArea: values => !!values.showValueArea,
    showLabels: values => !!(values.showPoc || values.showValueArea),
    pocColor: values => !!values.showPoc,
    levelColor: values => !!values.showValueArea,
  },
  cvd: {
    lineWidth: values => values.plot === 'line',
    zeroColor: values => !!values.showZero,
  },
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
  const formId = useId()
  const isProfile = isVolumeProfileGroup(group)
  const sharedProfile = isProfile ? orderFlowSettings('profile', preferences) : undefined
  const groupSections: readonly { title: string; open?: boolean; fields: readonly string[] }[] = sections[group].map((section, index) =>
    isProfile && index === 0 ? { ...section, fields: ['rowSizePercent', ...section.fields] } : section)
  const [expanded, setExpanded] = useState(() => Object.fromEntries(groupSections.map(section => [section.title, !!section.open])))
  const [values, setValues] = useState<Draft>(() => ({ ...orderFlowSettings(group, preferences),
    ...(sharedProfile && { rowSizePercent: sharedProfile.rowSizePercent }),
  }))
  const [error, setError] = useState<{ message: string; field?: string }>()
  const fields = Object.fromEntries(orderFlowFieldEntries(group))
  if (isProfile) fields.rowSizePercent = orderFlowFields.profile.rowSizePercent
  const unit = values.thresholdUnit as BigTradeThresholdUnit
  const activeThresholdFields: readonly string[] | undefined = group === 'bubbles' ? bubbleThresholdFields[unit] : undefined

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const patch = { ...values }
      if (group === 'candleProfile') {
        const palette = orderFlowSettings('candleProfile', preferences)
        for (const color of volumeProfileColorFields) {
          if (preferences?.candleProfile?.[color] === undefined && patch[color] === palette[color]) delete patch[color]
        }
      }
      const updates = { [group]: patch }
      if (sharedProfile) {
        delete patch.rows
        if (group !== 'profile') {
          const changed: Draft = {}
          for (const field of ['valueArea', 'rowSizePercent'] as const) {
            if (patch[field] !== sharedProfile[field]) changed[field] = patch[field]
            delete patch[field]
          }
          if (Object.keys(changed).length) updates.profile = changed
        }
      }
      const next = validateOrderFlowPreferences(updates, preferences)
      onSave(next)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      const field = message.match(/orderFlow\.\w+\.(\w+)/)?.[1]
      const section = groupSections.find(section => field && section.fields.includes(field))
      if (section) setExpanded(current => ({ ...current, [section.title]: true }))
      setError({ message: message.replace(/（orderFlow\.[\w.]+）$/, ''), field })
    }
  }

  function renderField(key: string) {
    const field = fields[key]
    const matchesThreshold = !activeThresholdFields || !thresholdFieldSet.has(key) || activeThresholdFields.includes(key)
    if (key !== error?.field && (!matchesThreshold || visibility[group][key]?.(values) === false)) return null
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
        <input type="number" min={field.min} max={field.max} step={field.step} aria-invalid={error?.field === key || undefined}
          value={Number.isNaN(value) ? '' : String(value)} onChange={event => setValue(event.target.valueAsNumber)} />
      )}
    </label>
  }

  return <WorkspaceDialog open title={`${titles[group]}设置`} onClose={onClose} className="order-flow-dialog"
    actions={<>
      {error && <p className="order-flow-error" role="alert">{error.message}</p>}
      <div className="order-flow-actions"><button type="button" onClick={onClose}>取消</button>
        <button type="submit" form={formId}>保存</button></div>
    </>}>
    <form id={formId} className="order-flow-form" noValidate onSubmit={submit}>
      {group === 'profile' && <p className="order-flow-hint">适用于左侧绘图工具创建的成交分布选区。</p>}
      {isProfile && <p className="order-flow-hint">档宽按最新价乘以比例计算，三种成交分布共用档宽比例和价值区比例。</p>}
      {group === 'footprint' && <p className="order-flow-hint">放大图表可查看价位数值。缺少历史逐笔时，可从图表工具栏下载。</p>}
      {groupSections.map((section, index) => {
        const open = expanded[section.title]
        const bodyId = `${formId}-${index}`
        return <section className="order-flow-section" key={section.title}>
          <h3><button type="button" aria-expanded={open} aria-controls={bodyId}
            onClick={() => setExpanded(current => ({ ...current, [section.title]: !current[section.title] }))}>
            {section.title}<span className="order-flow-chevron" aria-hidden="true" />
          </button></h3>
          <div className="order-flow-section-body" id={bodyId} hidden={!open}>
            {open && <>
              <div className="order-flow-fields">{section.fields.map(renderField)}</div>
              {group === 'bubbles' && index === 0 && unit === 'contracts' && <p className="order-flow-hint">张数筛选适用于 OKX 成交。</p>}
              {group === 'bubbles' && index === 0 && unit === 'lots' && <p className="order-flow-hint">手数按当前 cTrader 品种规格换算，ETF 代理成交无法换算为该品种手数。</p>}
            </>}
          </div>
        </section>
      })}
    </form>
  </WorkspaceDialog>
}

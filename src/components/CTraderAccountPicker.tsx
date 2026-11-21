import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CTraderAccountSelection } from '../market-data/ctrader-account-selection'
import { CTRADER_ACCOUNT_KEY, readCTraderAccount } from '../market-data/ctrader-account-preferences'
import type { CTraderAccount } from '../market-data/ctrader-client'
import { browserStorageKey, ctraderStorage } from '../storage/ctrader-storage'
import { PREFERENCES_RESTORED } from '../storage/preference-events'
import { WorkspaceDialog } from './WorkspaceDialog'

function accountLabel(account: CTraderAccount): string {
  return [account.isLive ? '真实账户' : '模拟账户', account.broker, `账号 ${account.login ?? account.id}`].filter(Boolean).join(' · ')
}

export function CTraderAccountPicker({ selection, busy, switching, onSwitchingChange }: {
  selection: CTraderAccountSelection
  busy: boolean
  switching: boolean
  onSwitchingChange(open: boolean): void
}) {
  const { accounts, selectedKey } = useSyncExternalStore(selection.subscribe, selection.getSnapshot)
  const [dismissed, setDismissed] = useState<readonly CTraderAccount[]>()
  const [choice, setChoice] = useState('')
  const [error, setError] = useState('')
  const [remembered, setRemembered] = useState(readCTraderAccount)
  useEffect(() => {
    const refresh = () => setRemembered(readCTraderAccount())
    const storageChanged = (event: StorageEvent) => {
      if (event.key === browserStorageKey(ctraderStorage, CTRADER_ACCOUNT_KEY) || event.key === null) refresh()
    }
    window.addEventListener(PREFERENCES_RESTORED, refresh)
    window.addEventListener('storage', storageChanged)
    return () => {
      window.removeEventListener(PREFERENCES_RESTORED, refresh)
      window.removeEventListener('storage', storageChanged)
    }
  }, [])
  useEffect(() => {
    if (switching) {
      setChoice(selectedKey ?? '')
      setError('')
    }
  }, [switching, selectedKey])
  const account = accounts.find(item => item.key === choice)
  const restored = selectedKey && remembered !== selectedKey && accounts.some(item => item.key === remembered)
  if (accounts.length === 0) return null

  return <>
    {selectedKey && <button type="button" disabled={busy || accounts.length < 2}
      title={accounts.length < 2 ? '当前只有一个授权账户' : undefined}
      onClick={() => onSwitchingChange(true)}>切换账户</button>}
    {restored && <small className="workspace-tools-note" role="status">已恢复账户选择，刷新页面后生效。</small>}
    {!selectedKey && dismissed === accounts && <button type="button" onClick={() => setDismissed(undefined)}>选择 cTrader 账户</button>}
    <WorkspaceDialog
      open={selectedKey ? switching : dismissed !== accounts}
      title={selectedKey ? '切换 cTrader 账户' : '选择 cTrader 账户'}
      onClose={() => {
        setError('')
        if (selectedKey) onSwitchingChange(false)
        else setDismissed(accounts)
      }}
    >
      <form onSubmit={event => {
        event.preventDefault()
        if (!account || (selectedKey && busy)) return
        try {
          // Start a new connection and chart cache together when changing accounts.
          if (selection.select(account.key)) window.location.reload()
          setRemembered(readCTraderAccount())
        } catch {
          setError('无法保存账户选择，请检查浏览器存储后重试。')
        }
      }}>
        <label className="panel-field">cTrader 账户
          <select value={account?.key ?? ''} onChange={event => setChoice(event.target.value)}>
            <option value="" disabled>请选择账户</option>
            {accounts.map(item => <option key={item.key} value={item.key}>{accountLabel(item)}</option>)}
          </select>
        </label>
        {selectedKey && <p>确认后重新载入工作站，并连接所选账户。</p>}
        {error && <p role="alert">{error}</p>}
        <button className="dialog-done" disabled={!account || account.key === selectedKey || Boolean(selectedKey && busy)} type="submit">连接账户</button>
      </form>
    </WorkspaceDialog>
  </>
}

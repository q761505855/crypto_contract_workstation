import { useState, useSyncExternalStore } from 'react'
import type { CTraderAccountSelection } from '../market-data/ctrader-account-selection'
import type { CTraderAccount } from '../market-data/ctrader-client'
import { WorkspaceDialog } from './WorkspaceDialog'

function accountLabel(account: CTraderAccount): string {
  return [account.isLive ? '真实账户' : '模拟账户', account.broker, `账号 ${account.login ?? account.id}`].filter(Boolean).join(' · ')
}

export function CTraderAccountPicker({ selection }: { selection: CTraderAccountSelection }) {
  const accounts = useSyncExternalStore(selection.subscribe, selection.getSnapshot)
  const [dismissed, setDismissed] = useState<readonly CTraderAccount[]>()
  const [choice, setChoice] = useState('')
  const account = accounts.find(item => item.key === choice)
  if (accounts.length === 0) return null

  return <>
    {dismissed === accounts && <button type="button" onClick={() => setDismissed(undefined)}>选择 cTrader 账户</button>}
    <WorkspaceDialog open={dismissed !== accounts} title="选择 cTrader 账户" onClose={() => setDismissed(accounts)}>
      <form onSubmit={event => {
        event.preventDefault()
        if (account) selection.select(account.key)
      }}>
        <label className="panel-field">cTrader 账户
          <select value={account?.key ?? ''} onChange={event => setChoice(event.target.value)}>
            <option value="" disabled>请选择账户</option>
            {accounts.map(item => <option key={item.key} value={item.key}>{accountLabel(item)}</option>)}
          </select>
        </label>
        <button className="dialog-done" disabled={!account} type="submit">连接账户</button>
      </form>
    </WorkspaceDialog>
  </>
}

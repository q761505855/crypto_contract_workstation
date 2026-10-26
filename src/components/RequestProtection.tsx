import { useEffect, useState } from 'react'
import type { BinanceRequestGuard } from '../market-data/request-guard'

export function RequestProtection({ guard, onResumed }: {
  guard: BinanceRequestGuard
  onResumed(): void
}) {
  const [status, setStatus] = useState(() => guard.getStatus())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const refresh = () => { setStatus(guard.getStatus()) }
    refresh()
    const timer = window.setInterval(refresh, 1_000)
    window.addEventListener('storage', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', refresh)
    }
  }, [guard])
  return (
    <section className="cache-summary" aria-label="行情请求保护">
      <strong>行情请求保护</strong>
      <p>{status.message}</p>
      {status.paused && (
        <button
          type="button"
          disabled={busy || !status.canResume}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              await guard.resume()
              setStatus(guard.getStatus())
              onResumed()
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally { setBusy(false) }
          }}
        >
          手动恢复远程请求
        </button>
      )}
      {error.length > 0 && <p role="alert">{error}</p>}
    </section>
  )
}

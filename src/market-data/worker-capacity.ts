export const workerCapacity = typeof Worker === 'function' ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 0

let active = 0
const waiting: (() => void)[] = []

/** Share CPU capacity between archive decoding and indicator calculation. */
export function reserveWorker(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const start = () => {
      signal.removeEventListener('abort', cancel)
      active++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        active--
        waiting.shift()?.()
      })
    }
    const cancel = () => {
      const index = waiting.indexOf(start)
      if (index >= 0) waiting.splice(index, 1)
      reject(signal.reason)
    }
    if (active < workerCapacity) start()
    else {
      waiting.push(start)
      signal.addEventListener('abort', cancel, { once: true })
    }
  })
}

import { runOrderFlowTask, type OrderFlowTask, type OrderFlowWorkerReply } from './order-flow-worker-tasks'

self.addEventListener('message', ({ data }: MessageEvent<OrderFlowTask>) => {
  try {
    const result = runOrderFlowTask(data)
    self.postMessage({ result } satisfies OrderFlowWorkerReply,
      result instanceof Float64Array ? { transfer: [result.buffer] } : {})
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies OrderFlowWorkerReply)
  }
})

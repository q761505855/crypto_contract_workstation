import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Exercise the shipped ESM Canvas scheduler used by Vite, including its
// private RAF coordination. The package does not export this internal class.
const dependency = readFileSync(resolve('node_modules/klinecharts/dist/index.esm.js'), 'utf8')
const start = dependency.indexOf('var Canvas =')
const canvasSource = dependency.slice(start, dependency.indexOf('}());', start) + 5)

interface InternalCanvas {
  _requestAnimationId: number
  _width: number
  _height: number
  _pixelWidth: number
  _pixelHeight: number
  _nextPixelWidth: number
  _nextPixelHeight: number
  _supportedDevicePixelContentBox: boolean
  _element: { clientWidth: number; clientHeight: number; width: number; height: number; style: Record<string, string> }
  _ctx: { clearRect: ReturnType<typeof vi.fn>; scale: ReturnType<typeof vi.fn> }
  _listener: () => void
  update(width: number, height: number): void
  _resetPixelRatio(): void
}

describe('klinecharts canvas resize scheduling', () => {
  it.each([true, false])('applies the latest resize when a normal draw is already pending (device pixel observer: %s)', (observerSupported) => {
    const frames: (() => void)[] = []
    const Canvas = runInNewContext(`${canvasSource}; Canvas`, {
      DEFAULT_REQUEST_ID: -1,
      requestAnimationFrame: (callback: () => void) => { frames.push(callback); return frames.length },
      getPixelRatio: () => 1,
    }) as { prototype: InternalCanvas }
    const snapshots: number[][] = []
    const canvas = Object.assign(Object.create(Canvas.prototype) as InternalCanvas, {
      _requestAnimationId: -1,
      _width: 881, _height: 260, _pixelWidth: 881, _pixelHeight: 260,
      _nextPixelWidth: 881, _nextPixelHeight: 260,
      _supportedDevicePixelContentBox: observerSupported,
      _element: { clientWidth: 881, clientHeight: 260, width: 881, height: 260, style: {} },
      _ctx: { clearRect: vi.fn(), scale: vi.fn() },
      _listener: () => snapshots.push([canvas._element.width, canvas._element.height]),
    })
    canvas.update(881, 260)
    for (const [width, height] of [[1161, 300], [1281, 320]]) {
      canvas._element.clientWidth = width
      canvas._element.clientHeight = height
      canvas.update(width, height)
      if (observerSupported) {
        canvas._nextPixelWidth = width
        canvas._nextPixelHeight = height
        canvas._resetPixelRatio()
      }
    }
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(snapshots).toEqual([[1281, 320]])
    expect(canvas._element.style).toEqual({ width: '1281px', height: '320px' })
    expect(canvas._ctx.scale).toHaveBeenCalledExactlyOnceWith(1, 1)
    expect(frames).toHaveLength(0)
    canvas.update(1281, 320)
    canvas.update(1281, 320)
    expect(frames).toHaveLength(1)
    frames.shift()!()
    expect(snapshots).toEqual([[1281, 320], [1281, 320]])
    expect(canvas._ctx.scale).toHaveBeenCalledOnce()
    expect(frames).toHaveLength(0)
  })
})

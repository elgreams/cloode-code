import { logForDebugging } from '../debug.js'

/**
 * Minimal Chrome DevTools Protocol client over the runtime's *native* WebSocket.
 *
 * This is the crux of the no-Node browser feature: Playwright's bundled `ws`
 * library hangs under Bun (every OS), and its `--remote-debugging-pipe` needs
 * Node-grade fd inheritance that Bun-on-Windows lacks. Bun's *native* global
 * `WebSocket`, by contrast, drives CDP flawlessly — so we speak CDP directly
 * instead of going through Playwright. Do NOT swap this for the `ws` package.
 *
 * One browser-level connection multiplexes every page via flat sessions
 * (`Target.attachToTarget({flatten:true})`): commands carry a `sessionId`,
 * responses are matched by the global `id`, and events fan out to listeners
 * tagged with the originating `sessionId`.
 */

export type CdpEvent = {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Default ceiling for any single CDP command. Chrome normally replies in
// milliseconds; a command that never resolves (a JS dialog blocking the
// renderer, a hung page, a `while(true)` Runtime.evaluate) would otherwise hang
// the pending promise — and the whole MCP tool call — until the socket closes.
// 30s is generous for legitimate slow commands while still bounding the hang.
const DEFAULT_SEND_TIMEOUT_MS = 30_000

export class CdpClient {
  private ws: WebSocket | undefined
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(ev: CdpEvent) => void>()
  private closed = false

  async connect(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.addEventListener('message', ev => this.onMessage(String(ev.data)))
    ws.addEventListener('close', () => this.onClose())
    ws.addEventListener('error', () =>
      logForDebugging('[browser] CDP websocket error'),
    )
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener(
        'error',
        () => reject(new Error('CDP websocket failed to open')),
        { once: true },
      )
    })
  }

  /**
   * Send a CDP command. `sessionId` targets a specific attached page; omit it
   * for browser-level domains (Target, Browser).
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const ws = this.ws
    if (!ws || this.closed) {
      return Promise.reject(new Error('CDP client is not connected'))
    }
    const id = ++this.nextId
    const msg: Record<string, unknown> = { id, method, params }
    if (sessionId) {
      msg.sessionId = sessionId
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the pending entry so a late reply can't resolve a settled promise
        // and so the map doesn't leak the timed-out request.
        if (this.pending.delete(id)) {
          reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      // Don't let a pending CDP timer keep the process alive on its own.
      ;(timer as { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify(msg))
    })
  }

  onEvent(listener: (ev: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      // ignore — best-effort teardown
    }
  }

  private onMessage(data: string): void {
    let msg: {
      id?: number
      result?: Record<string, unknown>
      error?: { message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) {
        return
      }
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'CDP error'))
      } else {
        p.resolve(msg.result ?? {})
      }
      return
    }
    if (msg.method) {
      const ev: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      }
      for (const l of this.listeners) {
        try {
          l(ev)
        } catch {
          // a listener throwing must not break the read loop
        }
      }
    }
  }

  private onClose(): void {
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('CDP connection closed'))
    }
    this.pending.clear()
  }
}

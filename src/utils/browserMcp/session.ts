import type { ChildProcess } from 'node:child_process'
import { CdpClient, type CdpEvent } from './cdp.js'
import { launchChrome } from './chrome.js'
import { SNAPSHOT_FN } from './snapshot.js'
import { logForDebugging } from '../debug.js'

const BUFFER_LIMIT = 200

// How long to wait for an element to become actionable before giving up. This
// is our stand-in for Playwright's auto-waiting; override via env if a page is
// unusually slow.
const ACTION_TIMEOUT_MS =
  Number(process.env.CLAUDE_BROWSER_ACTION_TIMEOUT_MS) || 5000

type ConsoleEntry = { level: string; text: string }
type NetworkEntry = {
  method: string
  url: string
  status?: number
  failed?: string
}

type Tab = { targetId: string; sessionId: string }

/**
 * Owns the launched Chrome and its CDP connection, and turns high-level tool
 * calls into CDP commands. One instance per MCP server process; Chrome is
 * launched lazily on the first tool call so server startup stays instant.
 */
export class BrowserSession {
  private proc: ChildProcess | undefined
  private cdp: CdpClient | undefined
  private starting: Promise<void> | undefined
  private readonly tabs: Tab[] = []
  private activeTargetId = ''
  private readonly console = new Map<string, ConsoleEntry[]>()
  private readonly network = new Map<string, NetworkEntry[]>()
  // requestId → buffer key, so responseReceived/loadingFailed can update the
  // entry created at requestWillBeSent time.
  private readonly reqIndex = new Map<string, NetworkEntry>()

  async ensureStarted(): Promise<void> {
    if (this.cdp) {
      return
    }
    if (!this.starting) {
      // Clear the cached promise on failure so a later tool call can retry. Left
      // set, a transient launch failure (stale lock, slow disk → port timeout)
      // would settle `starting` rejected and poison every later call with the
      // same stale error for the life of the subprocess.
      this.starting = this.start().catch(err => {
        this.starting = undefined
        throw err
      })
    }
    await this.starting
  }

  private async start(): Promise<void> {
    const { proc, browserWSEndpoint } = await launchChrome()
    this.proc = proc
    const cdp = new CdpClient()
    await cdp.connect(browserWSEndpoint)
    this.cdp = cdp
    cdp.onEvent(ev => this.onEvent(ev))

    await cdp.send('Target.setDiscoverTargets', { discover: true })
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>
    }
    const page = targetInfos.find(
      t => t.type === 'page' && !t.url.startsWith('devtools://'),
    )
    const targetId = page
      ? page.targetId
      : ((await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
          targetId: string
        }).targetId
    await this.attach(targetId)
    this.activeTargetId = targetId
  }

  private async attach(targetId: string): Promise<string> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string }
    this.console.set(sessionId, [])
    this.network.set(sessionId, [])
    await cdp.send('Page.enable', {}, sessionId)
    // Lifecycle events carry a loaderId, which is the only signal that lets
    // navigate() tell its own page-load apart from a prior in-flight one on the
    // same frame (loadEventFired carries no loader/frame id).
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)
    this.tabs.push({ targetId, sessionId })
    return sessionId
  }

  private get session(): string {
    const tab = this.tabs.find(t => t.targetId === this.activeTargetId)
    if (!tab) {
      throw new Error('no active browser tab')
    }
    return tab.sessionId
  }

  private push<T>(map: Map<string, T[]>, key: string, item: T): void {
    const arr = map.get(key) ?? []
    arr.push(item)
    if (arr.length > BUFFER_LIMIT) {
      arr.shift()
    }
    map.set(key, arr)
  }

  private onEvent(ev: CdpEvent): void {
    const sid = ev.sessionId
    if (!sid) {
      return
    }
    switch (ev.method) {
      case 'Runtime.consoleAPICalled': {
        const p = ev.params as {
          type: string
          args: Array<{ value?: unknown; description?: string }>
        }
        const text = p.args
          .map(a => (a.value !== undefined ? String(a.value) : a.description ?? ''))
          .join(' ')
        this.push(this.console, sid, { level: p.type, text })
        break
      }
      case 'Runtime.exceptionThrown': {
        const p = ev.params as {
          exceptionDetails?: { exception?: { description?: string }; text?: string }
        }
        const text =
          p.exceptionDetails?.exception?.description ??
          p.exceptionDetails?.text ??
          'uncaught exception'
        this.push(this.console, sid, { level: 'error', text })
        break
      }
      case 'Log.entryAdded': {
        const p = ev.params as { entry: { level: string; text: string } }
        this.push(this.console, sid, {
          level: p.entry.level,
          text: p.entry.text,
        })
        break
      }
      case 'Network.requestWillBeSent': {
        const p = ev.params as {
          requestId: string
          request: { url: string; method: string }
          redirectResponse?: { status: number }
        }
        // A redirect re-fires requestWillBeSent with the SAME requestId, carrying
        // the prior hop's response. Finalize that hop's status on its existing
        // entry instead of letting the new entry overwrite it in reqIndex (which
        // would lose the redirect's status and leave it looking pending).
        if (p.redirectResponse) {
          const prior = this.reqIndex.get(p.requestId)
          if (prior) {
            prior.status = p.redirectResponse.status
          }
        }
        const entry: NetworkEntry = {
          method: p.request.method,
          url: p.request.url,
        }
        this.reqIndex.set(p.requestId, entry)
        // reqIndex only exists to let the terminal events below back-fill an
        // entry's status/failed; it is NOT a display buffer. Without a bound it
        // grows one entry per request forever (a polling/streaming page leaks
        // memory for the lifetime of the long-running subprocess). Cap it the
        // same way as the display buffers — Map preserves insertion order, so
        // deleting the first key evicts the oldest in-flight request.
        if (this.reqIndex.size > BUFFER_LIMIT) {
          const oldest = this.reqIndex.keys().next().value
          if (oldest !== undefined) {
            this.reqIndex.delete(oldest)
          }
        }
        this.push(this.network, sid, entry)
        break
      }
      case 'Network.responseReceived': {
        const p = ev.params as {
          requestId: string
          response: { status: number }
        }
        const entry = this.reqIndex.get(p.requestId)
        if (entry) {
          entry.status = p.response.status
        }
        break
      }
      case 'Network.loadingFailed': {
        const p = ev.params as { requestId: string; errorText: string }
        const entry = this.reqIndex.get(p.requestId)
        if (entry) {
          entry.failed = p.errorText
        }
        // Terminal event — the entry will get no further updates, so drop the
        // index reference now rather than waiting for FIFO eviction.
        this.reqIndex.delete(p.requestId)
        break
      }
      case 'Network.loadingFinished': {
        // Terminal event: status was already recorded by responseReceived; the
        // index reference is no longer needed.
        const p = ev.params as { requestId: string }
        this.reqIndex.delete(p.requestId)
        break
      }
    }
  }

  private async evalRaw(
    expression: string,
  ): Promise<{ value?: unknown; error?: string }> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const res = (await cdp.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      this.session,
    )) as {
      result?: { value?: unknown }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    if (res.exceptionDetails) {
      return {
        error:
          res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          'evaluation error',
      }
    }
    return { value: res.result?.value }
  }

  // ---- tool operations -------------------------------------------------

  async navigate(url: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const sid = this.session
    // Buffer lifecycle 'load' events from the moment we listen — the load can
    // fire before Page.navigate's reply arrives — and only resolve on the one
    // whose loaderId matches THIS navigation, so a prior in-flight load on the
    // same frame can't resolve us early against the old document.
    let loaderId: string | undefined
    let resolveLoaded: (() => void) | undefined
    const seenLoaders = new Set<string>()
    const off = cdp.onEvent(ev => {
      if (ev.sessionId !== sid) return
      if (ev.method !== 'Page.lifecycleEvent') return
      const p = ev.params as { name?: string; loaderId?: string }
      if (p.name !== 'load' || !p.loaderId) return
      seenLoaders.add(p.loaderId)
      if (loaderId && p.loaderId === loaderId) {
        resolveLoaded?.()
      }
    })
    const loaded = new Promise<void>(resolve => {
      resolveLoaded = resolve
      // Don't hang forever on pages that never fire load (streaming, etc.).
      setTimeout(resolve, 30_000)
    })
    const res = (await cdp.send('Page.navigate', { url }, sid)) as {
      errorText?: string
      loaderId?: string
    }
    if (res.errorText) {
      off()
      throw new Error(`navigation failed: ${res.errorText}`)
    }
    loaderId = res.loaderId
    // The matching load may have already arrived while Page.navigate was
    // in-flight; resolve immediately if so. (No loaderId in the reply — e.g. a
    // same-document navigation — means no load to wait for.)
    if (!loaderId || seenLoaders.has(loaderId)) {
      resolveLoaded?.()
    }
    await loaded
    off()
    // Brief settle for client-rendered content after the load event.
    await new Promise(r => setTimeout(r, 400))
  }

  async snapshot(): Promise<string> {
    const { value, error } = await this.evalRaw(SNAPSHOT_FN)
    if (error) {
      throw new Error(error)
    }
    return String(value ?? '')
  }

  /**
   * Poll until the element for `ref` is actionable — present in the DOM,
   * visible, enabled, not covered by another element, and geometrically stable
   * (two consecutive identical bounding boxes, so animations/layout have
   * settled) — or until ACTION_TIMEOUT_MS. Returns the click point, or an error
   * describing why it never became actionable.
   *
   * This is the auto-waiting Playwright gives for free; without it a click can
   * land before the page is ready (mid-animation, behind an overlay, on a
   * not-yet-enabled button) and silently miss.
   */
  private async waitForActionable(
    ref: string,
  ): Promise<{ x: number; y: number } | { error: string }> {
    const expr = `(() => {
      const el = window.__brefMap && window.__brefMap[${JSON.stringify(ref)}];
      if (!el) return { status: 'missing' };
      if (!el.isConnected) return { status: 'detached' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)
        return { status: 'hidden' };
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { status: 'hidden' };
      if (el.disabled || el.getAttribute('aria-disabled') === 'true')
        return { status: 'disabled' };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      const covered = !top || (top !== el && !el.contains(top) && !top.contains(el));
      return { status: covered ? 'covered' : 'ok', x: cx, y: cy,
        box: Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height) };
    })()`
    const start = Date.now()
    let lastStatus = 'missing'
    let prevBox = ''
    while (Date.now() - start < ACTION_TIMEOUT_MS) {
      const { value, error } = await this.evalRaw(expr)
      if (error) {
        return { error }
      }
      const v = (value ?? {}) as {
        status?: string
        x?: number
        y?: number
        box?: string
      }
      lastStatus = v.status ?? 'missing'
      if (lastStatus === 'ok' && typeof v.x === 'number' && typeof v.y === 'number') {
        // Require geometric stability across two polls before acting.
        if (v.box && v.box === prevBox) {
          return { x: v.x, y: v.y }
        }
        prevBox = v.box ?? ''
      } else {
        prevBox = ''
      }
      await new Promise(r => setTimeout(r, 100))
    }
    const reason: Record<string, string> = {
      missing: `ref ${ref} not found — take a fresh browser_snapshot`,
      detached: `element for ${ref} was removed from the page — take a fresh browser_snapshot`,
      hidden: `element for ${ref} never became visible`,
      disabled: `element for ${ref} stayed disabled`,
      covered: `element for ${ref} is covered by another element`,
      ok: `element for ${ref} did not stop moving`,
    }
    return { error: reason[lastStatus] ?? `element for ${ref} is not actionable` }
  }

  async click(ref: string, doubleClick = false): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const pt = await this.waitForActionable(ref)
    if ('error' in pt) {
      throw new Error(pt.error)
    }
    const sid = this.session
    const base = { x: pt.x, y: pt.y, button: 'left', buttons: 1 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 }, sid)
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', ...base, clickCount: doubleClick ? 2 : 1 },
      sid,
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...base, clickCount: doubleClick ? 2 : 1 },
      sid,
    )
    await new Promise(r => setTimeout(r, 200))
  }

  async type(ref: string, text: string, submit = false): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    // Auto-wait for the field to be present/visible/enabled before typing.
    const ready = await this.waitForActionable(ref)
    if ('error' in ready) {
      throw new Error(ready.error)
    }
    // Focus + clear the field first so typing replaces existing content.
    const focus = await this.evalRaw(`(() => {
      const el = window.__brefMap && window.__brefMap[${JSON.stringify(ref)}];
      if (!el) return { __err: 'ref ${ref} not found — take a fresh browser_snapshot' };
      el.focus();
      if ('value' in el) el.value = '';
      return { ok: true };
    })()`)
    if (focus.error) {
      throw new Error(focus.error)
    }
    const v = focus.value as { __err?: string }
    if (v?.__err) {
      throw new Error(v.__err)
    }
    const sid = this.session
    await cdp.send('Input.insertText', { text }, sid)
    if (submit) {
      await this.pressKeyOn(sid, 'Enter')
    }
  }

  private async pressKeyOn(sid: string, key: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const special: Record<
      string,
      { code: string; vk: number; text?: string }
    > = {
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
    }
    const s = special[key]
    const down: Record<string, unknown> = s
      ? { type: 'keyDown', key, code: s.code, windowsVirtualKeyCode: s.vk, text: s.text }
      : { type: 'keyDown', key, text: key }
    const up: Record<string, unknown> = s
      ? { type: 'keyUp', key, code: s.code, windowsVirtualKeyCode: s.vk }
      : { type: 'keyUp', key }
    await cdp.send('Input.dispatchKeyEvent', down, sid)
    await cdp.send('Input.dispatchKeyEvent', up, sid)
  }

  async pressKey(key: string): Promise<void> {
    await this.pressKeyOn(this.session, key)
  }

  async evaluate(fn: string): Promise<unknown> {
    const { value, error } = await this.evalRaw(`(${fn})()`)
    if (error) {
      // A malformed `fn` surfaces as a raw V8 SyntaxError against the wrapped
      // `(<fn>)()` source, which is cryptic. Reframe it so the caller sees that
      // the function expression they passed is the problem.
      if (/SyntaxError/.test(error)) {
        throw new Error(
          `browser_evaluate expects a function expression, e.g. () => document.title — got a syntax error: ${error}`,
        )
      }
      throw new Error(error)
    }
    return value
  }

  async screenshot(fullPage = false): Promise<string> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const res = (await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: fullPage },
      this.session,
    )) as { data: string }
    return res.data
  }

  // Session id of the active tab, or undefined if there is none. Unlike the
  // `session` getter this never throws — read-only queries should degrade to an
  // empty result rather than error when the last tab has been closed.
  private get sessionOrNone(): string | undefined {
    return this.tabs.find(t => t.targetId === this.activeTargetId)?.sessionId
  }

  getConsole(): ConsoleEntry[] {
    const sid = this.sessionOrNone
    return sid ? this.console.get(sid) ?? [] : []
  }

  getNetwork(): NetworkEntry[] {
    const sid = this.sessionOrNone
    return sid ? this.network.get(sid) ?? [] : []
  }

  async wait(seconds: number): Promise<void> {
    await new Promise(r => setTimeout(r, Math.min(seconds, 30) * 1000))
  }

  // ---- tab management --------------------------------------------------

  async listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>
    }
    return this.tabs.map((t, index) => {
      const info = targetInfos.find(i => i.targetId === t.targetId)
      return {
        index,
        url: info?.url ?? '',
        title: info?.title ?? '',
        active: t.targetId === this.activeTargetId,
      }
    })
  }

  async newTab(url?: string): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const { targetId } = (await cdp.send('Target.createTarget', {
      url: url ?? 'about:blank',
    })) as { targetId: string }
    await this.attach(targetId)
    this.activeTargetId = targetId
  }

  selectTab(index: number): void {
    const tab = this.tabs[index]
    if (!tab) {
      throw new Error(`no tab at index ${index}`)
    }
    this.activeTargetId = tab.targetId
  }

  async closeTab(index: number): Promise<void> {
    const cdp = this.cdp
    if (!cdp) {
      throw new Error('browser not started')
    }
    const tab = this.tabs[index]
    if (!tab) {
      throw new Error(`no tab at index ${index}`)
    }
    await cdp.send('Target.closeTarget', { targetId: tab.targetId })
    this.tabs.splice(index, 1)
    this.console.delete(tab.sessionId)
    this.network.delete(tab.sessionId)
    if (this.activeTargetId === tab.targetId) {
      this.activeTargetId = this.tabs[0]?.targetId ?? ''
    }
  }

  shutdown(): void {
    try {
      this.cdp?.close()
    } catch {
      // ignore
    }
    try {
      this.proc?.kill()
    } catch (err) {
      logForDebugging(`[browser] failed to kill chrome: ${err}`)
    }
  }
}

import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getProviderForModel, resolveApiKey } from './registry.js'

// Tool-capability tracking for OpenAI-compatible models. Many backends (NVIDIA
// NIM's embedding/vision/guard/old-chat models, tool-less Ollama models) accept
// a /chat/completions request but cannot actually use the `tools` field — they
// either reject it outright or silently answer in plain text. This module
// remembers those model ids so we can warn the user ONCE per model that agentic
// tool use won't work, rather than letting the agent loop quietly stall.
//
// Distinct from discovery.recordUnsupportedOpenAICompatModel(): that one hides a
// model from /model entirely (the backend rejected the *model*). A tool-incapable
// model still works for plain chat, so it stays selectable — we only flag that
// tools won't fire.

// How long a tool-incapability flag lasts before the warning can resurface. The
// model behind an id can change (a re-pulled Ollama tag, a NIM swap), so a stale
// flag shouldn't suppress the warning forever. 7 days: long enough that a user
// isn't re-warned every session, short enough to recover from a misfire.
const TOOL_INCAPABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type ToolIncapableReason = 'rejected' | 'ignored' | 'capabilities'

type ToolIncapableEntry = { id: string; ts: number; reason?: ToolIncapableReason }

function readEntries(): ToolIncapableEntry[] {
  try {
    return getGlobalConfig().openAICompatToolIncapableModels ?? []
  } catch {
    return []
  }
}

/** True if `id` is currently flagged tool-incapable (non-expired). */
export function isToolIncapableModel(id: string | null | undefined): boolean {
  if (!id) {
    return false
  }
  const now = Date.now()
  return readEntries().some(
    e => e.id === id && now - e.ts < TOOL_INCAPABLE_TTL_MS,
  )
}

/** The active (non-expired) flag for `id`, or undefined. */
export function getToolIncapableEntry(
  id: string | null | undefined,
): ToolIncapableEntry | undefined {
  if (!id) {
    return undefined
  }
  const now = Date.now()
  return readEntries().find(
    e => e.id === id && now - e.ts < TOOL_INCAPABLE_TTL_MS,
  )
}

/**
 * Flag a model id as tool-incapable and emit a one-time warning to the UI.
 * Re-flagging an already-flagged id refreshes its timestamp but does NOT re-warn
 * within the TTL — that's the "once per model" guarantee. Returns true if this
 * call produced a fresh warning (caller can log/act on it), false if suppressed.
 */
export function recordToolIncapableModel(
  id: string,
  reason: ToolIncapableReason,
): boolean {
  if (!id) {
    return false
  }
  const already = isToolIncapableModel(id)
  try {
    saveGlobalConfig(config => {
      const now = Date.now()
      const current = config.openAICompatToolIncapableModels ?? []
      const others = current.filter(e => e.id !== id)
      return {
        ...config,
        openAICompatToolIncapableModels: [...others, { id, ts: now, reason }],
      }
    })
  } catch {
    // config not ready — best effort
  }
  if (already) {
    return false
  }
  logForDebugging(
    `[openai-compat] model '${id}' flagged tool-incapable (${reason})`,
  )
  emitToolWarning({ id, reason })
  return true
}

// ── One-time warning event channel (adapter → React UI) ─────────────
// The fetch adapter and query loop run outside React, so they can't call
// addNotification directly. They emit here; a React hook (useToolCapability
// Notification) subscribes and surfaces the warning. Mirrors the
// statusListeners pattern in claudeAiLimits.ts.

export type ToolWarning = { id: string; reason: ToolIncapableReason }
type ToolWarningListener = (w: ToolWarning) => void

const toolWarningListeners = new Set<ToolWarningListener>()
// Buffer warnings emitted before any listener mounts (e.g. a startup-time
// capabilities check), so they aren't lost. Drained on first subscribe.
const pendingWarnings: ToolWarning[] = []
// Ids already surfaced this process, so a repeat within the session never
// double-warns even if the persisted TTL logic is bypassed.
const warnedThisSession = new Set<string>()

export function emitToolWarning(w: ToolWarning): void {
  if (warnedThisSession.has(w.id)) {
    return
  }
  warnedThisSession.add(w.id)
  if (toolWarningListeners.size === 0) {
    pendingWarnings.push(w)
    return
  }
  toolWarningListeners.forEach(l => l(w))
}

export function subscribeToolWarnings(listener: ToolWarningListener): () => void {
  toolWarningListeners.add(listener)
  if (pendingWarnings.length > 0) {
    const drained = pendingWarnings.splice(0, pendingWarnings.length)
    for (const w of drained) {
      listener(w)
    }
  }
  return () => {
    toolWarningListeners.delete(listener)
  }
}

/** Human-readable warning text for a flagged model. */
export function toolWarningMessage(w: ToolWarning): string {
  const base = `Model "${w.id}" `
  switch (w.reason) {
    case 'rejected':
      return (
        base +
        "doesn't support tool use — the provider rejected this request's tools. " +
        'It can still chat, but file edits, search, and other agentic actions ' +
        'will fail. Pick a tool-capable model with /model.'
      )
    case 'capabilities':
      return (
        base +
        'is not advertised as tool-capable by the server. Agentic actions ' +
        '(editing files, running tools) likely won\u2019t work — switch to a ' +
        'tool-capable model with /model if you need them.'
      )
    case 'ignored':
    default:
      return (
        base +
        'appears to ignore tools — it answered in plain text instead of ' +
        'calling the tool it was asked to use. Agentic actions may not work ' +
        'reliably; a stronger model (via /model) will behave better.'
      )
  }
}

// ── Preemptive Ollama capability probe ──────────────────────────────
// Ollama is the one OpenAI-compatible backend that exposes per-model
// capabilities, via its non-standard POST /api/show endpoint, which returns
// `capabilities: ["completion","tools","vision",...]`. No OpenAI-standard
// endpoint carries this, so this is the only way to warn BEFORE the first turn.
// We detect "Ollama-style" purely by base URL shape and probe best-effort;
// any failure is silent (the reactive layers still catch real problems).

function ollamaRootFromBaseURL(baseURL: string): string | null {
  // Ollama's OpenAI-compat base is '<host>/v1'; /api/show lives at '<host>/api/show'.
  const trimmed = baseURL.replace(/\/+$/, '')
  if (/\/v1$/.test(trimmed)) {
    return trimmed.replace(/\/v1$/, '')
  }
  return null
}

function looksLikeOllama(baseURL: string): boolean {
  // Heuristic: localhost/127.0.0.1/0.0.0.0 with the default 11434 port, or a
  // host literally named 'ollama' (docker-compose service). Conservative on
  // purpose — a false positive just means a harmless /api/show probe that 404s.
  return (
    /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|ollama)(?::|\/|$)/.test(
      baseURL,
    ) || /:11434(?:\/|$)/.test(baseURL)
  )
}

/**
 * Best-effort preemptive check: if `modelId`'s provider is an Ollama-style
 * server, ask /api/show whether the model advertises the "tools" capability. If
 * it clearly does NOT, flag+warn once. Returns true if it warned. Any
 * uncertainty (not Ollama, network error, missing capabilities array) → no
 * warning, so we never cry wolf on a model that actually works.
 */
export async function checkOllamaToolCapability(
  modelId: string | null | undefined,
): Promise<boolean> {
  if (!modelId || isToolIncapableModel(modelId)) {
    return false
  }
  const provider = getProviderForModel(modelId)
  if (!provider?.baseURL || !looksLikeOllama(provider.baseURL)) {
    return false
  }
  const root = ollamaRootFromBaseURL(provider.baseURL)
  if (!root) {
    return false
  }
  const key = resolveApiKey(provider)
  try {
    const res = await globalThis.fetch(`${root}/api/show`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify({ model: modelId }),
    })
    if (!res.ok) {
      return false
    }
    const json: any = await res.json().catch(() => null)
    const caps = json?.capabilities
    // Only act on a well-formed, non-empty capabilities array. Anything else is
    // treated as "unknown" → stay silent.
    if (!Array.isArray(caps) || caps.length === 0) {
      return false
    }
    if (!caps.includes('tools')) {
      return recordToolIncapableModel(modelId, 'capabilities')
    }
    return false
  } catch (err) {
    logForDebugging(
      `[openai-compat] Ollama /api/show probe failed for '${modelId}': ${String(err)}`,
    )
    return false
  }
}

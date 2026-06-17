import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import { listProviders, resolveApiKey } from './registry.js'
import type { OpenAICompatModel, OpenAICompatProvider } from './types.js'

// Discovery + self-heal for OpenAI-compatible providers. Mirrors codexModels.ts:
// a background refresh hits each provider's /v1/models endpoint and caches the
// result (config.openAICompatModelCache, merged with the seed by the registry);
// rejected ids are remembered so the /model menu self-heals.

const TTL_MS = 24 * 60 * 60 * 1000 // 24h

function deriveLabel(id: string): string {
  // 'nvidia/llama-3.3-nemotron-super-49b-v1' -> 'Llama 3.3 Nemotron Super 49b V1'
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Fetch a provider's available models from `{baseURL}/models`. Returns null on
 * any failure (no URL, network error, non-OK, unrecognized shape) so callers
 * fall back to the seed. Tolerates `{data:[...]}` and bare `[...]` with string
 * or `{id}` entries.
 */
export async function fetchOpenAICompatModels(
  provider: OpenAICompatProvider,
): Promise<OpenAICompatModel[] | null> {
  if (!provider.baseURL) {
    return null
  }
  const url = `${provider.baseURL.replace(/\/+$/, '')}/models`
  const key = resolveApiKey(provider)
  try {
    const res = await globalThis.fetch(url, {
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(provider.headers ?? {}),
      },
    })
    if (!res.ok) {
      logForDebugging(
        `[openai-compat] ${url} -> HTTP ${res.status} ${res.statusText}`,
      )
      return null
    }
    const json: any = await res.json()
    const data: any[] | null = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : null
    if (!data) {
      return null
    }
    return data
      .map(m => (typeof m === 'string' ? m : m?.id))
      .filter((id: unknown): id is string => typeof id === 'string' && !!id)
      .map(id => ({ id, label: deriveLabel(id) }))
  } catch (err) {
    logForDebugging(`[openai-compat] model discovery failed: ${String(err)}`)
    return null
  }
}

const inFlight = new Set<string>()

/** Refresh + cache one provider's discovered models (TTL-gated unless force). */
export async function refreshProviderModels(
  provider: OpenAICompatProvider,
  force = false,
): Promise<void> {
  const cached = getGlobalConfig().openAICompatModelCache?.[provider.name]
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return
  }
  if (inFlight.has(provider.name)) {
    return
  }
  inFlight.add(provider.name)
  try {
    const models = await fetchOpenAICompatModels(provider)
    if (models && models.length > 0) {
      saveGlobalConfig(config => ({
        ...config,
        openAICompatModelCache: {
          ...(config.openAICompatModelCache ?? {}),
          [provider.name]: { models, fetchedAt: Date.now() },
        },
      }))
      logForDebugging(
        `[openai-compat] discovered ${models.length} models for '${provider.name}'`,
      )
    }
  } finally {
    inFlight.delete(provider.name)
  }
}

/** Refresh every active provider that has a usable key. */
export async function refreshAllOpenAICompatModels(force = false): Promise<void> {
  for (const provider of listProviders()) {
    if (resolveApiKey(provider)) {
      await refreshProviderModels(provider, force)
    }
  }
}

/** Fire-and-forget startup refresh; gates internally on config + freshness. */
export function prefetchOpenAICompatModelsIfSafe(): void {
  try {
    if (listProviders().length === 0) {
      return
    }
  } catch {
    return
  }
  void refreshAllOpenAICompatModels(false).catch(() => {})
}

/**
 * Remember a model id the backend rejected, so the /model menu stops offering
 * it. Stamped with the current time: the block expires after UNSUPPORTED_TTL_MS
 * (see registry) so a transient 404 doesn't hide a valid model forever. A repeat
 * rejection re-stamps the entry, extending the block; a model that has actually
 * gone away stays hidden as long as it keeps being rejected. Legacy `string[]`
 * entries are migrated to the `{id, ts}` shape on write.
 */
export function recordUnsupportedOpenAICompatModel(id: string): void {
  if (!id) {
    return
  }
  try {
    saveGlobalConfig(config => {
      const now = Date.now()
      const current = (config.openAICompatUnsupportedModels ?? []).map(e =>
        typeof e === 'string' ? { id: e, ts: 0 } : e,
      )
      const others = current.filter(e => e.id !== id)
      logForDebugging(`[openai-compat] model '${id}' rejected; hiding from /model`)
      return {
        ...config,
        openAICompatUnsupportedModels: [...others, { id, ts: now }],
      }
    })
  } catch {
    // config not ready — best effort
  }
}

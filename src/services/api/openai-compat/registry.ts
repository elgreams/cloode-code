import { getGlobalConfig } from '../../../utils/config.js'
import { PROVIDER_PRESETS } from './presets.js'
import type { OpenAICompatModel, OpenAICompatProvider } from './types.js'

// How long a model stays hidden after a backend rejection. A single transient
// 404 / "model not found" shouldn't blacklist a valid model forever, so the
// block expires and the model reappears in /model (where a later real rejection
// re-stamps it). 24h mirrors the discovery cache TTL.
export const UNSUPPORTED_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The set of currently-blocked (non-expired) unsupported model ids. Tolerates
 * the legacy `string[]` config shape by treating those entries as already
 * expired, so old config self-clears on upgrade rather than blocking forever.
 */
export function activeUnsupportedOpenAICompatIds(
  raw: ReturnType<typeof getGlobalConfig>['openAICompatUnsupportedModels'],
): Set<string> {
  const now = Date.now()
  const ids = new Set<string>()
  for (const entry of raw ?? []) {
    if (typeof entry === 'string') {
      continue // legacy entry: no timestamp -> treat as expired
    }
    if (entry && now - entry.ts < UNSUPPORTED_TTL_MS) {
      ids.add(entry.id)
    }
  }
  return ids
}

/**
 * All *active* OpenAI-compatible providers: those the user explicitly configured
 * (`config.openAICompatProviders`), plus any built-in preset whose `apiKeyEnv`
 * is set in the environment (the zero-config CI/scripting fallback). Config
 * entries win over presets of the same name.
 *
 * Defensive read: returns [] if config isn't enabled yet, so early callers (e.g.
 * model-list construction) can't crash on the config-access guard.
 */
export function listProviders(): OpenAICompatProvider[] {
  let config: ReturnType<typeof getGlobalConfig>
  try {
    config = getGlobalConfig()
  } catch {
    return []
  }
  const configured = config.openAICompatProviders ?? []
  const names = new Set(configured.map(p => p.name))
  const fromEnv: OpenAICompatProvider[] = PROVIDER_PRESETS.filter(
    p => !names.has(p.name) && !!process.env[p.apiKeyEnv],
  ).map(p => ({ ...p, models: [...p.models] }))

  const cache = config.openAICompatModelCache ?? {}
  const unsupported = activeUnsupportedOpenAICompatIds(
    config.openAICompatUnsupportedModels,
  )

  // Merge each provider's seed models with its discovered cache (seed labels
  // win), then drop any ids the backend has rejected.
  return [...configured, ...fromEnv].map(p => {
    const byId = new Map<string, OpenAICompatModel>()
    for (const m of p.models) {
      if (!byId.has(m.id)) {
        byId.set(m.id, m)
      }
    }
    for (const m of cache[p.name]?.models ?? []) {
      if (!byId.has(m.id)) {
        byId.set(m.id, m)
      }
    }
    return {
      ...p,
      models: [...byId.values()].filter(m => !unsupported.has(m.id)),
    }
  })
}

/** True if `modelId` belongs to a configured/active OpenAI-compatible provider. */
export function isOpenAICompatModel(modelId: string | null | undefined): boolean {
  if (!modelId) {
    return false
  }
  return listProviders().some(p => p.models.some(m => m.id === modelId))
}

/** The provider that serves `modelId`, or undefined. */
export function getProviderForModel(
  modelId: string,
): OpenAICompatProvider | undefined {
  return listProviders().find(p => p.models.some(m => m.id === modelId))
}

/** Resolve a provider's API key: explicit config value, else its env var. */
export function resolveApiKey(provider: OpenAICompatProvider): string | undefined {
  if (provider.apiKey) {
    return provider.apiKey
  }
  if (provider.apiKeyEnv) {
    return process.env[provider.apiKeyEnv] || undefined
  }
  return undefined
}

/** Flat list of every active custom model (for the /model picker, Commit 4). */
export function listOpenAICompatModels(): OpenAICompatModel[] {
  return listProviders().flatMap(p => p.models)
}

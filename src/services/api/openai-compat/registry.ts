import { getGlobalConfig } from '../../../utils/config.js'
import { PROVIDER_PRESETS } from './presets.js'
import type { OpenAICompatModel, OpenAICompatProvider } from './types.js'

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
  const unsupported = new Set(config.openAICompatUnsupportedModels ?? [])

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

// Resolution and caching of the GPT/Codex models the current ChatGPT account
// can actually use. Display reads from the cache (synchronously); a background
// refresh populates it from the Codex backend so the /model menu reflects real
// availability instead of a static guess.
//
// Resolution order for display: cached remote list → static seed (CODEX_MODELS).
// Routing is separate and pattern-based (see codex-fetch-adapter.isCodexModel).

import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { hasCodexAuth } from '../auth.js'
import {
  CODEX_MODELS,
  fetchCodexModels,
} from '../../services/api/codex-fetch-adapter.js'
import { logForDebugging } from '../debug.js'

const CODEX_MODELS_TTL_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * The GPT/Codex model ids to display. Prefers the cached account-specific list
 * from the Codex backend; falls back to the static seed when no cache exists.
 */
export function getResolvedCodexModelIds(): string[] {
  const cached = getGlobalConfig().codexAvailableModels
  if (cached?.models?.length) return cached.models
  return CODEX_MODELS.map(m => m.id)
}

let refreshInFlight = false

/**
 * Refresh the cached account model list from the Codex backend. No-op when no
 * Codex auth, when a refresh is already running, or when the cache is still
 * fresh (unless `force`). A failed/empty fetch leaves any existing cache intact.
 */
export async function refreshCodexAvailableModels(force = false): Promise<void> {
  if (refreshInFlight || !hasCodexAuth()) return
  const cached = getGlobalConfig().codexAvailableModels
  if (!force && cached && Date.now() - cached.fetchedAt < CODEX_MODELS_TTL_MS) {
    return
  }
  refreshInFlight = true
  try {
    const models = await fetchCodexModels()
    if (models && models.length) {
      saveGlobalConfig(config => ({
        ...config,
        codexAvailableModels: { models, fetchedAt: Date.now() },
      }))
      logForDebugging(`Codex available models refreshed: ${models.join(', ')}`)
    } else {
      logForDebugging('Codex available models fetch returned no usable list')
    }
  } finally {
    refreshInFlight = false
  }
}

/**
 * Fire-and-forget refresh for app startup. Safe to call unconditionally; it
 * gates internally on Codex auth and cache freshness.
 */
export function prefetchCodexModelsIfSafe(): void {
  if (!hasCodexAuth()) return
  void refreshCodexAvailableModels(false)
}

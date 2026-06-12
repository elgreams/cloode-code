import { refreshProviderModels } from '../../services/api/openai-compat/discovery.js'
import { getPreset, PROVIDER_PRESETS } from '../../services/api/openai-compat/presets.js'
import {
  isOpenAICompatModel,
  listProviders,
  resolveApiKey,
} from '../../services/api/openai-compat/registry.js'
import type { OpenAICompatProvider } from '../../services/api/openai-compat/types.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

const USAGE = [
  'Manage custom OpenAI-compatible providers:',
  '  /provider                      — list configured providers + models',
  '  /provider presets              — show built-in presets (NIM, OpenRouter, …)',
  '  /provider add <preset> <key>   — add a preset provider (e.g. /provider add nim nvapi-…)',
  '  /provider add custom <url> <key>  — add a self-hosted/other endpoint',
  '  /provider remove <name>        — remove a configured provider',
  '  /provider use <model-id>       — switch the active model to a custom one',
  '',
  'Note: keys are stored in your config (and visible in shell history when passed here).',
].join('\n')

function text(value: string): { type: 'text'; value: string } {
  return { type: 'text', value }
}

export const call: LocalCommandCall = async (args, context) => {
  const parts = (args || '').trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] || 'list').toLowerCase()

  if (sub === 'presets') {
    const lines = PROVIDER_PRESETS.map(
      p =>
        `  ${p.name.padEnd(11)} ${p.label}` +
        (p.baseURL ? ` — ${p.baseURL}` : ' — (you supply the URL)'),
    )
    return text(
      `Built-in presets:\n${lines.join('\n')}\n\nAdd one: /provider add <preset> <api-key>`,
    )
  }

  if (sub === 'list' || sub === 'status') {
    const providers = listProviders()
    if (providers.length === 0) {
      return text(`No OpenAI-compatible providers configured.\n\n${USAGE}`)
    }
    const st = context.getAppState()
    const active = st.mainLoopModelForSession ?? st.mainLoopModel
    const blocks = providers.map(p => {
      const keyed = resolveApiKey(p) ? 'key set' : 'NO KEY'
      const sample = p.models
        .slice(0, 4)
        .map(m => m.id)
        .join(', ')
      return (
        `  • ${p.label || p.name} [${p.name}] — ${p.models.length} models · ${keyed}\n` +
        `    ${p.baseURL}` +
        (sample ? `\n    e.g. ${sample}${p.models.length > 4 ? ', …' : ''}` : '')
      )
    })
    return text(
      `OpenAI-compatible providers:\n${blocks.join('\n')}\n\n` +
        `Active model: ${active ?? '(default)'}\n` +
        `Pick a model with /model, or /provider use <model-id>.`,
    )
  }

  if (sub === 'add') {
    const which = (parts[1] || '').toLowerCase()
    if (!which) {
      return text(USAGE)
    }

    let name: string
    let label: string
    let baseURL: string
    let apiKey: string | undefined
    let seedModels: OpenAICompatProvider['models']

    if (which === 'custom') {
      baseURL = parts[2] || ''
      apiKey = parts[3]
      if (!baseURL || !apiKey) {
        return text('Usage: /provider add custom <baseURL> <api-key>')
      }
      name = 'custom'
      label = 'Custom'
      seedModels = []
    } else {
      const preset = getPreset(which)
      if (!preset) {
        return text(`Unknown preset "${which}". See /provider presets.`)
      }
      if (!preset.baseURL) {
        return text(
          `Preset "${which}" has no fixed URL — use: /provider add custom <baseURL> <api-key>`,
        )
      }
      apiKey = parts[2]
      if (!apiKey) {
        return text(`Usage: /provider add ${which} <api-key>`)
      }
      name = preset.name
      label = preset.label ?? preset.name
      baseURL = preset.baseURL
      seedModels = preset.models.map(m => ({ ...m }))
    }

    const provider: OpenAICompatProvider = {
      name,
      label,
      baseURL,
      apiKey,
      models: seedModels,
    }
    saveGlobalConfig(cfg => {
      const others = (cfg.openAICompatProviders ?? []).filter(
        p => p.name !== name,
      )
      return { ...cfg, openAICompatProviders: [...others, provider] }
    })

    // Discover models (best-effort; the seed still works if this fails).
    try {
      await refreshProviderModels(provider, true)
    } catch {
      // ignore — discovery is optional
    }
    const total =
      listProviders().find(p => p.name === name)?.models.length ??
      seedModels.length
    const discovered =
      getGlobalConfig().openAICompatModelCache?.[name]?.models?.length ?? 0

    // Bump auth version so the model picker / status re-evaluate.
    context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))

    return text(
      `Added "${label}" (${baseURL}).` +
        (discovered ? ` Discovered ${discovered} models.` : '') +
        ` ${total} model${total === 1 ? '' : 's'} available — pick one with /model or /provider use <id>.`,
    )
  }

  if (sub === 'remove') {
    const name = (parts[1] || '').toLowerCase()
    if (!name) {
      return text('Usage: /provider remove <name>')
    }
    let removed = false
    saveGlobalConfig(cfg => {
      const before = cfg.openAICompatProviders ?? []
      const after = before.filter(p => p.name !== name)
      removed = after.length !== before.length
      const cache = { ...(cfg.openAICompatModelCache ?? {}) }
      delete cache[name]
      return { ...cfg, openAICompatProviders: after, openAICompatModelCache: cache }
    })
    context.setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))
    return text(
      removed
        ? `Removed provider "${name}".`
        : `No configured provider "${name}". (Presets auto-activated via env vars aren't removed here — unset the env var instead.)`,
    )
  }

  if (sub === 'use') {
    const model = parts.slice(1).join(' ')
    if (!model) {
      return text('Usage: /provider use <model-id>')
    }
    if (!isOpenAICompatModel(model)) {
      return text(
        `"${model}" isn't an available custom model. See /provider list or /model.`,
      )
    }
    context.setAppState(prev => ({
      ...prev,
      mainLoopModelForSession: model,
    }))
    return text(`Switched to ${model}.`)
  }

  return text(USAGE)
}

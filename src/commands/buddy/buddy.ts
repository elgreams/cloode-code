import { feature } from 'bun:bundle'
import * as React from 'react'
import { randomBytes } from 'crypto'
import {
  getCompanion,
  rollCompanionBones,
} from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import {
  RARITY_STARS,
  SPECIES,
  STAT_NAMES,
  type CompanionBones,
  type SavedCompanion,
  type Species,
  type StoredCompanion,
} from '../../buddy/types.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getSmallFastModel, modelDisplayString } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'

// Deterministic soul (name + personality) generated at hatch from the bones'
// inspiration seed, so a given user always hatches the same characterful
// companion. (The original April Fools build model-generated these; a curated
// pool keeps it instant + offline. Rename anytime with `/buddy rename`.)
const NAMES = [
  'Pixel', 'Biscuit', 'Mochi', 'Sir Quacksworth', 'Noodle', 'Gizmo', 'Waffles',
  'Pebble', 'Tofu', 'Sprocket', 'Marble', 'Clover', 'Dumpling', 'Bramble',
  'Ziggy', 'Pumpkin', 'Cosmo', 'Bandit', 'Maple', 'Hopper', 'Squish', 'Tater',
  'Bingo', 'Nimbus', 'Pickle', 'Wren', 'Fig', 'Bubbles', 'Taco', 'Mango',
  'Wobble', 'Echo', 'Pip', 'Cricket', 'Smudge', 'Doodle', 'Bean', 'Snickers',
]

const TRAITS = [
  'deeply suspicious of semicolons',
  'convinced every bug is a feature',
  'here for moral support, not code review',
  'powered entirely by snacks and spite',
  'a connoisseur of long compile times',
  'allergic to merge conflicts',
  'always rooting for the underdog PR',
  'fluent in sarcasm and little else',
  'just happy to be in the terminal',
  'pretty sure it could refactor this better',
]

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) | 0
    let t = Math.imul(a ^ (a >>> 16), 0x21f0aaad)
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97)
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

function generateSoul(
  bones: CompanionBones,
  seed: number,
): { name: string; personality: string } {
  const rng = prng(seed)
  const name = NAMES[Math.floor(rng() * NAMES.length)]!
  const top = [...STAT_NAMES].sort((a, b) => bones.stats[b] - bones.stats[a])[0]!
  const trait = TRAITS[Math.floor(rng() * TRAITS.length)]!
  const personality = `A ${bones.rarity} ${bones.species} with ${top.toLowerCase()} to spare — ${trait}.`
  return { name, personality }
}

function statBar(n: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, n)) / 100) * 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function speciesFromArg(arg: string): Species | undefined {
  return SPECIES.find(species => species === arg)
}

function hatchCompanion(): { soul: StoredCompanion; bones: CompanionBones } {
  const { bones, inspirationSeed } = rollCompanionBones()
  const soul = { ...generateSoul(bones, inspirationSeed), hatchedAt: Date.now() }
  // A fresh hatch (select/reroll/default/hatch) re-rolls from the account, so
  // drop any pin left over from a previously loaded save.
  saveGlobalConfig(c => ({ ...c, companion: soul, companionBones: undefined }))
  return { soul, bones }
}

function overrideLabel(): string {
  const override = getGlobalConfig().companionOverride
  if (override?.mode === 'selected') return `selected (${override.selectedSpecies})`
  if (override?.mode === 'rerolled') return 'rerolled'
  return 'account default'
}

function shinyLabel(): string {
  const override = getGlobalConfig().companionShinyOverride
  if (override === true) return 'forced on'
  if (override === false) return 'forced off'
  return 'natural roll'
}

function buddyModelLabel(): string {
  const model = getGlobalConfig().companionModel
  return model ? `override (${model})` : `default small-fast (${getSmallFastModel()})`
}

const DEFAULT_BUDDY_MODEL = '__DEFAULT_BUDDY_MODEL__'

type BuddyModelPickerValue = string

function BuddyModelPicker({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: 'system' | 'skip' }) => void
}): React.ReactNode {
  const current = getGlobalConfig().companionModel
  const defaultModel = getSmallFastModel()
  const options: OptionWithDescription<BuddyModelPickerValue>[] = [
    {
      value: DEFAULT_BUDDY_MODEL,
      label: 'Default small-fast',
      description: defaultModel,
    },
    ...getModelOptions(false)
      .filter(option => option.value !== null)
      .map(option => ({
        value: option.value as string,
        label: option.label,
        description: option.description,
      })),
  ]
  const defaultValue = current ?? DEFAULT_BUDDY_MODEL
  const defaultFocusValue = options.some(option => option.value === defaultValue)
    ? defaultValue
    : DEFAULT_BUDDY_MODEL

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { marginBottom: 1, flexDirection: 'column' },
      React.createElement(Text, { color: 'remember', bold: true }, 'Select buddy model'),
      React.createElement(
        Text,
        { dimColor: true },
        'Only companion quips use this model. Main chat model is unchanged.',
      ),
    ),
    React.createElement(Select<BuddyModelPickerValue>, {
      defaultValue,
      defaultFocusValue,
      options,
      visibleOptionCount: Math.min(10, options.length),
      onCancel: () => {
        onDone(`Kept buddy model as ${buddyModelLabel()}`, { display: 'system' })
      },
      onChange: value => {
        if (value === DEFAULT_BUDDY_MODEL) {
          saveGlobalConfig(c => ({ ...c, companionModel: undefined }))
          onDone(`Buddy model reset to default small-fast (${defaultModel}).`)
          return
        }
        saveGlobalConfig(c => ({ ...c, companionModel: value }))
        onDone(`Buddy model set to ${modelDisplayString(value)}. Main chat model unchanged.`)
      },
    }),
  )
}

function normalizeSaveLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').slice(0, 32)
}

function saveKey(saved: SavedCompanion): string {
  return saved.label.toLowerCase()
}

function findSavedCompanion(
  saved: SavedCompanion[],
  query: string,
): SavedCompanion | undefined {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return undefined
  return saved.find(s => s.id === normalized || saveKey(s) === normalized)
}

function formatSavedList(saved: SavedCompanion[]): string {
  if (saved.length === 0) return 'No saved companions yet. Use `/buddy save [name]`.'
  return saved
    .map(s => `- **${s.label}** (${s.id}) — saved ${new Date(s.savedAt).toLocaleDateString()}`)
    .join('\n')
}

// A fenced text card: sprite art + name/rarity + stat bars + personality.
function formatCard(
  name: string,
  personality: string,
  bones: CompanionBones,
): string {
  const art = renderSprite(bones).join('\n')
  const shiny = bones.shiny ? ' ✨shiny✨' : ''
  const stats = STAT_NAMES.map(
    s => `${s.padEnd(10)} ${statBar(bones.stats[s])} ${String(bones.stats[s]).padStart(3)}`,
  ).join('\n')
  return [
    '```',
    art,
    '',
    `${name}  ${RARITY_STARS[bones.rarity]}`,
    `${bones.rarity} ${bones.species}${shiny}`,
    '',
    stats,
    '```',
    `_${personality}_`,
  ].join('\n')
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const say = (m: string): null => {
    onDone(m, { display: 'system' })
    return null
  }
  if (!feature('BUDDY')) {
    return say('Companions are not enabled in this build.')
  }

  const trimmed = (args ?? '').trim()
  const sub = (trimmed.split(/\s+/)[0] ?? '').toLowerCase()
  const restStr = trimmed.slice(sub.length).trim()

  const stored = getGlobalConfig().companion

  if (sub === 'list') {
    return say(
      `Available companions:\n\n${SPECIES.map(species => `- ${species}`).join('\n')}\n\nUse \`/buddy select <species>\`, \`/buddy reroll\`, or \`/buddy default\`.`,
    )
  }

  if (sub === 'cheat') {
    return say(
      `Buddy cheat menu\n\nCurrent mode: **${overrideLabel()}**\nShiny mode: **${shinyLabel()}**\nBuddy model: **${buddyModelLabel()}**\n\nCommands:\n- \`/buddy list\` — show available species\n- \`/buddy select <species>\` — choose a companion species\n- \`/buddy reroll\` — roll a new deterministic companion\n- \`/buddy save [name]\` — save the current companion\n- \`/buddy saved\` — list saved companions\n- \`/buddy load <name|id>\` — restore a saved companion\n- \`/buddy delete <name|id>\` — delete a saved companion\n- \`/buddy shiny\` — toggle shiny on/off\n- \`/buddy shiny reset\` — return to natural shiny roll\n- \`/buddy model [model|default]\` — set the model used for companion quips\n- \`/buddy default\` — reset to account default\n- \`/buddy current\` — show current companion`,
    )
  }

  if (sub === 'select') {
    const species = speciesFromArg(restStr.toLowerCase())
    if (!species) {
      return say(
        `Usage: \`/buddy select <species>\`\n\nAvailable: ${SPECIES.join(', ')}`,
      )
    }
    saveGlobalConfig(c => ({
      ...c,
      companionOverride: { mode: 'selected', selectedSpecies: species },
    }))
    const { soul, bones } = hatchCompanion()
    return say(
      `Selected **${species}**.\n\n${formatCard(soul.name, soul.personality, bones)}`,
    )
  }

  if (sub === 'reroll') {
    const rerollSeed = randomBytes(6).toString('hex')
    saveGlobalConfig(c => ({
      ...c,
      companionOverride: { mode: 'rerolled', rerollSeed },
    }))
    const { soul, bones } = hatchCompanion()
    return say(
      `Rerolled your companion.\n\n${formatCard(soul.name, soul.personality, bones)}`,
    )
  }

  if (sub === 'default') {
    saveGlobalConfig(c => ({ ...c, companionOverride: undefined }))
    const { soul, bones } = hatchCompanion()
    return say(
      `Reset to your account default companion.\n\n${formatCard(soul.name, soul.personality, bones)}`,
    )
  }

  if (sub === 'shiny') {
    const normalized = restStr.toLowerCase()
    let shinyOverride: boolean | undefined
    if (normalized === '') {
      shinyOverride = !rollCompanionBones().bones.shiny
    } else if (normalized === 'on') {
      shinyOverride = true
    } else if (normalized === 'off') {
      shinyOverride = false
    } else if (normalized === 'reset') {
      shinyOverride = undefined
    } else {
      return say('Usage: `/buddy shiny [on|off|reset]`')
    }

    saveGlobalConfig(c => ({ ...c, companionShinyOverride: shinyOverride }))
    const companion = getCompanion()
    if (!companion) {
      return say('Shiny setting saved. Run `/buddy` to hatch a companion.')
    }
    const prefix =
      shinyOverride === undefined
        ? 'Reset shiny to natural roll.'
        : `Shiny ${shinyOverride ? 'enabled' : 'disabled'}.`
    return say(
      `${prefix}\n\n${formatCard(companion.name, companion.personality, companion)}`,
    )
  }

  if (sub === 'model') {
    const model = restStr.trim()
    if (!model) {
      return React.createElement(BuddyModelPicker, { onDone })
    }
    if (model.toLowerCase() === 'default' || model.toLowerCase() === 'reset') {
      saveGlobalConfig(c => ({ ...c, companionModel: undefined }))
      return say(`Buddy model reset to **default small-fast (${getSmallFastModel()})**.`)
    }
    // Validate against the known model ids (the interactive picker does; the
    // text path didn't). An unknown id would persist, then every observer turn
    // throws inside queryHaiku — swallowed by the observer's try/catch — so the
    // companion goes silently mute with no feedback. Reject up front instead.
    const known = getModelOptions(false).some(option => option.value === model)
    if (!known) {
      return say(
        `Unknown model **${model}**. Run \`/buddy model\` to pick from available models.`,
      )
    }
    saveGlobalConfig(c => ({ ...c, companionModel: model }))
    return say(`Buddy model set to **${model}**. Main chat model unchanged.`)
  }

  if (sub === 'saved' || sub === 'saves') {
    return say(`Saved companions:\n\n${formatSavedList(getGlobalConfig().companionSaved ?? [])}`)
  }

  if (sub === 'save') {
    const config = getGlobalConfig()
    if (!config.companion) {
      return say('No companion to save yet. Run `/buddy` to hatch one.')
    }
    const label = normalizeSaveLabel(restStr || config.companion.name)
    if (!label) return say('Usage: `/buddy save [name]`')

    // Snapshot the exact bones on screen now, so loading this save restores the
    // same creature under any account instead of re-rolling from its UUID.
    const current = getCompanion()
    const saved: SavedCompanion = {
      id: randomBytes(3).toString('hex'),
      label,
      companion: config.companion,
      override: config.companionOverride,
      shinyOverride: config.companionShinyOverride,
      bones: current
        ? {
            rarity: current.rarity,
            species: current.species,
            eye: current.eye,
            hat: current.hat,
            shiny: current.shiny,
            stats: current.stats,
          }
        : undefined,
      savedAt: Date.now(),
    }
    saveGlobalConfig(c => {
      const existing = c.companionSaved ?? []
      const withoutSameLabel = existing.filter(s => saveKey(s) !== saveKey(saved))
      return { ...c, companionSaved: [...withoutSameLabel, saved] }
    })
    return say(`Saved **${label}** (${saved.id}).`)
  }

  if (sub === 'load') {
    const config = getGlobalConfig()
    const saved = findSavedCompanion(config.companionSaved ?? [], restStr)
    if (!saved) {
      return say(`Usage: \`/buddy load <name|id>\`\n\n${formatSavedList(config.companionSaved ?? [])}`)
    }
    saveGlobalConfig(c => ({
      ...c,
      companion: saved.companion,
      companionOverride: saved.override,
      companionShinyOverride: saved.shinyOverride,
      // Pin the saved bones so the creature looks identical regardless of the
      // active account. Older saves without bones fall back to re-rolling.
      companionBones: saved.bones,
    }))
    const companion = getCompanion()
    if (!companion) return say(`Loaded **${saved.label}**.`)
    return say(
      `Loaded **${saved.label}**.\n\n${formatCard(companion.name, companion.personality, companion)}`,
    )
  }

  if (sub === 'delete' || sub === 'remove') {
    const config = getGlobalConfig()
    const saved = findSavedCompanion(config.companionSaved ?? [], restStr)
    if (!saved) {
      return say(`Usage: \`/buddy delete <name|id>\`\n\n${formatSavedList(config.companionSaved ?? [])}`)
    }
    saveGlobalConfig(c => ({
      ...c,
      companionSaved: (c.companionSaved ?? []).filter(s => s.id !== saved.id),
    }))
    return say(`Deleted saved companion **${saved.label}** (${saved.id}).`)
  }

  // Hatch when there's no companion yet and no (or an explicit "hatch") arg.
  if (!stored && (sub === '' || sub === 'hatch')) {
    const { soul, bones } = hatchCompanion()
    return say(
      `🥚✨ A companion hatched!\n\n${formatCard(soul.name, soul.personality, bones)}\n\nIt now lives beside your prompt. Try \`/buddy pet\`, \`/buddy rename <name>\`, \`/buddy save [name]\`, \`/buddy select <species>\`, \`/buddy reroll\`, or \`/buddy release\`.`,
    )
  }
  if (!stored) {
    return say("You don't have a companion yet — run `/buddy` to hatch one.")
  }

  const companion = getCompanion()
  if (!companion) {
    return say('Could not load your companion. Try `/buddy` again.')
  }

  switch (sub) {
    case '':
    case 'show':
      return say(formatCard(companion.name, companion.personality, companion))
    case 'current':
      return say(
        `Current mode: **${overrideLabel()}**\nShiny mode: **${shinyLabel()}**\nBuddy model: **${buddyModelLabel()}**\n\n${formatCard(companion.name, companion.personality, companion)}`,
      )
    case 'pet':
      context.setAppState(s => ({ ...s, companionPetAt: Date.now() }))
      return say(`💕 You pet ${companion.name}.`)
    case 'rename': {
      const newName = restStr.slice(0, 24)
      if (!newName) {
        return say('Usage: `/buddy rename <name>`')
      }
      saveGlobalConfig(c =>
        c.companion ? { ...c, companion: { ...c.companion, name: newName } } : c,
      )
      return say(`Renamed to **${newName}**.`)
    }
    case 'release':
      saveGlobalConfig(c => ({ ...c, companion: undefined, companionBones: undefined }))
      return say(
        `👋 You released ${companion.name}. Run \`/buddy\` to hatch a new one.`,
      )
    case 'mute':
      saveGlobalConfig(c => ({ ...c, companionMuted: true }))
      return say(
        `🔇 ${companion.name} muted — the sprite is hidden. \`/buddy unmute\` brings it back.`,
      )
    case 'unmute':
      saveGlobalConfig(c => ({ ...c, companionMuted: false }))
      return say(`🔊 ${companion.name} is back.`)
    default:
      return say(
        `Unknown subcommand "${sub}". Try: \`/buddy\` (show), \`pet\`, \`rename <name>\`, \`save [name]\`, \`saved\`, \`load <name|id>\`, \`delete <name|id>\`, \`list\`, \`select <species>\`, \`reroll\`, \`shiny\`, \`model\`, \`default\`, \`release\`, \`mute\`, \`unmute\`.`,
      )
  }
}

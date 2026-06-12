import { feature } from 'bun:bundle'
import {
  companionUserId,
  getCompanion,
  roll,
} from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import {
  RARITY_STARS,
  STAT_NAMES,
  type CompanionBones,
  type StoredCompanion,
} from '../../buddy/types.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

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

  // Hatch when there's no companion yet and no (or an explicit "hatch") arg.
  if (!stored && (sub === '' || sub === 'hatch')) {
    const { bones, inspirationSeed } = roll(companionUserId())
    const soul = generateSoul(bones, inspirationSeed)
    const hatched: StoredCompanion = { ...soul, hatchedAt: Date.now() }
    saveGlobalConfig(c => ({ ...c, companion: hatched }))
    return say(
      `🥚✨ A companion hatched!\n\n${formatCard(soul.name, soul.personality, bones)}\n\nIt now lives beside your prompt. Try \`/buddy pet\`, \`/buddy rename <name>\`, \`/buddy mute\`, or \`/buddy release\`.`,
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
      saveGlobalConfig(c => ({ ...c, companion: undefined }))
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
        `Unknown subcommand "${sub}". Try: \`/buddy\` (show), \`pet\`, \`rename <name>\`, \`release\`, \`mute\`, \`unmute\`.`,
      )
  }
}

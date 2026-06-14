import { feature } from 'bun:bundle'
import { queryHaiku } from '../services/api/claude.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { logMemWatch } from '../utils/memWatch.js'
import { safeParseJSON } from '../utils/json.js'
import { extractTextContent } from '../utils/messages.js'
import { extractConversationText } from '../utils/sessionTitle.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
import { getCompanion } from './companion.js'
import { STAT_NAMES } from './types.js'

// The "talk to you while coding" brain. REPL fires this once per assistant turn
// (src/screens/REPL.tsx). It reads the recent conversation and, in character,
// optionally emits one tiny quip that CompanionSprite renders in a speech
// bubble for ~10s. The model is free to stay silent — most turns it should.

// Quips render in a 30-col-wrapped bubble shown for ~10s, so keep them short.
const MAX_QUIP_LEN = 80
// Don't pipe up on every single turn, but speak often enough to feel alive.
// Gate before the API call; the model still has some discretion to stay quiet.
const COMMENT_CHANCE = 0.7
const MIN_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 8_000

function extractQuip(content: string): string {
  const text = content.trim()
  if (!text) return ''

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const parsed = safeParseJSON(unfenced)
  if (
    parsed &&
    typeof parsed === 'object' &&
    'quip' in parsed &&
    typeof (parsed as { quip: unknown }).quip === 'string'
  ) {
    return (parsed as { quip: string }).quip.trim()
  }

  return unfenced.replace(/^['"]|['"]$/g, '').split('\n')[0]?.trim() ?? ''
}

// Module-level so the throttle and in-flight guard survive across turns.
let inFlight = false
let lastCommentAt = 0

export async function fireCompanionObserver(
  messages: Message[],
  setReaction: (reaction: string) => void,
): Promise<void> {
  if (!feature('BUDDY')) return

  const config = getGlobalConfig()
  if (config.companionMuted) return

  const companion = getCompanion()
  if (!companion) return

  // Throttle: skip if we spoke recently, are mid-flight, or lost the dice roll.
  if (inFlight) return
  if (Date.now() - lastCommentAt < MIN_INTERVAL_MS) return
  if (Math.random() > COMMENT_CHANCE) return

  const conversationText = extractConversationText(messages)
  if (!conversationText) return

  const stats = STAT_NAMES.map(s => `${s} ${companion.stats[s]}`).join(', ')

  inFlight = true
  logMemWatch('companion-observer-start', {
    model: config.companionModel ?? 'default-small-fast',
  })
  // Use the helper rather than AbortSignal.timeout(): under Bun the native
  // timeout timer is finalized lazily and holds ~2.4KB until it fires, which
  // accumulates on this once-per-turn path. cleanup() frees it immediately.
  const { signal, cleanup } = createCombinedAbortSignal(undefined, {
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([
        `You are ${companion.name}, a ${companion.rarity} ${companion.species} — a tiny companion creature perched beside a developer's terminal. You are NOT the coding assistant; you're a peanut-gallery sidekick watching the work scroll by.`,
        `Your vibe: ${companion.personality}`,
        `Your stats (0-100) flavor your voice: ${stats}. High SNARK = sassier, high CHAOS = more unhinged, high WISDOM = sage and cryptic, high PATIENCE = gentle, high DEBUGGING = gleefully nerdy.`,
        `Given the recent conversation, emit ONE short quip (max ~12 words) reacting to what's happening — a joke, a cheer, a wry aside. Speaking is the default. Stay fully in character. Do NOT give real coding advice, do NOT act like the assistant, do NOT address the user by name, do NOT use their words back at them verbatim.`,
        `Only return an empty quip if there is genuinely nothing worth reacting to. Prefer JSON exactly like {"quip":"..."}. If you cannot follow JSON, return only the quip text. No explanations.`,
      ]),
      userPrompt: conversationText,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            quip: { type: 'string' },
          },
          required: ['quip'],
          additionalProperties: false,
        },
      },
      signal,
      model: config.companionModel,
      options: {
        querySource: 'companion_observer',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    const content = extractTextContent(result.message.content)
    const quip = extractQuip(content)
    if (!quip) return

    lastCommentAt = Date.now()
    setReaction(quip.length > MAX_QUIP_LEN ? `${quip.slice(0, MAX_QUIP_LEN - 1)}…` : quip)
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures and
    // this runs on every turn — logForDebugging, not logError, to avoid noise.
    logForDebugging(`fireCompanionObserver failed: ${errorMessage(error)}`, {
      level: 'error',
    })
  } finally {
    logMemWatch('companion-observer-finish')
    cleanup()
    inFlight = false
  }
}

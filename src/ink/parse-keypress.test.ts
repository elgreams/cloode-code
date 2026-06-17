import { expect, test } from 'bun:test'
import { INITIAL_STATE, type ParsedKey, parseMultipleKeypresses } from './parse-keypress.js'

// Parse a single escape sequence and return the one ParsedKey it produces.
// Asserts exactly one key came out so a regression that splits/merges a
// sequence surfaces here rather than as a confusing undefined downstream.
function parseOne(seq: string): ParsedKey {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, seq)
  expect(keys.length).toBe(1)
  const k = keys[0]!
  expect(k.kind).toBe('key')
  return k as ParsedKey
}

// ── Kitty keyboard protocol: event-type sub-parameter ──────────────────
// Format: CSI codepoint ; modifier:event_type u (event_type 1=press,
// 2=repeat, 3=release). Drives push-to-talk release detection — see
// useVoice.ts. Without "report event types" (flag bit 2) the sub-param is
// absent and eventType must be undefined (legacy press-only behavior).

test('CSI u without event-type sub-param leaves eventType undefined', () => {
  // ESC[32u = space, no modifier, no event type → treated as a press.
  const k = parseOne('\x1b[32u')
  expect(k.name).toBe('space')
  expect(k.eventType).toBeUndefined()
})

test('CSI u with explicit press event-type (1)', () => {
  // ESC[32;1:1u = space, no modifiers, press.
  const k = parseOne('\x1b[32;1:1u')
  expect(k.name).toBe('space')
  expect(k.eventType).toBe('press')
})

test('CSI u with repeat event-type (2)', () => {
  const k = parseOne('\x1b[32;1:2u')
  expect(k.name).toBe('space')
  expect(k.eventType).toBe('repeat')
})

test('CSI u with release event-type (3)', () => {
  const k = parseOne('\x1b[32;1:3u')
  expect(k.name).toBe('space')
  expect(k.eventType).toBe('release')
})

test('event-type sub-param coexists with a real modifier', () => {
  // ESC[97;5:3u = Ctrl+a release (modifier 5 = ctrl per Kitty encoding).
  const k = parseOne('\x1b[97;5:3u')
  expect(k.name).toBe('a')
  expect(k.ctrl).toBe(true)
  expect(k.eventType).toBe('release')
})

test('codepoint alternate-key sub-params are ignored, event-type still parses', () => {
  // Codepoint may carry colon sub-params (shifted/base-layout key codes).
  // ESC[97:65;2:3u = base 'a' / shifted 'A', shift modifier, release.
  const k = parseOne('\x1b[97:65;2:3u')
  expect(k.name).toBe('a')
  expect(k.shift).toBe(true)
  expect(k.eventType).toBe('release')
})

test('plain modifier without event-type still has undefined eventType', () => {
  // ESC[13;2u = Shift+Enter, no event-type reporting.
  const k = parseOne('\x1b[13;2u')
  expect(k.name).toBe('return')
  expect(k.shift).toBe(true)
  expect(k.eventType).toBeUndefined()
})

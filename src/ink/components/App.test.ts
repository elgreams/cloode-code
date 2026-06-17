import { expect, test } from 'bun:test'
import { EventEmitter } from '../events/emitter.js'
import type { InputEvent } from '../events/input-event.js'
import type { ParsedKey } from '../parse-keypress.js'
import { processKeysInBatch } from './App.js'

// Build a ParsedKey for a single printable char with an optional Kitty
// event type. Defaults mirror parseKeypress output for a bare char.
function key(name: string, eventType?: ParsedKey['eventType']): ParsedKey {
  return {
    kind: 'key',
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name,
    raw: name,
    isPasted: false,
    eventType,
  }
}

// Minimal App stand-in exposing only what processKeysInBatch touches for
// plain key events. processKeysInBatch is a free function taking `app`, so
// a structural stub is enough — no React/terminal needed.
function makeFakeApp() {
  const emitter = new EventEmitter()
  const inputs: InputEvent[] = []
  const releases: ParsedKey[] = []
  const dispatched: ParsedKey[] = []
  emitter.on('input', (e: InputEvent) => inputs.push(e))
  emitter.on('keyrelease', (k: ParsedKey) => releases.push(k))
  const app = {
    internal_eventEmitter: emitter,
    handleInput: () => {},
    handleSuspend: () => {},
    props: { dispatchKeyboardEvent: (k: ParsedKey) => dispatched.push(k) },
  }
  return { app, inputs, releases, dispatched }
}

// Release events (Kitty event_type=3) must NOT reach the normal input sinks,
// or every useInput/onKeyDown handler double-fires. They go to 'keyrelease'.

test('press event flows through normal input sinks, not keyrelease', () => {
  const { app, inputs, releases, dispatched } = makeFakeApp()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processKeysInBatch(app as any, [key('x', 'press')], undefined, undefined)
  expect(inputs.length).toBe(1)
  expect(dispatched.length).toBe(1)
  expect(releases.length).toBe(0)
})

test('release event is diverted to keyrelease and skips input sinks', () => {
  const { app, inputs, releases, dispatched } = makeFakeApp()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processKeysInBatch(app as any, [key('x', 'release')], undefined, undefined)
  expect(inputs.length).toBe(0)
  expect(dispatched.length).toBe(0)
  expect(releases.length).toBe(1)
  expect(releases[0]!.name).toBe('x')
})

test('repeat event behaves like a press (held keys keep typing)', () => {
  const { app, inputs, releases } = makeFakeApp()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processKeysInBatch(app as any, [key('x', 'repeat')], undefined, undefined)
  expect(inputs.length).toBe(1)
  expect(releases.length).toBe(0)
})

test('undefined eventType (legacy terminal) flows as a normal keystroke', () => {
  const { app, inputs, releases } = makeFakeApp()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processKeysInBatch(app as any, [key('x')], undefined, undefined)
  expect(inputs.length).toBe(1)
  expect(releases.length).toBe(0)
})

test('press+release of one key yields exactly one keystroke', () => {
  const { app, inputs, releases } = makeFakeApp()
  processKeysInBatch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app as any,
    [key('x', 'press'), key('x', 'release')],
    undefined,
    undefined,
  )
  expect(inputs.length).toBe(1)
  expect(releases.length).toBe(1)
})

import { useEffect } from 'react'
import { useEventCallback } from 'usehooks-ts'
import type { ParsedKey } from '../parse-keypress.js'
import useStdin from './use-stdin.js'

type Handler = (key: ParsedKey) => void

type Options = {
  /** Disable the listener without unmounting the consumer. @default true */
  isActive?: boolean
}

/**
 * Subscribe to Kitty keyboard-protocol key *release* events.
 *
 * Releases only flow when the terminal supports the "report event types"
 * flag and we've enabled it (see ink.tsx / terminal.ts allowlist). App.tsx
 * diverts release events (event_type=3) off the normal `'input'` channel —
 * they would otherwise double-fire every useInput handler — and re-emits
 * them on this dedicated `'keyrelease'` channel. On terminals without event
 * reporting this hook simply never fires, and consumers must fall back to a
 * timing heuristic (see useVoice.ts).
 *
 * The handler receives the raw ParsedKey so consumers can match on
 * name/modifiers (e.g. space release ends push-to-talk).
 */
export function useKeyRelease(handler: Handler, options: Options = {}): void {
  const { internal_eventEmitter } = useStdin()

  // Stable listener reference reading the latest handler/isActive from
  // closure — mirrors useInput so listener-array ordering stays stable.
  const onRelease = useEventCallback((key: ParsedKey) => {
    if (options.isActive === false) return
    handler(key)
  })

  useEffect(() => {
    internal_eventEmitter?.on('keyrelease', onRelease)
    return () => {
      internal_eventEmitter?.removeListener('keyrelease', onRelease)
    }
  }, [internal_eventEmitter, onRelease])
}

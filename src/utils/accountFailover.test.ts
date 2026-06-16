import { expect, test } from 'bun:test'
import {
  currentLimits,
  emitStatusChange,
  getRawUtilization,
  resetLimitSignal,
} from '../services/claudeAiLimits.js'
import { exhaustionReset } from './accountFailover.js'

const THRESHOLD = 0.95

// Regression: the process-global rate-limit signal (currentLimits /
// rawUtilization) is NOT per-account. When the active account is exhausted and
// we switch tokens, switchToAccount() must clear that signal via
// resetLimitSignal(). Otherwise the next turn boundary reads the OLD account's
// "rejected" state through exhaustionReset() and stamps the freshly-switched
// account as exhausted too — every account ends up marked dead and failover
// stalls on "all accounts exhausted". These tests pin the clear-on-switch
// contract at its seam: a rejected signal must read as exhausted before the
// reset and as clean after it.
test('a rejected (non-overage) signal reads as exhausted', () => {
  emitStatusChange({
    status: 'rejected',
    resetsAt: Date.now() / 1000 + 3600,
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  })
  expect(
    exhaustionReset(currentLimits, getRawUtilization(), THRESHOLD),
  ).not.toBeNull()
})

// Regression: a stamp, once written, must not outlive the actual limit. The
// failover listener now drives setAccountExhausted with `reset ?? undefined`,
// so a healthy reading clears the active account's stamp (self-heal on the next
// good response). This pins the precondition: an 'allowed' signal below the
// threshold yields a null reset, which the listener passes as `undefined` to
// clear the stamp. Without this, an account keeps serving requests while
// failover still thinks it's dead, surfacing a false "all accounts exhausted".
test('a healthy (allowed) signal yields a null reset (drives stamp clear)', () => {
  emitStatusChange({
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  })
  expect(
    exhaustionReset(currentLimits, getRawUtilization(), THRESHOLD),
  ).toBeNull()
})

test('resetLimitSignal clears the signal so it no longer reads exhausted', () => {
  emitStatusChange({
    status: 'rejected',
    resetsAt: Date.now() / 1000 + 3600,
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  })
  // Sanity: exhausted before the reset.
  expect(
    exhaustionReset(currentLimits, getRawUtilization(), THRESHOLD),
  ).not.toBeNull()

  // This is what switchToAccount() now runs on every switch.
  resetLimitSignal()

  // The just-switched-to account must start from a clean slate.
  expect(currentLimits.status).toBe('allowed')
  expect(getRawUtilization()).toEqual({})
  expect(
    exhaustionReset(currentLimits, getRawUtilization(), THRESHOLD),
  ).toBeNull()
})

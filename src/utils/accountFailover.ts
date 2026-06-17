/**
 * Auto-failover between saved Anthropic accounts (build step 6).
 *
 * Detection and action are deliberately separated:
 *   - DETECTION happens mid-request, driven by the rate-limit signal
 *     (statusListeners / currentLimits / getRawUtilization in claudeAiLimits).
 *     The listener only RECORDS state — it stamps the active account's reset
 *     time onto its saved entry. It never switches.
 *   - ACTION happens only at a turn boundary, via maybeFailoverBetweenTurns(),
 *     which the REPL calls before issuing the next request. This guarantees we
 *     never swap the live token mid-response.
 *
 * Failover is driven solely from the main REPL turn boundary. Teammates,
 * sub-agents and background tasks do not trigger it; they pick up the new token
 * on their next request because the switch is a single global write to the live
 * slot. No mid-stream re-issue.
 */
import {
  currentLimits,
  getRawUtilization,
  statusListeners,
  type ClaudeAILimits,
} from '../services/claudeAiLimits.js'
import {
  getActiveAccountId,
  listSavedAccounts,
  setAccountExhausted,
  switchToAccount,
  type SavedAccount,
} from './accountSwitch.js'
import { getGlobalConfig } from './config.js'

const DEFAULT_THRESHOLD = 0.95

// Fallback "exhausted until" horizon for a hard rejection that carried no reset
// timestamp. Long enough that failover rotates off the rejecting account, short
// enough that the account becomes a candidate again soon if every account is in
// the same state. A real reset from response headers supersedes it.
const REJECTION_BACKOFF_SECONDS = 60

function failoverEnabled(): boolean {
  return getGlobalConfig().autoAccountFailover === true
}

function threshold(): number {
  const t = getGlobalConfig().autoAccountFailoverThreshold
  return typeof t === 'number' && t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD
}

/**
 * If the given limit signal indicates the active account is exhausted, return
 * the unix-epoch (seconds) time it becomes usable again; otherwise null.
 *
 * Exhausted means either:
 *   - a hard rejection that is NOT being served from overage (always fails
 *     over, regardless of threshold — a rejection can land before any
 *     utilization header reads high), or
 *   - any tracked window (5h / 7d) at or above the utilization threshold.
 *
 * When multiple windows are exhausted the account is not usable until the
 * LATEST of them resets, so we return the max.
 */
export function exhaustionReset(
  limits: ClaudeAILimits,
  raw: ReturnType<typeof getRawUtilization>,
  thresholdFraction: number,
): number | null {
  if (limits.status === 'rejected' && !limits.isUsingOverage) {
    // Prefer the representative reset; fall back to the soonest window reset.
    const windowResets = [raw.five_hour?.resets_at, raw.seven_day?.resets_at]
      .filter((n): n is number => typeof n === 'number')
    // A hard rejection ALWAYS exhausts the account, even when the error carried
    // no reset timestamp (a bare 429 with no unified ratelimit headers). Falling
    // back to null here would read as "account is fine" and suppress failover on
    // a real rejection. Use a short backoff sentinel so the turn-boundary switch
    // still rotates; a real reset overwrites it on the next response with headers.
    return (
      limits.resetsAt ??
      (windowResets.length
        ? Math.min(...windowResets)
        : Date.now() / 1000 + REJECTION_BACKOFF_SECONDS)
    )
  }

  let latest: number | null = null
  for (const w of [raw.five_hour, raw.seven_day]) {
    if (w && w.utilization >= thresholdFraction) {
      latest = latest == null ? w.resets_at : Math.max(latest, w.resets_at)
    }
  }
  return latest
}

/**
 * Listener: keep the active account's exhaustion stamp in sync with the live
 * signal. When the account is seen exhausted, stamp its reset time so the
 * turn-boundary switch knows the correct identity's reset (currentLimits will
 * change to the NEW account after a switch, losing the old reset otherwise).
 * When the account is seen HEALTHY (reset == null), clear any existing stamp —
 * otherwise a stamp, once written, outlives the actual limit: the account keeps
 * serving requests fine but failover still treats it as dead until its reset
 * time, and with the other account also exhausted that surfaces as a false
 * "all accounts exhausted". Clearing on a healthy reading makes the active
 * account self-heal on its next successful response. Gated on the feature being
 * on so we never write limit-state into config for users who haven't opted in.
 * setAccountExhausted is a no-op when the value is unchanged, so this won't
 * churn the config file as limits jitter.
 */
function onLimitsChange(limits: ClaudeAILimits): void {
  if (!failoverEnabled()) return
  const activeId = getActiveAccountId()
  if (!activeId) return
  const reset = exhaustionReset(limits, getRawUtilization(), threshold())
  setAccountExhausted(activeId, reset ?? undefined)
}

statusListeners.add(onLimitsChange)

/** Order accounts round-robin starting AFTER the active one, so repeated
 * failovers cycle through the pool instead of always re-picking the first. */
function rotateAfter(accounts: SavedAccount[], activeId: string | undefined): SavedAccount[] {
  const idx = accounts.findIndex(a => a.id === activeId)
  if (idx < 0) return accounts
  return [...accounts.slice(idx + 1), ...accounts.slice(0, idx + 1)]
}

export type FailoverResult =
  | { type: 'switched'; from?: SavedAccount; to: SavedAccount; fromReset: number }
  | { type: 'all-exhausted'; soonestReset?: number }

/**
 * Called at the turn boundary, before the next request. If failover is on and
 * the active account is exhausted, rotate to the next non-exhausted saved
 * account. If every account is exhausted, surface the soonest reset instead of
 * thrashing between dead accounts. Returns null when no action is taken.
 */
export function maybeFailoverBetweenTurns(): FailoverResult | null {
  if (!failoverEnabled()) return null
  const accounts = listSavedAccounts()
  if (accounts.length < 2) return null

  const activeId = getActiveAccountId()
  const active = accounts.find(a => a.id === activeId)
  const now = Date.now() / 1000

  // If the live slot isn't one of our saved accounts (e.g. the user /login'd to
  // an unmanaged account, so the pointer was cleared), the live exhaustion
  // signal can't be attributed to a managed identity. Don't rotate off it onto a
  // saved account the user never asked to switch to.
  if (!active) return null

  // Is the active account exhausted right now? Prefer the live signal; fall
  // back to a still-valid stamp (e.g. the feature was just toggled on, or the
  // signal predates this process).
  const liveReset = exhaustionReset(currentLimits, getRawUtilization(), threshold())
  const stampedReset =
    active?.exhaustedUntil && active.exhaustedUntil > now
      ? active.exhaustedUntil
      : null
  const activeReset = liveReset ?? stampedReset
  if (activeReset == null) return null

  // Record the active account's reset so we don't roll back onto it too soon
  // (covers the just-toggled-on case where the listener never saw this state).
  if (active) setAccountExhausted(active.id, activeReset)

  // Pick the next account that isn't still tapped out.
  const candidate = rotateAfter(accounts, activeId).find(
    a => a.id !== activeId && !(a.exhaustedUntil && a.exhaustedUntil > now),
  )

  if (candidate) {
    if (!switchToAccount(candidate.id)) return null
    return { type: 'switched', from: active, to: candidate, fromReset: activeReset }
  }

  // Everything is exhausted — surface the soonest reset, switch nothing.
  const resets = accounts
    .map(a => (a.id === activeId ? activeReset : a.exhaustedUntil))
    .filter((n): n is number => typeof n === 'number')
  return {
    type: 'all-exhausted',
    soonestReset: resets.length ? Math.min(...resets) : undefined,
  }
}

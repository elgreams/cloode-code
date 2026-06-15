# Multi-Account Auto-Failover — Roadmap

Status: **manual-switching foundation BUILT (uncommitted, in local cli-dev); auto-failover NOT started.**

## Current state (what's built so far)

Built and verified, but **held uncommitted** pending real-world testing with a
second Anthropic account:

- `savedAnthropicAccounts` + `activeAnthropicAccountId` in GlobalConfig — additive,
  does not migrate or touch the existing single `claudeAiOauth` slot.
- `src/utils/accountSwitch.ts` — save / list / switch / remove primitives, plus
  `syncActiveAccountTokens`.
- `/account` command — `save <label>`, `list`, `use <label>`, `remove <label>`.
- **Refresh-staleness fix:** `saveOAuthTokensIfNeeded` (the single chokepoint for
  every token write, incl. refresh) now updates the active saved-account snapshot
  so a refresh can't leave the drawer copy stale. Resolves open question #1 for
  the manual case.

Verified: token swap writes the correct block into the live slot (byte-level
check); refresh-staleness self-heals (real-path test). **Not yet verified:** that
switching lands on a genuinely different identity with a separate rate limit —
needs a second account.

**NOT built yet: auto-failover** (the core "roll over when I hit my limit" goal).
That is the remaining work — see build step 4 and open questions #3–#5, #10–#11.

## Goal

Let a user save **multiple Anthropic (Claude) accounts** as logged-in at once and,
optionally, **automatically roll the active session over to another account when
the current one hits its usage limit**. Motivating case: two $20 Pro
subscriptions are cheaper than one $100 Max plan, and people already switch
between them by hand — this automates that switch.

---

## Feasibility summary

The codebase cooperates well. Three findings make this tractable:

1. **Auth is a single swappable slot.** OAuth tokens live in secure storage under
   one `claudeAiOauth` key (`src/utils/auth.ts` ~L1218). At request time the
   client just reads `getClaudeAIOAuthTokens()?.accessToken`
   (`src/services/api/client.ts` ~L379). That getter is **memoized**, and there's
   already a `getClaudeAIOAuthTokens.cache?.clear?.()` call after a token save.
   → "Switch account" = swap the stored token block + clear that cache. No
   request-path rewrite needed.

2. **Rate-limit detection already exists.** `src/services/claudeAiLimits.ts`
   parses Anthropic's `anthropic-ratelimit-unified-*` response headers on every
   call, tracks 5-hour and 7-day windows, and calls `emitStatusChange()` with a
   `status` + `resetsAt`. There's a `statusListeners` Set we can subscribe to.
   → This is the failover **trigger**. No polling required.

3. **Per-window utilization is exposed** via `getRawUtilization()` (0–1 fraction
   + reset time per window). → Enables *preemptive* switching (swap at ~100%
   before a hard rejection) instead of only reacting to errors.

---

## Proposed architecture

### Data model (new)
- A list of saved accounts: `{ id, label, tokenBlock, subscriptionType, lastKnownResetsAt? }`.
- An **active-account pointer**.
- A setting, e.g. `autoAccountFailover: boolean` (default off).

### Storage
- Today: one `claudeAiOauth` block in secure storage.
- New: store N accounts. The OAuth save path appends/updates by account id
  instead of overwriting the single slot.
- Requires a **migration** of the existing single account into the new list.

### Switch primitive
A `switchActiveAccount(id)` that:
1. Writes the chosen account's token block into the active `claudeAiOauth` slot.
2. Calls `getClaudeAIOAuthTokens.cache?.clear?.()` (+ `clearBetasCaches()`,
   `clearToolSchemaCache()` as the save path already does).
3. Updates the active-account pointer.

### Failover logic
- Subscribe to `statusListeners` (and/or read `getRawUtilization()` after each turn).
- When the active account is exhausted (or ≥ threshold), rotate to the next
  account whose `resetsAt` is in the past / not exhausted.
- Track each account's `resetsAt` so we don't roll onto another tapped-out account.

### UI / commands
- `/account` command (mirror the existing `/provider` pattern):
  - `add` (runs OAuth, stores under a label)
  - `list` (show accounts + last-known limit status)
  - `use <id>` (manual switch)
  - `remove <id>`
- Setting toggle for auto-failover (and a footer/status indicator showing which
  account is active).

---

## Recommended v1 scope

Keep it small and safe:

- Store N accounts + manual `/account` switching (**the foundation**).
- **Preemptive auto-switch BETWEEN turns** only: when the active account is
  exhausted, switch before the *next* request — not mid-response.

Leave mid-stream retry/failover and fancier balancing as follow-ups.

---

## ⚠️ Open questions / needs-more-thought

These are the parts that are *not* obviously solved and need decisions before building:

1. **Per-account token refresh.** The refresh logic (`auth.ts` ~L1516+) assumes a
   single account with one `refreshToken`/`expiresAt`. With N accounts, refresh
   must operate on *whichever account is active* (and ideally refresh inactive
   accounts lazily when switched to). **Biggest correctness risk.** Needs design.

2. **Secure-storage shape + backends.** Secure storage has multiple backends
   (keychain, file, etc.). Changing the schema from one block to a list touches
   all of them, plus a migration that must not lock users out of their existing
   login. Needs careful, reversible migration.

3. **Mid-stream vs between-turn failover.** Mid-response failover means
   re-issuing an in-flight streamed request against a new token — messy
   (partial output, tool-call state). Between-turn is clean. **Recommend
   between-turn for v1**, but confirm that's acceptable UX.

4. **What counts as "exhausted"?** Hard 429/rejected status is unambiguous, but
   preemptive switching needs a utilization threshold (95%? 100%?) and has to
   choose between the 5h and 7d windows. Wrong threshold = premature switching or
   late switching. Needs a sensible default + maybe a setting.

5. **Detecting "all accounts exhausted."** If every saved account is tapped out,
   we should stop rotating and surface the soonest `resetsAt` rather than
   thrashing between dead accounts.

6. **Subscription-type mismatch.** Two accounts may differ (Pro vs Max, different
   `rateLimitTier`). Switching could change available models/limits mid-session.
   How do we communicate or guard that?

7. **Profile/identity display.** `oauthAccount` (profile) is also cached
   (`auth.ts` ~L1696). Cost tracking, `/status`, and any per-account display need
   to follow the active account. Audit everywhere `oauthAccount` is read.

8. **In-flight requests during a manual switch.** If the user runs `/account use`
   mid-turn, what happens to the active request? Probably: apply on next turn.

9. **ToS / account-safety stance.** Owning and using multiple paid subscriptions
   is normal and not inherently a violation; account/credential *sharing* is what
   policies target. **Automated** failover to defeat per-account caps is a grey
   area ("circumventing rate limits"). Not a technical blocker, but worth a clear,
   honest note in user-facing docs so people understand the risk surface. Decide
   how prominently to disclose.

10. **Teammates / sub-agents / background tasks.** These spawn their own query
    flows. Does a failover on the main thread propagate to in-process teammates
    and background tasks? They may each be hitting the API. Needs thought on
    whether failover is global (process-wide) or per-flow.

11. **Concurrent-use detection.** If both accounts are ever used simultaneously
    (e.g. main thread on account A, a background task still on account B mid-swap),
    is that a problem for either ToS or correctness? Probably want failover to be
    a single global switch with a brief drain.

---

## Suggested build order

1. ✅ **Multi-account storage** (foundation). Done — stored in GlobalConfig,
   additive (no migration of the live slot needed for the manual case, so Q2 is
   deferred, not yet resolved).
2. ✅ **`/account` command** (save/list/use/remove) — manual switching, no auto.
3. ✅ **Per-account refresh** correctness (Q1) — solved via `syncActiveAccountTokens`.
4. ⏳ **NEXT — verify with a real second account.** Confirm switching changes
   identity + gives a separate rate limit. Nothing automated depends-proven until
   this passes.
5. ⏳ **Auto-failover (between turns)** — the core goal, NOT started. Subscribe to
   the existing `statusListeners` (and/or poll `getRawUtilization()` after each
   turn); when the active account is exhausted, rotate to the next non-exhausted
   saved account before the next request. Resolves/needs Q3, Q4, Q5, Q10, Q11.
   Add an `autoAccountFailover` setting (default off).
6. ⏳ **Polish**: active-account indicator in the footer, all-exhausted handling
   (surface soonest `resetsAt` instead of thrashing), docs note (Q9).

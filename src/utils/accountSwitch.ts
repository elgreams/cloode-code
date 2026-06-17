/**
 * Multi-account switching for Anthropic (Claude) logins — PROBE.
 *
 * The live OAuth token lives in a single secure-storage slot (`claudeAiOauth`),
 * read at request time via the memoized getClaudeAIOAuthTokens(). This module
 * lets the user snapshot several accounts into GlobalConfig and swap which one
 * occupies the live slot. The goal of this first slice is to validate that a
 * token swap actually routes the next API request to the other account.
 *
 * Deliberately additive/reversible: we never migrate the existing single slot;
 * saving an account just snapshots whatever is currently in it.
 */
import { randomUUID } from 'crypto'
import { resetLimitSignal } from '../services/claudeAiLimits.js'
import { clearOAuthTokenCache, getClaudeAIOAuthTokens } from './auth.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getSecureStorage } from './secureStorage/index.js'

export type SavedAccount = NonNullable<
  ReturnType<typeof getGlobalConfig>['savedAnthropicAccounts']
>[number]

export function listSavedAccounts(): SavedAccount[] {
  return getGlobalConfig().savedAnthropicAccounts ?? []
}

export function getActiveAccountId(): string | undefined {
  return getGlobalConfig().activeAnthropicAccountId
}

/**
 * Snapshot the account currently logged in (the live claudeAiOauth slot) into
 * the saved list under `label`. Returns the saved entry, or null if there is
 * no refreshable OAuth login to snapshot.
 */
export function saveCurrentAccount(label: string): SavedAccount | null {
  // Read fresh from disk, NOT the memoized getter. After /login swaps the live
  // account mid-session, the memo can still hold the previous account's token —
  // snapshotting that would save the wrong credentials (two "different" saved
  // accounts ending up with identical tokens). Clearing first guarantees we
  // capture whatever is actually in the live slot right now.
  clearOAuthTokenCache()
  const tokens = getClaudeAIOAuthTokens()
  // Only persist real, refreshable logins — env/FD inference tokens have no
  // refreshToken/expiresAt and can't be meaningfully restored later.
  if (!tokens?.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
    return null
  }

  const entry: SavedAccount = {
    id: randomUUID(),
    label,
    tokens: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType ?? null,
      rateLimitTier: tokens.rateLimitTier ?? null,
    },
    accountEmail: getGlobalConfig().oauthAccount?.emailAddress,
    // Snapshot the full profile so a switch can restore the displayed identity
    // (banner/whoami), not just the token.
    account: getGlobalConfig().oauthAccount,
    addedAt: Date.now(),
  }

  saveGlobalConfig(cfg => {
    // De-dup by label: re-saving an existing label updates it in place.
    const others = (cfg.savedAnthropicAccounts ?? []).filter(
      a => a.label !== label,
    )
    return {
      ...cfg,
      savedAnthropicAccounts: [...others, entry],
      // A save always snapshots whatever's currently in the live slot, so the
      // freshly-saved entry IS the active account. Point at it unconditionally
      // — otherwise saving a just-logged-in second account leaves the pointer
      // (and the list's "*" marker) stuck on the first.
      activeAnthropicAccountId: entry.id,
    }
  })
  return entry
}

/**
 * Write a saved account's token block into the live secure-storage slot and
 * clear the memoized token cache so the next request uses it. Returns false if
 * no such account or the storage write failed.
 */
export function switchToAccount(id: string): boolean {
  const account = listSavedAccounts().find(a => a.id === id)
  if (!account) return false

  const secureStorage = getSecureStorage()
  const storageData = secureStorage.read() || {}
  storageData.claudeAiOauth = {
    accessToken: account.tokens.accessToken,
    refreshToken: account.tokens.refreshToken,
    expiresAt: account.tokens.expiresAt,
    scopes: account.tokens.scopes,
    subscriptionType: account.tokens.subscriptionType ?? null,
    rateLimitTier: account.tokens.rateLimitTier ?? null,
  }
  const result = secureStorage.update(storageData)
  if (!result.success) return false

  // Drop BOTH the token memo and the keychain/storage cache so the next
  // getClaudeAIOAuthTokens() re-reads the slot we just wrote. Clearing only the
  // token memo leaves a stale keychain cache on macOS.
  clearOAuthTokenCache()

  // Point the active pointer at the new account FIRST. resetLimitSignal() below
  // emits a healthy status that the failover listener (onLimitsChange) reacts to
  // by clearing the *active* account's exhaustion stamp. That must resolve to
  // the account we're switching TO (clear its stamp — it's starting clean), not
  // the one we're leaving (whose stamp the failover path may have just set to
  // avoid rolling back onto it). Also restores the displayed identity:
  // oauthAccount drives the startup banner and whoami.
  saveGlobalConfig(cfg => ({
    ...cfg,
    activeAnthropicAccountId: id,
    ...(account.account ? { oauthAccount: account.account } : {}),
  }))

  // The process-global rate-limit signal (currentLimits / rawUtilization)
  // belongs to the account we're switching AWAY from. Leaving it in place lets
  // maybeFailoverBetweenTurns() read the old account's exhaustion at the next
  // turn boundary and stamp it onto the account we just switched TO, which
  // stalls failover (every account ends up marked exhausted). Clear it so the
  // new account starts clean; its first response repopulates from fresh headers.
  resetLimitSignal()
  return true
}

/**
 * Keep a saved snapshot current across a token REFRESH (not a login).
 *
 * Called only from the refresh path, matching by the OLD refresh token we just
 * rotated. This is the precise identity key: matching by active pointer or
 * email misattributes during a /login to a different account, which previously
 * stamped the new account's token onto the old account's snapshot — leaving two
 * "different" saved accounts with identical tokens. No-op if no snapshot owns
 * that refresh token.
 */
export function syncSavedAccountByRefreshToken(
  oldRefreshToken: string,
  tokens: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string | null
    rateLimitTier?: string | null
  },
): void {
  const accounts = getGlobalConfig().savedAnthropicAccounts ?? []
  if (!accounts.some(a => a.tokens.refreshToken === oldRefreshToken)) return

  saveGlobalConfig(c => ({
    ...c,
    savedAnthropicAccounts: (c.savedAnthropicAccounts ?? []).map(a =>
      a.tokens.refreshToken === oldRefreshToken
        ? {
            ...a,
            tokens: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              scopes: tokens.scopes ?? a.tokens.scopes,
              subscriptionType:
                tokens.subscriptionType ?? a.tokens.subscriptionType ?? null,
              rateLimitTier:
                tokens.rateLimitTier ?? a.tokens.rateLimitTier ?? null,
            },
          }
        : a,
    ),
  }))
}

/**
 * Keep a saved snapshot current across a /login re-auth (not a refresh).
 *
 * The refresh path keys by the rotated refresh token, but a /login mints a
 * brand-new token pair with no link to the old one — so we key by account
 * identity (accountUuid) instead. installOAuthTokens calls storeOAuthAccountInfo
 * for the freshly-authenticated account BEFORE saving tokens, so `accountUuid`
 * here is the new login's identity. If a saved snapshot already owns that uuid
 * (i.e. the user re-logged into an account they'd saved), refresh its token
 * block so a later `/account use` replays the new credentials, not the stale,
 * now-revoked ones. No-op if no snapshot owns that uuid (a genuinely new account
 * is handled by saveCurrentAccount instead). Matching by uuid — not the active
 * pointer or email — avoids the cross-contamination that misattributes during a
 * /login to a different account.
 */
export function syncSavedAccountByUuid(
  accountUuid: string,
  tokens: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes?: string[]
    subscriptionType?: string | null
    rateLimitTier?: string | null
  },
): void {
  const accounts = getGlobalConfig().savedAnthropicAccounts ?? []
  if (!accounts.some(a => a.account?.accountUuid === accountUuid)) return

  saveGlobalConfig(c => ({
    ...c,
    savedAnthropicAccounts: (c.savedAnthropicAccounts ?? []).map(a =>
      a.account?.accountUuid === accountUuid
        ? {
            ...a,
            tokens: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              scopes: tokens.scopes ?? a.tokens.scopes,
              subscriptionType:
                tokens.subscriptionType ?? a.tokens.subscriptionType ?? null,
              rateLimitTier:
                tokens.rateLimitTier ?? a.tokens.rateLimitTier ?? null,
            },
          }
        : a,
    ),
  }))
}

/**
 * Record (or clear) a saved account's usage-limit reset time. Centralised here
 * so all savedAnthropicAccounts mutations live in one module. No-op if the
 * value is unchanged, so callers on a hot path can call freely without churning
 * the config file. Pass undefined to clear an exhaustion mark.
 */
export function setAccountExhausted(
  id: string,
  exhaustedUntil: number | undefined,
): void {
  const target = listSavedAccounts().find(a => a.id === id)
  if (!target || target.exhaustedUntil === exhaustedUntil) return
  saveGlobalConfig(cfg => ({
    ...cfg,
    savedAnthropicAccounts: (cfg.savedAnthropicAccounts ?? []).map(a =>
      a.id === id ? { ...a, exhaustedUntil } : a,
    ),
  }))
}

export function removeSavedAccount(id: string): boolean {
  const existing = listSavedAccounts()
  if (!existing.some(a => a.id === id)) return false
  saveGlobalConfig(cfg => ({
    ...cfg,
    savedAnthropicAccounts: (cfg.savedAnthropicAccounts ?? []).filter(
      a => a.id !== id,
    ),
    activeAnthropicAccountId:
      cfg.activeAnthropicAccountId === id
        ? undefined
        : cfg.activeAnthropicAccountId,
  }))
  return true
}

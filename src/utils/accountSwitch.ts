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
import { getClaudeAIOAuthTokens } from './auth.js'
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
      activeAnthropicAccountId: cfg.activeAnthropicAccountId ?? entry.id,
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

  // Drop the memoized token so the next getClaudeAIOAuthTokens() re-reads disk.
  getClaudeAIOAuthTokens.cache?.clear?.()

  saveGlobalConfig(cfg => ({ ...cfg, activeAnthropicAccountId: id }))
  return true
}

/**
 * Keep the active account's saved snapshot in sync with a fresh token block.
 *
 * Called from saveOAuthTokensIfNeeded after every successful token write (login
 * and, critically, refresh). Without this, a refresh updates only the live slot
 * and the saved snapshot goes stale — switch away and back and you'd restore a
 * dead refresh token and get logged out. Matching is by activeAnthropicAccountId
 * (refresh tokens rotate, so we can't match on token value); no-op if there is
 * no active saved account.
 */
export function syncActiveAccountTokens(tokens: {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
}): void {
  const cfg = getGlobalConfig()
  const activeId = cfg.activeAnthropicAccountId
  if (!activeId) return
  const accounts = cfg.savedAnthropicAccounts ?? []
  if (!accounts.some(a => a.id === activeId)) return

  saveGlobalConfig(c => ({
    ...c,
    savedAnthropicAccounts: (c.savedAnthropicAccounts ?? []).map(a =>
      a.id === activeId
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

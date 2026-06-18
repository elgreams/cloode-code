import { checkQuotaStatus } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  getActiveAccountId,
  listSavedAccounts,
  removeSavedAccount,
  saveCurrentAccount,
  setAccountExhausted,
  switchToAccount,
} from '../../utils/accountSwitch.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { formatResetTime } from '../../utils/format.js'

const USAGE = [
  'Multi-account switching. Subcommands:',
  '  /account save <label>   Snapshot the current login under a label',
  '  /account list           List saved accounts',
  '  /account use <label>    Switch the active account to <label>',
  '  /account remove <label> Forget a saved account',
  '  /account failover [on|off]  Toggle auto-failover when a limit is hit',
  '  /account usage [on|off]     Toggle the usage footer line',
].join('\n')

function findByLabel(label: string) {
  return listSavedAccounts().find(a => a.label === label)
}

function onOff(enabled: boolean | undefined): 'on' | 'off' {
  return enabled ? 'on' : 'off'
}

export const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  const [sub, ...rest] = trimmed.split(/\s+/)
  const label = rest.join(' ').trim()

  switch (sub) {
    case 'save': {
      if (!label) return { type: 'text', value: 'Usage: /account save <label>' }
      const saved = saveCurrentAccount(label)
      if (!saved) {
        return {
          type: 'text',
          value:
            'No refreshable Claude login to save. Sign in with /login first (env/token logins can’t be saved).',
        }
      }
      return {
        type: 'text',
        value: `Saved current account as "${saved.label}"${saved.accountEmail ? ` (${saved.accountEmail})` : ''} [token …${saved.tokens.accessToken.slice(-8)}].`,
      }
    }

    case 'list': {
      const accounts = listSavedAccounts()
      if (accounts.length === 0) {
        return {
          type: 'text',
          value: 'No saved accounts. Use /account save <label> while logged in.',
        }
      }
      const activeId = getActiveAccountId()
      const nowSec = Date.now() / 1000
      const lines = accounts.map(a => {
        const active = a.id === activeId
        const marker = active ? '→ ' : '  '
        const email = a.accountEmail ? ` — ${a.accountEmail}` : ''
        const sub = a.tokens.subscriptionType
          ? ` [${a.tokens.subscriptionType}]`
          : ''
        const tag = active ? '  (active)' : ''
        const tok = `  …${a.tokens.accessToken.slice(-8)}`
        const limited =
          a.exhaustedUntil && a.exhaustedUntil > nowSec
            ? `  (limited until ${formatResetTime(a.exhaustedUntil, true)})`
            : ''
        return `${marker}${a.label}${email}${sub}${tok}${tag}${limited}`
      })
      return {
        type: 'text',
        value: `Saved accounts (auto-failover ${onOff(getGlobalConfig().autoAccountFailover)}, usage footer ${onOff(getGlobalConfig().accountUsageFooterEnabled)}):\n${lines.join('\n')}`,
      }
    }

    case 'usage': {
      const arg = label.toLowerCase()
      if (arg !== 'on' && arg !== 'off') {
        return {
          type: 'text',
          value: `Account usage footer is ${onOff(getGlobalConfig().accountUsageFooterEnabled)}. Use /account usage on|off to change it.`,
        }
      }
      const enabled = arg === 'on'
      saveGlobalConfig(cfg => ({ ...cfg, accountUsageFooterEnabled: enabled }))
      return {
        type: 'text',
        value: enabled
          ? 'Account usage footer ON. Usage will appear as a separate footer line when Anthropic usage data is available.'
          : 'Account usage footer OFF.',
      }
    }

    case 'failover': {
      const arg = label.toLowerCase()
      if (arg !== 'on' && arg !== 'off') {
        return {
          type: 'text',
          value: `Auto-failover is ${onOff(getGlobalConfig().autoAccountFailover)}. Use /account failover on|off to change it.`,
        }
      }
      const enabled = arg === 'on'
      saveGlobalConfig(cfg => ({ ...cfg, autoAccountFailover: enabled }))
      return {
        type: 'text',
        value: enabled
          ? 'Auto-failover ON. When the active account hits its usage limit, the next request will switch to the next non-exhausted saved account.'
          : 'Auto-failover OFF. Accounts will only switch when you run /account use.',
      }
    }

    case 'use': {
      if (!label) return { type: 'text', value: 'Usage: /account use <label>' }
      const account = findByLabel(label)
      if (!account) {
        return { type: 'text', value: `No saved account named "${label}".` }
      }
      const ok = switchToAccount(account.id)
      if (ok) {
        // Manually selecting an account is the user asserting it's usable, so
        // clear any stale exhaustion stamp on it. Without this, a leftover
        // exhaustedUntil (e.g. one mis-stamped by an older failover bug) makes
        // maybeFailoverBetweenTurns treat the just-selected account as tapped
        // out and refuse to fail over to it. Goes through the app's own write
        // path so it sticks, unlike editing ~/.claude.json while we're running.
        setAccountExhausted(account.id, undefined)
        // switchToAccount() → resetLimitSignal() wipes rawUtilization, so the
        // footer's 5h/7d usage parts disappear until the next real turn
        // repopulates them from response headers. Fire a quota check now (it
        // reads the freshly-swapped live token) so the new account's usage
        // refills within a second or two instead of going blank until the user
        // sends a message. Fire-and-forget; the footer updates when it emits.
        void checkQuotaStatus().catch(() => {})
      }
      return {
        type: 'text',
        value: ok
          ? `Switched to "${account.label}". The next request will use this account.`
          : `Failed to switch to "${account.label}" (could not write credentials).`,
      }
    }

    case 'remove': {
      if (!label) {
        return { type: 'text', value: 'Usage: /account remove <label>' }
      }
      const account = findByLabel(label)
      if (!account) {
        return { type: 'text', value: `No saved account named "${label}".` }
      }
      removeSavedAccount(account.id)
      return { type: 'text', value: `Removed "${account.label}".` }
    }

    default:
      return { type: 'text', value: USAGE }
  }
}

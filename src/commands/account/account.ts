import type { LocalCommandCall } from '../../types/command.js'
import {
  getActiveAccountId,
  listSavedAccounts,
  removeSavedAccount,
  saveCurrentAccount,
  switchToAccount,
} from '../../utils/accountSwitch.js'

const USAGE = [
  'Multi-account switching (probe). Subcommands:',
  '  /account save <label>   Snapshot the current login under a label',
  '  /account list           List saved accounts',
  '  /account use <label>    Switch the active account to <label>',
  '  /account remove <label> Forget a saved account',
].join('\n')

function findByLabel(label: string) {
  return listSavedAccounts().find(a => a.label === label)
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
      const lines = accounts.map(a => {
        const active = a.id === activeId
        const marker = active ? '→ ' : '  '
        const email = a.accountEmail ? ` — ${a.accountEmail}` : ''
        const sub = a.tokens.subscriptionType
          ? ` [${a.tokens.subscriptionType}]`
          : ''
        const tag = active ? '  (active)' : ''
        const tok = `  …${a.tokens.accessToken.slice(-8)}`
        return `${marker}${a.label}${email}${sub}${tok}${tag}`
      })
      return {
        type: 'text',
        value: `Saved accounts:\n${lines.join('\n')}`,
      }
    }

    case 'use': {
      if (!label) return { type: 'text', value: 'Usage: /account use <label>' }
      const account = findByLabel(label)
      if (!account) {
        return { type: 'text', value: `No saved account named "${label}".` }
      }
      const ok = switchToAccount(account.id)
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

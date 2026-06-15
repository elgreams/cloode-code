import type { LocalCommandCall } from '../../types/command.js'
import {
  isBrowserEnabled,
  setBrowserEnabled,
} from '../../utils/browserMcp/setup.js'

const ENABLED_MSG =
  'Browser automation ENABLED. Restart cloode to load the browser tools ' +
  '(mcp__browser__*). They drive your installed Chrome with a persistent ' +
  'profile, so logins stick between sessions.'

const DISABLED_MSG =
  'Browser automation DISABLED. Restart cloode to unload the browser tools.'

export const call: LocalCommandCall = async args => {
  const arg = args.trim().toLowerCase()
  const enabled = isBrowserEnabled()

  if (arg === 'on' || arg === 'enable') {
    setBrowserEnabled(true)
    return { type: 'text', value: ENABLED_MSG }
  }
  if (arg === 'off' || arg === 'disable') {
    setBrowserEnabled(false)
    return { type: 'text', value: DISABLED_MSG }
  }
  // No/unknown arg → status + usage.
  return {
    type: 'text',
    value:
      `Browser automation is ${enabled ? 'ON' : 'OFF'}.\n` +
      `Use \`/browser on\` to enable or \`/browser off\` to disable ` +
      `(takes effect after restarting cloode).`,
  }
}

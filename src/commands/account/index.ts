import type { Command } from '../../commands.js'

const account = {
  type: 'local',
  name: 'account',
  description:
    'Manage, switch, and auto-failover between saved Anthropic accounts',
  isEnabled: () => true,
  supportsNonInteractive: true,
  argumentHint: '<save|list|use|remove|failover|usage> [label|on|off]',
  load: () => import('./account.js'),
} satisfies Command

export default account

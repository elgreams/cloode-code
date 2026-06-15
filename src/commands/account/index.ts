import type { Command } from '../../commands.js'

const account = {
  type: 'local',
  name: 'account',
  description:
    'Manage and switch between saved Anthropic accounts (save/list/use/remove)',
  isEnabled: () => true,
  supportsNonInteractive: true,
  argumentHint: '<save|list|use|remove> [label]',
  load: () => import('./account.js'),
} satisfies Command

export default account

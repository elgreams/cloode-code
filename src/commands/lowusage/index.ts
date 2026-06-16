import type { Command } from '../../commands.js'

const lowusage = {
  type: 'local-jsx',
  name: 'lowusage',
  description:
    'Route background work (subagents, permission checks) to a cheaper model to conserve usage',
  argumentHint: '[model|off|status]',
  load: () => import('./lowusage.js'),
} satisfies Command

export default lowusage

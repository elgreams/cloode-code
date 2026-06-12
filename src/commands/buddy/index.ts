import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Your terminal companion — hatch it, pet it, name it',
  argumentHint: '[pet | rename <name> | release | mute | unmute]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy

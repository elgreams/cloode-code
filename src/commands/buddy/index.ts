import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Your terminal companion — hatch it, pet it, name it',
  argumentHint: '[pet|rename <name>|save [name]|load <name|id>|saved|delete <name|id>|list|select <species>|reroll|shiny [on|off|reset]|model [model|default]|current|cheat|default|release|mute|unmute]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy

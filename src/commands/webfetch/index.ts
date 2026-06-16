import type { Command } from '../../commands.js'

const webfetch = {
  type: 'local-jsx',
  name: 'webfetch',
  description: 'Configure WebFetch behavior',
  argumentHint: 'model [model|default]',
  load: () => import('./webfetch.js'),
} satisfies Command

export default webfetch

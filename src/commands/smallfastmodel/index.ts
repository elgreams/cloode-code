import type { Command } from '../../commands.js'

const smallfastmodel = {
  type: 'local-jsx',
  name: 'smallfastmodel',
  description:
    'Set the small/fast model used for cheap background calls (titles, summaries, web-fetch)',
  argumentHint: '[model|default]',
  load: () => import('./smallfastmodel.js'),
} satisfies Command

export default smallfastmodel

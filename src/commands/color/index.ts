/**
 * Color command - minimal metadata only.
 * Implementation is lazy-loaded from color.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: 'Recolor the startup banner border + Clawd figure (and session color)',
  immediate: true,
  argumentHint: '<name|#hex|rgb()|reset>',
  load: () => import('./color.js'),
} satisfies Command

export default color

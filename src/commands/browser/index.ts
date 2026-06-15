import type { Command } from '../../commands.js'

const browser = {
  type: 'local',
  name: 'browser',
  description:
    'Browser automation — drives your installed Chrome over CDP (no setup, no Node)',
  supportsNonInteractive: true,
  argumentHint: '[on|off]',
  load: () => import('./browser.js'),
} satisfies Command

export default browser

import type { Command } from '../../commands.js'

const dangerouslySkipPermissions = {
  type: 'local',
  name: 'dangerously-skip-permissions',
  description:
    'Toggle bypass-permissions mode on/off (run tools without prompting), like the --dangerously-skip-permissions flag',
  isEnabled: () => true,
  supportsNonInteractive: false,
  load: () => import('./dangerously-skip-permissions.js'),
} satisfies Command

export default dangerouslySkipPermissions

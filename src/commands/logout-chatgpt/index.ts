import type { Command } from '../../commands.js'
import { hasCodexAuth } from '../../utils/auth.js'

const logoutChatgpt = {
  type: 'local',
  name: 'logout-chatgpt',
  description: 'Sign out of ChatGPT/Codex and clear cached GPT models',
  isEnabled: () => hasCodexAuth(),
  supportsNonInteractive: true,
  load: () => import('./logout-chatgpt.js'),
} satisfies Command

export default logoutChatgpt

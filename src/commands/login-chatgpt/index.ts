import type { Command } from '../../commands.js'
import { isUsing3PServices } from '../../utils/auth.js'

const loginChatgpt = {
  type: 'local-jsx',
  name: 'login-chatgpt',
  description: 'Sign in to ChatGPT/Codex to use GPT models from /model',
  isEnabled: () => !isUsing3PServices(),
  load: () => import('./login-chatgpt.js'),
} satisfies Command

export default loginChatgpt

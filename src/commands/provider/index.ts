import type { Command } from '../../commands.js'

const provider = {
  type: 'local',
  name: 'provider',
  description:
    'Manage custom OpenAI-compatible model providers (NIM, OpenRouter, vLLM, …)',
  argumentHint: '[list | add <preset> <key> | remove <name> | use <model>]',
  supportsNonInteractive: true,
  load: () => import('./provider.js'),
} satisfies Command

export default provider

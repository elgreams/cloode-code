import type { LocalCommandCall } from '../../types/command.js'
import { clearCodexOAuthTokens } from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { isCodexModel } from '../../services/api/codex-fetch-adapter.js'

export const call: LocalCommandCall = async (_args, context) => {
  clearCodexOAuthTokens()

  // Drop cached GPT model lists so a future login starts clean.
  saveGlobalConfig(cfg => {
    const {
      codexAvailableModels: _models,
      codexUnsupportedModels: _blocked,
      ...rest
    } = cfg
    return rest as typeof cfg
  })

  // If the active model is a GPT/Codex model, fall back to the default (Claude)
  // model — otherwise the next request would try a GPT model with no auth.
  const appState = context.getAppState()
  const activeModel = appState.mainLoopModelForSession ?? appState.mainLoopModel
  const wasOnCodex = !!activeModel && isCodexModel(String(activeModel))

  context.setAppState(prev => ({
    ...prev,
    ...(wasOnCodex ? { mainLoopModel: null, mainLoopModelForSession: null } : {}),
    // Bump so auth-dependent hooks (model picker, status) re-evaluate.
    authVersion: prev.authVersion + 1,
  }))

  const resetNote = wasOnCodex ? ' Switched back to the default model.' : ''
  return {
    type: 'text',
    value: `Signed out of ChatGPT/Codex.${resetNote}`,
  }
}

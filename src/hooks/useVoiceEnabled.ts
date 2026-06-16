import { useAppState } from '../state/AppState.js'
import { isVoiceGrowthBookEnabled } from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with the GrowthBook
 * kill-switch. Voice runs against a local STT engine, so there is no auth
 * requirement — availability no longer depends on how the user is signed in.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  return userIntent && isVoiceGrowthBookEnabled()
}

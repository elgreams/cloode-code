import { normalizeLanguageForSTT } from '../../hooks/useVoice.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js'

const LANG_HINT_MAX_SHOWS = 2

// Ensure an offline whisper engine is ready before enabling voice. Returns:
//   - null            → nothing to do (already provisioned, or user supplied
//                        their own STT endpoint/binary).
//   - { fatal: true } → provisioning is required on this platform but failed;
//                        the message explains the next step (e.g. install brew
//                        whisper-cpp on macOS).
// Non-fatal failures (network blip) are swallowed: transcribePcm will retry the
// download lazily on first use, so we don't block enabling over a transient.
async function ensureSpeechEngineReady(): Promise<{
  fatal: boolean
  message: string
} | null> {
  // Honor an explicitly configured endpoint/binary — don't override it.
  const userConfiguredEndpoint =
    process.env.VOICE_STT_URL ||
    process.env.VOICE_STT_BINARY ||
    getInitialSettings().voiceSttUrl ||
    getInitialSettings().voiceSttBinary
  if (userConfiguredEndpoint) return null

  const { isWhisperProvisioned, provisionWhisper } = await import(
    '../../services/whisperProvision.js'
  )
  if (isWhisperProvisioned()) return null

  // macOS has no prebuilt engine; provisionWhisper resolves brew's whisper-cli
  // if present, else returns null. Give a precise hint in that case.
  try {
    const result = await provisionWhisper()
    if (result) return null
    if (process.platform === 'darwin') {
      return {
        fatal: true,
        message:
          'Voice mode needs an offline speech engine. On macOS, install it with:\n  brew install whisper-cpp\nThen run /voice again. (Alternatively, set voiceSttUrl in /config to use a remote transcription endpoint.)',
      }
    }
    return {
      fatal: true,
      message:
        'Voice mode could not set up an offline speech engine for this platform. Set voiceSttUrl in /config to use a transcription endpoint instead.',
    }
  } catch {
    // Transient download failure — enable anyway; first use retries lazily.
    return null
  }
}

export const call: LocalCommandCall = async () => {
  // Kill-switch check (voice has no auth requirement — it runs locally).
  if (!isVoiceModeEnabled()) {
    return {
      type: 'text' as const,
      value: 'Voice mode is not available.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true

  // Toggle OFF — no checks needed
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Voice mode disabled.',
    }
  }

  // Toggle ON — run pre-flight checks first
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // On Windows the native audio module isn't bundled in source builds, so we
  // provision a SoX recorder before the availability check. Best-effort: a
  // failure here isn't fatal (the user may have a system sox/rec, or native
  // audio may load); the check below decides whether voice can actually run.
  if (process.platform === 'win32') {
    const { isSoxProvisioned, provisionSox } = await import(
      '../../services/soxProvision.js'
    )
    if (!isSoxProvisioned()) {
      await provisionSox().catch(() => null)
    }
  }

  // Check recording availability (microphone access)
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  // Check for recording tools
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  // Probe mic access so the OS permission dialog fires now rather than
  // on the user's first hold-to-talk activation.
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = 'Settings \u2192 Privacy \u2192 Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      guidance = 'System Settings \u2192 Privacy & Security \u2192 Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
    }
  }

  // Provision the offline speech engine on first enable so the first
  // hold-to-talk doesn't stall on a ~140MB download. Skipped automatically
  // when already downloaded or when the user configured their own STT endpoint
  // (VOICE_STT_URL / voiceSttUrl) or binary.
  const provisionNote = await ensureSpeechEngineReady()
  if (provisionNote?.fatal) {
    return { type: 'text' as const, value: provisionNote.message }
  }

  // All checks passed — enable voice
  const result = updateSettingsForSource('userSettings', { voiceEnabled: true })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  const stt = normalizeLanguageForSTT(currentSettings.language)
  const cfg = getGlobalConfig()
  // Reset the hint counter whenever the resolved STT language changes
  // (including first-ever enable, where lastLanguage is undefined).
  const langChanged = cfg.voiceLangHintLastLanguage !== stt.code
  const priorCount = langChanged ? 0 : (cfg.voiceLangHintShownCount ?? 0)
  const showHint = !stt.fellBackFrom && priorCount < LANG_HINT_MAX_SHOWS
  let langNote = ''
  if (stt.fellBackFrom) {
    langNote = ` Note: "${stt.fellBackFrom}" is not a supported dictation language; using English. Change it via /config.`
  } else if (showHint) {
    langNote = ` Dictation language: ${stt.code} (/config to change).`
  }
  if (langChanged || showHint) {
    saveGlobalConfig(prev => ({
      ...prev,
      voiceLangHintShownCount: priorCount + (showHint ? 1 : 0),
      voiceLangHintLastLanguage: stt.code,
    }))
  }
  return {
    type: 'text' as const,
    value: `Voice mode enabled. Hold ${key} to record.${langNote}`,
  }
}

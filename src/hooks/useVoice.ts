// React hook for hold-to-talk voice input using a local speech-to-text engine.
//
// Hold the keybinding to record; release to stop and transcribe.  Auto-repeat
// key events reset an internal timer — when no keypress arrives within
// RELEASE_TIMEOUT_MS the recording stops automatically.  Uses the native audio
// module (or SoX/arecord) for recording and src/services/localTranscribe.ts
// for STT, so it works regardless of how the user is authenticated.
//
// Unlike the previous streaming implementation, audio is buffered while the key
// is held and transcribed as a single clip on release (batch). There is no
// live interim preview — local engines transcribe the whole utterance at once.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetVoiceState } from '../context/voice.js'
import { useTerminalFocus } from '../ink/hooks/use-terminal-focus.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  isLocalTranscribeConfigured,
  transcribePcm,
} from '../services/localTranscribe.js'
import { getVoiceKeyterms } from '../services/voiceKeyterms.js'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { getSystemLocaleLanguage } from '../utils/intl.js'
import { logError } from '../utils/log.js'
import { getInitialSettings } from '../utils/settings/settings.js'

// ─── Language normalization ─────────────────────────────────────────────

const DEFAULT_STT_LANGUAGE = 'en'

// Maps language names (English and native) to ISO 639-1 codes understood by
// whisper-based engines.  Keys must be lowercase.  Unlike the old Anthropic
// path, there is no server-side allowlist — whisper accepts a broad set of
// languages — so unknown two/three-letter codes are passed through as-is and
// only truly unrecognizable input falls back to DEFAULT_STT_LANGUAGE.
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  japanese: 'ja',
  日本語: 'ja',
  german: 'de',
  deutsch: 'de',
  portuguese: 'pt',
  português: 'pt',
  portugues: 'pt',
  italian: 'it',
  italiano: 'it',
  korean: 'ko',
  한국어: 'ko',
  hindi: 'hi',
  हिन्दी: 'hi',
  हिंदी: 'hi',
  indonesian: 'id',
  'bahasa indonesia': 'id',
  bahasa: 'id',
  russian: 'ru',
  русский: 'ru',
  polish: 'pl',
  polski: 'pl',
  turkish: 'tr',
  türkçe: 'tr',
  turkce: 'tr',
  dutch: 'nl',
  nederlands: 'nl',
  ukrainian: 'uk',
  українська: 'uk',
  greek: 'el',
  ελληνικά: 'el',
  czech: 'cs',
  čeština: 'cs',
  cestina: 'cs',
  danish: 'da',
  dansk: 'da',
  swedish: 'sv',
  svenska: 'sv',
  norwegian: 'no',
  norsk: 'no',
}

// Normalize a language preference string (from settings.language) to an ISO
// 639-1 code for the STT engine.  Returns the default language if the input
// cannot be resolved.  When the input is non-empty but unrecognizable,
// fellBackFrom is set to the original input so callers can surface a warning.
export function normalizeLanguageForSTT(language: string | undefined): {
  code: string
  fellBackFrom?: string
} {
  if (!language) return { code: DEFAULT_STT_LANGUAGE }
  const lower = language.toLowerCase().trim()
  if (!lower) return { code: DEFAULT_STT_LANGUAGE }
  const fromName = LANGUAGE_NAME_TO_CODE[lower]
  if (fromName) return { code: fromName }
  // Accept a plausible language code (ISO 639-1/2 base subtag) as-is — whisper
  // engines understand far more languages than we can enumerate by name.
  const base = lower.split('-')[0]
  if (base && /^[a-z]{2,3}$/.test(base)) return { code: base }
  return { code: DEFAULT_STT_LANGUAGE, fellBackFrom: language }
}

// Lazy-loaded voice (capture) module. We defer importing voice.ts (and its
// native audio-capture-napi dependency) until voice input is actually
// activated. On macOS, loading the native audio module can trigger a TCC
// microphone permission prompt — we must avoid that until voice is enabled.
type VoiceModule = typeof import('../services/voice.js')
let voiceModule: VoiceModule | null = null

type VoiceState = 'idle' | 'recording' | 'processing'

type UseVoiceOptions = {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  enabled: boolean
  focusMode: boolean
}

type UseVoiceReturn = {
  state: VoiceState
  handleKeyEvent: (fallbackMs?: number) => void
}

// Gap (ms) between auto-repeat key events that signals key release.
// Terminal auto-repeat typically fires every 30-80ms; 200ms comfortably
// covers jitter while still feeling responsive.
const RELEASE_TIMEOUT_MS = 200

// Fallback (ms) to arm the release timer if no auto-repeat is seen.
// macOS default key repeat delay is ~500ms; 600ms gives headroom.
// If the user tapped and released before auto-repeat started, this
// ensures the release timer gets armed and recording stops.
//
// For modifier-combo first-press activation (handleKeyEvent called at
// t=0, before any auto-repeat), callers should pass FIRST_PRESS_FALLBACK_MS
// instead — the gap to the next keypress is the OS initial repeat *delay*
// (up to ~2s on macOS with slider at "Long"), not the repeat *rate*.
const REPEAT_FALLBACK_MS = 600
export const FIRST_PRESS_FALLBACK_MS = 2000

// How long (ms) to keep a focus-mode session alive without any speech
// before tearing it down and transcribing what was captured. Re-arms on
// the next focus cycle (blur → refocus).
const FOCUS_SILENCE_TIMEOUT_MS = 5_000

// Number of bars shown in the recording waveform visualizer.
const AUDIO_LEVEL_BARS = 16

// Compute RMS amplitude from a 16-bit signed PCM buffer and return a
// normalized 0-1 value. A sqrt curve spreads quieter levels across more
// of the visual range so the waveform uses the full set of block heights.
export function computeLevel(chunk: Buffer): number {
  const samples = chunk.length >> 1 // 16-bit = 2 bytes per sample
  if (samples === 0) return 0
  let sumSq = 0
  for (let i = 0; i < chunk.length - 1; i += 2) {
    // Read 16-bit signed little-endian
    const sample = ((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16
    sumSq += sample * sample
  }
  const rms = Math.sqrt(sumSq / samples)
  const normalized = Math.min(rms / 2000, 1)
  return Math.sqrt(normalized)
}

export function useVoice({
  onTranscript,
  onError,
  enabled,
  focusMode,
}: UseVoiceOptions): UseVoiceReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True once we've seen a second keypress (auto-repeat) while recording.
  // The OS key repeat delay (~500ms on macOS) means the first keypress is
  // solo — arming the release timer before auto-repeat starts would cause
  // a false release.
  const seenRepeatRef = useRef(false)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // True when the current recording session was started by terminal focus
  // (not by a keypress). Focus-driven sessions end on blur, not key release.
  const focusTriggeredRef = useRef(false)
  // Timer that tears down the session after prolonged silence in focus mode.
  const focusSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // Set when a focus-mode session is torn down due to silence. Prevents
  // the focus effect from immediately restarting. Cleared on blur so the
  // next focus cycle re-arms recording.
  const silenceTimedOutRef = useRef(false)
  const recordingStartRef = useRef(0)
  // Incremented on each startRecordingSession(). The transcribe continuation
  // captures its generation and bails if a newer session has started — so a
  // slow transcription from an abandoned session can't inject text into the
  // next one.
  const sessionGenRef = useRef(0)
  // Raw PCM captured this session, concatenated and transcribed on release.
  const chunksRef = useRef<Buffer[]>([])
  // True if at least one audio chunk with non-trivial signal was received.
  // Used to distinguish "microphone is silent/inaccessible" from "speech not
  // detected" when the transcript comes back empty.
  const hasAudioSignalRef = useRef(false)
  const audioLevelsRef = useRef<number[]>([])
  const isFocused = useTerminalFocus()
  const setVoiceState = useSetVoiceState()

  // Keep callback refs current without triggering re-renders
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(newState: VoiceState): void {
    stateRef.current = newState
    setState(newState)
    setVoiceState(prev => {
      if (prev.voiceState === newState) return prev
      return { ...prev, voiceState: newState }
    })
  }

  const cleanup = useCallback((): void => {
    // Stale any in-flight session so a pending transcription can't inject
    // text after voice was torn down (e.g. /voice toggled off mid-recording).
    sessionGenRef.current++
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
      focusSilenceTimerRef.current = null
    }
    silenceTimedOutRef.current = false
    voiceModule?.stopRecording()
    chunksRef.current = []
    audioLevelsRef.current = []
    setVoiceState(prev => {
      if (prev.voiceInterimTranscript === '' && !prev.voiceAudioLevels.length)
        return prev
      return { ...prev, voiceInterimTranscript: '', voiceAudioLevels: [] }
    })
  }, [setVoiceState])

  function finishRecording(): void {
    logForDebugging(
      '[voice] finishRecording: stopping recording, transitioning to processing',
    )
    const focusTriggered = focusTriggeredRef.current
    focusTriggeredRef.current = false
    updateState('processing')
    voiceModule?.stopRecording()
    // Capture duration BEFORE the transcription round-trip so the STT wait
    // time isn't counted as recording time.
    const recordingDurationMs = Date.now() - recordingStartRef.current
    const hadAudioSignal = hasAudioSignalRef.current
    // Capture the generation BEFORE the async boundary — a keypress during
    // transcription can start a new session and bump sessionGenRef.
    const myGen = sessionGenRef.current
    const isStale = () => sessionGenRef.current !== myGen
    const pcm = Buffer.concat(chunksRef.current)
    chunksRef.current = []
    logForDebugging(
      `[voice] Recording stopped (${String(pcm.length)} PCM bytes captured)`,
    )

    void (async () => {
      let text = ''
      try {
        if (pcm.length > 0 && hadAudioSignal) {
          const stt = normalizeLanguageForSTT(getInitialSettings().language)
          const keyterms = await getVoiceKeyterms()
          if (isStale()) return
          const result = await transcribePcm(pcm, {
            language: stt.code,
            prompt: keyterms.length ? keyterms.join(', ') : undefined,
          })
          if (isStale()) return
          text = result.text.trim()
        }
      } catch (err) {
        if (isStale()) return
        logError(toError(err))
        onErrorRef.current?.(
          `Transcription failed: ${toError(err).message}. Check your voice STT endpoint (/config voiceSttUrl).`,
        )
        updateState('idle')
        setVoiceState(prev => {
          if (prev.voiceInterimTranscript === '') return prev
          return { ...prev, voiceInterimTranscript: '' }
        })
        return
      }

      logEvent('tengu_voice_recording_completed', {
        transcriptChars: text.length,
        recordingDurationMs,
        hadAudioSignal,
        focusTriggered,
      })

      logForDebugging(
        `[voice] Final transcript (${String(text.length)} chars): "${text.slice(0, 200)}"`,
      )

      if (text) {
        onTranscriptRef.current(text)
      } else if (recordingDurationMs > 2000) {
        // Only warn on empty transcript for recordings > 2s (short ones are
        // accidental taps → silently return to idle).
        if (!hadAudioSignal) {
          onErrorRef.current?.(
            'No audio detected from microphone. Check that the correct input device is selected and that Claude Code has microphone access.',
          )
        } else {
          onErrorRef.current?.('No speech detected.')
        }
      }

      setVoiceState(prev => {
        if (prev.voiceInterimTranscript === '') return prev
        return { ...prev, voiceInterimTranscript: '' }
      })
      updateState('idle')
    })().catch(err => {
      logError(toError(err))
      if (!isStale()) updateState('idle')
    })
  }

  // When voice is enabled, lazy-import voice.ts so checkRecordingAvailability
  // et al. are ready when the user presses the voice key. Do NOT preload the
  // native module — require('audio-capture.node') is a synchronous dlopen of
  // CoreAudio/AudioUnit that blocks the event loop for ~1s (warm) to ~8s
  // (cold coreaudiod). setImmediate doesn't help: it yields one tick, then the
  // dlopen still blocks. The first voice keypress pays the dlopen cost instead.
  useEffect(() => {
    if (enabled && !voiceModule) {
      void import('../services/voice.js').then(mod => {
        voiceModule = mod
      })
    }
  }, [enabled])

  // ── Focus silence timer ────────────────────────────────────────────
  // Arms (or resets) a timer that tears down the focus-mode session
  // after FOCUS_SILENCE_TIMEOUT_MS of no speech, transcribing what was
  // captured. Called when a session starts and on each audio chunk.
  function armFocusSilenceTimer(): void {
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
    }
    focusSilenceTimerRef.current = setTimeout(
      (
        focusSilenceTimerRef,
        stateRef,
        focusTriggeredRef,
        silenceTimedOutRef,
        finishRecording,
      ) => {
        focusSilenceTimerRef.current = null
        if (stateRef.current === 'recording' && focusTriggeredRef.current) {
          logForDebugging(
            '[voice] Focus silence timeout — tearing down session',
          )
          silenceTimedOutRef.current = true
          finishRecording()
        }
      },
      FOCUS_SILENCE_TIMEOUT_MS,
      focusSilenceTimerRef,
      stateRef,
      focusTriggeredRef,
      silenceTimedOutRef,
      finishRecording,
    )
  }

  // ── Focus-driven recording ──────────────────────────────────────────
  // In focus mode, start recording when the terminal gains focus and
  // stop (and transcribe) when it loses focus.
  useEffect(() => {
    if (!enabled || !focusMode) {
      // Focus mode was disabled while a focus-driven recording was active —
      // stop the recording so it doesn't linger until the silence timer fires.
      if (focusTriggeredRef.current && stateRef.current === 'recording') {
        logForDebugging(
          '[voice] Focus mode disabled during recording, finishing',
        )
        finishRecording()
      }
      return
    }
    let cancelled = false
    if (
      isFocused &&
      stateRef.current === 'idle' &&
      !silenceTimedOutRef.current
    ) {
      const beginFocusRecording = (): void => {
        // Re-check conditions — state or enabled/focusMode may have changed
        // during the await (effect cleanup sets cancelled).
        if (
          cancelled ||
          stateRef.current !== 'idle' ||
          silenceTimedOutRef.current
        )
          return
        logForDebugging('[voice] Focus gained, starting recording session')
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
      }
      if (voiceModule) {
        beginFocusRecording()
      } else {
        // Voice module is loading (async import resolves from cache as a
        // microtask). Wait for it before starting the recording session.
        void import('../services/voice.js').then(mod => {
          voiceModule = mod
          beginFocusRecording()
        })
      }
    } else if (!isFocused) {
      // Clear the silence timeout flag on blur so the next focus
      // cycle re-arms recording.
      silenceTimedOutRef.current = false
      if (stateRef.current === 'recording') {
        logForDebugging('[voice] Focus lost, finishing recording')
        finishRecording()
      }
    }
    return () => {
      cancelled = true
    }
  }, [enabled, focusMode, isFocused])

  // ── Start a new recording session (audio capture only) ──
  async function startRecordingSession(): Promise<void> {
    if (!voiceModule) {
      onErrorRef.current?.(
        'Voice module not loaded yet. Try again in a moment.',
      )
      return
    }

    // Transition to 'recording' synchronously, BEFORE any await. Callers read
    // state synchronously right after `void startRecordingSession()` (the
    // space-hold guard in useVoiceIntegration and the re-entry check in
    // handleKeyEvent). If an await runs first, they see stale 'idle'.
    updateState('recording')
    recordingStartRef.current = Date.now()
    seenRepeatRef.current = false
    hasAudioSignalRef.current = false
    chunksRef.current = []
    const myGen = ++sessionGenRef.current

    // ── Pre-check: can we actually record audio? ──────────────
    const availability = await voiceModule.checkRecordingAvailability()
    if (sessionGenRef.current !== myGen) return
    if (!availability.available) {
      logForDebugging(
        `[voice] Recording not available: ${availability.reason ?? 'unknown'}`,
      )
      onErrorRef.current?.(
        availability.reason ?? 'Audio recording is not available.',
      )
      cleanup()
      updateState('idle')
      return
    }

    logForDebugging('[voice] Starting audio capture')
    // Clear any previous error
    setVoiceState(prev => {
      if (!prev.voiceError) return prev
      return { ...prev, voiceError: null }
    })

    audioLevelsRef.current = []
    const started = await voiceModule.startRecording(
      (chunk: Buffer) => {
        if (sessionGenRef.current !== myGen) return
        // Own the buffer — native module buffers may share a pooled
        // ArrayBuffer that gets overwritten before we transcribe.
        chunksRef.current.push(Buffer.from(chunk))
        // Update audio level histogram for the recording visualizer
        const level = computeLevel(chunk)
        if (!hasAudioSignalRef.current && level > 0.01) {
          hasAudioSignalRef.current = true
        }
        // Active speech resets the focus silence timer.
        if (focusTriggeredRef.current && level > 0.01) {
          armFocusSilenceTimer()
        }
        const levels = audioLevelsRef.current
        if (levels.length >= AUDIO_LEVEL_BARS) {
          levels.shift()
        }
        levels.push(level)
        // Copy the array so React sees a new reference
        const snapshot = [...levels]
        audioLevelsRef.current = snapshot
        setVoiceState(prev => ({ ...prev, voiceAudioLevels: snapshot }))
      },
      () => {
        // External end (e.g. device error) - treat as stop
        if (stateRef.current === 'recording') {
          finishRecording()
        }
      },
      { silenceDetection: false },
    )

    if (sessionGenRef.current !== myGen) return
    if (!started) {
      logError(new Error('[voice] Recording failed — no audio tool found'))
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
      setVoiceState(prev => ({
        ...prev,
        voiceError: 'Recording failed — no audio tool found',
      }))
      return
    }

    const rawLanguage = getInitialSettings().language
    const stt = normalizeLanguageForSTT(rawLanguage)
    logEvent('tengu_voice_recording_started', {
      focusTriggered: focusTriggeredRef.current,
      sttLanguage:
        stt.code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      sttLanguageIsDefault: !rawLanguage?.trim(),
      sttLanguageFellBack: stt.fellBackFrom !== undefined,
      // ISO 639 subtag from Intl (bounded set, never user text). undefined if
      // Intl failed — omitted from the payload, no retry cost (cached).
      systemLocaleLanguage:
        getSystemLocaleLanguage() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // ── Hold-to-talk handler ────────────────────────────────────────────
  // Called on every keypress (including terminal auto-repeats while
  // the key is held).  A gap longer than RELEASE_TIMEOUT_MS between
  // events is interpreted as key release.
  //
  // Recording starts immediately on the first keypress to eliminate
  // startup delay.  The release timer is only armed after auto-repeat
  // is detected (to avoid false releases during the OS key repeat
  // delay of ~500ms on macOS).
  const handleKeyEvent = useCallback(
    (fallbackMs = REPEAT_FALLBACK_MS): void => {
      if (!enabled || !isLocalTranscribeConfigured()) {
        return
      }

      // In focus mode, recording is driven by terminal focus, not keypresses.
      if (focusTriggeredRef.current) {
        // Active focus recording — ignore key events (session ends on blur).
        return
      }
      if (focusMode && silenceTimedOutRef.current) {
        // Focus session timed out due to silence — keypress re-arms it.
        logForDebugging(
          '[voice] Re-arming focus recording after silence timeout',
        )
        silenceTimedOutRef.current = false
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
        return
      }

      const currentState = stateRef.current

      // Ignore keypresses while processing
      if (currentState === 'processing') {
        return
      }

      if (currentState === 'idle') {
        logForDebugging(
          '[voice] handleKeyEvent: idle, starting recording session immediately',
        )
        void startRecordingSession()
        // Fallback: if no auto-repeat arrives within REPEAT_FALLBACK_MS,
        // arm the release timer anyway (the user likely tapped and released).
        repeatFallbackTimerRef.current = setTimeout(
          (
            repeatFallbackTimerRef,
            stateRef,
            seenRepeatRef,
            releaseTimerRef,
            finishRecording,
          ) => {
            repeatFallbackTimerRef.current = null
            if (stateRef.current === 'recording' && !seenRepeatRef.current) {
              logForDebugging(
                '[voice] No auto-repeat seen, arming release timer via fallback',
              )
              seenRepeatRef.current = true
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
          fallbackMs,
          repeatFallbackTimerRef,
          stateRef,
          seenRepeatRef,
          releaseTimerRef,
          finishRecording,
        )
      } else if (currentState === 'recording') {
        // Second+ keypress while recording — auto-repeat has started.
        seenRepeatRef.current = true
        if (repeatFallbackTimerRef.current) {
          clearTimeout(repeatFallbackTimerRef.current)
          repeatFallbackTimerRef.current = null
        }
      }

      // Reset the release timer on every keypress (including auto-repeats)
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current)
      }

      // Only arm the release timer once auto-repeat has been seen.
      // The OS key repeat delay is ~500ms on macOS; without this gate
      // the 200ms timer fires before repeat starts, causing a false release.
      if (stateRef.current === 'recording' && seenRepeatRef.current) {
        releaseTimerRef.current = setTimeout(
          (releaseTimerRef, stateRef, finishRecording) => {
            releaseTimerRef.current = null
            if (stateRef.current === 'recording') {
              finishRecording()
            }
          },
          RELEASE_TIMEOUT_MS,
          releaseTimerRef,
          stateRef,
          finishRecording,
        )
      }
    },
    [enabled, focusMode, cleanup],
  )

  // Cleanup only when disabled or unmounted - NOT on state changes
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup])

  return {
    state,
    handleKeyEvent,
  }
}

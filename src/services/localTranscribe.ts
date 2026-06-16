// Local speech-to-text for push-to-talk voice input.
//
// Replaces the Anthropic voice_stream WebSocket client. Works regardless of
// how the user is authenticated (API key, Bedrock, OAuth, or no login at all)
// because transcription runs against a local/self-hosted engine rather than
// Anthropic's servers.
//
// Two backends, selected by config:
//   - HTTP (default): POST the recorded clip to an OpenAI-compatible
//     /v1/audio/transcriptions endpoint (whisper.cpp server,
//     faster-whisper-server, LocalAI, Ollama, Groq, OpenAI, …).
//   - Binary (optional): shell out to a local whisper.cpp executable for
//     fully-offline transcription with no server running.
//
// Audio arrives as raw 16kHz / 16-bit signed / mono PCM (the format produced
// by src/services/voice.ts). We wrap it in a WAV container before handing it
// to either backend.

import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getProxyFetchOptions } from '../utils/proxy.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  getProvisionedWhisper,
  provisionWhisper,
} from './whisperProvision.js'

// PCM format constants — must match RECORDING_* in services/voice.ts.
const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

const DEFAULT_STT_URL = 'http://localhost:8080/v1/audio/transcriptions'
const DEFAULT_STT_MODEL = 'whisper-1'

export type TranscribeResult = { text: string }

type SttConfig = {
  url: string
  model: string
  apiKey?: string
  binary?: string
  modelPath?: string
  // True when the user explicitly pointed voice at an HTTP endpoint (env or
  // settings). When false we're on the built-in default and prefer the
  // auto-provisioned offline engine over the (likely-absent) localhost server.
  urlExplicit: boolean
}

// Resolve STT config from env overrides (highest priority) then settings.json.
function getSttConfig(): SttConfig {
  const settings = getInitialSettings()
  const binary = process.env.VOICE_STT_BINARY || settings.voiceSttBinary
  const modelPath =
    process.env.VOICE_STT_MODEL_PATH || settings.voiceSttModelPath
  const explicitUrl = process.env.VOICE_STT_URL || settings.voiceSttUrl
  return {
    url: explicitUrl || DEFAULT_STT_URL,
    model:
      process.env.VOICE_STT_MODEL || settings.voiceSttModel || DEFAULT_STT_MODEL,
    apiKey: process.env.VOICE_STT_API_KEY || settings.voiceSttApiKey,
    binary: binary || undefined,
    modelPath: modelPath || undefined,
    urlExplicit: Boolean(explicitUrl),
  }
}

// Voice dictation always has a working default (the HTTP endpoint), so the
// command and keybinding are always available — there is no auth/provider
// requirement to gate on. Kept as a function so callers read intent clearly
// and so a future "require explicit config" policy has one place to change.
export function isLocalTranscribeConfigured(): boolean {
  return true
}

// Wrap raw little-endian PCM in a minimal 44-byte WAV header so the audio is
// self-describing for HTTP endpoints and whisper.cpp (which both want a real
// container, not headerless PCM).
export function pcmToWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4) // RIFF chunk size
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20) // audio format = PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// ─── HTTP backend ───────────────────────────────────────────────────────

async function transcribeHttp(
  wav: Buffer,
  cfg: SttConfig,
  opts: { language?: string; prompt?: string },
): Promise<TranscribeResult> {
  const form = new FormData()
  // Node/Bun Blob accepts a Uint8Array; wav is a Buffer (a Uint8Array subclass).
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', cfg.model)
  if (opts.language) form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)
  // OpenAI returns { text } by default with response_format=json.
  form.append('response_format', 'json')

  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  logForDebugging(
    `[voice] Transcribing ${String(wav.length)} bytes via HTTP ${cfg.url} (model=${cfg.model})`,
  )

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const res = await fetch(cfg.url, {
    method: 'POST',
    body: form,
    headers,
    ...getProxyFetchOptions(),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Transcription endpoint returned HTTP ${String(res.status)}${
        body ? `: ${body.slice(0, 200)}` : ''
      }`,
    )
  }

  // Most OpenAI-compatible servers return JSON { text }. Some minimal servers
  // return plain text; fall back to the raw body in that case.
  const raw = await res.text()
  let text = raw
  try {
    const parsed = JSON.parse(raw) as { text?: string }
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {
    // plain-text response — use as-is
  }
  return { text: text.trim() }
}

// ─── Binary backend (whisper.cpp) ───────────────────────────────────────

async function transcribeBinary(
  wav: Buffer,
  cfg: SttConfig,
  opts: { language?: string },
): Promise<TranscribeResult> {
  if (!cfg.modelPath) {
    throw new Error(
      'voiceSttBinary is set but voiceSttModelPath (whisper model .bin) is not configured.',
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'claude-voice-'))
  const wavPath = join(dir, 'audio.wav')
  try {
    await writeFile(wavPath, wav)
    // whisper.cpp CLI: -otxt writes <wavPath>.txt; -nt strips timestamps.
    const args = [
      '-m',
      cfg.modelPath,
      '-f',
      wavPath,
      '-l',
      opts.language ?? 'auto',
      '-otxt',
      '-nt',
    ]
    logForDebugging(
      `[voice] Transcribing via binary ${cfg.binary} ${args.join(' ')}`,
    )
    await runProcess(cfg.binary!, args)
    const txt = await readFile(`${wavPath}.txt`, 'utf8')
    return { text: txt.trim() }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runProcess(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `${cmd} exited with code ${String(code)}${
              stderr ? `: ${stderr.slice(-200)}` : ''
            }`,
          ),
        )
    })
  })
}

// ─── Public API ─────────────────────────────────────────────────────────

// Transcribe a complete recording. `pcm` is the concatenated raw PCM captured
// while the key was held. Returns the recognized text (possibly empty if the
// clip contained no speech).
export async function transcribePcm(
  pcm: Buffer,
  opts: { language?: string; prompt?: string } = {},
): Promise<TranscribeResult> {
  const cfg = getSttConfig()
  const wav = pcmToWav(pcm)
  try {
    // 1. Explicit binary config always wins.
    if (cfg.binary) {
      return await transcribeBinary(wav, cfg, { language: opts.language })
    }
    // 2. If the user explicitly configured an HTTP endpoint, honor it.
    if (cfg.urlExplicit) {
      return await transcribeHttp(wav, cfg, opts)
    }
    // 3. Default path: use the auto-provisioned offline engine. Provision it
    //    on demand if needed (normally already done at /voice enable time).
    const provisioned =
      getProvisionedWhisper() ?? (await provisionWhisper().catch(() => null))
    if (provisioned) {
      return await transcribeBinary(
        wav,
        { ...cfg, binary: provisioned.binary, modelPath: provisioned.modelPath },
        { language: opts.language },
      )
    }
    // 4. Last resort (e.g. macOS without brew): the built-in HTTP default.
    return await transcribeHttp(wav, cfg, opts)
  } catch (err) {
    logError(toError(err))
    throw err
  }
}

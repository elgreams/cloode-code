// Auto-provisioning of an offline whisper.cpp engine for voice dictation.
//
// Goal: a non-technical user runs `/voice` and it just works — no server to
// install, no config to edit. On first enable we download a self-contained
// whisper.cpp binary plus a small ggml model into the Claude config dir and
// transcribe fully offline thereafter.
//
// Distribution facts (whisper.cpp release v1.8.7, ggml-org/whisper.cpp):
//   - Linux  x64/arm64: tarball with a statically-friendly `whisper-cli`
//     (needs only libc/libstdc++/libgomp — present on any desktop Linux).
//   - Windows x64:       zip with `whisper-cli.exe` + bundled ggml/SDL DLLs.
//   - macOS:             NO official prebuilt CLI. We fall back to a Homebrew
//     `whisper-cpp` if present, otherwise return null so the caller keeps the
//     configurable HTTP backend.
// Models are fetched from the canonical HuggingFace repo.

import { spawn } from 'child_process'
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { toError } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { logError } from '../utils/log.js'
import { createAxiosInstance } from '../utils/proxy.js'

// Pinned release — bump deliberately so the asset names below stay valid.
const WHISPER_VERSION = 'v1.8.7'
const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}`

// Default model. base.en is the sweet spot for English dictation: ~142MB,
// markedly more accurate than tiny while still fast on CPU. Overridable via
// VOICE_WHISPER_MODEL (e.g. "small.en", "medium", "large-v3-turbo").
const DEFAULT_MODEL = 'base.en'
const MODEL_BASE =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export type ProvisionProgress = {
  // 'binary' while fetching the engine, 'model' while fetching weights.
  phase: 'binary' | 'model'
  // 0..1 when Content-Length is known, otherwise undefined (indeterminate).
  ratio?: number
  // Human-readable label, e.g. "whisper engine" / "speech model (base.en)".
  label: string
}

export type ProvisionResult = {
  // Absolute path to the whisper-cli executable.
  binary: string
  // Absolute path to the ggml model file.
  modelPath: string
}

type PlatformAsset = {
  // Release asset filename.
  asset: string
  // 'tar' (Linux .tar.gz) or 'zip' (Windows).
  kind: 'tar' | 'zip'
}

// Map process.platform/arch to the matching release asset. Returns null on
// platforms with no prebuilt CLI (macOS) — the caller handles the brew path.
function platformAsset(): PlatformAsset | null {
  if (process.platform === 'linux') {
    if (process.arch === 'x64')
      return { asset: 'whisper-bin-ubuntu-x64.tar.gz', kind: 'tar' }
    if (process.arch === 'arm64')
      return { asset: 'whisper-bin-ubuntu-arm64.tar.gz', kind: 'tar' }
    return null
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { asset: 'whisper-bin-x64.zip', kind: 'zip' }
  }
  return null
}

function whisperDir(): string {
  return join(getClaudeConfigHomeDir(), 'whisper')
}

function binaryName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
}

function modelName(): string {
  return process.env.VOICE_WHISPER_MODEL?.trim() || DEFAULT_MODEL
}

function binaryPath(): string {
  return join(whisperDir(), 'bin', binaryName())
}

function modelPath(): string {
  return join(whisperDir(), 'models', `ggml-${modelName()}.bin`)
}

// True if both the engine and the selected model are already on disk.
export function isWhisperProvisioned(): boolean {
  return existsSync(binaryPath()) && existsSync(modelPath())
}

// Resolve the provisioned engine without downloading. Returns null if either
// piece is missing — callers should provision() first.
export function getProvisionedWhisper(): ProvisionResult | null {
  if (!isWhisperProvisioned()) return null
  return { binary: binaryPath(), modelPath: modelPath() }
}

// ─── macOS via Homebrew ──────────────────────────────────────────────────

function which(cmd: string): Promise<string | null> {
  return new Promise(resolve => {
    // whisper-cli prints usage and exits non-zero with no args, but the spawn
    // succeeding (no 'error') already proves the binary exists on PATH.
    const child = spawn(cmd, ['--help'], { stdio: 'ignore' })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(cmd))
  })
}

// On macOS there is no prebuilt CLI asset. If Homebrew's `whisper-cpp` is
// installed it provides `whisper-cli`, so use it. We do NOT auto-run
// `brew install` (slow, may prompt, compiles) — instead the caller surfaces a
// one-line hint. Returns the binary path or null.
async function resolveMacWhisper(): Promise<string | null> {
  const candidates = ['whisper-cli', 'whisper-cpp']
  for (const c of candidates) {
    const found = await which(c)
    if (found) return found
  }
  return null
}

// ─── Download with progress ───────────────────────────────────────────────

async function downloadToFile(
  url: string,
  dest: string,
  onProgress: ((ratio: number | undefined) => void) | undefined,
): Promise<void> {
  const axios = createAxiosInstance()
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 10 * 60_000,
    maxContentLength: 2 * 1024 * 1024 * 1024,
    maxRedirects: 5,
    onDownloadProgress: e => {
      if (!onProgress) return
      const total = e.total
      onProgress(total ? e.loaded / total : undefined)
    },
  })
  await writeFile(dest, Buffer.from(res.data))
}

// ─── Archive extraction ───────────────────────────────────────────────────

function runCmd(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', code =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${cmd} exited ${String(code)}${stderr ? `: ${stderr.slice(-200)}` : ''}`,
            ),
          ),
    )
  })
}

// Extract the whisper-cli (and, on Windows, its sibling DLLs) from a release
// archive into `<whisper>/bin/`. Linux uses system `tar` (always present);
// Windows uses fflate. Only the files we need are written.
async function extractBinary(
  archivePath: string,
  kind: 'tar' | 'zip',
  binDir: string,
): Promise<void> {
  await mkdir(binDir, { recursive: true })

  if (kind === 'tar') {
    // Strip the top-level "whisper-bin-ubuntu-*/" dir; keep only whisper-cli.
    const tmp = join(binDir, '.extract')
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    await runCmd('tar', ['xzf', archivePath, '-C', tmp])
    // The binary sits one directory deep: whisper-bin-ubuntu-x64/whisper-cli.
    const top = (await readdir(tmp))[0]
    const src = join(tmp, top, 'whisper-cli')
    const dst = join(binDir, 'whisper-cli')
    await rename(src, dst)
    await chmod(dst, 0o755)
    await rm(tmp, { recursive: true, force: true })
    return
  }

  // Windows zip: pull whisper-cli.exe and every .dll out of the Release/ dir.
  const { unzipFile } = await import('../utils/dxt/zip.js')
  const { readFile } = await import('fs/promises')
  const entries = await unzipFile(await readFile(archivePath))
  for (const [name, data] of Object.entries(entries)) {
    const base = name.split('/').pop() ?? name
    const isWanted =
      base.toLowerCase() === 'whisper-cli.exe' ||
      base.toLowerCase().endsWith('.dll')
    if (!isWanted) continue
    await writeFile(join(binDir, base), Buffer.from(data))
  }
}

// ─── Public provisioning entry point ──────────────────────────────────────

let inFlight: Promise<ProvisionResult | null> | null = null

// Ensure an offline whisper engine + model are available, downloading them on
// first call. Idempotent and concurrency-safe (single in-process promise plus a
// cross-process lockfile). Returns null when the platform has no prebuilt
// engine and no Homebrew fallback — the caller then keeps the HTTP backend.
//
// `onProgress` is invoked during downloads so the UI can show a real bar.
export function provisionWhisper(
  onProgress?: (p: ProvisionProgress) => void,
): Promise<ProvisionResult | null> {
  inFlight ??= doProvision(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doProvision(
  onProgress?: (p: ProvisionProgress) => void,
): Promise<ProvisionResult | null> {
  // Already done — fast path, no lock, no network.
  const existing = getProvisionedWhisper()
  if (existing) return existing

  // macOS: no prebuilt CLI. Use brew's whisper-cli if available; still need a
  // model, which we can download regardless of platform.
  if (process.platform === 'darwin') {
    const mac = await resolveMacWhisper()
    if (!mac) return null
    const model = await ensureModel(onProgress)
    return { binary: mac, modelPath: model }
  }

  const asset = platformAsset()
  if (!asset) return null // unsupported platform/arch

  const dir = whisperDir()
  await mkdir(dir, { recursive: true })

  // Cross-process lock so two CLI instances don't race the same download.
  const lockPath = join(dir, '.provision')
  await writeFile(lockPath, '').catch(() => {})
  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(lockPath, { stale: 15 * 60_000, retries: 0 })
  } catch {
    // Another process holds the lock — wait for it to finish, then re-check.
    release = null
  }

  try {
    // Re-check after acquiring (or failing to acquire) the lock: the other
    // process may have completed provisioning while we waited.
    const afterLock = getProvisionedWhisper()
    if (afterLock) return afterLock
    if (!release) {
      // Couldn't get the lock and it's still not provisioned. Poll briefly.
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const done = getProvisionedWhisper()
        if (done) return done
      }
      return null
    }

    // 1. Engine binary (skip if a prior partial run already placed it).
    if (!existsSync(binaryPath())) {
      const binDir = join(dir, 'bin')
      await mkdir(binDir, { recursive: true })
      const archivePath = join(binDir, asset.asset)
      logForDebugging(`[whisper] downloading engine ${asset.asset}`)
      await downloadToFile(`${RELEASE_BASE}/${asset.asset}`, archivePath, r =>
        onProgress?.({ phase: 'binary', ratio: r, label: 'whisper engine' }),
      )
      await extractBinary(archivePath, asset.kind, binDir)
      await rm(archivePath, { force: true })
    }

    // 2. Model weights.
    const model = await ensureModel(onProgress)

    const result: ProvisionResult = { binary: binaryPath(), modelPath: model }
    logForDebugging(
      `[whisper] provisioned: ${result.binary} + ${result.modelPath}`,
    )
    return result
  } catch (err) {
    logError(toError(err))
    throw err
  } finally {
    if (release) await release().catch(() => {})
  }
}

// Download the selected ggml model unless it's already present. Shared by the
// macOS and prebuilt paths.
async function ensureModel(
  onProgress?: (p: ProvisionProgress) => void,
): Promise<string> {
  const dest = modelPath()
  if (existsSync(dest)) return dest
  const dir = join(whisperDir(), 'models')
  await mkdir(dir, { recursive: true })
  const name = modelName()
  const tmp = `${dest}.${String(process.pid)}.tmp`
  const url = `${MODEL_BASE}/ggml-${name}.bin`
  logForDebugging(`[whisper] downloading model ggml-${name}.bin`)
  await downloadToFile(url, tmp, r =>
    onProgress?.({
      phase: 'model',
      ratio: r,
      label: `speech model (${name})`,
    }),
  )
  // Sanity-check the download is a real model, not an HTML error page.
  const info = await stat(tmp)
  if (info.size < 1_000_000) {
    await rm(tmp, { force: true })
    throw new Error(
      `Model download failed (got ${String(info.size)} bytes from ${url}).`,
    )
  }
  await rename(tmp, dest)
  return dest
}

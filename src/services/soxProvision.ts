// Auto-provisioning of a SoX recorder on Windows for voice dictation.
//
// Windows source builds don't bundle the native audio-capture module, so mic
// capture has no in-process backend there. Linux/macOS fall back to a system
// `rec`/`arecord`; Windows users rarely have SoX on PATH. To keep voice
// "just works" (the same goal as whisperProvision), we download a small
// self-contained SoX build into the Claude config dir on first voice enable
// and record through `sox.exe -d` thereafter — no installer, no admin, no PATH.
//
// Only Windows is provisioned here: Linux/macOS keep using their system
// recorder (`rec`/`arecord`), which their package managers provide.

import { mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { toError } from '../utils/errors.js'
import * as lockfile from '../utils/lockfile.js'
import { logError } from '../utils/log.js'
import { createAxiosInstance } from '../utils/proxy.js'

// Pinned SoX release. The win32 zip ships sox.exe plus its sibling DLLs under
// a top-level "sox-<version>/" directory. SourceForge is SoX's canonical host;
// the /download suffix 302-redirects to a mirror (axios follows redirects).
const SOX_VERSION = '14.4.2'
const SOX_WIN_URL = `https://sourceforge.net/projects/sox/files/sox/${SOX_VERSION}/sox-${SOX_VERSION}-win32.zip/download`

function soxDir(): string {
  return join(getClaudeConfigHomeDir(), 'sox')
}

function soxBinDir(): string {
  return join(soxDir(), 'bin')
}

// Absolute path to the provisioned sox executable.
export function soxBinaryPath(): string {
  return join(soxBinDir(), 'sox.exe')
}

// True once sox.exe is on disk. Windows-only — other platforms use system rec.
export function isSoxProvisioned(): boolean {
  return process.platform === 'win32' && existsSync(soxBinaryPath())
}

// Resolve the provisioned sox.exe without downloading. Null if not present.
export function getProvisionedSox(): string | null {
  return isSoxProvisioned() ? soxBinaryPath() : null
}

// ─── Download ─────────────────────────────────────────────────────────────

async function downloadToFile(
  url: string,
  dest: string,
  onProgress: ((ratio: number | undefined) => void) | undefined,
): Promise<void> {
  const axios = createAxiosInstance()
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 10 * 60_000,
    maxContentLength: 256 * 1024 * 1024,
    maxRedirects: 5,
    onDownloadProgress: e => {
      if (!onProgress) return
      const total = e.total
      onProgress(total ? e.loaded / total : undefined)
    },
  })
  await writeFile(dest, Buffer.from(res.data))
}

// Extract sox.exe and every sibling .dll from the win32 zip into binDir,
// flattening the top-level "sox-<version>/" directory.
async function extractSox(archivePath: string, binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true })
  const { unzipFile } = await import('../utils/dxt/zip.js')
  const { readFile } = await import('fs/promises')
  const entries = await unzipFile(await readFile(archivePath))
  for (const [name, data] of Object.entries(entries)) {
    const base = name.split('/').pop() ?? name
    const lower = base.toLowerCase()
    const isWanted = lower === 'sox.exe' || lower.endsWith('.dll')
    if (!isWanted) continue
    await writeFile(join(binDir, base), Buffer.from(data))
  }
}

// ─── Public provisioning entry point ──────────────────────────────────────

let inFlight: Promise<string | null> | null = null

// Ensure sox.exe is available on Windows, downloading it on first call.
// Idempotent and concurrency-safe (single in-process promise + cross-process
// lockfile). Returns the binary path, or null on non-Windows platforms or if
// provisioning fails.
export function provisionSox(
  onProgress?: (ratio: number | undefined) => void,
): Promise<string | null> {
  inFlight ??= doProvision(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doProvision(
  onProgress?: (ratio: number | undefined) => void,
): Promise<string | null> {
  if (process.platform !== 'win32') return null

  // Already done — fast path, no lock, no network.
  const existing = getProvisionedSox()
  if (existing) return existing

  const dir = soxDir()
  await mkdir(dir, { recursive: true })

  // Cross-process lock so two CLI instances don't race the same download.
  const lockPath = join(dir, '.provision')
  await writeFile(lockPath, '').catch(() => {})
  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(lockPath, { stale: 15 * 60_000, retries: 0 })
  } catch {
    release = null
  }

  try {
    // Re-check after acquiring (or failing to acquire) the lock.
    const afterLock = getProvisionedSox()
    if (afterLock) return afterLock
    if (!release) {
      // Another process is downloading. Poll briefly for it to finish.
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const done = getProvisionedSox()
        if (done) return done
      }
      return null
    }

    const binDir = soxBinDir()
    await mkdir(binDir, { recursive: true })
    const archivePath = join(binDir, `sox-${SOX_VERSION}-win32.zip`)
    logForDebugging('[sox] downloading recorder')
    await downloadToFile(SOX_WIN_URL, archivePath, onProgress)
    await extractSox(archivePath, binDir)
    await rm(archivePath, { force: true })

    const bin = soxBinaryPath()
    if (!existsSync(bin)) {
      throw new Error('SoX archive did not contain sox.exe')
    }
    const info = await stat(bin)
    if (info.size < 100_000) {
      await rm(bin, { force: true })
      throw new Error(
        `SoX download looks corrupt (sox.exe was ${String(info.size)} bytes).`,
      )
    }
    logForDebugging(`[sox] provisioned: ${bin}`)
    return bin
  } catch (err) {
    logError(toError(err))
    return null
  } finally {
    if (release) await release().catch(() => {})
  }
}

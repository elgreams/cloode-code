import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { logForDebugging } from '../debug.js'

// Persistent profile so logins/cookies stick across sessions. A dedicated dir
// (not the user's default Chrome profile) means we launch an independent
// instance that never collides with their everyday browser.
export function getBrowserProfileDir(): string {
  return join(getClaudeConfigHomeDir(), 'browser-mcp', 'profile')
}

/**
 * Candidate Chrome/Chromium executables per platform. First existing one wins.
 * `CLAUDE_BROWSER_EXECUTABLE` overrides everything (used in CI / on boxes
 * without Google Chrome, pointed at a Chromium binary).
 */
function chromeCandidates(): string[] {
  const override = process.env.CLAUDE_BROWSER_EXECUTABLE
  if (override) {
    return [override]
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const pf86 =
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env['LOCALAPPDATA'] ?? ''
    return [
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean) as string[]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  // Linux: PATH-resolved names first, then common absolute paths.
  return [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

// Resolve a bare executable name (no path separator) against PATH, the way the
// OS would at spawn time. Returns the first existing match, or undefined.
function resolveOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = join(dir, name)
    if (existsSync(full)) {
      return full
    }
  }
  return undefined
}

function resolveChromePath(): string | undefined {
  for (const cand of chromeCandidates()) {
    // Bare names (no path separator) must be resolved against PATH here, not
    // accepted blindly: if we hand a non-existent name like `google-chrome` to
    // spawn(), it fails with ENOENT *after* launchChrome() has already moved on
    // to polling for DevToolsActivePort — which then times out with a
    // misleading "did not expose a DevTools port" error instead of falling
    // through to the next candidate (e.g. `chromium`). Absolute paths just need
    // to exist on disk.
    if (!cand.includes('/') && !cand.includes('\\')) {
      const resolved = resolveOnPath(cand)
      if (resolved) {
        return resolved
      }
      continue
    }
    if (existsSync(cand)) {
      return cand
    }
  }
  return undefined
}

export type LaunchedChrome = {
  proc: ChildProcess
  port: number
  browserWSEndpoint: string
}

// We record the launched Chrome's PID here so a later launch can evict it. The
// profile is single-owner (only the MCP ever uses it), so any Chrome still
// bound to it after our process is gone is an orphan from a crashed session.
function chromePidFile(profileDir: string): string {
  return join(profileDir, 'mcp_chrome.pid')
}

/**
 * Kill any Chrome we previously launched on this profile that is still alive,
 * then clear the singleton lock files it left behind. Without this, launching a
 * second Chrome on the same `--user-data-dir` makes the new process hand off to
 * the surviving instance and exit *without* writing DevToolsActivePort — which
 * surfaces as "Chrome did not expose a DevTools port in time". A crashed session
 * (our shutdown() never ran) is exactly when this orphan is left behind.
 */
/**
 * Split a shell-style argument string into tokens, honoring single and double
 * quotes (which group spaces and are stripped from the result). Used for
 * CLAUDE_BROWSER_EXTRA_ARGS so a quoted value containing spaces stays one arg.
 * Goes to `spawn` with no shell, so quotes here are purely for grouping — there
 * is no shell-injection surface to widen.
 */
function tokenizeArgs(input: string | undefined): string[] {
  if (!input) return []
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | undefined
  let has = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = undefined
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === ' ' || ch === '\t') {
      if (has) tokens.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) tokens.push(cur)
  return tokens
}

/**
 * True only if `pid` is a live process whose command line is a Chrome launched
 * against `profileDir` (i.e. it carries our `--user-data-dir`). Guards the
 * orphan reaper against killing an unrelated process that reused a recycled PID.
 * On any uncertainty (command unavailable, read failed) returns false — we'd
 * rather leak an orphan than kill the wrong process.
 */
function pidIsOurChrome(pid: number, profileDir: string): boolean {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    let cmdline = ''
    if (process.platform === 'win32') {
      // CIM gives the full command line; query by PID and read CommandLine.
      cmdline = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } else {
      // `ps -o command=` prints the argv of the pid with no header.
      cmdline = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    }
    return cmdline.includes(profileDir)
  } catch {
    return false
  }
}

function reapOrphanChrome(profileDir: string): void {
  const pidFile = chromePidFile(profileDir)
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isFinite(pid) && pid > 0) {
      try {
        // Signal 0 just tests for existence; if it throws, the process is gone.
        process.kill(pid, 0)
        // The recorded PID may have been recycled by the OS to an unrelated
        // process after our orphaned Chrome died. Only kill if the live process
        // is positively a Chrome bound to THIS profile; otherwise skip (the
        // SingletonLock cleanup below still recovers the handoff case).
        if (pidIsOurChrome(pid, profileDir)) {
          process.kill(pid)
          logForDebugging(`[browser] reaped orphan chrome pid ${pid}`)
        } else {
          logForDebugging(
            `[browser] pid ${pid} is alive but not our chrome — not killing`,
          )
        }
      } catch {
        // Not running (or not ours to kill) — nothing to reap.
      }
    }
    rmSync(pidFile, { force: true })
  }
  // Chrome treats a live SingletonLock as "another instance owns this profile"
  // and hands off to it. With the owner now dead, drop the stale lock so our
  // fresh launch takes ownership instead of handing off.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, name), { force: true })
  }
}

async function readDevToolsPort(
  profileDir: string,
  timeoutMs: number,
): Promise<number> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const start = Date.now()
  // Poll the DevToolsActivePort file Chrome writes once the debug server is up.
  // (Date.now() is available here — chrome.ts only runs in the live MCP
  // subprocess, never inside a replayable Workflow script.)
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf8').trim()
      const port = Number.parseInt(raw.split('\n')[0] ?? '', 10)
      if (Number.isFinite(port) && port > 0) {
        return port
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(
    'Chrome did not expose a DevTools port in time (DevToolsActivePort missing)',
  )
}

/**
 * Launch the user's installed Chrome with a TCP remote-debugging port and a
 * persistent profile, then resolve its browser-level WebSocket endpoint.
 *
 * Uses `--remote-debugging-port` (TCP), NOT `--remote-debugging-pipe`: the pipe
 * relies on inherited fds 3/4 which Bun-on-Windows does not pass to children.
 * A plain port spawn has no extra fds, so it works under Bun on every OS.
 */
export async function launchChrome(): Promise<LaunchedChrome> {
  const exe = resolveChromePath()
  if (!exe) {
    throw new Error(
      'No Chrome/Chromium found. Install Google Chrome, or set ' +
        'CLAUDE_BROWSER_EXECUTABLE to a Chromium binary.',
    )
  }
  const profile = getBrowserProfileDir()
  mkdirSync(profile, { recursive: true })
  // A stale port file from a crashed prior run would be read as a live port.
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })
  // Evict any orphaned Chrome from a crashed session so we launch a fresh
  // instance instead of handing off to it (which never writes the port file).
  reapOrphanChrome(profile)

  const args = [
    '--remote-debugging-port=0', // 0 → Chrome picks a free port, written to DevToolsActivePort
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,AcceptCHFrame',
    '--homepage=about:blank',
    // Extra args (e.g. --no-sandbox in containers/CI). Tokenized quote-aware so
    // a flag whose value contains spaces survives (e.g.
    // --host-resolver-rules="MAP * 1.2.3.4"); a naive split(' ') would shatter it.
    ...tokenizeArgs(process.env.CLAUDE_BROWSER_EXTRA_ARGS),
    'about:blank',
  ]
  logForDebugging(`[browser] launching ${exe}`)
  const proc = spawn(exe, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Detach so a hung Chrome can't keep our process group alive; we still hold
    // the handle and kill it explicitly on shutdown.
    detached: false,
  })
  // If spawn itself fails (e.g. ENOENT), surface it immediately rather than
  // letting readDevToolsPort() burn its full 30s timeout on a process that
  // never started, then report the misleading "no DevTools port" error.
  const spawnFailed = new Promise<never>((_, reject) => {
    proc.on('error', err => {
      logForDebugging(`[browser] chrome spawn error: ${err}`)
      reject(
        new Error(
          `Failed to launch Chrome (${exe}): ${(err as Error).message}`,
        ),
      )
    })
  })

  // Record the PID so a later launch (after a crash that skips shutdown()) can
  // find and reap this Chrome before colliding on the profile.
  if (proc.pid) {
    writeFileSync(chromePidFile(profile), String(proc.pid), 'utf8')
  }

  const port = await Promise.race([
    readDevToolsPort(profile, 30_000),
    spawnFailed,
  ])
  const version = (await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json()) as { webSocketDebuggerUrl?: string }
  const browserWSEndpoint = version.webSocketDebuggerUrl
  if (!browserWSEndpoint) {
    throw new Error('Chrome did not report a browser WebSocket endpoint')
  }
  logForDebugging(`[browser] chrome debug port ${port}`)
  return { proc, port, browserWSEndpoint }
}

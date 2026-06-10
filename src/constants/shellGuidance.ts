import { env } from '../utils/env.js'

export type ShellKind = 'powershell' | 'cmd' | 'windows-unix' | 'posix' | 'unknown'

function getShellName(): string {
  const shell = process.env.SHELL || process.env.ComSpec || process.env.COMSPEC || 'unknown'
  const lower = shell.toLowerCase()
  if (lower.includes('powershell')) return 'PowerShell'
  if (lower.includes('pwsh')) return 'PowerShell'
  if (lower.includes('cmd.exe')) return 'cmd.exe'
  if (lower.includes('zsh')) return 'zsh'
  if (lower.includes('bash')) return 'bash'
  return shell
}

function detectShellKind(): ShellKind {
  const shell = (process.env.SHELL || '').toLowerCase()
  const comspec = (process.env.ComSpec || process.env.COMSPEC || '').toLowerCase()

  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return 'posix'
  }

  if (env.platform !== 'win32') {
    if (shell.includes('bash') || shell.includes('zsh') || shell.includes('fish')) {
      return 'posix'
    }
    return 'unknown'
  }

  if (
    process.env.MSYSTEM ||
    process.env.MINGW_PREFIX ||
    shell.includes('bash') ||
    shell.includes('zsh') ||
    shell.includes('sh.exe')
  ) {
    return 'windows-unix'
  }

  if (
    process.env.PSModulePath ||
    shell.includes('powershell') ||
    shell.includes('pwsh')
  ) {
    return 'powershell'
  }

  if (comspec.includes('cmd.exe')) {
    return 'cmd'
  }

  return 'powershell'
}

export function getShellInfoLine(): string {
  const shellName = getShellName()
  const kind = detectShellKind()

  if (env.platform === 'win32') {
    if (kind === 'windows-unix') {
      return `Shell: ${shellName} on Windows (Unix-like shell detected; Unix shell syntax is appropriate, but Windows path/permission behavior may differ)`
    }
    if (kind === 'cmd') {
      return `Shell: ${shellName} on Windows (use cmd.exe syntax, not Unix shell syntax)`
    }
    return `Shell: ${shellName} on Windows (use PowerShell syntax, not Unix shell syntax)`
  }

  return `Shell: ${shellName}`
}

export function getShellGuidanceSection(): string | null {
  if (env.platform !== 'win32') {
    return null
  }

  const kind = detectShellKind()
  if (kind === 'windows-unix') {
    return `Windows shell guidance: A Unix-like shell was detected on Windows. Use Unix shell syntax where appropriate, but remember this is still Windows: paths may be C:/Users/name or /c/Users/name, chmod may not behave like Linux on NTFS, and Windows executables may require .exe suffixes.`
  }

  if (kind === 'cmd') {
    return `Windows shell guidance: Use cmd.exe syntax for shell commands. Use dir to list files, type to read files, set NAME=value for environment variables, %NAME% to read them, > NUL 2>&1 for null output, and quote paths with spaces. Prefer PowerShell if available for complex file/search tasks. Do not assume Unix-only commands or paths like sed, awk, grep, chmod, /tmp, or /dev/null exist.`
  }

  return `Windows shell guidance: Prefer PowerShell syntax for shell commands. Common translations: list files with Get-ChildItem -Force; read files with Get-Content -Raw <path>; get first/last lines with Get-Content <path> -TotalCount N or Get-Content <path> -Tail N; search text with Select-String -Path <path> -Pattern <regex>; search recursively with Get-ChildItem -Recurse -File | Select-String -Pattern <regex>; create directories with New-Item -ItemType Directory -Force -Path <path>; copy/move/delete with Copy-Item, Move-Item, and Remove-Item -Recurse -Force; use $env:NAME = "value" for environment variables; use *> $null or Out-Null instead of /dev/null; quote paths with spaces. Do not assume Unix-only commands like sed, awk, grep, chmod, or paths like /tmp exist.`
}

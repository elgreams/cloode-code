#Requires -Version 5.1
# free-code installer (Windows)
# Usage: irm https://raw.githubusercontent.com/elgreams/free-code/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
# Don't let native-command stderr (git/bun write progress there) trip the Stop
# preference on PowerShell 7.4+, which would abort mid-clone/-install.
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Repo       = 'https://github.com/elgreams/free-code.git'
$InstallDir = Join-Path $HOME 'free-code'
$BinDir     = Join-Path $HOME '.local\bin'
$BunMin     = '1.3.11'

function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

function Test-VersionGte($have, $want) {
  try { return [version]$have -ge [version]$want } catch { return $false }
}

# ---- header --------------------------------------------------------------
Write-Host ""
Write-Host @'
   ___                            _
  / _|_ __ ___  ___        ___ __| | ___
 | |_| '__/ _ \/ _ \_____ / __/ _` |/ _ \
 |  _| | |  __/  __/_____| (_| (_| |  __/
 |_| |_|  \___|\___|      \___\__,_|\___|
'@ -ForegroundColor Cyan
Write-Host "  The free build of Claude Code" -ForegroundColor DarkGray
Write-Host ""
Info "Starting installation..."
Write-Host ""

# ---- system checks -------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git is not installed. Install Git for Windows: https://git-scm.com/download/win"
}
Ok "git: $(git --version)"

$bunOk = $false
if (Get-Command bun -ErrorAction SilentlyContinue) {
  $ver = (bun --version) 2>$null
  if (Test-VersionGte $ver $BunMin) { Ok "bun: v$ver"; $bunOk = $true }
  else { Warn "bun v$ver found but v$BunMin+ required. Upgrading..." }
} else {
  Info "bun not found. Installing..."
}

if (-not $bunOk) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Invoke-RestMethod 'https://bun.sh/install.ps1' | Invoke-Expression
  $ErrorActionPreference = $prev
  # Make bun available on PATH for the rest of this session.
  $bunBin = Join-Path $HOME '.bun\bin'
  if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Fail "bun installed but not on PATH. Restart your terminal and re-run this installer."
  }
  Ok "bun: v$(bun --version) (just installed)"
}
Write-Host ""

# ---- clone & build -------------------------------------------------------
if (Test-Path $InstallDir) {
  Warn "$InstallDir already exists"
  if (Test-Path (Join-Path $InstallDir '.git')) {
    Info "Pulling latest changes..."
    git -C $InstallDir pull --ff-only origin main 2>$null
    if ($LASTEXITCODE -ne 0) { Warn "Pull failed, continuing with existing copy" }
  }
} else {
  Info "Cloning repository..."
  git clone --depth 1 $Repo $InstallDir
}
Ok "Source: $InstallDir"

Info "Installing dependencies..."
Push-Location $InstallDir
try {
  bun install --frozen-lockfile 2>$null
  if ($LASTEXITCODE -ne 0) { bun install }
} finally { Pop-Location }
Ok "Dependencies installed"

Info "Building free-code (all experimental features enabled)..."
Push-Location $InstallDir
try { bun run build:dev:full } finally { Pop-Location }
# Bun appends .exe to the compiled output on Windows.
$Exe = Join-Path $InstallDir 'cli-dev.exe'
if (-not (Test-Path $Exe)) { Fail "Build did not produce $Exe" }
Ok "Binary built: $Exe"

# ---- put `free-code` on PATH (a .cmd shim, so rebuilds are picked up) -----
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Shim = Join-Path $BinDir 'free-code.cmd'
Set-Content -Path $Shim -Value "@echo off`r`n`"$Exe`" %*" -Encoding Ascii
Ok "Shim: $Shim"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
  $env:Path = "$BinDir;$env:Path"
  Warn "Added $BinDir to your user PATH — restart your terminal for it to take effect."
}

# ---- done ----------------------------------------------------------------
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Run it:" -ForegroundColor White
Write-Host "    free-code                       # interactive REPL" -ForegroundColor Cyan
Write-Host "    free-code -p `"your prompt`"       # one-shot mode" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Log in with Claude.ai:" -ForegroundColor White
Write-Host "    free-code /login" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source: $InstallDir" -ForegroundColor DarkGray
Write-Host "  Binary: $Exe" -ForegroundColor DarkGray
Write-Host "  Shim:   $Shim" -ForegroundColor DarkGray
Write-Host ""

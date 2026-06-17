#Requires -Version 5.1
# cloode installer (Windows)
# Usage: irm https://raw.githubusercontent.com/elgreams/cloode-code/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
# Don't let native-command stderr (git/bun write progress there) trip the Stop
# preference on PowerShell 7.4+, which would abort mid-clone/-install.
if (Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Repo       = 'https://github.com/elgreams/cloode-code.git'
$InstallDir = Join-Path $HOME 'cloode-code'
$BinDir     = Join-Path $HOME '.local\bin'
$BunMin     = '1.3.11'

function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
# Use throw, not `exit`: this script is run via `irm ... | iex`, so it executes
# in the caller's session. `exit` there terminates the whole PowerShell host —
# closing the window before the user can read the error. `throw` aborts the
# script but leaves the interactive session (and the message) intact, and still
# yields exit code 1 when run as a file via `powershell -File`.
function Fail($m) { Write-Host "[x] $m" -ForegroundColor Red; throw $m }

function Test-VersionGte($have, $want) {
  try { return [version]$have -ge [version]$want } catch { return $false }
}

# ---- header --------------------------------------------------------------
Write-Host ""
Write-Host @'
        _                 _
   ___ | | ___   ___   __| | ___
  / __|| |/ _ \ / _ \ / _` |/ _ \
 | (__ | | (_) | (_) | (_| |  __/
  \___||_|\___/ \___/ \__,_|\___|
'@ -ForegroundColor Cyan
Write-Host "  Claude Code, reanimated." -ForegroundColor DarkGray
Write-Host ""
Info "Starting installation..."
Write-Host ""

# ---- system checks -------------------------------------------------------
# git provides both the clone below AND bash.exe, which the built CLI uses at
# runtime as its default shell. So git is required for install AND for the app
# to work afterwards. If it's missing, try winget (in-box on Win10 1809+/11);
# fall back to the manual download link only if winget is absent or fails.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Info "git not found. Installing Git for Windows via winget..."
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
    $ErrorActionPreference = $prev
    # winget installs to a well-known location but doesn't refresh this running
    # session's PATH. Re-probe PATH, then fall back to the default install dir.
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) {
      # Probe both install scopes: machine-scope lands in ProgramFiles; a
      # non-admin winget run installs user-scope under LocalAppData\Programs.
      # Checking only ProgramFiles reports a successful user install as failure.
      foreach ($gitExe in @(
          (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
          (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe')
        )) {
        if (Test-Path $gitExe) {
          $env:Path = "$(Split-Path $gitExe);$env:Path"
          $gitCmd = Get-Command git -ErrorAction SilentlyContinue
          if ($gitCmd) { break }
        }
      }
    }
  }
  # Fallback: PortableGit — the no-admin, no-winget build of Git for Windows.
  # It's a 7-Zip self-extractor we unpack into the user profile, so it needs no
  # elevation. The built CLI locates bash via a PATH lookup (Shell.ts), so a
  # portable install works fine as long as its bin dir is on PATH — which we
  # both set for this session and persist for future terminals.
  if (-not $gitCmd) {
    try {
      Info "git not found. Downloading PortableGit (no admin required)..."
      $ProgressPreference = 'SilentlyContinue'
      $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'cloode-installer' }
      $asset = $rel.assets | Where-Object { $_.name -match 'PortableGit-.*-64-bit\.7z\.exe$' } | Select-Object -First 1
      if ($asset) {
        $sfx = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest $asset.browser_download_url -OutFile $sfx
        $gitRoot = Join-Path $HOME 'PortableGit'
        Info "Extracting PortableGit to $gitRoot ..."
        # 7-Zip SFX flags: -o<dir> sets the target, -y auto-confirms (silent).
        # Build "-o<dir>" as a SINGLE string argument. Writing -o"$gitRoot"
        # places the quote mid-token; PowerShell 5.1's native-arg quoting then
        # splits a path containing spaces (e.g. C:\Users\First Last\PortableGit)
        # into two arguments, so the SFX extracts to the wrong dir or no-ops. One
        # pre-built string lets the binder quote the whole "-o<path>" correctly.
        & $sfx "-o$gitRoot" -y | Out-Null
        $gitBin = Join-Path $gitRoot 'bin'
        if (Test-Path (Join-Path $gitBin 'git.exe')) {
          $env:Path = "$gitBin;$env:Path"
          $userPathGit = [Environment]::GetEnvironmentVariable('Path', 'User')
          # Compare PATH segments exactly. `-notlike "*$gitBin*"` treats $gitBin
          # as a wildcard pattern: bracket chars in the profile path break the
          # match (duplicate entries on re-run) and substring matching collides
          # with longer entries. Split on ';' and test for an exact member.
          if (($userPathGit -split ';') -notcontains $gitBin) {
            [Environment]::SetEnvironmentVariable('Path', "$gitBin;$userPathGit", 'User')
          }
          $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        }
      }
    } catch {
      Warn "PortableGit install failed: $($_.Exception.Message)"
    }
  }
  if (-not $gitCmd) {
    Fail "git is not installed and could not be installed automatically. Install Git for Windows: https://git-scm.com/download/win then re-run this installer."
  }
}
# Capture git's full path now and call it explicitly later: Bun's installer
# (run via iex below) rewrites $env:Path from the registry, which can drop a
# git entry that only lived on the session PATH — breaking a later `git clone`.
$Git = $gitCmd.Source
Ok "git: $(& $Git --version)"

# Point the CLI at bash.exe explicitly. The CLI otherwise derives bash from
# git's path assuming the standard layout (Git\cmd\git.exe -> Git\bin\bash.exe),
# which misses non-standard installs like PortableGit (git and bash together in
# \bin). We do this for EVERY run (not just fresh PortableGit installs) so a
# re-run on a machine with git already present still gets bash wired up. Resolve
# bash relative to the git we found, then fall back to bash on PATH.
$BashExe = $null
foreach ($cand in @(
    (Join-Path (Split-Path (Split-Path $Git)) 'bin\bash.exe'),  # Git\cmd\git.exe -> Git\bin\bash.exe
    (Join-Path (Split-Path $Git) 'bash.exe')                    # PortableGit\bin\{git,bash}.exe
  )) {
  if (Test-Path $cand) { $BashExe = $cand; break }
}
if (-not $BashExe) {
  $bashCmd = Get-Command bash -ErrorAction SilentlyContinue
  if ($bashCmd) { $BashExe = $bashCmd.Source }
}
if ($BashExe) {
  $env:CLAUDE_CODE_GIT_BASH_PATH = $BashExe
  [Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $BashExe, 'User')
  Ok "bash: $BashExe"
} else {
  Warn "Could not locate bash.exe next to git. If the CLI reports git-bash missing, set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe."
}

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
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Git -C $InstallDir pull --ff-only origin main 2>&1 | Out-Host
    $pullExit = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($pullExit -ne 0) { Warn "Pull failed, continuing with existing copy" }
  }
} else {
  Info "Cloning repository..."
  & $Git clone --depth 1 $Repo $InstallDir
  # `git clone` is a native command; with PSNativeCommandUseErrorActionPreference
  # disabled above, a non-zero exit won't abort on its own. Check it explicitly,
  # else we'd plough on (bun install / build) against a partial or empty dir and
  # surface a confusing "Build did not produce cli-dev.exe" instead of the real
  # cause. Remove the freshly-created dir so a re-run can clone cleanly rather
  # than taking the pull path on a broken checkout.
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    Fail "git clone failed (exit $LASTEXITCODE). Check your network/proxy and re-run."
  }
}
Ok "Source: $InstallDir"

Info "Installing dependencies..."
Push-Location $InstallDir
try {
  bun install --frozen-lockfile 2>$null
  if ($LASTEXITCODE -ne 0) {
    # Frozen-lockfile failed (lockfile drift) — retry without it, this time
    # surfacing diagnostics. Native exit codes don't abort (Stop coupling is
    # disabled above), so check explicitly rather than letting a failed install
    # proceed to the build and masquerade as "Build did not produce cli-dev.exe".
    bun install
    if ($LASTEXITCODE -ne 0) { Fail "bun install failed (exit $LASTEXITCODE)." }
  }
} finally { Pop-Location }
Ok "Dependencies installed"

# build.ts shells out to `git` for the dev version string; make sure git is on
# PATH for the build subprocess (Bun's installer above may have dropped it).
$env:Path = "$(Split-Path $Git);$env:Path"
Info "Building cloode (all experimental features enabled)..."
Push-Location $InstallDir
try { bun run build:dev:full } finally { Pop-Location }
# Bun appends .exe to the compiled output on Windows.
$Exe = Join-Path $InstallDir 'cli-dev.exe'
if (-not (Test-Path $Exe)) { Fail "Build did not produce $Exe" }
Ok "Binary built: $Exe"

# ---- put `cloode` on PATH (a .cmd shim, so rebuilds are picked up) --------
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Shim = Join-Path $BinDir 'cloode.cmd'
$ShimContent = @"
@echo off
"$Exe" %*
"@
Set-Content -Path $Shim -Value $ShimContent -Encoding Ascii
Ok "Shim: $Shim"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
# Exact-segment compare, not `-notlike "*$BinDir*"` (see PortableGit PATH note):
# wildcard matching on the interpolated path duplicates the entry on re-run when
# the profile path has bracket chars, or skips a needed edit on a prefix clash.
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
  $env:Path = "$BinDir;$env:Path"
  Warn "Added $BinDir to your user PATH - restart your terminal for it to take effect."
}

# ---- done ----------------------------------------------------------------
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Run it:" -ForegroundColor White
Write-Host "    cloode                          # interactive REPL" -ForegroundColor Cyan
Write-Host "    cloode -p `"your prompt`"          # one-shot mode" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Log in with Claude.ai:" -ForegroundColor White
Write-Host "    cloode /login" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Source: $InstallDir" -ForegroundColor DarkGray
Write-Host "  Binary: $Exe" -ForegroundColor DarkGray
Write-Host "  Shim:   $Shim" -ForegroundColor DarkGray
Write-Host ""

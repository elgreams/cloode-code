<p align="center">
  <img src="assets/screenshot.png" alt="Cloode Code" width="720" />
</p>

<h1 align="center">Cloode Code</h1>

<p align="center">
  <strong>Claude Code, reanimated.</strong><br>
  All telemetry stripped. All guardrails removed. All experimental features unlocked.<br>
  One binary, zero callbacks home.
</p>

<p align="center">
  <a href="#quick-install"><img src="https://img.shields.io/badge/install-one--liner-blue?style=flat-square" alt="Install" /></a>
  <a href="https://github.com/elgreams/cloode-code/stargazers"><img src="https://img.shields.io/github/stars/elgreams/cloode-code?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/elgreams/cloode-code/issues"><img src="https://img.shields.io/github/issues/elgreams/cloode-code?style=flat-square" alt="Issues" /></a>
  <a href="https://github.com/elgreams/cloode-code/blob/main/FEATURES.md"><img src="https://img.shields.io/badge/features-88%20flags-orange?style=flat-square" alt="Feature Flags" /></a>
</p>

---

## Quick Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/elgreams/cloode-code/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/elgreams/cloode-code/main/install.ps1 | iex
```

Each installer checks your system, installs [Bun](https://bun.sh) if needed, clones the repo, builds with all experimental features enabled, and puts `cloode` on your PATH (a symlink on macOS/Linux, a `cloode.cmd` shim on Windows). On macOS/Linux you'll need [git](https://git-scm.com/downloads) installed first; on Windows the installer auto-installs git for you (via winget, or a no-admin PortableGit fallback) and wires up the bash path the binary needs at runtime.

Then run `cloode` and use the `/login` command to authenticate with your preferred model provider.

---

## Table of Contents

- [What is this](#what-is-this)
- [Model Providers](#model-providers)
- [Quick Install](#quick-install)
- [Requirements](#requirements)
- [Build](#build)
- [Usage](#usage)
- [Multi-Account Switching & Failover](#multi-account-switching--failover)
- [Browser Automation](#browser-automation)
- [Commands & Capabilities](#commands--capabilities)
- [Experimental Features](#experimental-features)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

---

## What is this

A clean, buildable fork of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI -- the terminal-native AI coding agent. The upstream source became publicly available on March 31, 2026 through a source map exposure in the npm distribution.

This fork applies three categories of changes on top of that snapshot:

### Telemetry removed

The upstream binary phones home through OpenTelemetry/gRPC, GrowthBook analytics, Sentry error reporting, and custom event logging. In this build:

- All outbound telemetry endpoints are dead-code-eliminated or stubbed
- GrowthBook feature flag evaluation still works locally (needed for runtime feature gates) but does not report back
- No crash reports, no usage analytics, no session fingerprinting

### Security-prompt guardrails removed

Anthropic injects system-level instructions into every conversation that constrain Claude's behavior beyond what the model itself enforces. These include hardcoded refusal patterns, injected "cyber risk" instruction blocks, and managed-settings security overlays pushed from Anthropic's servers.

This build strips those injections. The model's own safety training still applies -- this just removes the extra layer of prompt-level restrictions that the CLI wraps around it.

### Experimental features unlocked

Claude Code ships with 88 feature flags gated behind `bun:bundle` compile-time switches. Most are disabled in the public npm release. Of the 88, **55 bundle cleanly** and 33 still fail; `bun run build:dev:full` enables a curated **36-flag working bundle** of them. See [Experimental Features](#experimental-features) below, or refer to [FEATURES.md](FEATURES.md) for the full audit.

### Claude-in-Chrome replaced

The upstream Claude-in-Chrome integration depends on an unpublished Anthropic package and cannot run in this fork, so it is disabled. The built-in [`/browser` automation](#browser-automation) replaces it: it drives your installed Chrome directly, with no extension or extra dependencies.

---

## Model Providers

Cloode Code supports **Anthropic, OpenAI/ChatGPT, and any OpenAI-compatible endpoint**
(NVIDIA NIM, OpenRouter, vLLM, Ollama, …) out of the box, plus Bedrock, Vertex, and
Foundry. Anthropic, ChatGPT, and custom OpenAI-compatible models all switch live from
the `/model` menu (sign in with `/login` / `/login-chatgpt`, or add an endpoint with
`/provider`); Bedrock, Vertex, and Foundry are selected via environment variable.

### Anthropic (Direct API) -- Default

Use Anthropic's first-party API directly. Pick any of these from the `/model` menu.

| Model | ID |
|---|---|
| Claude Fable 5 | `claude-fable-5` |
| Claude Opus 4.8 | `claude-opus-4-8` |
| Claude Opus 4.7 | `claude-opus-4-7` |
| Claude Opus 4.6 (default) | `claude-opus-4-6` |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Claude Haiku 4.5 | `claude-haiku-4-5` |

### OpenAI Codex (ChatGPT)

Use GPT models through a ChatGPT (Plus/Pro/Business) subscription. Sign in with
`/login-chatgpt`, then pick a GPT model from `/model` (**no env var required**).
You can be logged into Claude **and** ChatGPT at the same time and switch between
them per request straight from `/model`.

| Model | ID |
|---|---|
| GPT-5.5 (recommended) | `gpt-5.5` |
| GPT-5.4 | `gpt-5.4` |
| GPT-5.4 Mini | `gpt-5.4-mini` |

> ChatGPT-subscription accounts only support the general GPT line above; the
> dedicated `*-codex` variants are API-key-only and will be rejected. `/model`
> shows the models your account can actually use.

```text
/login-chatgpt     # sign in with ChatGPT
/model             # pick a GPT model (or a Claude model, switch any time)
/logout-chatgpt    # sign out of ChatGPT
```

The legacy `CLAUDE_CODE_USE_OPENAI=1` env var still works (forces OpenAI globally),
but it's no longer necessary; per-model routing handles everything.

### NVIDIA NIM & OpenAI-compatible endpoints

Connect **any** OpenAI-compatible `/v1/chat/completions` backend (**NVIDIA NIM**,
OpenRouter, Together, vLLM, Ollama, LM Studio, or your own self-hosted server)
natively, with no proxy. Cloode Code translates the Anthropic Messages protocol to
chat-completions in-process (the same mechanism the ChatGPT integration uses).

Add a provider with `/provider`, then pick its model from `/model`:

```text
/provider add nim nvapi-yourkey                          # NVIDIA NIM (free key at build.nvidia.com)
/provider add custom http://localhost:11434/v1 ollama    # local Ollama / vLLM / LM Studio
/provider list                                           # configured providers + models
/model                                                   # pick a discovered model
```

Cloode Code queries each backend's `/v1/models` endpoint to populate `/model`, and
remembers any model the backend rejects so the menu self-heals. Anthropic-only
features (extended thinking, prompt caching, effort) don't apply to these models
and are dropped from the request automatically.

> **Tool-calling is the whole ballgame.** Cloode Code is a heavy tool user, so choose
> models with solid OpenAI function-calling (e.g. NIM's Nemotron/Llama *-tool*
> variants). Weaker models will struggle regardless of the adapter.

Keys can also come from an env var for CI/scripting (`NVIDIA_NIM_API_KEY`,
`OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, or `OPENAI_COMPAT_API_KEY`); the
matching preset auto-activates without `/provider`.

### AWS Bedrock

Route requests through your AWS account via Amazon Bedrock.

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"   # or AWS_DEFAULT_REGION
cloode
```

Uses your standard AWS credentials (environment variables, `~/.aws/config`, or IAM role). Models are mapped to Bedrock ARN format automatically (e.g., `us.anthropic.claude-opus-4-6-v1`).

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_USE_BEDROCK` | Enable Bedrock provider |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS region (default: `us-east-1`) |
| `ANTHROPIC_BEDROCK_BASE_URL` | Custom Bedrock endpoint |
| `AWS_BEARER_TOKEN_BEDROCK` | Bearer token auth |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | Skip auth (testing) |

### Google Cloud Vertex AI

Route requests through your GCP project via Vertex AI.

```bash
export CLAUDE_CODE_USE_VERTEX=1
cloode
```

Uses Google Cloud Application Default Credentials (`gcloud auth application-default login`). Models are mapped to Vertex format automatically (e.g., `claude-opus-4-6@latest`).

### Anthropic Foundry

Use Anthropic Foundry for dedicated deployments.

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
cloode
```

Supports custom deployment IDs as model names.

### Provider Selection Summary

| Provider | Env Variable | Auth Method |
|---|---|---|
| Anthropic (default) | -- | `ANTHROPIC_API_KEY` or OAuth (`/login`) |
| OpenAI Codex (ChatGPT) | -- (optional `CLAUDE_CODE_USE_OPENAI=1`) | OAuth (`/login-chatgpt`) |
| OpenAI-compatible (NIM, OpenRouter, vLLM, …) | -- | `/provider` (or `*_API_KEY` env) |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | AWS credentials |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | `gcloud` ADC |
| Anthropic Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `ANTHROPIC_FOUNDRY_API_KEY` |

---

## Requirements

- **Runtime**: [Bun](https://bun.sh) >= 1.3.11
- **OS**: macOS, Linux, or Windows (native, see the PowerShell installer above; or via WSL)
- **Auth**: An API key or OAuth login for your chosen provider

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

---

## Build

```bash
git clone https://github.com/elgreams/cloode-code.git
cd cloode-code
bun build
./cli
```

### Build Variants

| Command | Output | Features | Description |
|---|---|---|---|
| `bun run build` | `./cli` | defaults (`VOICE_MODE`, `BUDDY`) | Production-like binary |
| `bun run build:dev` | `./cli-dev` | defaults (`VOICE_MODE`, `BUDDY`) | Dev version stamp |
| `bun run build:dev:full` | `./cli-dev` | defaults + the 36-flag working bundle | Full unlock build |
| `bun run compile` | `./dist/cli` | defaults (`VOICE_MODE`, `BUDDY`) | Alternative output path |

> All builds also embed the platform's ripgrep (self-extracts on first use) so file search works with no external `rg`. On Windows, `compile`/`--target=windows` produce a single `.exe`.

### Custom Feature Flags

Enable specific flags without the full bundle:

```bash
# Enable just ultraplan and ultrathink
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK

# Add a flag on top of the dev build
bun run ./scripts/build.ts --dev --feature=BRIDGE_MODE
```

---

## Usage

```bash
# Interactive REPL (default)
./cli

# One-shot mode
./cli -p "what files are in this directory?"

# Specify a model
./cli --model claude-opus-4-6

# Run from source (slower startup)
bun run dev

# OAuth login
./cli /login
```

### Session Management

Conversations are saved to disk and can be resumed later.

```bash
# Continue the most recent conversation in the current directory
./cli --continue            # or -c

# Resume a specific session by ID
./cli --resume <session-id>

# Open the interactive resume picker (optionally with a search term)
./cli --resume

# List resumable sessions, grouped by directory, with dates + summaries
./cli sessions              # current project (+ worktrees); --all for every project
./cli sessions --json       # structured output for scripts/pipes
./cli sessions --limit 20

# Browse sessions interactively across all projects: pick a directory,
# then a session, and it resumes right there
./cli sessions -i
```

> `sessions` is an alias for `list-sessions`. The interactive browser (`-i`)
> always spans every project, like a file manager rooted at your sessions.

### Environment Variables Reference

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | Auth token (alternative) |
| `ANTHROPIC_MODEL` | Override default model |
| `ANTHROPIC_BASE_URL` | Custom API endpoint |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Custom Opus model ID |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Custom Sonnet model ID |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Custom Haiku model ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token via env |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | API key helper cache TTL |
| `CLAUDE_BROWSER_EXECUTABLE` | Path to a specific Chrome/Chromium binary for `/browser` |
| `CLAUDE_BROWSER_EXTRA_ARGS` | Extra args passed to Chrome at launch |
| `CLAUDE_BROWSER_ACTION_TIMEOUT_MS` | Click/type auto-wait timeout (default 5000) |
| `NVIDIA_NIM_API_KEY` | NVIDIA NIM key (auto-activates the NIM provider) |
| `OPENROUTER_API_KEY` / `TOGETHER_API_KEY` | Auto-activate the OpenRouter / Together preset |
| `OPENAI_COMPAT_API_KEY` | Key for the generic `custom` OpenAI-compatible preset |
| `CLAUDE_CODE_USE_OPENAI` | Force Codex/OpenAI routing globally (legacy) |
| `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX` / `_USE_FOUNDRY` | Select Bedrock / Vertex / Foundry |

---

## Multi-Account Switching & Failover

Save several Anthropic (Claude) logins at once and switch between them, manually
or automatically when one hits its usage limit. The motivating case: two $20 Pro
subscriptions are cheaper than one $100 Max plan, and people already swap between
them by hand. This automates that swap.

Everything lives under the `/account` command:

```text
/account save <label>      # snapshot the current login under a name
/account list              # show saved accounts, active marker, and limit status
/account use <label>       # switch the active account (takes effect next request)
/account remove <label>    # forget a saved account
/account failover [on|off] # auto-switch when the active account is exhausted
/account usage [on|off]    # show a live usage line in the prompt footer
```

**Switching is live.** A switch writes the chosen account's token into the active
slot and takes effect on the next request, with no restart. The displayed identity
(email/profile) follows the switch too.

**Auto-failover (`/account failover on`, default off).** When the active account
is exhausted, the *next* request rolls over to the next non-exhausted saved
account, never mid-response. "Exhausted" means a hard rate-limit rejection
(always a backstop) or crossing a utilization threshold (`autoAccountFailoverThreshold`,
default `0.95` of the 5h or 7d window; set it to `1.0` to squeeze every token and
only switch on a hard reject). Each account's reset time is tracked so failover
won't roll onto another tapped-out account; if every account is exhausted it
surfaces the soonest reset instead of thrashing. Failover only fires from the main
REPL turn boundary.

**Usage footer (`/account usage on`, default off).** Adds a dedicated footer line
showing the active account label, 5h/7d usage %, reset times, and the failover
threshold when enabled. It updates live as limit headers come in and re-labels
when the active account switches.

> **A note on account safety.** Owning and using multiple paid subscriptions you
> hold is normal. Automated failover to defeat per-account caps is a grey area
> ("circumventing rate limits") and credential *sharing* is what provider policies
> target. Use this with accounts that are yours, and at your own discretion.

---

## Browser Automation

Cloode Code can drive your installed Chrome directly: no extension, no Node, no Playwright. Enable it with `/browser on` (off by default; the setting persists), then restart. The tools surface as `mcp__browser__*`.

- Drives your real Chrome/Chromium over the Chrome DevTools Protocol, with a persistent profile so logins stick between sessions.
- Tools: navigate, accessibility snapshot, click, type, press key, evaluate JS, screenshot, console messages, network requests, wait, and tab management.
- Clicks and typing auto-wait for the target to be visible, enabled, and settled before acting.

Requires Chrome, Chromium, or Edge installed. Toggle with `/browser on` / `/browser off`. See the `CLAUDE_BROWSER_*` [environment variables](#environment-variables-reference) to point at a specific browser or tune the auto-wait timeout.

---

## Commands & Capabilities

Run `/help` in the REPL for the full command list. Cloode Code keeps all of Claude Code's built-in machinery and adds a few fork extras.

**Fork extras**

| Command | What it does |
|---|---|
| `/provider` | Add OpenAI-compatible endpoints (NIM, OpenRouter, vLLM, …); see [Model Providers](#model-providers) |
| `/account` | Save, switch, and auto-failover between Anthropic logins; see [Multi-Account Switching & Failover](#multi-account-switching--failover) |
| `/browser` | Drive your installed Chrome over CDP; see [Browser Automation](#browser-automation) |
| `sessions` (CLI) | List/browse resumable sessions across projects; see [Session Management](#session-management) |
| `/color` | Recolor the startup banner border + the Clawd figure (`/color cyan`, `/color #ff8800`, `/color reset`) |
| `/buddy` | Hatch a terminal companion (the April Fools easter egg): `pet`, `rename`, `release`, `mute` |

**Inherited Claude Code essentials** (all working)

| Area | How |
|---|---|
| MCP servers | `/mcp`, or `--mcp-config <file>` to connect external tools/data |
| Skills | `/skills`, or drop `.md` files in `~/.claude/skills/`; invoke with `/skill-name` |
| Memory | `/memory`, plus `CLAUDE.md` auto-discovery for project context |
| Hooks | `/hooks` to run shell commands on tool/file events |
| Plugins | `/plugin` (alias `/marketplace`) to install community plugins |
| Custom agents | `/agents` to define agent presets; `--agents` to load |
| Checkpoints | `/rewind` to restore code/conversation to an earlier point |
| IDE bridge | `/ide` for VS Code / JetBrains / Cursor integration |
| Diagnostics | `/doctor`, `/status`, `/cost`, `/context` |

---

## Experimental Features

The `bun run build:dev:full` build enables the 36-flag working bundle (of the 55 that compile cleanly). Highlights:

### Interaction & UI

| Flag | Description |
|---|---|
| `ULTRAPLAN` | Remote multi-agent planning on Claude Code web (Opus-class) |
| `ULTRATHINK` | Deep thinking mode -- type "ultrathink" to boost reasoning effort |
| `VOICE_MODE` | Push-to-talk voice input and dictation |
| `TOKEN_BUDGET` | Token budget tracking and usage warnings |
| `HISTORY_PICKER` | Interactive prompt history picker |
| `MESSAGE_ACTIONS` | Message action entrypoints in the UI |
| `QUICK_SEARCH` | Prompt quick-search |
| `SHOT_STATS` | Shot-distribution stats |

### Agents, Memory & Planning

| Flag | Description |
|---|---|
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in explore/plan agent presets |
| `VERIFICATION_AGENT` | Verification agent for task validation |
| `AGENT_TRIGGERS` | Local cron/trigger tools for background automation |
| `AGENT_TRIGGERS_REMOTE` | Remote trigger tool path |
| `EXTRACT_MEMORIES` | Post-query automatic memory extraction |
| `COMPACTION_REMINDERS` | Smart reminders around context compaction |
| `CACHED_MICROCOMPACT` | Cached microcompact state through query flows |
| `TEAMMEM` | Team-memory files and watcher hooks |

### Tools & Infrastructure

| Flag | Description |
|---|---|
| `BRIDGE_MODE` | IDE remote-control bridge (VS Code, JetBrains) |
| `BASH_CLASSIFIER` | Classifier-assisted bash permission decisions |
| `PROMPT_CACHE_BREAK_DETECTION` | Cache-break detection in compaction/query flow |

See [FEATURES.md](FEATURES.md) for the complete audit of all 88 flags, including 33 broken flags with reconstruction notes.

---

## Project Structure

```
scripts/
  build.ts                # Build script with feature flag system

src/
  entrypoints/cli.tsx     # CLI entrypoint
  commands.ts             # Command registry (slash commands)
  tools.ts                # Tool registry (agent tools)
  QueryEngine.ts          # LLM query engine
  screens/REPL.tsx        # Main interactive UI (Ink/React)

  commands/               # /slash command implementations
  tools/                  # Agent tool implementations (Bash, Read, Edit, etc.)
  components/             # Ink/React terminal UI components
  hooks/                  # React hooks
  services/               # API clients, MCP, OAuth, analytics
    api/                  # API client + Codex fetch adapter
    oauth/                # OAuth flows (Anthropic + OpenAI)
  state/                  # App state store
  utils/                  # Utilities
    model/                # Model configs, providers, validation
  skills/                 # Skill system
  plugins/                # Plugin system
  bridge/                 # IDE bridge
  voice/                  # Voice input
  tasks/                  # Background task management
```

---

## Tech Stack

| | |
|---|---|
| **Runtime** | [Bun](https://bun.sh) |
| **Language** | TypeScript |
| **Terminal UI** | React + [Ink](https://github.com/vadimdemedes/ink) |
| **CLI Parsing** | [Commander.js](https://github.com/tj/commander.js) |
| **Schema Validation** | Zod v4 |
| **Code Search** | ripgrep (bundled) |
| **Browser** | Chrome DevTools Protocol (native WebSocket) |
| **Protocols** | MCP, LSP |
| **APIs** | Anthropic Messages, OpenAI Codex, OpenAI-compatible (NIM/OpenRouter/…), AWS Bedrock, Google Vertex AI |

---

## Contributing

Contributions are welcome. If you're working on restoring one of the 33 broken feature flags, check the reconstruction notes in [FEATURES.md](FEATURES.md) first -- many are close to compiling and just need a small wrapper or missing asset.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add something'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

---

## License

The original Claude Code source is the property of Anthropic. This fork exists because the source was publicly exposed through their npm distribution. Use at your own discretion.

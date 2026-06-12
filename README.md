<p align="center">
  <img src="assets/screenshot.png" alt="free-code" width="720" />
</p>

<h1 align="center">free-code</h1>

<p align="center">
  <strong>The free build of Claude Code.</strong><br>
  All telemetry stripped. All guardrails removed. All experimental features unlocked.<br>
  One binary, zero callbacks home.
</p>

<p align="center">
  <a href="#quick-install"><img src="https://img.shields.io/badge/install-one--liner-blue?style=flat-square" alt="Install" /></a>
  <a href="https://github.com/elgreams/free-code/stargazers"><img src="https://img.shields.io/github/stars/elgreams/free-code?style=flat-square" alt="Stars" /></a>
  <a href="https://github.com/elgreams/free-code/issues"><img src="https://img.shields.io/github/issues/elgreams/free-code?style=flat-square" alt="Issues" /></a>
  <a href="https://github.com/elgreams/free-code/blob/main/FEATURES.md"><img src="https://img.shields.io/badge/features-88%20flags-orange?style=flat-square" alt="Feature Flags" /></a>
</p>

---

## Quick Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/elgreams/free-code/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/elgreams/free-code/main/install.ps1 | iex
```

Each installer checks your system, installs [Bun](https://bun.sh) if needed, clones the repo, builds with all experimental features enabled, and puts `free-code` on your PATH (a symlink on macOS/Linux, a `free-code.cmd` shim on Windows). You'll need [git](https://git-scm.com/downloads) installed first.

Then run `free-code` and use the `/login` command to authenticate with your preferred model provider.

---

## Table of Contents

- [What is this](#what-is-this)
- [Model Providers](#model-providers)
- [Quick Install](#quick-install)
- [Requirements](#requirements)
- [Build](#build)
- [Usage](#usage)
- [Browser Automation](#browser-automation)
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

Claude Code ships with 88 feature flags gated behind `bun:bundle` compile-time switches. Most are disabled in the public npm release. This build unlocks all 54 flags that compile cleanly. See [Experimental Features](#experimental-features) below, or refer to [FEATURES.md](FEATURES.md) for the full audit.

### Claude-in-Chrome replaced

The upstream Claude-in-Chrome integration depends on an unpublished Anthropic package and cannot run in this fork, so it is disabled. The built-in [`/browser` automation](#browser-automation) replaces it — it drives your installed Chrome directly, with no extension or extra dependencies.

---

## Model Providers

free-code supports **five API providers** out of the box. Anthropic and OpenAI/ChatGPT
switch live from the `/model` menu (sign in once with `/login` and/or
`/login-chatgpt`); Bedrock, Vertex, and Foundry are selected via environment variable.

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
`/login-chatgpt`, then pick a GPT model from `/model` — **no env var required**.
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
/model             # pick a GPT model (or a Claude model — switch any time)
/logout-chatgpt    # sign out of ChatGPT
```

The legacy `CLAUDE_CODE_USE_OPENAI=1` env var still works (forces OpenAI globally),
but it's no longer necessary — per-model routing handles everything.

### AWS Bedrock

Route requests through your AWS account via Amazon Bedrock.

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="us-east-1"   # or AWS_DEFAULT_REGION
free-code
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
free-code
```

Uses Google Cloud Application Default Credentials (`gcloud auth application-default login`). Models are mapped to Vertex format automatically (e.g., `claude-opus-4-6@latest`).

### Anthropic Foundry

Use Anthropic Foundry for dedicated deployments.

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_API_KEY="..."
free-code
```

Supports custom deployment IDs as model names.

### Provider Selection Summary

| Provider | Env Variable | Auth Method |
|---|---|---|
| Anthropic (default) | -- | `ANTHROPIC_API_KEY` or OAuth (`/login`) |
| OpenAI Codex (ChatGPT) | -- (optional `CLAUDE_CODE_USE_OPENAI=1`) | OAuth (`/login-chatgpt`) |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` | AWS credentials |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` | `gcloud` ADC |
| Anthropic Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` | `ANTHROPIC_FOUNDRY_API_KEY` |

---

## Requirements

- **Runtime**: [Bun](https://bun.sh) >= 1.3.11
- **OS**: macOS or Linux (Windows via WSL)
- **Auth**: An API key or OAuth login for your chosen provider

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

---

## Build

```bash
git clone https://github.com/elgreams/free-code.git
cd free-code
bun build
./cli
```

### Build Variants

| Command | Output | Features | Description |
|---|---|---|---|
| `bun run build` | `./cli` | `VOICE_MODE` only | Production-like binary |
| `bun run build:dev` | `./cli-dev` | `VOICE_MODE` only | Dev version stamp |
| `bun run build:dev:full` | `./cli-dev` | All 54 experimental flags | Full unlock build |
| `bun run compile` | `./dist/cli` | `VOICE_MODE` only | Alternative output path |

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

---

## Browser Automation

free-code can drive your installed Chrome directly — no extension, no Node, no Playwright. Enable it with `/browser on` (off by default; the setting persists), then restart. The tools surface as `mcp__browser__*`.

- Drives your real Chrome/Chromium over the Chrome DevTools Protocol, with a persistent profile so logins stick between sessions.
- Tools: navigate, accessibility snapshot, click, type, press key, evaluate JS, screenshot, console messages, network requests, wait, and tab management.
- Clicks and typing auto-wait for the target to be visible, enabled, and settled before acting.

Requires Chrome, Chromium, or Edge installed. Toggle with `/browser on` / `/browser off`. See the `CLAUDE_BROWSER_*` [environment variables](#environment-variables-reference) to point at a specific browser or tune the auto-wait timeout.

---

## Experimental Features

The `bun run build:dev:full` build enables all 54 working feature flags. Highlights:

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

See [FEATURES.md](FEATURES.md) for the complete audit of all 88 flags, including 34 broken flags with reconstruction notes.

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
| **APIs** | Anthropic Messages, OpenAI Codex, AWS Bedrock, Google Vertex AI |

---

## Contributing

Contributions are welcome. If you're working on restoring one of the 34 broken feature flags, check the reconstruction notes in [FEATURES.md](FEATURES.md) first -- many are close to compiling and just need a small wrapper or missing asset.

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add something'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

---

## License

The original Claude Code source is the property of Anthropic. This fork exists because the source was publicly exposed through their npm distribution. Use at your own discretion.

import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  AGENT_COLORS,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  getTranscriptPath,
  saveAgentColor,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'

const RESET_ALIASES = ['default', 'reset', 'none'] as const

// Named colors -> raw theme color strings for the accent override (startup
// banner border + the Clawd figure). Covers the agent palette plus common ANSI
// names; purple/orange/pink aren't ANSI names so they map to hex.
const NAMED_ACCENT: Record<string, string> = {
  red: 'ansi:red',
  green: 'ansi:green',
  blue: 'ansi:blue',
  yellow: 'ansi:yellow',
  cyan: 'ansi:cyan',
  magenta: 'ansi:magenta',
  white: 'ansi:white',
  gray: 'ansi:gray',
  grey: 'ansi:gray',
  purple: '#a855f7',
  orange: '#ff8800',
  pink: '#ff5fbf',
  redbright: 'ansi:redBright',
  greenbright: 'ansi:greenBright',
  bluebright: 'ansi:blueBright',
  yellowbright: 'ansi:yellowBright',
  cyanbright: 'ansi:cyanBright',
  magentabright: 'ansi:magentaBright',
}

// Resolve user input to a raw theme color string, or null if unrecognized.
function toAccentColor(arg: string): string | null {
  const a = arg.trim()
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(a)) return a
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(a)) return a
  if (a.toLowerCase().startsWith('ansi:')) return a
  return NAMED_ACCENT[a.toLowerCase()] ?? null
}

const HELP =
  'Usage: /color <name | #hex | rgb(r,g,b) | reset>. Named: red, green, blue, ' +
  'yellow, cyan, magenta, purple, orange, pink, white, gray (+ Bright variants). ' +
  'Recolors the startup banner border and the Clawd figure.'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Teammates cannot set their own color.
  if (isTeammate()) {
    onDone(
      'Cannot set color: this session is a swarm teammate. Teammate colors are assigned by the team leader.',
      { display: 'system' },
    )
    return null
  }

  const raw = (args ?? '').trim()
  if (!raw) {
    onDone(HELP, { display: 'system' })
    return null
  }

  const lower = raw.toLowerCase()

  // Reset: clear the accent override and reset the session agent color.
  if (RESET_ALIASES.includes(lower as (typeof RESET_ALIASES)[number])) {
    saveGlobalConfig(cfg => ({ ...cfg, accentColorOverride: undefined }))
    const sessionId = getSessionId() as UUID
    await saveAgentColor(sessionId, 'default', getTranscriptPath())
    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: {
        ...prev.standaloneAgentContext,
        name: prev.standaloneAgentContext?.name ?? '',
        color: undefined,
      },
    }))
    onDone('Color reset to default — restart to see the banner update.', {
      display: 'system',
    })
    return null
  }

  const accent = toAccentColor(raw)
  if (!accent) {
    onDone(`Invalid color "${raw}". ${HELP}`, { display: 'system' })
    return null
  }

  // Recolor the startup banner border + Clawd (persisted globally; applied by
  // getTheme to startupAccent + clawd_body).
  saveGlobalConfig(cfg => ({ ...cfg, accentColorOverride: accent }))

  // If it's also an agent-palette color, set the session color too (preserves
  // the original /color behavior).
  let alsoAgent = ''
  if (AGENT_COLORS.includes(lower as AgentColorName)) {
    const sessionId = getSessionId() as UUID
    await saveAgentColor(sessionId, lower, getTranscriptPath())
    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: {
        ...prev.standaloneAgentContext,
        name: prev.standaloneAgentContext?.name ?? '',
        color: lower as AgentColorName,
      },
    }))
    alsoAgent = ' and session color'
  }

  onDone(
    `Accent${alsoAgent} set to ${raw} — restart to see the banner + Clawd recolored.`,
    { display: 'system' },
  )
  return null
}

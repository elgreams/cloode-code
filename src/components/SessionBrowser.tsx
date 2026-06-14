import figures from 'figures'
import React from 'react'
import { Box, Text } from '../ink.js'
import type { SessionInfo } from '../utils/listSessionsImpl.js'
import { Select } from './CustomSelect/select.js'

export type DirGroup = {
  dir: string
  sessions: SessionInfo[]
  lastModified: number
}

type Props = {
  groups: DirGroup[]
  /** Called with the chosen session + its directory when the user resumes. */
  onResume: (session: SessionInfo, dir: string) => void
  /** Called when the user exits without choosing (Esc at top level). */
  onExit: () => void
  formatAge: (epochMs: number) => string
}

function summaryOf(s: SessionInfo): string {
  return (s.customTitle || s.summary || s.firstPrompt || '(no summary)')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Two-level interactive session browser:
 *   directories  → Enter → sessions in that directory → Enter → resume.
 * Esc / left-arrow backs out a level; Esc at the directory list exits.
 */
export function SessionBrowser({
  groups,
  onResume,
  onExit,
  formatAge,
}: Props): React.ReactNode {
  const [selectedDir, setSelectedDir] = React.useState<string | null>(null)

  const activeGroup = selectedDir
    ? (groups.find(g => g.dir === selectedDir) ?? null)
    : null

  if (activeGroup) {
    const sessionOptions = activeGroup.sessions.map(s => ({
      label: (
        <Text>
          <Text dimColor>{formatAge(s.createdAt ?? s.lastModified).padEnd(9)}</Text>
          {s.gitBranch ? <Text color="autoAccept">{s.gitBranch} </Text> : null}
          {summaryOf(s)}
        </Text>
      ),
      value: s.sessionId,
    }))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color="autoAccept">
            {activeGroup.dir}
          </Text>
          <Text dimColor>
            {activeGroup.sessions.length} session
            {activeGroup.sessions.length === 1 ? '' : 's'} · enter to resume ·
            esc to go back
          </Text>
        </Box>
        <Select
          options={sessionOptions}
          visibleOptionCount={12}
          onChange={(sessionId: string) => {
            const session = activeGroup.sessions.find(
              s => s.sessionId === sessionId,
            )
            if (session) onResume(session, activeGroup.dir)
          }}
          onCancel={() => setSelectedDir(null)}
        />
      </Box>
    )
  }

  const dirOptions = groups.map(g => ({
    label: (
      <Text>
        {g.dir}{' '}
        <Text dimColor>
          ({g.sessions.length} · {formatAge(g.lastModified)})
        </Text>
      </Text>
    ),
    value: g.dir,
  }))

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>
          {figures.pointer} Sessions by directory
        </Text>
        <Text dimColor>
          {groups.length} director{groups.length === 1 ? 'y' : 'ies'} · enter to
          open · esc to exit
        </Text>
      </Box>
      <Select
        options={dirOptions}
        visibleOptionCount={12}
        onChange={(dir: string) => setSelectedDir(dir)}
        onCancel={onExit}
      />
    </Box>
  )
}

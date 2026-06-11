import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { runCodexOAuthFlow } from '../../services/oauth/codex-client.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { saveCodexOAuthTokens } from '../../utils/auth.js'
import { refreshCodexAvailableModels } from '../../utils/model/codexModels.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <ChatGPTLogin onDone={onDone} setAppState={context.setAppState} />
}

type Status =
  | { state: 'starting' }
  | { state: 'waiting'; url: string }
  | { state: 'success' }
  | { state: 'error'; message: string }

function ChatGPTLogin({
  onDone,
  setAppState,
}: {
  onDone: LocalJSXCommandOnDone
  setAppState: LocalJSXCommandContext['setAppState']
}): React.ReactNode {
  const [status, setStatus] = useState<Status>({ state: 'starting' })

  useEffect(() => {
    let finished = false
    const finish = (msg: string) => {
      if (!finished) {
        finished = true
        onDone(msg)
      }
    }

    void (async () => {
      try {
        // runCodexOAuthFlow opens the browser itself; onUrlReady just surfaces
        // the URL in case it needs to be opened manually.
        const tokens = await runCodexOAuthFlow(async url => {
          setStatus({ state: 'waiting', url })
        })
        saveCodexOAuthTokens(tokens)
        // Refresh the account's available-models cache now that we're signed in.
        void refreshCodexAvailableModels(true)
        // Bump authVersion so auth-dependent UI (model picker, status) re-reads.
        setAppState(prev => ({ ...prev, authVersion: prev.authVersion + 1 }))
        setStatus({ state: 'success' })
        setTimeout(() => finish('ChatGPT login successful'), 800)
      } catch (err) {
        setStatus({ state: 'error', message: (err as Error).message })
        setTimeout(() => finish('ChatGPT login failed'), 1500)
      }
    })()

    return () => {
      finished = true
    }
  }, [onDone, setAppState])

  return (
    <Box flexDirection="column">
      {status.state === 'starting' && <Text>Starting ChatGPT sign-in…</Text>}
      {status.state === 'waiting' && (
        <Box flexDirection="column">
          <Text>Opening your browser to sign in to ChatGPT.</Text>
          <Text dimColor>If it doesn't open automatically, visit:</Text>
          <Text color="cyan">{status.url}</Text>
        </Box>
      )}
      {status.state === 'success' && (
        <Text color="green">
          ✓ Signed in to ChatGPT/Codex. GPT models are now available in /model.
        </Text>
      )}
      {status.state === 'error' && (
        <Text color="red">ChatGPT sign-in failed: {status.message}</Text>
      )}
    </Box>
  )
}

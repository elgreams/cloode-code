import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { enableConfigs } from '../config.js'
import { logForDebugging } from '../debug.js'
import { BrowserSession } from './session.js'
import { BROWSER_TOOLS, dispatchTool } from './tools.js'

/**
 * Server instructions injected into the model's prompt at handshake (via
 * InitializeResult.instructions). Tells the agent what these tools are, that
 * they are THE current browser feature (not the deprecated claude-in-chrome
 * extension), and the snapshot→ref→action workflow. Keep under
 * MAX_MCP_DESCRIPTION_LENGTH (2048) in services/mcp/client.ts.
 */
const BROWSER_MCP_INSTRUCTIONS = `free-code's built-in browser automation. These mcp__browser__* tools drive the user's REAL installed Chrome over the Chrome DevTools Protocol, using a persistent profile so logins and cookies stick between sessions. This is what the user means by "browser mcp" or "chrome mcp" — it is turned on with the /browser command. Do NOT confuse it with the deprecated claude-in-chrome extension feature (mcp__claude-in-chrome__*); these browser_* tools are the current, supported way to drive a browser, and you can use them directly with no skill or extension to invoke first.

Core loop:
1. browser_navigate(url) opens a page and returns an accessibility snapshot; browser_snapshot re-reads the current page.
2. Every actionable element in a snapshot has a [ref=eN] id. Pass that ref to browser_click or browser_type. Refs are only valid for the LATEST snapshot — re-snapshot after the page changes.
3. browser_type fills a field (set submit=true to press Enter); browser_press_key sends a single key.

Prefer snapshots over browser_screenshot for understanding page structure — screenshots are only for judging visual appearance. Other tools: browser_evaluate (run a JS function expression, returns JSON), browser_console_messages, browser_network_requests, browser_wait (let content settle), and browser_tabs (list/new/select/close).

There is no auto-waiting: if content has not loaded, browser_wait then re-snapshot. If a tool fails 2-3 times or the page stops responding, stop and ask the user instead of looping.`

/**
 * Subprocess entrypoint for `--browser-mcp`. A self-contained MCP server that
 * drives the user's installed Chrome over the DevTools Protocol using the
 * runtime's native WebSocket — no Node, no npx, no Playwright. Spawned by the
 * built-in registration in main.tsx (`<cloode exe> --browser-mcp`).
 */
export async function runBrowserMcpServer(): Promise<void> {
  enableConfigs()

  const session = new BrowserSession()
  const server = new Server(
    { name: 'browser', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: BROWSER_MCP_INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOLS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params
    try {
      return await dispatchTool(session, name, args ?? {})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logForDebugging(`[browser] tool ${name} failed: ${message}`)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    }
  })

  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = (): void => {
    if (exiting) {
      return
    }
    exiting = true
    session.shutdown()
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', shutdownAndExit)
  process.stdin.on('error', shutdownAndExit)

  logForDebugging('[browser] starting MCP server')
  await server.connect(transport)
  logForDebugging('[browser] MCP server started')
}

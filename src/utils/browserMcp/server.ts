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
    { capabilities: { tools: {} } },
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

import { logForDebugging } from '../../../utils/debug.js'
import { recordUnsupportedOpenAICompatModel } from './discovery.js'

// Custom `fetch` that makes a standard OpenAI `/v1/chat/completions` endpoint
// (NIM, OpenRouter, vLLM, Ollama, …) look like the Anthropic Messages API to the
// Anthropic SDK. Mirrors codex-fetch-adapter.ts but targets chat-completions
// (simpler than the Codex Responses API). Translation functions are exported for
// unit testing. Commit 2 of OPENAI_PROVIDER_ROADMAP.md — not wired into routing
// yet (that's Commit 3).

// ── Minimal Anthropic request shapes ────────────────────────────────
interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: { type?: string; media_type?: string; data?: string }
  [key: string]: unknown
}
interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}
interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// ── Tools: Anthropic → OpenAI ───────────────────────────────────────
export function translateTools(
  tools: AnthropicTool[],
): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function extractSystemText(
  system: unknown,
): string {
  if (typeof system === 'string') {
    return system
  }
  if (Array.isArray(system)) {
    return system
      .filter(
        (b): b is { type: string; text: string } =>
          !!b && b.type === 'text' && typeof b.text === 'string',
      )
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

// ── Messages: Anthropic → OpenAI chat messages ──────────────────────
export function translateMessages(
  systemText: string,
  messages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (systemText) {
    out.push({ role: 'system', content: systemText })
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) {
      continue
    }

    if (msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = []
      const toolMsgs: Array<Record<string, unknown>> = []
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          let outText = ''
          if (typeof b.content === 'string') {
            outText = b.content
          } else if (Array.isArray(b.content)) {
            outText = b.content
              .map(c =>
                c.type === 'text'
                  ? (c.text ?? '')
                  : c.type === 'image'
                    ? '[image]'
                    : '',
              )
              .join('\n')
          }
          toolMsgs.push({
            role: 'tool',
            tool_call_id: b.tool_use_id || '',
            content: outText || '',
          })
        } else if (b.type === 'text' && typeof b.text === 'string') {
          parts.push({ type: 'text', text: b.text })
        } else if (b.type === 'image' && b.source?.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${b.source.media_type};base64,${b.source.data}`,
            },
          })
        }
      }
      // tool results first (they answer a prior assistant tool_calls turn), then
      // any remaining user text/images.
      out.push(...toolMsgs)
      if (parts.length === 1 && parts[0].type === 'text') {
        out.push({ role: 'user', content: parts[0].text })
      } else if (parts.length > 0) {
        out.push({ role: 'user', content: parts })
      }
    } else {
      // assistant — text and/or tool_use → one assistant message.
      let text = ''
      const toolCalls: Array<Record<string, unknown>> = []
      for (const b of msg.content) {
        if (b.type === 'text' && typeof b.text === 'string') {
          text += b.text
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || '',
            type: 'function',
            function: {
              name: b.name || '',
              arguments: JSON.stringify(b.input || {}),
            },
          })
        }
      }
      const m: Record<string, unknown> = {
        role: 'assistant',
        content: text || null,
      }
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls
      }
      out.push(m)
    }
  }
  return out
}

// ── Full request: Anthropic body → OpenAI chat-completions body ─────
export function buildChatBody(
  anthropicBody: Record<string, unknown>,
): Record<string, unknown> {
  const messages = translateMessages(
    extractSystemText(anthropicBody.system),
    (anthropicBody.messages as AnthropicMessage[]) || [],
  )
  const stream = anthropicBody.stream !== false
  const body: Record<string, unknown> = {
    model: anthropicBody.model,
    messages,
    stream,
  }
  // Map only the fields chat-completions understands; Anthropic-only knobs
  // (thinking, effort, cache_control, betas) are intentionally dropped.
  if (typeof anthropicBody.max_tokens === 'number') {
    body.max_tokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    body.temperature = anthropicBody.temperature
  }
  if (
    Array.isArray(anthropicBody.stop_sequences) &&
    anthropicBody.stop_sequences.length > 0
  ) {
    body.stop = anthropicBody.stop_sequences
  }
  const tools = (anthropicBody.tools as AnthropicTool[]) || []
  if (tools.length > 0) {
    body.tools = translateTools(tools)
    body.tool_choice = 'auto'
  }
  if (stream) {
    body.stream_options = { include_usage: true }
  }
  return body
}

function safeParseArgs(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string' || !s) {
    return {}
  }
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function mapStopReason(finish: unknown): string {
  if (finish === 'tool_calls') {
    return 'tool_use'
  }
  if (finish === 'length') {
    return 'max_tokens'
  }
  return 'end_turn'
}

// ── Non-streaming: OpenAI chat response → Anthropic Messages JSON ────
export function openAIResponseToAnthropic(
  json: Record<string, any>,
  model: string,
): Record<string, unknown> {
  const choice = json.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const content: Array<Record<string, unknown>> = []
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    content.push({ type: 'text', text: msg.content })
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id ?? '',
        name: tc.function?.name ?? '',
        input: safeParseArgs(tc.function?.arguments),
      })
    }
  }
  return {
    id: json.id ?? newMessageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  }
}

function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function newMessageId(): string {
  // Runtime path (not a Workflow script) — Date.now/Math.random are fine here.
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

// ── Streaming: OpenAI chat SSE → Anthropic Messages SSE ──────────────
export function translateChatStreamToAnthropic(
  upstream: Response,
  model: string,
): Response {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const messageId = newMessageId()

  const readable = new ReadableStream({
    async start(controller) {
      const enq = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(formatSSE(event, data)))

      enq('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      let blockIndex = -1
      let textOpen = false
      let toolOpen = false
      let currentToolIndex = -1
      let inputTokens = 0
      let outputTokens = 0
      let finishReason: unknown = 'stop'

      const closeBlock = () => {
        if (textOpen || toolOpen) {
          enq('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
          })
          textOpen = false
          toolOpen = false
        }
      }
      const openText = () => {
        if (toolOpen) {
          closeBlock()
        }
        if (!textOpen) {
          blockIndex++
          enq('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          })
          textOpen = true
        }
      }
      const openTool = (id: string, name: string) => {
        closeBlock()
        blockIndex++
        enq('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        })
        toolOpen = true
      }

      const reader = upstream.body?.getReader()
      let buffer = ''
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) {
              continue
            }
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') {
              continue
            }
            let chunk: any
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens
              outputTokens = chunk.usage.completion_tokens ?? outputTokens
            }
            const choice = chunk.choices?.[0]
            if (!choice) {
              continue
            }
            const delta = choice.delta ?? {}
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              openText()
              enq('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (idx !== currentToolIndex) {
                  currentToolIndex = idx
                  openTool(tc.id || `call_${idx}`, tc.function?.name || '')
                }
                if (tc.function?.arguments) {
                  enq('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: tc.function.arguments,
                    },
                  })
                }
              }
            }
            if (choice.finish_reason) {
              finishReason = choice.finish_reason
            }
          }
        }
      }

      closeBlock()
      enq('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      enq('message_stop', {
        type: 'message_stop',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'x-request-id': messageId,
    },
  })
}

// ── The fetch interceptor ───────────────────────────────────────────
export function createOpenAICompatFetch(opts: {
  baseURL: string
  apiKey: string
  headers?: Record<string, string>
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const text =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(text)
    } catch {
      anthropicBody = {}
    }

    const wantStream = anthropicBody.stream !== false
    const body = buildChatBody(anthropicBody)
    const endpoint = `${opts.baseURL.replace(/\/+$/, '')}/chat/completions`

    let res: Response
    try {
      res = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: wantStream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      logForDebugging(`[openai-compat] request failed: ${String(err)}`)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `Request failed: ${String(err)}` },
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      logForDebugging(
        `[openai-compat] ${endpoint} -> ${res.status}: ${errText.slice(0, 500)}`,
      )
      // Self-heal: if the backend rejects the model, remember it so /model stops
      // offering it (mirrors recordUnsupportedCodexModel).
      if (
        res.status === 404 ||
        /not found|does not exist|no such model|unsupported|invalid model|unknown model/i.test(
          errText,
        )
      ) {
        recordUnsupportedOpenAICompatModel(String(body.model))
      }
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `Upstream ${res.status}: ${errText.slice(0, 500)}`,
          },
        }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (!wantStream) {
      const json = (await res.json().catch(() => ({}))) as Record<string, any>
      return new Response(
        JSON.stringify(openAIResponseToAnthropic(json, String(body.model))),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return translateChatStreamToAnthropic(res, String(body.model))
  }
}

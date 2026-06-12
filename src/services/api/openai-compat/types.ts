// Shared types for the generic OpenAI-compatible provider feature (NIM,
// OpenRouter, vLLM, Ollama, Together, self-hosted, …). See
// OPENAI_PROVIDER_ROADMAP.md. Commit 1: types + registry only, no routing yet.

export type OpenAICompatModel = {
  id: string // the id sent to the backend, e.g. 'nvidia/llama-3.3-nemotron-super-49b-v1'
  label: string // display name for /model
  description?: string
  contextWindow?: number
}

export type OpenAICompatProvider = {
  name: string // unique key/namespace, e.g. 'nim'
  label?: string // display name, e.g. 'NVIDIA NIM'
  baseURL: string // OpenAI-compatible base, e.g. 'https://integrate.api.nvidia.com/v1'
  apiKeyEnv?: string // env var to read the key from (preferred over apiKey)
  apiKey?: string // or stored directly in config (plaintext)
  headers?: Record<string, string> // extra request headers
  models: OpenAICompatModel[]
}

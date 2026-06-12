import type { OpenAICompatProvider } from './types.js'

// Built-in provider templates offered by `/provider add` (it prefills the base
// URL; "custom" prompts for one). A preset only becomes *active* once the user
// adds it (saving an entry to config), OR — as a zero-config fallback — when its
// `apiKeyEnv` is present in the environment (see registry.listProviders).
//
// Seed model lists mirror CODEX_MODELS: a display/offline fallback that live
// discovery (roadmap Commit 5) and user config can augment or override. Model
// ids are real NIM-hosted examples; exact availability varies by account.
export const PROVIDER_PRESETS: ReadonlyArray<
  OpenAICompatProvider & { apiKeyEnv: string }
> = [
  {
    name: 'nim',
    label: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_NIM_API_KEY',
    models: [
      {
        id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
        label: 'Nemotron Super 49B',
        description: 'NVIDIA Nemotron — tool-capable, good default',
      },
      {
        id: 'meta/llama-3.3-70b-instruct',
        label: 'Llama 3.3 70B',
        description: 'Meta Llama 3.3 70B Instruct',
      },
      {
        id: 'qwen/qwen2.5-coder-32b-instruct',
        label: 'Qwen2.5 Coder 32B',
        description: 'Coding-focused, strong tool use',
      },
      {
        id: 'deepseek-ai/deepseek-r1',
        label: 'DeepSeek R1',
        description: 'Reasoning model',
      },
    ],
  },
  {
    name: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [],
  },
  {
    name: 'together',
    label: 'Together',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    models: [],
  },
  {
    // Self-hosted / any other OpenAI-compatible server (vLLM, Ollama, LM Studio).
    name: 'custom',
    label: 'Custom (self-hosted / other)',
    baseURL: '',
    apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
    models: [],
  },
]

export function getPreset(
  name: string,
): (OpenAICompatProvider & { apiKeyEnv: string }) | undefined {
  return PROVIDER_PRESETS.find(p => p.name === name)
}

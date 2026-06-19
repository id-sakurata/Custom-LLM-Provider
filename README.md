# Custom LLM Provider for GitHub Copilot Chat

A VSCode extension that registers custom LLM models from any OpenAI-compatible API endpoint directly into GitHub Copilot Chat.

## Features

- **Auto-fetches models** from `GET /v1/models` on activation.
- **Accurate Token Counting** using `js-tiktoken` (cl100k_base encoding).
- **Persistent Connections** (HTTP Keep-Alive) for reduced latency.
- **Granular Error Handling**: Specific VS Code error types for 401/403 (Auth), 429 (Rate Limit), and 5xx (Server) errors.
- **Image/Vision Support**: Full support for `vscode.LanguageModelImagePart` (auto-conversion to Base64).
- **Anti-Race Condition**: Strict sequential request queue for models with cooldowns.
- **Tool/Function Calling**: Native support for VS Code Chat tools.
- **Reasoning/Thinking**: Supports reasoning tokens and thinking budgets, rendered inside clean Markdown blockquotes.
- **Request Delay Indicator**: Displays a real-time countdown on the status bar (e.g., `Delay 2.5s`) during active request cooldowns if the configured request delay is greater than 1 second.
- **Auto-refresh** on a configurable interval.
- **Re-registers on config change** — no restart needed.

## Requirements

- VSCode >= 1.90
- GitHub Copilot Chat extension installed and signed in
- An OpenAI-compatible server (e.g., LM Studio, Ollama OpenAI mode, vLLM, llama.cpp)

## Quick Start

1. Install the extension
2. Open Settings → search `customLlmProvider`
3. Set your **endpoint** (default: `http://localhost:20128`)
4. The extension will auto-fetch and register all models on startup
5. Open Copilot Chat → click the model picker → your models appear under `custom-llm`

## Configuration

```jsonc
{
  // Base URL of your API (no trailing slash, no /v1)
  "customLlmProvider.endpoint": "http://localhost:20128",

  // API key (leave empty if not needed)
  "customLlmProvider.apiKey": "",

  // Auto-refresh interval in minutes (0 = disabled)
  "customLlmProvider.autoRefreshInterval": 0,

  // Extra model IDs to register even if not in /v1/models
  "customLlmProvider.additionalModels": [
    "my-local-model"
  ],

  // Default capabilities applied to all models (fallback)
  "customLlmProvider.maxInputTokens": 160000,
  "customLlmProvider.maxOutputTokens": 32000,
  "customLlmProvider.requestDelay": 1000,
  "customLlmProvider.toolCalling": true,
  "customLlmProvider.toolFlavor": "openai-tools", // "openai-tools" | "openai-functions" | "text-based"
  "customLlmProvider.vision": false,
  "customLlmProvider.thinking": true,
  "customLlmProvider.reasoning": true,
  "customLlmProvider.reasoningEffort": "medium", // "low" | "medium" | "high"

  // Per-model overrides (partial — only what differs from fallback)
  "customLlmProvider.modelOverrides": {
    "llava-1.6": {
      "vision": true
    },
    "qwen2.5-coder-32b": {
      "maxOutputTokens": 8192,
      "toolCalling": true,
      "reasoning": false
    }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `Custom LLM: Refresh Models` | Re-fetch and re-register all models now |
| `Custom LLM: Show Provider Status` | Show status of registered models in a Quick Pick and print log to Output panel |
| `Custom LLM: Setup Wizard` | Interactive setup wizard to configure endpoint and API Key |
| `Custom LLM: Open Dashboard` | Open the Webview dashboard showing stats and registered models |

## How It Works

1. On activation (`onLanguageModelChat`), the extension calls `GET /v1/models`
2. Each returned model ID is registered via `vscode.lm.registerChatModelProvider`
3. When Copilot Chat sends a request, the extension streams `POST /v1/chat/completions` using SSE
4. Tool calls, vision, and reasoning are conditionally enabled based on capabilities config

## Building

```bash
npm install
npm run compile
npx vsce package   # produces custom-llm-provider-1.0.0.vsix
```

Then install: `Extensions → ··· → Install from VSIX`

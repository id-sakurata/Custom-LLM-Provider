import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import { URL } from 'url';
import * as vscode from 'vscode';
import { ModelCapabilities } from './types';
import { ToolAdapter } from './toolAdapter';
import { StatusBarManager } from './statusBar';
import { ConfigManager } from './config';
import { calculateDelay, isRetryableHttpError, timestamp } from './retryHandler';

/**
 * Interface for OpenAI-compatible chat messages.
 */
interface OAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content:
    | string
    | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Interface for OpenAI-compatible chat completion chunks.
 */
interface ChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
      reasoning_content?: string;
    };
    finish_reason?: string;
    index: number;
  }>;
}

/**
 * Handles chat requests and responses between VS Code and the LLM endpoint.
 */
export class ChatHandler {
  private static lastRequestPromise: Promise<void> = Promise.resolve();
  private static lastRequestTime = 0;
  private startedThinking = false;

  // Shared agents for persistent connections (Keep-Alive)
  private static readonly httpAgent = new http.Agent({ keepAlive: true });
  private static readonly httpsAgent = new https.Agent({ keepAlive: true });

  constructor(
    private readonly chatEndpoint: string,
    private readonly apiKey: string,
    private readonly capabilities: ModelCapabilities,
    private readonly outputChannel?: vscode.OutputChannel
  ) {}

  /**
   * Sends a chat request to the configured endpoint and yields response parts.
   * Uses a static queue to prevent race conditions and enforce request delays.
   */
  async *sendRequest(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    tools: readonly vscode.LanguageModelChatTool[],
    modelId: string,
    token: vscode.CancellationToken
  ): AsyncIterable<vscode.LanguageModelResponsePart> {
    // Enqueue our request and update the global promise atomically before any await context switch
    let currentRequestResolver!: () => void;
    const previousPromise = ChatHandler.lastRequestPromise;
    ChatHandler.lastRequestPromise = new Promise((resolve) => {
      currentRequestResolver = resolve;
    });

    try {
      // Wait for the previous request in the global queue to finish its critical section
      await previousPromise;
      await this.applyRequestDelay();

      const oaiMessages = this.convertMessages(messages);
      const translated = ToolAdapter.translate(tools, this.capabilities.toolFlavor);

      const body: Record<string, unknown> = {
        model: modelId,
        messages: oaiMessages,
        stream: true,
        max_tokens: this.capabilities.maxOutputTokens,
      };

      if (this.capabilities.temperature > 0) {
        body.temperature = this.capabilities.temperature;
      }
      if (this.capabilities.topP < 1.0) {
        body.top_p = this.capabilities.topP;
      }

      if (this.capabilities.toolCalling) {
        if (translated.tools) {
          body.tools = translated.tools;
          body.tool_choice = 'auto';
        } else if (translated.functions) {
          body.functions = translated.functions;
        }
      }

      if (this.capabilities.reasoning && this.capabilities.thinking) {
        const budgetMap: Record<string, number> = { low: 2000, medium: 8000, high: 20000 };
        
        // OpenAI o1 / o3 style
        if (modelId.toLowerCase().includes('o1') || modelId.toLowerCase().includes('o3')) {
          body.reasoning_effort = this.capabilities.reasoningEffort;
        } 
        // Anthropic / Others style
        else {
          body.thinking = {
            type: 'enabled',
            budget_tokens: budgetMap[this.capabilities.reasoningEffort] ?? 8000,
          };
        }

        // DeepSeek / OpenRouter style: include_reasoning
        body.include_reasoning = true;
      }

      const retryConfig = ConfigManager.retryConfig;
      const maxRetries = retryConfig.maxRetries;
      let hasYieldedContent = false;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (token.isCancellationRequested) {
          break;
        }

        try {
          let streamedAny = false;
          for await (const part of this.streamCompletion(body, token)) {
            streamedAny = true;
            hasYieldedContent = true;
            if (token.isCancellationRequested) {
              break;
            }
            yield part;
          }
          if (!streamedAny && !token.isCancellationRequested) {
            throw new Error('Empty response: stream completed with no content');
          }
          break;
        } catch (err) {
          if (hasYieldedContent || attempt >= maxRetries || !(err instanceof Error) || !isRetryableHttpError(err, retryConfig.retryOnStatus)) {
            throw err;
          }

          const delay = calculateDelay(attempt, retryConfig);
          this.outputChannel?.appendLine(`[${timestamp()}] Retry ${attempt + 1}/${maxRetries} after: ${err.message}, waiting ${delay}ms`);
          yield new vscode.LanguageModelTextPart(`\n\n> ⏳ Request failed (${err.message}). Retrying in ${(delay / 1000).toFixed(1)}s... (${attempt + 1}/${maxRetries})\n\n`);

          await new Promise<void>((r) => setTimeout(r, delay));
        }
      }
    } finally {
      // Release the queue after the request's initial delay/setup is done
      currentRequestResolver!();
    }
  }

  /**
   * Enforces a delay between requests to comply with API rate limits/cooldowns.
   */
  private async applyRequestDelay(): Promise<void> {
    const delay = this.capabilities.requestDelay;
    if (delay <= 0) {
      ChatHandler.lastRequestTime = Date.now();
      return;
    }
    const elapsed = Date.now() - ChatHandler.lastRequestTime;
    if (elapsed < delay) {
      const waitTime = delay - elapsed;
      if (waitTime > 1000) {
        const statusBar = StatusBarManager.instance;
        const endTime = Date.now() + waitTime;
        
        while (Date.now() < endTime) {
          const remaining = endTime - Date.now();
          if (remaining <= 0) {
            break;
          }
          if (statusBar) {
            statusBar.showCooldown(remaining);
          }
          // Sleep for 100ms
          await new Promise<void>((r) => setTimeout(r, Math.min(100, remaining)));
        }
        
        if (statusBar) {
          statusBar.restore();
        }
      } else {
        await new Promise<void>((r) => setTimeout(r, waitTime));
      }
    }
    ChatHandler.lastRequestTime = Date.now();
  }

  /**
   * Converts VS Code chat messages to OpenAI-compatible format.
   * Supports text, tool calls, and image input (Vision).
   */
  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): OAIChatMessage[] {
    const result: OAIChatMessage[] = [];

    for (const msg of messages) {
      const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
      const role: 'user' | 'assistant' = isUser ? 'user' : 'assistant';

      const contentParts: Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> = [];
      const toolCallParts: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      const toolResultParts: Array<{ id: string; content: string }> = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          contentParts.push({ type: 'text', text: part.value });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCallParts.push({
            id: part.callId,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          const content = part.content
            .filter(
              (c): c is vscode.LanguageModelTextPart =>
                c instanceof vscode.LanguageModelTextPart
            )
            .map((c) => c.value)
            .join('');
          toolResultParts.push({ id: part.callId, content });
        } else if (this.capabilities.vision && (part as any).data && (part as any).mimeTypes) {
           // Convert ImagePart to Base64 data URL
           const imagePart = part as any;
           const base64 = Buffer.from(imagePart.data).toString('base64');
           contentParts.push({
             type: 'image_url',
             image_url: { url: `data:${imagePart.mimeTypes[0] || 'image/png'};base64,${base64}` }
           });
        }
      }

      for (const tr of toolResultParts) {
        result.push({ role: 'tool', tool_call_id: tr.id, content: tr.content });
      }

      if (toolCallParts.length > 0) {
        // In OpenAI API, tool_calls are part of an assistant message
        result.push({
          role: 'assistant',
          content: contentParts.map(p => p.text).join('\n') || '',
          tool_calls: toolCallParts,
        });
        continue;
      }

      if (contentParts.length > 0) {
        // If there are multiple parts (text + images), use array content
        const content = contentParts.length === 1 && contentParts[0].type === 'text' 
            ? contentParts[0].text! 
            : contentParts;
        
        result.push({ role, content });
      }
    }

    return result;
  }

  /**
   * Streams the completion from the API endpoint.
   * Implements granular error handling for HTTP status codes.
   */
  private async *streamCompletion(
    body: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncIterable<vscode.LanguageModelResponsePart> {
    const bodyStr = JSON.stringify(body);
    const url = new URL(this.chatEndpoint);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const proxyUrl = ConfigManager.proxyUrl;
    let agent: http.Agent | undefined = isHttps ? ChatHandler.httpsAgent : ChatHandler.httpAgent;

    const options: http.RequestOptions = {
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    };

    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      options.hostname = proxy.hostname;
      options.port = proxy.port || '8080';
      if (isHttps) {
        // HTTPS target through HTTP proxy — use CONNECT tunneling
        agent = undefined;
        options.agent = undefined;
        options.createConnection = (_options, oncreate) => {
          const proxyPort = String(options.port ?? '8080');
          const proxyHost = String(options.hostname ?? 'localhost');
          const proxySocket = net.connect(Number(proxyPort), proxyHost, () => {
            proxySocket.write(
              `CONNECT ${url.hostname}:${url.port || '443'} HTTP/1.1\r\n` +
              `Host: ${url.hostname}:${url.port || '443'}\r\n` +
              `\r\n`
            );
          });
          proxySocket.once('data', (data) => {
            if (data.toString().startsWith('HTTP/1.1 200')) {
              oncreate(null, proxySocket);
            } else {
              oncreate(new Error(`Proxy CONNECT failed: ${data.toString().slice(0, 100)}`), null!);
            }
          });
          proxySocket.on('error', (err) => oncreate(err, null!));
          return proxySocket;
        };
        options.path = url.pathname + url.search;
      } else {
        options.path = this.chatEndpoint;
      }
    } else {
      options.hostname = url.hostname;
      options.port = url.port || (isHttps ? '443' : '80');
      options.path = url.pathname + url.search;
    }

    const chunks: ChatCompletionChunk[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    let error: Error | null = null;

    const req = lib.request(options, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errBody = '';
        res.on('data', (d: Buffer) => {
          errBody += d.toString();
        });
        res.on('end', () => {
          // Map HTTP status codes to VS Code LanguageModelErrors
          if (res.statusCode === 401 || res.statusCode === 403) {
            error = vscode.LanguageModelError.NoPermissions(`API Auth failed (HTTP ${res.statusCode}): ${errBody.slice(0, 200)}`);
          } else if (res.statusCode === 429) {
            error = new Error(`Rate limit exceeded (HTTP 429). Please wait before retrying.`);
          } else if (res.statusCode! >= 500) {
            error = new Error(`Server error (HTTP ${res.statusCode}): ${errBody.slice(0, 200)}`);
          } else {
            error = new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`);
          }
          done = true;
          notify?.();
        });
        return;
      }

      let buffer = '';
      res.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t || t === 'data: [DONE]') {
            if (t === 'data: [DONE]') {
              done = true;
            }
            continue;
          }
          if (t.startsWith('data: ')) {
            try {
              chunks.push(JSON.parse(t.slice(6)) as ChatCompletionChunk);
              notify?.();
              notify = null;
            } catch {
              /* skip malformed JSON */
            }
          }
        }
      });
      res.on('end', () => {
        done = true;
        notify?.();
      });
      res.on('error', (e: Error) => {
        error = e;
        done = true;
        notify?.();
      });
    });

    req.on('error', (e: Error) => {
      error = e;
      done = true;
      notify?.();
    });
    
    token.onCancellationRequested(() => {
      req.destroy();
      done = true;
      notify?.();
    });
    
    req.write(bodyStr);
    req.end();

    const timeout = ConfigManager.streamTimeout;
    const reqTimeout = timeout > 0 ? timeout : undefined;
    req.setTimeout(reqTimeout ?? 120000, () => {
      error = new Error(`Request timed out after ${(reqTimeout ?? 120000) / 1000} seconds`);
      req.destroy();
      done = true;
      notify?.();
    });

    const toolCallAccumulator = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    let accumulatedText = '';

    while (true) {
      if (error) {
        throw error;
      }
      if (chunks.length > 0) {
        const chunk = chunks.shift()!;
        for (const choice of chunk.choices) {
          const delta = choice.delta;

          if (delta.reasoning_content) {
            if (this.capabilities.reasoning && this.capabilities.thinking) {
              if (!this.startedThinking) {
                yield new vscode.LanguageModelTextPart('\n\n> 💭 **Thinking Process:**\n> ');
                this.startedThinking = true;
              }
              yield new vscode.LanguageModelTextPart(delta.reasoning_content.replace(/\n/g, '\n> '));
            }
            continue;
          }

          if (this.startedThinking && (delta.content || choice.finish_reason)) {
            yield new vscode.LanguageModelTextPart('\n\n---\n\n');
            this.startedThinking = false;
          }

          if (delta.content) {
            accumulatedText += delta.content;
            yield new vscode.LanguageModelTextPart(delta.content);
            
            // Detect text-based tool calling if enabled
            if (this.capabilities.toolFlavor === 'text-based') {
                const detected = ToolAdapter.detectToolCallInText(accumulatedText);
                if (detected) {
                    yield new vscode.LanguageModelToolCallPart(
                        `text-${Date.now()}`,
                        detected.name,
                        detected.args
                    );
                    accumulatedText = ''; // Reset after detection
                }
            }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulator.has(idx)) {
                toolCallAccumulator.set(idx, {
                  id: '',
                  name: '',
                  arguments: '',
                });
              }
              const acc = toolCallAccumulator.get(idx)!;
              if (tc.id) {
                acc.id = tc.id;
              }
              if (tc.function?.name) {
                acc.name += tc.function.name;
              }
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments;
              }
            }
          }

          if (choice.finish_reason === 'tool_calls' || (choice.finish_reason === 'stop' && toolCallAccumulator.size > 0)) {
            for (const [, tc] of toolCallAccumulator) {
              try {
                const repairedJson = ToolAdapter.repairJson(tc.arguments);
                const args = JSON.parse(repairedJson || '{}');
                yield new vscode.LanguageModelToolCallPart(tc.id || `call-${Date.now()}`, tc.name, args);
              } catch {
                // Ignore malformed tool call arguments
              }
            }
            toolCallAccumulator.clear();
          }
        }
      } else if (done) {
        break;
      } else {
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    }

    // Ensure thinking block is properly closed if stream ended abruptly
    if (this.startedThinking) {
      yield new vscode.LanguageModelTextPart('\n\n---\n\n');
      this.startedThinking = false;
    }
  }
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatHandler = void 0;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const url_1 = require("url");
const vscode = __importStar(require("vscode"));
const toolAdapter_1 = require("./toolAdapter");
const statusBar_1 = require("./statusBar");
const config_1 = require("./config");
const retryHandler_1 = require("./retryHandler");
/**
 * Handles chat requests and responses between VS Code and the LLM endpoint.
 */
class ChatHandler {
    constructor(chatEndpoint, apiKey, capabilities, outputChannel) {
        this.chatEndpoint = chatEndpoint;
        this.apiKey = apiKey;
        this.capabilities = capabilities;
        this.outputChannel = outputChannel;
        this.startedThinking = false;
    }
    /**
     * Sends a chat request to the configured endpoint and yields response parts.
     * Uses a static queue to prevent race conditions and enforce request delays.
     */
    async *sendRequest(messages, tools, modelId, token) {
        // Enqueue our request and update the global promise atomically before any await context switch
        let currentRequestResolver;
        const previousPromise = ChatHandler.lastRequestPromise;
        ChatHandler.lastRequestPromise = new Promise((resolve) => {
            currentRequestResolver = resolve;
        });
        try {
            // Wait for the previous request in the global queue to finish its critical section
            await previousPromise;
            await this.applyRequestDelay();
            const oaiMessages = this.convertMessages(messages);
            const translated = toolAdapter_1.ToolAdapter.translate(tools, this.capabilities.toolFlavor);
            const body = {
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
                }
                else if (translated.functions) {
                    body.functions = translated.functions;
                }
            }
            if (this.capabilities.reasoning && this.capabilities.thinking) {
                const budgetMap = { low: 2000, medium: 8000, high: 20000 };
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
            const retryConfig = config_1.ConfigManager.retryConfig;
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
                }
                catch (err) {
                    if (hasYieldedContent || attempt >= maxRetries || !(err instanceof Error) || !(0, retryHandler_1.isRetryableHttpError)(err, retryConfig.retryOnStatus)) {
                        throw err;
                    }
                    const delay = (0, retryHandler_1.calculateDelay)(attempt, retryConfig);
                    this.outputChannel?.appendLine(`[${(0, retryHandler_1.timestamp)()}] Retry ${attempt + 1}/${maxRetries} after: ${err.message}, waiting ${delay}ms`);
                    yield new vscode.LanguageModelTextPart(`\n\n> ⏳ Request failed (${err.message}). Retrying in ${(delay / 1000).toFixed(1)}s... (${attempt + 1}/${maxRetries})\n\n`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }
        finally {
            // Release the queue after the request's initial delay/setup is done
            currentRequestResolver();
        }
    }
    /**
     * Enforces a delay between requests to comply with API rate limits/cooldowns.
     */
    async applyRequestDelay() {
        const delay = this.capabilities.requestDelay;
        if (delay <= 0) {
            ChatHandler.lastRequestTime = Date.now();
            return;
        }
        const elapsed = Date.now() - ChatHandler.lastRequestTime;
        if (elapsed < delay) {
            const waitTime = delay - elapsed;
            if (waitTime > 1000) {
                const statusBar = statusBar_1.StatusBarManager.instance;
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
                    await new Promise((r) => setTimeout(r, Math.min(100, remaining)));
                }
                if (statusBar) {
                    statusBar.restore();
                }
            }
            else {
                await new Promise((r) => setTimeout(r, waitTime));
            }
        }
        ChatHandler.lastRequestTime = Date.now();
    }
    /**
     * Converts VS Code chat messages to OpenAI-compatible format.
     * Supports text, tool calls, and image input (Vision).
     */
    convertMessages(messages) {
        const result = [];
        for (const msg of messages) {
            const isUser = msg.role === vscode.LanguageModelChatMessageRole.User;
            const role = isUser ? 'user' : 'assistant';
            const contentParts = [];
            const toolCallParts = [];
            const toolResultParts = [];
            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    contentParts.push({ type: 'text', text: part.value });
                }
                else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCallParts.push({
                        id: part.callId,
                        type: 'function',
                        function: { name: part.name, arguments: JSON.stringify(part.input) },
                    });
                }
                else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const content = part.content
                        .filter((c) => c instanceof vscode.LanguageModelTextPart)
                        .map((c) => c.value)
                        .join('');
                    toolResultParts.push({ id: part.callId, content });
                }
                else if (this.capabilities.vision && part.data && part.mimeTypes) {
                    // Convert ImagePart to Base64 data URL
                    const imagePart = part;
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
                    ? contentParts[0].text
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
    async *streamCompletion(body, token) {
        const bodyStr = JSON.stringify(body);
        const url = new url_1.URL(this.chatEndpoint);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const proxyUrl = config_1.ConfigManager.proxyUrl;
        let agent = isHttps ? ChatHandler.httpsAgent : ChatHandler.httpAgent;
        const options = {
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
            const proxy = new url_1.URL(proxyUrl);
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
                        proxySocket.write(`CONNECT ${url.hostname}:${url.port || '443'} HTTP/1.1\r\n` +
                            `Host: ${url.hostname}:${url.port || '443'}\r\n` +
                            `\r\n`);
                    });
                    proxySocket.once('data', (data) => {
                        if (data.toString().startsWith('HTTP/1.1 200')) {
                            oncreate(null, proxySocket);
                        }
                        else {
                            oncreate(new Error(`Proxy CONNECT failed: ${data.toString().slice(0, 100)}`), null);
                        }
                    });
                    proxySocket.on('error', (err) => oncreate(err, null));
                    return proxySocket;
                };
                options.path = url.pathname + url.search;
            }
            else {
                options.path = this.chatEndpoint;
            }
        }
        else {
            options.hostname = url.hostname;
            options.port = url.port || (isHttps ? '443' : '80');
            options.path = url.pathname + url.search;
        }
        const chunks = [];
        let done = false;
        let notify = null;
        let error = null;
        const req = lib.request(options, (res) => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                let errBody = '';
                res.on('data', (d) => {
                    errBody += d.toString();
                });
                res.on('end', () => {
                    // Map HTTP status codes to VS Code LanguageModelErrors
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        error = vscode.LanguageModelError.NoPermissions(`API Auth failed (HTTP ${res.statusCode}): ${errBody.slice(0, 200)}`);
                    }
                    else if (res.statusCode === 429) {
                        error = new Error(`Rate limit exceeded (HTTP 429). Please wait before retrying.`);
                    }
                    else if (res.statusCode >= 500) {
                        error = new Error(`Server error (HTTP ${res.statusCode}): ${errBody.slice(0, 200)}`);
                    }
                    else {
                        error = new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 300)}`);
                    }
                    done = true;
                    notify?.();
                });
                return;
            }
            let buffer = '';
            res.on('data', (data) => {
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
                            chunks.push(JSON.parse(t.slice(6)));
                            notify?.();
                            notify = null;
                        }
                        catch {
                            /* skip malformed JSON */
                        }
                    }
                }
            });
            res.on('end', () => {
                done = true;
                notify?.();
            });
            res.on('error', (e) => {
                error = e;
                done = true;
                notify?.();
            });
        });
        req.on('error', (e) => {
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
        const timeout = config_1.ConfigManager.streamTimeout;
        const reqTimeout = timeout > 0 ? timeout : undefined;
        req.setTimeout(reqTimeout ?? 120000, () => {
            error = new Error(`Request timed out after ${(reqTimeout ?? 120000) / 1000} seconds`);
            req.destroy();
            done = true;
            notify?.();
        });
        const toolCallAccumulator = new Map();
        let accumulatedText = '';
        while (true) {
            if (error) {
                throw error;
            }
            if (chunks.length > 0) {
                const chunk = chunks.shift();
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
                            const detected = toolAdapter_1.ToolAdapter.detectToolCallInText(accumulatedText);
                            if (detected) {
                                yield new vscode.LanguageModelToolCallPart(`text-${Date.now()}`, detected.name, detected.args);
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
                            const acc = toolCallAccumulator.get(idx);
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
                                const repairedJson = toolAdapter_1.ToolAdapter.repairJson(tc.arguments);
                                const args = JSON.parse(repairedJson || '{}');
                                yield new vscode.LanguageModelToolCallPart(tc.id || `call-${Date.now()}`, tc.name, args);
                            }
                            catch {
                                // Ignore malformed tool call arguments
                            }
                        }
                        toolCallAccumulator.clear();
                    }
                }
            }
            else if (done) {
                break;
            }
            else {
                await new Promise((r) => {
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
exports.ChatHandler = ChatHandler;
ChatHandler.lastRequestPromise = Promise.resolve();
ChatHandler.lastRequestTime = 0;
// Shared agents for persistent connections (Keep-Alive)
ChatHandler.httpAgent = new http.Agent({ keepAlive: true });
ChatHandler.httpsAgent = new https.Agent({ keepAlive: true });

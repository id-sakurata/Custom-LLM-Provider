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
exports.CustomInlineCompletionProvider = void 0;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const config_1 = require("./config");
/**
 * Provides inline completions (ghost text) using the configured LLM endpoint.
 */
class CustomInlineCompletionProvider {
    constructor(outputChannel) {
        this.outputChannel = outputChannel;
    }
    async provideInlineCompletionItems(document, position, context, token) {
        if (!config_1.ConfigManager.inlineCompletionEnabled) {
            return [];
        }
        const model = config_1.ConfigManager.inlineCompletionModel;
        if (!model) {
            this.outputChannel.appendLine(`[Inline Completion] Warning: No model configured. Please set customLlmProvider.inlineCompletion.model`);
            return [];
        }
        // Debounce to prevent making API requests on every single keystroke
        await new Promise((resolve) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(() => {
                resolve();
            }, config_1.ConfigManager.inlineCompletionDebounceDelay);
        });
        if (token.isCancellationRequested) {
            return [];
        }
        this.outputChannel.appendLine(`\n[Inline Completion] Triggered for file: ${document.fileName} at line ${position.line}, char ${position.character}`);
        // Get prefix and suffix around cursor
        const maxLines = config_1.ConfigManager.inlineCompletionMaxContextLines;
        const startLine = Math.max(0, position.line - maxLines);
        const endLine = Math.min(document.lineCount - 1, position.line + maxLines);
        const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
        const prefix = document.getText(prefixRange);
        const suffixRange = new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length));
        const suffix = document.getText(suffixRange);
        const mode = config_1.ConfigManager.inlineCompletionMode;
        const baseUrl = config_1.ConfigManager.inlineCompletionEndpoint || config_1.ConfigManager.endpoint;
        const apiKey = config_1.ConfigManager.inlineCompletionApiKey || config_1.ConfigManager.apiKey;
        try {
            let resultText = '';
            this.outputChannel.appendLine(`[Inline Completion] Sending request in mode '${mode}' to model '${model}'...`);
            if (mode === 'completions-fim') {
                resultText = await this.fetchCompletionsFIM(baseUrl, apiKey, model, prefix, suffix, token);
            }
            else if (mode === 'chat-fim') {
                resultText = await this.fetchChatFIM(baseUrl, apiKey, model, prefix, suffix, token);
            }
            else {
                resultText = await this.fetchForwardOnly(baseUrl, apiKey, model, prefix, token);
            }
            if (token.isCancellationRequested) {
                this.outputChannel.appendLine(`[Inline Completion] Request was cancelled by VS Code.`);
                return [];
            }
            if (!resultText) {
                this.outputChannel.appendLine(`[Inline Completion] Empty response returned from provider.`);
                return [];
            }
            this.outputChannel.appendLine(`[Inline Completion] Received response length: ${resultText.length} chars.`);
            // Clean up markdown codeblocks if model returned them
            let cleaned = resultText;
            if (cleaned.startsWith('```')) {
                const lines = cleaned.split('\n');
                if (lines[0].startsWith('```')) {
                    lines.shift();
                }
                if (lines[lines.length - 1] === '```') {
                    lines.pop();
                }
                cleaned = lines.join('\n');
            }
            this.outputChannel.appendLine(`[Inline Completion] Cleaned completion text:\n${cleaned}`);
            const item = new vscode.InlineCompletionItem(cleaned);
            item.range = new vscode.Range(position, position);
            return new vscode.InlineCompletionList([item]);
        }
        catch (e) {
            this.outputChannel.appendLine(`[Inline Completion] Error: ${e.message || e}`);
            return [];
        }
    }
    async fetchCompletionsFIM(baseUrl, apiKey, model, prefix, suffix, token) {
        const url = `${baseUrl}/v1/completions`;
        // Choose FIM tags depending on model family
        let prompt = '';
        let stop = [];
        const isQwenOrDeepseek = model.toLowerCase().includes('qwen') || model.toLowerCase().includes('deepseek');
        if (isQwenOrDeepseek) {
            prompt = `<｜fim begin｜>${prefix}<｜fim hole｜>${suffix}<｜fim end｜>`;
            stop = ['<｜fim begin｜>', '<｜fim hole｜>', '<｜fim end｜>', '\n\n', '```'];
        }
        else {
            prompt = `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
            stop = ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '</fim_middle>', '\n\n', '```'];
        }
        const body = {
            model,
            prompt,
            max_tokens: 128,
            temperature: 0.1,
            stop,
            stream: false
        };
        const responseText = await this.postRequest(url, apiKey, body, token);
        try {
            const parsed = JSON.parse(responseText);
            return parsed?.choices?.[0]?.text || '';
        }
        catch {
            return '';
        }
    }
    async fetchChatFIM(baseUrl, apiKey, model, prefix, suffix, token) {
        const url = `${baseUrl}/v1/chat/completions`;
        const body = {
            model,
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert AI code completion assistant.\nYour task is to fill in the missing code at the <FILL_ME> tag.\nRules:\n1. Return ONLY the exact code replacing <FILL_ME> tag directly.\n2. Do NOT wrap inside markdown blocks (such as ```).\n3. Do NOT write explanations, conversations, or comments.\n4. Preserve the indentation and coding style.'
                },
                {
                    role: 'user',
                    content: `${prefix}<FILL_ME>${suffix}`
                }
            ],
            max_tokens: 128,
            temperature: 0.1,
            stop: ['\n\n'],
            stream: false
        };
        const responseText = await this.postRequest(url, apiKey, body, token);
        try {
            const parsed = JSON.parse(responseText);
            return parsed?.choices?.[0]?.message?.content || '';
        }
        catch {
            return '';
        }
    }
    async fetchForwardOnly(baseUrl, apiKey, model, prefix, token) {
        const url = `${baseUrl}/v1/chat/completions`;
        const body = {
            model,
            messages: [
                {
                    role: 'system',
                    content: 'You are a code completion engine. Continue the user\'s code. Output ONLY the code that directly follows the user\'s input, without markdown blocks, explanation, or conversational text.'
                },
                {
                    role: 'user',
                    content: prefix
                }
            ],
            max_tokens: 128,
            temperature: 0.1,
            stop: ['\n\n'],
            stream: false
        };
        const responseText = await this.postRequest(url, apiKey, body, token);
        try {
            const parsed = JSON.parse(responseText);
            return parsed?.choices?.[0]?.message?.content || '';
        }
        catch {
            return '';
        }
    }
    postRequest(targetUrl, apiKey, body, token) {
        return new Promise((resolve, reject) => {
            const url = new url_1.URL(targetUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;
            const bodyStr = JSON.stringify(body);
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyStr),
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
            };
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    }
                    else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', (e) => {
                reject(e);
            });
            token.onCancellationRequested(() => {
                req.destroy();
                resolve('');
            });
            req.write(bodyStr);
            req.end();
        });
    }
}
exports.CustomInlineCompletionProvider = CustomInlineCompletionProvider;

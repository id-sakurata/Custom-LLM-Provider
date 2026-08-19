import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { ConfigManager } from './config';

interface CacheEntry {
  uri: string;
  prefix: string;
  completion: string;
  timestamp: number;
}

/**
 * Provides inline completions (ghost text) using the configured LLM endpoint.
 * Features:
 * - Phase 1: Local Caching, Dynamic Single/Multi-line Tuning, Suffix Deduplication
 * - Phase 2: Neighboring Open Tabs Context (Jaccard Similarity)
 * - Phase 3: AST Go-To-Definition Context Resolver
 */
export class CustomInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastCache: CacheEntry | undefined;

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
    if (!ConfigManager.inlineCompletionEnabled) {
      return [];
    }

    const model = ConfigManager.inlineCompletionModel;
    if (!model) {
      this.outputChannel.appendLine(`[Inline Completion] Warning: No model configured. Please set customLlmProvider.inlineCompletion.model`);
      return [];
    }

    const triggerKindStr = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke ? 'Explicit (Invoke)' : 'Automatic (Typing)';
    this.outputChannel.appendLine(`\n[Inline Completion] Event Triggered (${triggerKindStr}) -> File: ${document.fileName}:${position.line + 1}:${position.character + 1}`);

    // Get prefix and suffix around cursor
    const maxLines = ConfigManager.inlineCompletionMaxContextLines;
    const startLine = Math.max(0, position.line - maxLines);
    const endLine = Math.min(document.lineCount - 1, position.line + maxLines);

    const prefixRange = new vscode.Range(new vscode.Position(startLine, 0), position);
    const prefix = document.getText(prefixRange);

    const suffixRange = new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length));
    const suffix = document.getText(suffixRange);

    // ==========================================
    // PHASE 1A: LOCAL CACHING (FAST SERVE)
    // ==========================================
    const docUriStr = document.uri.toString();
    if (this.lastCache && this.lastCache.uri === docUriStr && (Date.now() - this.lastCache.timestamp < 10000)) {
      if (prefix.startsWith(this.lastCache.prefix)) {
        const typedPart = prefix.substring(this.lastCache.prefix.length);
        if (this.lastCache.completion.startsWith(typedPart)) {
          const remainingSuggestion = this.lastCache.completion.substring(typedPart.length);
          if (remainingSuggestion.trim().length > 0) {
            this.outputChannel.appendLine(`[Inline Completion] ⚡ [Phase 1 Cache Hit] Serving remaining suggestion instantly (no API request needed).`);
            const item = new vscode.InlineCompletionItem(remainingSuggestion);
            item.range = new vscode.Range(position, position);
            return new vscode.InlineCompletionList([item]);
          }
        }
      }
    }

    // Debounce to prevent making API requests on every single keystroke
    await new Promise<void>((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        resolve();
      }, ConfigManager.inlineCompletionDebounceDelay);
    });

    if (token.isCancellationRequested) {
      this.outputChannel.appendLine(`[Inline Completion] Cancelled during debounce delay.`);
      return [];
    }

    // ==========================================
    // PHASE 1B: DYNAMIC SINGLE VS MULTI-LINE
    // ==========================================
    const currentLineText = document.lineAt(position.line).text;
    const textAfterCursor = currentLineText.substring(position.character).trim();
    const isMidLine = textAfterCursor.length > 0;
    const isSingleLineRequest = isMidLine;

    // ==========================================
    // PHASE 2: NEIGHBORING OPEN TABS CONTEXT
    // ==========================================
    const neighboringContext = this.getNeighboringTabsContext(document, prefix);

    // ==========================================
    // PHASE 3: AST DEFINITION RESOLVER CONTEXT
    // ==========================================
    const definitionContext = await this.getDefinitionContext(document, position);

    // Combine Codebase Contexts
    const extraContext = [neighboringContext, definitionContext].filter(Boolean).join('\n\n');

    const mode = ConfigManager.inlineCompletionMode;
    const baseUrl = ConfigManager.inlineCompletionEndpoint || ConfigManager.endpoint;
    const apiKey = ConfigManager.inlineCompletionApiKey || ConfigManager.apiKey;

    const hasApiKey = apiKey ? 'Yes (configured)' : 'No (empty)';
    this.outputChannel.appendLine(`[Inline Completion] Config & Intelligence Snapshot:`);
    this.outputChannel.appendLine(`  • Effective Base URL : ${baseUrl}`);
    this.outputChannel.appendLine(`  • Target Model       : ${model}`);
    this.outputChannel.appendLine(`  • Mode               : ${mode}`);
    this.outputChannel.appendLine(`  • Completion Scope   : ${isSingleLineRequest ? 'Single Line (Mid-line cursor)' : 'Multi-Line / Full Block'}`);
    this.outputChannel.appendLine(`  • API Key Present    : ${hasApiKey}`);
    this.outputChannel.appendLine(`  • Context Window     : Prefix ${prefix.length} chars, Suffix ${suffix.length} chars`);
    if (neighboringContext) {
      this.outputChannel.appendLine(`  • [Phase 2] Neighboring Tabs Context included (${neighboringContext.length} chars)`);
    }
    if (definitionContext) {
      this.outputChannel.appendLine(`  • [Phase 3] AST Definition Context included (${definitionContext.length} chars)`);
    }

    const startTime = Date.now();
    try {
      let resultText = '';
      if (mode === 'completions-fim') {
        resultText = await this.fetchCompletionsFIM(baseUrl, apiKey, model, prefix, suffix, isSingleLineRequest, extraContext, token);
      } else if (mode === 'chat-fim') {
        resultText = await this.fetchChatFIM(baseUrl, apiKey, model, prefix, suffix, isSingleLineRequest, extraContext, token);
      } else {
        resultText = await this.fetchForwardOnly(baseUrl, apiKey, model, prefix, isSingleLineRequest, extraContext, token);
      }

      const duration = Date.now() - startTime;

      if (token.isCancellationRequested) {
        this.outputChannel.appendLine(`[Inline Completion] Request was cancelled by VS Code after ${duration}ms.`);
        return [];
      }

      if (!resultText) {
        this.outputChannel.appendLine(`[Inline Completion] Empty/null completion returned from provider (${duration}ms).`);
        return [];
      }

      this.outputChannel.appendLine(`[Inline Completion] Received response in ${duration}ms (Raw Length: ${resultText.length} chars).`);

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

      // ==========================================
      // PHASE 1C: SUFFIX OVERLAP DEDUPLICATION
      // ==========================================
      cleaned = this.cleanSuffixOverlap(cleaned, suffix);

      if (isSingleLineRequest && cleaned.includes('\n')) {
        cleaned = cleaned.split('\n')[0];
      }

      if (!cleaned.trim()) {
        this.outputChannel.appendLine(`[Inline Completion] Completion became empty after post-processing deduplication.`);
        return [];
      }

      // Save to cache for Phase 1A fast reuse
      this.lastCache = {
        uri: docUriStr,
        prefix,
        completion: cleaned,
        timestamp: Date.now()
      };

      this.outputChannel.appendLine(`[Inline Completion] Cleaned ghost text suggestion:\n--- START ---\n${cleaned}\n--- END ---`);

      const item = new vscode.InlineCompletionItem(cleaned);
      item.range = new vscode.Range(position, position);

      return new vscode.InlineCompletionList([item]);
    } catch (e: any) {
      const duration = Date.now() - startTime;
      this.outputChannel.appendLine(`[Inline Completion] Request Failed after ${duration}ms: ${e.message || e}`);
      return [];
    }
  }

  /**
   * Phase 1C: Strips overlapping suffix characters (closing brackets, semicolons) from completion end.
   */
  private cleanSuffixOverlap(completionText: string, suffixText: string): string {
    const trimmedSuffix = suffixText.trimStart();
    if (!trimmedSuffix) {
      return completionText;
    }

    // Common overlap tokens
    const tokens = [');', ')', '}', '};', ']', '];', '>', ';'];
    let result = completionText;

    for (const token of tokens) {
      if (result.endsWith(token) && trimmedSuffix.startsWith(token)) {
        result = result.substring(0, result.length - token.length);
        break;
      }
    }
    return result;
  }

  /**
   * Phase 2: Scans open tabs in VS Code workspace and extracts relevant snippets using Jaccard Similarity.
   */
  private getNeighboringTabsContext(currentDoc: vscode.TextDocument, currentPrefix: string): string {
    try {
      const openDocs = vscode.workspace.textDocuments.filter((doc) => {
        return (
          doc.uri.toString() !== currentDoc.uri.toString() &&
          doc.uri.scheme === 'file' &&
          !doc.fileName.includes('node_modules') &&
          doc.getText().length > 0 &&
          doc.getText().length < 50000
        );
      });

      if (openDocs.length === 0) {
        return '';
      }

      const getTokens = (text: string): Set<string> => {
        const words = text.match(/\w{3,}/g) || [];
        return new Set(words.map((w) => w.toLowerCase()));
      };

      const currentTokens = getTokens(currentPrefix.slice(-1000));
      if (currentTokens.size === 0) {
        return '';
      }

      const scoredDocs: { doc: vscode.TextDocument; score: number }[] = [];

      for (const doc of openDocs) {
        const docTokens = getTokens(doc.getText().slice(0, 3000));
        let intersection = 0;
        for (const token of currentTokens) {
          if (docTokens.has(token)) {
            intersection++;
          }
        }
        const union = new Set([...currentTokens, ...docTokens]).size;
        const jaccardScore = union > 0 ? intersection / union : 0;

        if (jaccardScore > 0.05) {
          scoredDocs.push({ doc, score: jaccardScore });
        }
      }

      scoredDocs.sort((a, b) => b.score - a.score);
      const topDocs = scoredDocs.slice(0, 2);

      if (topDocs.length === 0) {
        return '';
      }

      const snippets: string[] = [];
      for (const { doc } of topDocs) {
        const relPath = vscode.workspace.asRelativePath(doc.uri);
        const excerpt = doc.getText().slice(0, 800);
        snippets.push(`// Open Tab Reference: ${relPath}\n${excerpt}`);
      }

      return snippets.join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * Phase 3: Uses VS Code AST Definition Provider to resolve imported types/functions around cursor.
   */
  private async getDefinitionContext(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
    try {
      const wordRange = document.getWordRangeAtPosition(position) || document.getWordRangeAtPosition(new vscode.Position(position.line, Math.max(0, position.character - 1)));
      if (!wordRange) {
        return '';
      }

      const word = document.getText(wordRange);
      if (!word || word.length < 3) {
        return '';
      }

      const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider',
        document.uri,
        wordRange.start
      );

      if (!definitions || definitions.length === 0) {
        return '';
      }

      let defUri: vscode.Uri | undefined;
      let defRange: vscode.Range | undefined;

      const firstDef = definitions[0];
      if ('uri' in firstDef) {
        defUri = firstDef.uri;
        defRange = firstDef.range;
      } else if ('targetUri' in firstDef) {
        defUri = firstDef.targetUri;
        defRange = firstDef.targetRange;
      }

      if (!defUri || defUri.toString() === document.uri.toString()) {
        return '';
      }

      const defDoc = await vscode.workspace.openTextDocument(defUri);
      const startL = Math.max(0, (defRange?.start.line || 0) - 2);
      const endL = Math.min(defDoc.lineCount - 1, (defRange?.end.line || 0) + 10);
      const snippet = defDoc.getText(new vscode.Range(new vscode.Position(startL, 0), new vscode.Position(endL, defDoc.lineAt(endL).text.length)));

      const relPath = vscode.workspace.asRelativePath(defUri);
      return `// Resolved Definition (${word} in ${relPath}):\n${snippet}`;
    } catch {
      return '';
    }
  }

  private resolveEndpointUrl(baseUrl: string, defaultPath: string): string {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanPath = defaultPath.startsWith('/') ? defaultPath : `/${defaultPath}`;

    // If cleanBase already ends with /v1 and cleanPath starts with /v1/, remove the extra /v1
    if (cleanBase.toLowerCase().endsWith('/v1') && cleanPath.toLowerCase().startsWith('/v1/')) {
      return `${cleanBase}${cleanPath.substring(3)}`;
    }

    // If cleanBase already contains /v1 elsewhere in the URL
    if (cleanBase.toLowerCase().includes('/v1') && cleanPath.toLowerCase().startsWith('/v1/')) {
      return `${cleanBase}${cleanPath.substring(3)}`;
    }

    return `${cleanBase}${cleanPath}`;
  }

  private async fetchCompletionsFIM(
    baseUrl: string,
    apiKey: string,
    model: string,
    prefix: string,
    suffix: string,
    isSingleLine: boolean,
    extraContext: string,
    token: vscode.CancellationToken
  ): Promise<string> {
    const url = this.resolveEndpointUrl(baseUrl, '/v1/completions');
    const useStreaming = ConfigManager.inlineCompletionUseStreaming;
    
    let prompt = '';
    let stop: string[] = [];
    
    const contextPrefix = extraContext ? `/* Codebase Context:\n${extraContext}\n*/\n` : '';
    const fullPrefix = contextPrefix + prefix;

    const isQwenOrDeepseek = model.toLowerCase().includes('qwen') || model.toLowerCase().includes('deepseek');
    if (isQwenOrDeepseek) {
      prompt = `<｜fim begin｜>${fullPrefix}<｜fim hole｜>${suffix}<｜fim end｜>`;
      stop = isSingleLine ? ['\n', '<｜fim begin｜>', '<｜fim hole｜>', '<｜fim end｜>'] : ['<｜fim begin｜>', '<｜fim hole｜>', '<｜fim end｜>', '\n\n', '```'];
    } else {
      prompt = `<fim_prefix>${fullPrefix}<fim_suffix>${suffix}<fim_middle>`;
      stop = isSingleLine ? ['\n', '<fim_prefix>', '<fim_suffix>', '<fim_middle>'] : ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '</fim_middle>', '\n\n', '```'];
    }

    const body = {
      model,
      prompt,
      max_tokens: isSingleLine ? 48 : 128,
      temperature: 0.1,
      stop,
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, isSingleLine, useStreaming, token);
  }

  private async fetchChatFIM(
    baseUrl: string,
    apiKey: string,
    model: string,
    prefix: string,
    suffix: string,
    isSingleLine: boolean,
    extraContext: string,
    token: vscode.CancellationToken
  ): Promise<string> {
    const url = this.resolveEndpointUrl(baseUrl, '/v1/chat/completions');
    const useStreaming = ConfigManager.inlineCompletionUseStreaming;

    const systemPrompt = `You are an expert AI code completion assistant.
Your task is to fill in the missing code at the <FILL_ME> tag.
${extraContext ? `Relevant Codebase Context:\n${extraContext}\n` : ''}
Rules:
1. Return ONLY the exact code replacing <FILL_ME> tag directly.
2. Do NOT wrap inside markdown blocks (such as \`\`\`).
3. Do NOT write explanations, conversations, or comments.
4. Preserve the indentation and coding style.
${isSingleLine ? '5. Output ONLY a single line of code.' : ''}`;

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: `${prefix}<FILL_ME>${suffix}`
        }
      ],
      max_tokens: isSingleLine ? 48 : 128,
      temperature: 0.1,
      stop: isSingleLine ? ['\n'] : ['\n\n'],
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, isSingleLine, useStreaming, token);
  }

  private async fetchForwardOnly(
    baseUrl: string,
    apiKey: string,
    model: string,
    prefix: string,
    isSingleLine: boolean,
    extraContext: string,
    token: vscode.CancellationToken
  ): Promise<string> {
    const url = this.resolveEndpointUrl(baseUrl, '/v1/chat/completions');
    const useStreaming = ConfigManager.inlineCompletionUseStreaming;

    const systemPrompt = `You are a code completion engine. Continue the user's code.
${extraContext ? `Relevant Codebase Context:\n${extraContext}\n` : ''}
Output ONLY the code that directly follows the user's input, without markdown blocks, explanation, or conversational text.
${isSingleLine ? 'Output ONLY a single line of code.' : ''}`;

    const body = {
      model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: prefix
        }
      ],
      max_tokens: isSingleLine ? 48 : 128,
      temperature: 0.1,
      stop: isSingleLine ? ['\n'] : ['\n\n'],
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, isSingleLine, useStreaming, token);
  }

  private postRequest(
    targetUrl: string,
    apiKey: string,
    body: Record<string, any>,
    isSingleLine: boolean,
    useStreaming: boolean,
    token: vscode.CancellationToken
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(targetUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const bodyStr = JSON.stringify(body);
      this.outputChannel.appendLine(`[Inline Completion] HTTP POST (stream=${useStreaming}) -> Full Request URL: ${targetUrl}`);
      
      const options: http.RequestOptions = {
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

      const reqStartTime = Date.now();
      const cancelListener = token.onCancellationRequested(() => {
        this.outputChannel.appendLine(`[Inline Completion] HTTP Request destroyed (token cancelled by VS Code).`);
        req.destroy();
        resolve('');
      });

      const req = lib.request(options, (res) => {
        let rawData = '';
        let accumulatedStreamText = '';
        let firstTokenTime = 0;
        let sseBuffer = '';

        res.on('data', (chunk) => {
          const chunkStr = chunk.toString();
          rawData += chunkStr;

          if (useStreaming) {
            sseBuffer += chunkStr;
            const lines = sseBuffer.split('\n');
            // Keep incomplete trailing line in sseBuffer for next chunk
            sseBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) {
                continue;
              }
              if (trimmed === 'data: [DONE]') {
                break;
              }
              if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.substring(6);
                try {
                  const parsed = JSON.parse(jsonStr);
                  const delta = parsed?.choices?.[0]?.delta?.content || parsed?.choices?.[0]?.text || '';
                  if (delta) {
                    if (!firstTokenTime) {
                      firstTokenTime = Date.now() - reqStartTime;
                      this.outputChannel.appendLine(`[Inline Completion] ⚡ [TTFT / First Token] Received in ${firstTokenTime}ms`);
                    }
                    accumulatedStreamText += delta;

                    // Early abort if single line request meets a newline
                    if (isSingleLine && accumulatedStreamText.includes('\n')) {
                      this.outputChannel.appendLine(`[Inline Completion] Early streaming abort triggered (single-line newline detected).`);
                      cancelListener.dispose();
                      req.destroy();
                      resolve(accumulatedStreamText.split('\n')[0]);
                      return;
                    }
                  }
                } catch {
                  // Partial JSON chunk fragment, ignore
                }
              }
            }
          }
        });

        res.on('end', () => {
          cancelListener.dispose();
          const reqDuration = Date.now() - reqStartTime;
          this.outputChannel.appendLine(`[Inline Completion] HTTP Response Status: ${res.statusCode} ${res.statusMessage || ''} (${reqDuration}ms)`);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (useStreaming && accumulatedStreamText) {
              resolve(accumulatedStreamText);
              return;
            }

            // Fallback non-streaming parse
            try {
              const parsed = JSON.parse(rawData);
              const result = parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || '';
              resolve(result);
            } catch (err: any) {
              this.outputChannel.appendLine(`[Inline Completion] Failed to parse JSON response: ${err.message}`);
              resolve('');
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${rawData}`));
          }
        });
      });

      req.on('error', (e) => {
        cancelListener.dispose();
        this.outputChannel.appendLine(`[Inline Completion] Network Error: ${e.message}`);
        reject(e);
      });

      req.write(bodyStr);
      req.end();
    });
  }
}


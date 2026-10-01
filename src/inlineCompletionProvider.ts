import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import { ConfigManager } from './config';

interface CacheEntry {
  readonly uri: string;
  readonly prefix: string;
  readonly completion: string;
  readonly timestamp: number;
  hitCount: number;
}

/**
 * LRU (Least Recently Used) cache for inline completion results.
 * Stores multiple completion entries and evicts the oldest when capacity is reached.
 * Supports progressive prefix matching: if the user continues typing characters
 * that match the start of a cached completion, the remaining portion is served instantly.
 */
class LRUCompletionCache {
  private entries: CacheEntry[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 20, ttlMs = 30_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Tries to find a cached completion that matches the current typing context.
   * Searches from most recent to oldest. On a hit, the entry is promoted to MRU position.
   * @returns The remaining (untyped) portion of the completion, or undefined if no match.
   */
  tryMatch(uri: string, currentPrefix: string): string | undefined {
    const now = Date.now();
    // Evict expired entries
    this.entries = this.entries.filter(e => now - e.timestamp < this.ttlMs);

    // Search from most recent to oldest for a matching prefix
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.uri !== uri) {
        continue;
      }

      if (currentPrefix.startsWith(entry.prefix)) {
        const typedPart = currentPrefix.substring(entry.prefix.length);
        if (entry.completion.startsWith(typedPart)) {
          const remaining = entry.completion.substring(typedPart.length);
          if (remaining.trim().length > 0) {
            entry.hitCount++;
            // Promote to MRU position (end of array)
            this.entries.splice(i, 1);
            this.entries.push(entry);
            return remaining;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Stores a new completion entry. Evicts the oldest (LRU) entry if at capacity.
   */
  set(uri: string, prefix: string, completion: string): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift(); // LRU eviction: remove oldest
    }
    this.entries.push({
      uri,
      prefix,
      completion,
      timestamp: Date.now(),
      hitCount: 0,
    });
  }

  /** Clears all cached entries. */
  clear(): void {
    this.entries = [];
  }

  /** Returns the current number of cached entries. */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Describes the structural context around the cursor position.
 * Used to generate more accurate, scope-aware completions.
 */
interface CursorContext {
  /** Whether cursor is in the middle of a line (text exists after cursor on same line). */
  readonly isMidLine: boolean;
  /** Whether to constrain completion to a single line. */
  readonly isSingleLineRequest: boolean;
  /** The language ID of the document (e.g., 'typescript', 'python'). */
  readonly languageId: string;
  /** The indentation string at the cursor's line. */
  readonly lineIndent: string;
  /** The current line text before the cursor. */
  readonly linePrefix: string;
  /** The current line text after the cursor. */
  readonly lineSuffix: string;
  /** Whether the cursor is inside a string literal. */
  readonly isInString: boolean;
  /** Whether the cursor is inside a comment. */
  readonly isInComment: boolean;
  /** Whether the cursor appears to be at a block opening (after {, :, =>). */
  readonly isBlockOpening: boolean;
  /** Whether the cursor appears to be at a blank/empty line. */
  readonly isBlankLine: boolean;
  /** Name of the enclosing function/method, if detectable. */
  readonly enclosingFunctionName: string;
  /** Language-specific stop tokens for completion termination. */
  readonly stopTokens: string[];
}

/**
 * Provides inline completions (ghost text) using the configured LLM endpoint.
 * Features:
 * - Phase 1: LRU Caching, Dynamic Single/Multi-line Tuning, Suffix Deduplication
 * - Phase 2: Neighboring Open Tabs Context (Import-Aware Extraction)
 * - Phase 3: AST Go-To-Definition Context Resolver (Multi-Symbol)
 * - Phase 4: Structural Cursor Context Analysis
 * - Optimizations: HTTP keepAlive, Request Timeout, Superseding Cancellation
 */
export class CustomInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly cache = new LRUCompletionCache(20, 30_000);

  /**
   * HTTP/HTTPS agents with keepAlive enabled for connection reuse across requests.
   * Eliminates TCP/TLS handshake overhead (~50-150ms) on repeated requests to the same host.
   */
  private static readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  private static readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

  /**
   * Monotonically increasing counter to detect superseded requests.
   * Each new provideInlineCompletionItems call increments this, allowing
   * earlier (now-stale) requests to detect they've been superseded.
   */
  private requestGeneration = 0;

  /** Abort function for the currently inflight HTTP request, if any. */
  private abortInflightRequest: (() => void) | undefined;

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

    // ==========================================
    // SUPERSEDING CANCELLATION: Abort previous inflight request
    // ==========================================
    if (this.abortInflightRequest) {
      this.outputChannel.appendLine(`[Inline Completion] ⚡ Cancelling previous inflight request (superseded by new keystroke).`);
      this.abortInflightRequest();
      this.abortInflightRequest = undefined;
    }
    const generation = ++this.requestGeneration;

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
    // PHASE 1A: LRU CACHE (FAST SERVE)
    // ==========================================
    const docUriStr = document.uri.toString();
    const cachedRemaining = this.cache.tryMatch(docUriStr, prefix);
    if (cachedRemaining) {
      this.outputChannel.appendLine(`[Inline Completion] ⚡ [Phase 1 LRU Cache Hit] Serving remaining suggestion instantly (cache size: ${this.cache.size}, no API request needed).`);
      const item = new vscode.InlineCompletionItem(cachedRemaining);
      item.range = new vscode.Range(position, position);
      return new vscode.InlineCompletionList([item]);
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

    // Check cancellation AND superseding after debounce
    if (token.isCancellationRequested || generation !== this.requestGeneration) {
      this.outputChannel.appendLine(`[Inline Completion] Cancelled during debounce delay${generation !== this.requestGeneration ? ' (superseded by newer request)' : ''}.`);
      return [];
    }

    // ==========================================
    // PHASE 4: STRUCTURAL CURSOR CONTEXT ANALYSIS
    // ==========================================
    const cursorCtx = this.analyzeCursorContext(document, position);

    // Skip completion in contexts where ghost text is rarely useful
    if (cursorCtx.isInComment && context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
      this.outputChannel.appendLine(`[Inline Completion] Skipped: cursor is inside a comment (auto-trigger only).`);
      return [];
    }

    this.outputChannel.appendLine(`[Inline Completion] Cursor Analysis: ` +
      `scope=${cursorCtx.isSingleLineRequest ? 'single-line' : 'multi-line'}, ` +
      `lang=${cursorCtx.languageId}, ` +
      `inString=${cursorCtx.isInString}, inComment=${cursorCtx.isInComment}, ` +
      `blockOpening=${cursorCtx.isBlockOpening}, blankLine=${cursorCtx.isBlankLine}` +
      `${cursorCtx.enclosingFunctionName ? `, fn=${cursorCtx.enclosingFunctionName}` : ''}`);

    // ==========================================
    // PHASE 2: NEIGHBORING OPEN TABS CONTEXT
    // ==========================================
    const neighboringContext = this.getNeighboringTabsContext(document, prefix);

    // ==========================================
    // PHASE 3: AST DEFINITION RESOLVER CONTEXT (MULTI-SYMBOL)
    // ==========================================
    const definitionContext = await this.getDefinitionContext(document, position);

    // Check superseding again after async definition resolution
    if (generation !== this.requestGeneration) {
      this.outputChannel.appendLine(`[Inline Completion] Cancelled after context gathering (superseded by newer request).`);
      return [];
    }

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
    this.outputChannel.appendLine(`  • Completion Scope   : ${cursorCtx.isSingleLineRequest ? 'Single Line (Mid-line cursor)' : 'Multi-Line / Full Block'}`);
    this.outputChannel.appendLine(`  • API Key Present    : ${hasApiKey}`);
    this.outputChannel.appendLine(`  • Context Window     : Prefix ${prefix.length} chars, Suffix ${suffix.length} chars`);
    this.outputChannel.appendLine(`  • Stop Tokens        : ${JSON.stringify(cursorCtx.stopTokens)}`);
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
        resultText = await this.fetchCompletionsFIM(baseUrl, apiKey, model, prefix, suffix, cursorCtx, extraContext, generation, token);
      } else if (mode === 'chat-fim') {
        resultText = await this.fetchChatFIM(baseUrl, apiKey, model, prefix, suffix, cursorCtx, extraContext, generation, token);
      } else {
        resultText = await this.fetchForwardOnly(baseUrl, apiKey, model, prefix, cursorCtx, extraContext, generation, token);
      }

      const duration = Date.now() - startTime;

      // Final superseding + cancellation check after API call returns
      if (token.isCancellationRequested || generation !== this.requestGeneration) {
        this.outputChannel.appendLine(`[Inline Completion] Request result discarded after ${duration}ms (superseded or cancelled).`);
        return [];
      }

      if (!resultText) {
        this.outputChannel.appendLine(`[Inline Completion] Empty/null completion returned from provider (${duration}ms).`);
        return [];
      }

      this.outputChannel.appendLine(`[Inline Completion] Received response in ${duration}ms (Raw Length: ${resultText.length} chars).`);

      // ==========================================
      // POST-PROCESSING PIPELINE
      // ==========================================
      let cleaned = this.postProcessCompletion(resultText, suffix, cursorCtx);

      if (!cleaned.trim()) {
        this.outputChannel.appendLine(`[Inline Completion] Completion became empty after post-processing.`);
        return [];
      }

      // Save to LRU cache for Phase 1A fast reuse
      this.cache.set(docUriStr, prefix, cleaned);

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

  // ============================================================
  // PHASE 4: STRUCTURAL CURSOR CONTEXT ANALYSIS
  // ============================================================

  /**
   * Analyzes the document structure around the cursor to produce richer context signals.
   * This enables smarter single/multi-line decisions, language-aware stop tokens,
   * and scope-sensitive prompt construction.
   */
  private analyzeCursorContext(document: vscode.TextDocument, position: vscode.Position): CursorContext {
    const languageId = document.languageId;
    const currentLine = document.lineAt(position.line);
    const lineText = currentLine.text;
    const linePrefix = lineText.substring(0, position.character);
    const lineSuffix = lineText.substring(position.character);
    const trimmedSuffix = lineSuffix.trim();
    const trimmedPrefix = linePrefix.trim();
    const lineIndent = lineText.match(/^(\s*)/)?.[1] || '';

    // Mid-line detection: text after cursor on the same line
    const isMidLine = trimmedSuffix.length > 0;

    // Blank line: cursor is on an empty or whitespace-only line
    const isBlankLine = lineText.trim().length === 0;

    // Block opening detection: line ends with block-start tokens
    const blockOpenTokens = ['{', ':', '=>', '->', 'then', 'do', '('];
    const isBlockOpening = !isMidLine && blockOpenTokens.some(t => trimmedPrefix.endsWith(t));

    // String detection via heuristic quote counting
    const isInString = this.detectInString(linePrefix);

    // Comment detection
    const isInComment = this.detectInComment(document, position, linePrefix);

    // Single-line decision: mid-line OR inside a string → single-line
    // Block opening or blank line → multi-line
    const isSingleLineRequest = isMidLine || (cursorIsOnlyClosingBracket(trimmedSuffix) ? false : isInString);

    // Enclosing function name (for prompt augmentation)
    const enclosingFunctionName = this.detectEnclosingFunction(document, position);

    // Language-specific stop tokens
    const stopTokens = this.getLanguageStopTokens(languageId, isSingleLineRequest);

    return {
      isMidLine,
      isSingleLineRequest,
      languageId,
      lineIndent,
      linePrefix,
      lineSuffix: trimmedSuffix,
      isInString,
      isInComment,
      isBlockOpening,
      isBlankLine,
      enclosingFunctionName,
      stopTokens,
    };
  }

  /**
   * Heuristic detection of whether the cursor is inside a string literal
   * by counting unescaped quotes on the current line before the cursor.
   */
  private detectInString(linePrefix: string): boolean {
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;

    for (let i = 0; i < linePrefix.length; i++) {
      const ch = linePrefix[i];
      const prev = i > 0 ? linePrefix[i - 1] : '';

      if (prev === '\\') {
        continue;
      }

      if (ch === "'" && !inDouble && !inBacktick) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && !inBacktick) {
        inDouble = !inDouble;
      } else if (ch === '`' && !inSingle && !inDouble) {
        inBacktick = !inBacktick;
      }
    }

    return inSingle || inDouble || inBacktick;
  }

  /**
   * Detects whether the cursor position is inside a comment.
   * Checks for line comments (//, #, --) and block comments.
   */
  private detectInComment(document: vscode.TextDocument, position: vscode.Position, linePrefix: string): boolean {
    const langId = document.languageId;

    // Line comment detection
    const lineCommentTokens: Record<string, string[]> = {
      'typescript': ['//'],
      'javascript': ['//'],
      'typescriptreact': ['//'],
      'javascriptreact': ['//'],
      'java': ['//'],
      'c': ['//'],
      'cpp': ['//'],
      'csharp': ['//'],
      'go': ['//'],
      'rust': ['//'],
      'swift': ['//'],
      'kotlin': ['//'],
      'dart': ['//'],
      'php': ['//', '#'],
      'python': ['#'],
      'ruby': ['#'],
      'perl': ['#'],
      'shellscript': ['#'],
      'bash': ['#'],
      'yaml': ['#'],
      'r': ['#'],
      'lua': ['--'],
      'sql': ['--'],
      'haskell': ['--'],
    };

    const tokens = lineCommentTokens[langId] || ['//'];
    const trimmedPrefix = linePrefix.trimStart();
    for (const tok of tokens) {
      if (trimmedPrefix.startsWith(tok)) {
        return true;
      }
      // Check if there's a comment token in the prefix (not inside a string)
      const tokIdx = linePrefix.lastIndexOf(tok);
      if (tokIdx >= 0) {
        const beforeTok = linePrefix.substring(0, tokIdx);
        if (!this.detectInString(beforeTok)) {
          return true;
        }
      }
    }

    // Block comment detection: check if cursor is between /* and */
    const textBefore = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - 50), 0),
      position
    ));
    const lastBlockOpen = textBefore.lastIndexOf('/*');
    const lastBlockClose = textBefore.lastIndexOf('*/');
    if (lastBlockOpen > lastBlockClose) {
      return true;
    }

    return false;
  }

  /**
   * Attempts to find the enclosing function/method name by scanning backwards
   * from the cursor position for function declaration patterns.
   */
  private detectEnclosingFunction(document: vscode.TextDocument, position: vscode.Position): string {
    // Patterns to match function/method declarations across languages
    const patterns = [
      /(?:function|async\s+function)\s+(\w+)/,            // JS/TS function declarations
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/,  // JS/TS arrow/expression
      /(?:public|private|protected|static|async)\s+(\w+)\s*\(/,  // Class methods
      /def\s+(\w+)\s*\(/,                                 // Python
      /fn\s+(\w+)\s*\(/,                                  // Rust
      /func\s+(\w+)\s*\(/,                                // Go
      /fun\s+(\w+)\s*\(/,                                 // Kotlin
    ];

    const searchStart = Math.max(0, position.line - 30);
    for (let line = position.line; line >= searchStart; line--) {
      const lineText = document.lineAt(line).text;
      for (const pattern of patterns) {
        const match = lineText.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    }
    return '';
  }

  /**
   * Returns language-specific stop tokens that prevent the model from generating
   * beyond the current logical code block (e.g., into the next function).
   */
  private getLanguageStopTokens(languageId: string, isSingleLine: boolean): string[] {
    if (isSingleLine) {
      return ['\n'];
    }

    const langStops: Record<string, string[]> = {
      'typescript': ['\nfunction ', '\nexport function ', '\nexport class ', '\nexport interface ', '\nexport type ', '\nexport const ', '\nexport default '],
      'javascript': ['\nfunction ', '\nexport function ', '\nexport class ', '\nexport default ', '\nmodule.exports'],
      'typescriptreact': ['\nfunction ', '\nexport function ', '\nexport class ', '\nexport const ', '\nexport default '],
      'javascriptreact': ['\nfunction ', '\nexport function ', '\nexport class ', '\nexport default '],
      'python': ['\ndef ', '\nclass ', '\n@', '\nif __name__'],
      'rust': ['\nfn ', '\nimpl ', '\nstruct ', '\nenum ', '\ntrait ', '\nmod ', '\npub fn ', '\npub struct '],
      'go': ['\nfunc ', '\ntype ', '\nvar ', '\nconst ', '\npackage '],
      'java': ['\npublic class ', '\nprivate ', '\nprotected ', '\npublic static ', '\n@Override'],
      'csharp': ['\npublic class ', '\nprivate ', '\nprotected ', '\npublic static ', '\nnamespace '],
      'kotlin': ['\nfun ', '\nclass ', '\nobject ', '\ninterface '],
      'php': ['\nfunction ', '\nclass ', '\npublic function ', '\nprivate function '],
      'ruby': ['\ndef ', '\nclass ', '\nmodule ', '\nend\n'],
      'lua': ['\nfunction ', '\nlocal function '],
      'swift': ['\nfunc ', '\nclass ', '\nstruct ', '\nenum ', '\nprotocol '],
      'dart': ['\nclass ', '\nvoid ', '\nFuture', '\nWidget '],
    };

    const base = ['\n\n\n']; // Triple newline always stops
    const specific = langStops[languageId] || [];
    return [...base, ...specific];
  }

  // ============================================================
  // POST-PROCESSING PIPELINE
  // ============================================================

  /**
   * Cleans and validates the raw completion text through multiple stages:
   * 1. Strip markdown codeblock wrappers
   * 2. Remove leading newline if mid-line
   * 3. Fix indentation alignment
   * 4. Suffix overlap deduplication
   * 5. Single-line truncation
   * 6. Scope boundary truncation (prevent bleeding into next function)
   */
  private postProcessCompletion(raw: string, suffix: string, ctx: CursorContext): string {
    let cleaned = raw;

    // 1. Strip markdown codeblocks if model returned them
    if (cleaned.startsWith('```')) {
      const lines = cleaned.split('\n');
      if (lines[0].startsWith('```')) {
        lines.shift();
      }
      if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
        lines.pop();
      }
      cleaned = lines.join('\n');
    }
    // Also strip inline backticks wrapping the entire output
    if (cleaned.startsWith('`') && cleaned.endsWith('`') && !cleaned.includes('\n')) {
      cleaned = cleaned.slice(1, -1);
    }

    // 2. Remove leading newline if we're mid-line (model sometimes adds one)
    if (ctx.isMidLine && cleaned.startsWith('\n')) {
      cleaned = cleaned.replace(/^\n+/, '');
    }

    // 3. Fix indentation: ensure continuation lines are at least as indented as cursor line
    if (!ctx.isSingleLineRequest && cleaned.includes('\n')) {
      cleaned = this.fixIndentation(cleaned, ctx.lineIndent);
    }

    // 4. Suffix overlap deduplication
    cleaned = this.cleanSuffixOverlap(cleaned, suffix);

    // 5. Scope boundary truncation: cut off if completion bleeds into next function/class
    if (!ctx.isSingleLineRequest) {
      cleaned = this.truncateAtScopeBoundary(cleaned, ctx);
    }

    // 6. Single-line truncation (final)
    if (ctx.isSingleLineRequest && cleaned.includes('\n')) {
      cleaned = cleaned.split('\n')[0];
    }

    return cleaned;
  }

  /**
   * Ensures multi-line completions have consistent indentation relative to the cursor line.
   * Lines that start with less indentation than expected are likely the model starting
   * a new top-level scope — we truncate there.
   */
  private fixIndentation(completion: string, baseIndent: string): string {
    const lines = completion.split('\n');
    if (lines.length <= 1) {
      return completion;
    }

    // First line inherits cursor position, skip it
    const result: string[] = [lines[0]];
    const baseDepth = baseIndent.length;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Empty lines are always ok
      if (trimmed.length === 0) {
        result.push(line);
        continue;
      }

      // Closing brackets/braces can have less indent
      if (trimmed.startsWith('}') || trimmed.startsWith(')') || trimmed.startsWith(']')) {
        result.push(line);
        continue;
      }

      // If a non-empty line has significantly less indentation than the base,
      // it's likely a new top-level declaration — stop here
      const lineIndent = (line.match(/^(\s*)/)?.[1] || '').length;
      if (lineIndent < baseDepth - 2 && baseDepth > 2) {
        break;
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * Truncates completion text at scope boundaries (next function/class declaration)
   * to prevent the model from generating beyond the current logical scope.
   */
  private truncateAtScopeBoundary(completion: string, ctx: CursorContext): string {
    const lines = completion.split('\n');
    if (lines.length <= 2) {
      return completion;
    }

    const result: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip first line (continuation of cursor line)
      if (i > 0) {
        // Check if this line matches any stop token pattern (top-level declaration)
        const trimmed = line.trimStart();
        if (this.isTopLevelDeclaration(trimmed, ctx.languageId) && i > 1) {
          // Keep trailing empty lines before the boundary, but stop before the new declaration
          while (result.length > 0 && result[result.length - 1].trim() === '') {
            result.pop();
          }
          break;
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * Detects if a line appears to be a top-level declaration in the given language.
   */
  private isTopLevelDeclaration(trimmedLine: string, languageId: string): boolean {
    // Universal patterns
    const universalPatterns = [
      /^(export\s+)?(default\s+)?(async\s+)?function\s+\w+/,  // function declarations
      /^(export\s+)?(default\s+)?class\s+\w+/,                // class declarations
      /^(export\s+)?interface\s+\w+/,                          // TS interface
      /^(export\s+)?type\s+\w+/,                               // TS type alias
      /^(export\s+)?enum\s+\w+/,                               // TS enum
    ];

    const langPatterns: Record<string, RegExp[]> = {
      'python': [/^def\s+\w+/, /^class\s+\w+/, /^@\w+/],
      'rust': [/^(pub\s+)?fn\s+\w+/, /^(pub\s+)?struct\s+\w+/, /^(pub\s+)?enum\s+\w+/, /^impl\s+/, /^trait\s+/, /^mod\s+/],
      'go': [/^func\s+/, /^type\s+\w+/, /^var\s+/, /^const\s+/],
      'java': [/^(public|private|protected)\s+(static\s+)?(class|interface|enum)\s+/, /^@\w+/],
      'csharp': [/^(public|private|protected|internal)\s+(static\s+)?(class|interface|enum|struct)\s+/, /^namespace\s+/],
      'kotlin': [/^(fun|class|object|interface|enum)\s+\w+/],
      'php': [/^(public|private|protected)?\s*(static\s+)?function\s+/, /^class\s+\w+/],
      'ruby': [/^def\s+\w+/, /^class\s+\w+/, /^module\s+\w+/],
      'swift': [/^(func|class|struct|enum|protocol)\s+\w+/],
      'dart': [/^(class|void|Future|Widget|int|String|double|bool)\s+\w+/],
    };

    for (const pattern of universalPatterns) {
      if (pattern.test(trimmedLine)) {
        return true;
      }
    }

    const specific = langPatterns[languageId] || [];
    for (const pattern of specific) {
      if (pattern.test(trimmedLine)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Phase 1C: Strips overlapping suffix characters from completion end.
   * Enhanced with longest-common-suffix matching for more accurate deduplication.
   */
  private cleanSuffixOverlap(completionText: string, suffixText: string): string {
    const trimmedSuffix = suffixText.trimStart();
    if (!trimmedSuffix) {
      return completionText;
    }

    let result = completionText;

    // Strategy 1: Token-based overlap (fast path)
    const tokens = [');', ')', '}', '};', ']', '];', '/>', '>', ';', '}}', '});', '],'];
    for (const token of tokens) {
      if (result.endsWith(token) && trimmedSuffix.startsWith(token)) {
        result = result.substring(0, result.length - token.length);
        return result;
      }
    }

    // Strategy 2: Longest trailing overlap detection
    // Find the longest suffix of `result` that is also a prefix of `trimmedSuffix`
    const maxCheck = Math.min(result.length, trimmedSuffix.length, 100);
    let longestOverlap = 0;
    for (let len = 1; len <= maxCheck; len++) {
      const tail = result.substring(result.length - len);
      if (trimmedSuffix.startsWith(tail)) {
        longestOverlap = len;
      }
    }
    if (longestOverlap > 0) {
      result = result.substring(0, result.length - longestOverlap);
    }

    return result;
  }

  // ============================================================
  // PHASE 2: NEIGHBORING TABS CONTEXT (IMPORT-AWARE)
  // ============================================================

  /**
   * Scans open tabs and extracts relevant code snippets.
   * Enhanced: prioritizes files that are imported by the current document
   * and extracts export signatures rather than just the first 800 chars.
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

      // Detect imports in the current document to prioritize related files
      const currentText = currentDoc.getText();
      const importedPaths = this.extractImportPaths(currentText, currentDoc.languageId);

      const getTokens = (text: string): Set<string> => {
        const words = text.match(/\w{3,}/g) || [];
        return new Set(words.map((w) => w.toLowerCase()));
      };

      const currentTokens = getTokens(currentPrefix.slice(-1500));
      if (currentTokens.size === 0) {
        return '';
      }

      const scoredDocs: { doc: vscode.TextDocument; score: number; isImported: boolean }[] = [];

      for (const doc of openDocs) {
        const docBaseName = path.basename(doc.fileName, path.extname(doc.fileName));
        const isImported = importedPaths.some(ip => 
          ip.includes(docBaseName) || doc.fileName.replace(/\\/g, '/').includes(ip)
        );

        const docTokens = getTokens(doc.getText().slice(0, 5000));
        let intersection = 0;
        for (const token of currentTokens) {
          if (docTokens.has(token)) {
            intersection++;
          }
        }
        const union = new Set([...currentTokens, ...docTokens]).size;
        let jaccardScore = union > 0 ? intersection / union : 0;

        // Boost score for imported files
        if (isImported) {
          jaccardScore = Math.max(jaccardScore, 0.1) * 1.5;
        }

        if (jaccardScore > 0.04) {
          scoredDocs.push({ doc, score: jaccardScore, isImported });
        }
      }

      scoredDocs.sort((a, b) => b.score - a.score);
      const topDocs = scoredDocs.slice(0, 3);

      if (topDocs.length === 0) {
        return '';
      }

      const snippets: string[] = [];
      for (const { doc, isImported } of topDocs) {
        const relPath = vscode.workspace.asRelativePath(doc.uri);
        let excerpt: string;

        if (isImported) {
          // For imported files: extract export signatures (more useful than first 800 chars)
          excerpt = this.extractExportSignatures(doc);
        } else {
          // For Jaccard-matched files: use vicinity around matching tokens
          excerpt = doc.getText().slice(0, 1000);
        }

        if (excerpt.trim()) {
          snippets.push(`// ${isImported ? 'Imported' : 'Related'} Tab: ${relPath}\n${excerpt}`);
        }
      }

      return snippets.join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * Extracts import/require paths from the document text.
   */
  private extractImportPaths(text: string, languageId: string): string[] {
    const paths: string[] = [];

    // ES6 imports: import { X } from './path'
    const esImportRegex = /from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = esImportRegex.exec(text)) !== null) {
      paths.push(match[1]);
    }

    // CommonJS: require('./path')
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(text)) !== null) {
      paths.push(match[1]);
    }

    // Python: from module import X
    if (languageId === 'python') {
      const pyImportRegex = /(?:from\s+(\S+)\s+import|import\s+(\S+))/g;
      while ((match = pyImportRegex.exec(text)) !== null) {
        paths.push(match[1] || match[2]);
      }
    }

    // Go: import "path"
    if (languageId === 'go') {
      const goImportRegex = /import\s+(?:\w+\s+)?["']([^"']+)["']/g;
      while ((match = goImportRegex.exec(text)) !== null) {
        paths.push(match[1]);
      }
    }

    // Rust: use crate::module
    if (languageId === 'rust') {
      const rustUseRegex = /use\s+(?:crate::)?(\S+)/g;
      while ((match = rustUseRegex.exec(text)) !== null) {
        paths.push(match[1].replace(/::/g, '/'));
      }
    }

    return paths;
  }

  /**
   * Extracts exported function/class/type signatures from a document.
   * Returns a compact summary of the file's public API rather than raw content.
   */
  private extractExportSignatures(doc: vscode.TextDocument): string {
    const text = doc.getText();
    const lines = text.split('\n');
    const signatures: string[] = [];
    let totalChars = 0;
    const maxChars = 1200;

    for (let i = 0; i < lines.length && totalChars < maxChars; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Match export declarations, function signatures, class declarations, type/interface
      if (
        trimmed.startsWith('export ') ||
        trimmed.startsWith('module.exports') ||
        /^(public|def |fn |func |class |interface |type |struct |enum )/.test(trimmed)
      ) {
        // Include the declaration line and following lines until the body starts
        let signature = line;
        // For single-line exports/declarations, just take the line
        if (trimmed.endsWith('{') || trimmed.endsWith('(') || trimmed.endsWith(':')) {
          // Multi-line: include up to 3 more lines for the signature
          const extraLines = [];
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const nextLine = lines[j].trim();
            extraLines.push(lines[j]);
            if (nextLine.includes('{') || nextLine.includes('=>') || nextLine.endsWith(':')) {
              break;
            }
          }
          signature = [line, ...extraLines].join('\n');
        }

        totalChars += signature.length;
        signatures.push(signature);
      }
    }

    return signatures.join('\n');
  }

  // ============================================================
  // PHASE 3: AST DEFINITION RESOLVER (MULTI-SYMBOL)
  // ============================================================

  /**
   * Uses VS Code Definition Provider to resolve types/functions around the cursor.
   * Enhanced: resolves multiple symbols on the current line (not just the word at cursor).
   */
  private async getDefinitionContext(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
    try {
      const currentLine = document.lineAt(position.line).text;

      // Extract unique identifiers from the current line and 2 lines above
      const contextLines = [];
      for (let l = Math.max(0, position.line - 2); l <= position.line; l++) {
        contextLines.push(document.lineAt(l).text);
      }
      const contextText = contextLines.join(' ');
      const identifiers = this.extractIdentifiers(contextText, document.languageId);

      if (identifiers.length === 0) {
        return '';
      }

      const snippets: string[] = [];
      const resolvedUris = new Set<string>(); // Prevent duplicate definitions
      const maxDefinitions = 3;

      for (const identifier of identifiers) {
        if (snippets.length >= maxDefinitions) {
          break;
        }

        // Find the position of this identifier on the relevant lines
        const identPos = this.findIdentifierPosition(document, position, identifier);
        if (!identPos) {
          continue;
        }

        try {
          const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            document.uri,
            identPos
          );

          if (!definitions || definitions.length === 0) {
            continue;
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
            continue;
          }

          const uriKey = `${defUri.toString()}:${defRange?.start.line}`;
          if (resolvedUris.has(uriKey)) {
            continue;
          }
          resolvedUris.add(uriKey);

          const defDoc = await vscode.workspace.openTextDocument(defUri);
          const startL = Math.max(0, (defRange?.start.line || 0) - 1);
          const endL = Math.min(defDoc.lineCount - 1, (defRange?.end.line || 0) + 15);
          const snippet = defDoc.getText(new vscode.Range(
            new vscode.Position(startL, 0),
            new vscode.Position(endL, defDoc.lineAt(endL).text.length)
          ));

          const relPath = vscode.workspace.asRelativePath(defUri);
          snippets.push(`// Definition: ${identifier} (${relPath})\n${snippet}`);
        } catch {
          // Individual definition lookup failure, continue with next identifier
          continue;
        }
      }

      return snippets.join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * Extracts meaningful identifiers (likely type/function references) from text.
   * Filters out language keywords and common primitives.
   */
  private extractIdentifiers(text: string, languageId: string): string[] {
    const words = text.match(/[A-Z]\w{2,}|\w{3,}/g) || [];
    
    const commonKeywords = new Set([
      // JS/TS
      'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum',
      'return', 'import', 'export', 'from', 'async', 'await', 'new', 'this',
      'true', 'false', 'null', 'undefined', 'void', 'string', 'number', 'boolean',
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
      'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof',
      'public', 'private', 'protected', 'static', 'readonly', 'abstract',
      'extends', 'implements', 'super', 'yield', 'delete',
      // Python
      'def', 'self', 'cls', 'None', 'True', 'False', 'lambda', 'with', 'as',
      'pass', 'raise', 'except', 'global', 'nonlocal', 'assert', 'elif',
      // Common
      'and', 'not', 'the', 'that', 'then', 'than', 'have', 'has', 'get', 'set',
      'map', 'filter', 'reduce', 'find', 'some', 'every', 'forEach',
      'push', 'pop', 'shift', 'length', 'size', 'index', 'value', 'key',
      'error', 'Error', 'console', 'log', 'warn', 'info',
      'Math', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean',
      'Promise', 'JSON', 'Buffer', 'require', 'module', 'exports',
    ]);

    const seen = new Set<string>();
    const result: string[] = [];

    for (const word of words) {
      const lower = word.toLowerCase();
      if (commonKeywords.has(word) || commonKeywords.has(lower)) {
        continue;
      }
      if (seen.has(lower) || word.length > 40) {
        continue;
      }
      seen.add(lower);
      result.push(word);
    }

    // Prioritize PascalCase words (likely types/classes) first
    result.sort((a, b) => {
      const aIsPascal = /^[A-Z]/.test(a);
      const bIsPascal = /^[A-Z]/.test(b);
      if (aIsPascal && !bIsPascal) return -1;
      if (!aIsPascal && bIsPascal) return 1;
      return 0;
    });

    return result.slice(0, 5); // Limit to 5 identifiers to avoid too many lookups
  }

  /**
   * Finds the position of an identifier in the document near the cursor.
   */
  private findIdentifierPosition(document: vscode.TextDocument, cursorPos: vscode.Position, identifier: string): vscode.Position | undefined {
    // Search current line and 2 lines above
    for (let line = cursorPos.line; line >= Math.max(0, cursorPos.line - 2); line--) {
      const lineText = document.lineAt(line).text;
      const idx = lineText.indexOf(identifier);
      if (idx >= 0) {
        return new vscode.Position(line, idx + 1); // +1 to be inside the word
      }
    }
    return undefined;
  }

  // ============================================================
  // API REQUEST METHODS
  // ============================================================

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
    ctx: CursorContext,
    extraContext: string,
    generation: number,
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
      const fimStops = ['<｜fim begin｜>', '<｜fim hole｜>', '<｜fim end｜>'];
      stop = [...ctx.stopTokens, ...fimStops, '```'];
    } else {
      prompt = `<fim_prefix>${fullPrefix}<fim_suffix>${suffix}<fim_middle>`;
      const fimStops = ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '</fim_middle>'];
      stop = [...ctx.stopTokens, ...fimStops, '```'];
    }

    const body = {
      model,
      prompt,
      max_tokens: ctx.isSingleLineRequest ? 48 : (ctx.isBlockOpening ? 256 : 128),
      temperature: ctx.isInString ? 0.0 : 0.1,
      stop,
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, ctx.isSingleLineRequest, useStreaming, generation, token);
  }

  private async fetchChatFIM(
    baseUrl: string,
    apiKey: string,
    model: string,
    prefix: string,
    suffix: string,
    ctx: CursorContext,
    extraContext: string,
    generation: number,
    token: vscode.CancellationToken
  ): Promise<string> {
    const url = this.resolveEndpointUrl(baseUrl, '/v1/chat/completions');
    const useStreaming = ConfigManager.inlineCompletionUseStreaming;

    const scopeHint = ctx.enclosingFunctionName
      ? `You are completing code inside the function/method "${ctx.enclosingFunctionName}".`
      : '';

    const styleHint = ctx.isBlockOpening
      ? 'The cursor is at a block opening. Complete the full block body.'
      : ctx.isBlankLine
        ? 'The cursor is on a blank line. Write the next logical statement or block.'
        : '';

    const systemPrompt = `You are an expert AI code completion assistant for ${ctx.languageId} code.
Your task is to fill in the missing code at the <FILL_ME> marker.
${scopeHint}
${styleHint}
${extraContext ? `Relevant Codebase Context:\n${extraContext}\n` : ''}
Rules:
1. Return ONLY the exact code that replaces the <FILL_ME> marker.
2. Do NOT wrap output in markdown code blocks or backticks.
3. Do NOT write explanations, comments, or conversational text.
4. Match the existing indentation style (${ctx.lineIndent.includes('\t') ? 'tabs' : 'spaces'}).
5. Match the coding conventions visible in the surrounding code.
${ctx.isSingleLineRequest ? '6. Output ONLY a single line of code.' : ''}`;

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
      max_tokens: ctx.isSingleLineRequest ? 48 : (ctx.isBlockOpening ? 256 : 128),
      temperature: ctx.isInString ? 0.0 : 0.1,
      stop: ctx.stopTokens,
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, ctx.isSingleLineRequest, useStreaming, generation, token);
  }

  private async fetchForwardOnly(
    baseUrl: string,
    apiKey: string,
    model: string,
    prefix: string,
    ctx: CursorContext,
    extraContext: string,
    generation: number,
    token: vscode.CancellationToken
  ): Promise<string> {
    const url = this.resolveEndpointUrl(baseUrl, '/v1/chat/completions');
    const useStreaming = ConfigManager.inlineCompletionUseStreaming;

    const scopeHint = ctx.enclosingFunctionName
      ? `You are completing code inside the function/method "${ctx.enclosingFunctionName}".`
      : '';

    const systemPrompt = `You are a ${ctx.languageId} code completion engine. Continue the user's code naturally.
${scopeHint}
${extraContext ? `Relevant Codebase Context:\n${extraContext}\n` : ''}
Output ONLY the code that directly follows the user's input. No markdown, no explanation, no conversation.
Match the existing indentation and coding style exactly.
${ctx.isSingleLineRequest ? 'Output ONLY a single line of code.' : ''}`;

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
      max_tokens: ctx.isSingleLineRequest ? 48 : (ctx.isBlockOpening ? 256 : 128),
      temperature: ctx.isInString ? 0.0 : 0.1,
      stop: ctx.stopTokens,
      stream: useStreaming
    };

    return this.postRequest(url, apiKey, body, ctx.isSingleLineRequest, useStreaming, generation, token);
  }

  // ============================================================
  // HTTP TRANSPORT
  // ============================================================

  /**
   * Sends an HTTP POST request to the LLM endpoint.
   * Includes: keepAlive connection pooling, configurable timeout, and superseding cancellation.
   */
  private postRequest(
    targetUrl: string,
    apiKey: string,
    body: Record<string, any>,
    isSingleLine: boolean,
    useStreaming: boolean,
    generation: number,
    token: vscode.CancellationToken
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Pre-flight superseding check: if a newer request already started, bail immediately
      if (generation !== this.requestGeneration) {
        resolve('');
        return;
      }

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
        // HTTP keepAlive connection pooling — reuses TCP connections
        agent: isHttps ? CustomInlineCompletionProvider.httpsAgent : CustomInlineCompletionProvider.httpAgent,
      };

      let resolved = false;
      const safeResolve = (value: string): void => {
        if (!resolved) {
          resolved = true;
          this.abortInflightRequest = undefined;
          cancelListener.dispose();
          resolve(value);
        }
      };
      const safeReject = (error: Error): void => {
        if (!resolved) {
          resolved = true;
          this.abortInflightRequest = undefined;
          cancelListener.dispose();
          reject(error);
        }
      };

      const reqStartTime = Date.now();
      const cancelListener = token.onCancellationRequested(() => {
        this.outputChannel.appendLine(`[Inline Completion] HTTP Request destroyed (token cancelled by VS Code).`);
        req.destroy();
        safeResolve('');
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
                      req.destroy();
                      safeResolve(accumulatedStreamText.split('\n')[0]);
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
          const reqDuration = Date.now() - reqStartTime;
          this.outputChannel.appendLine(`[Inline Completion] HTTP Response Status: ${res.statusCode} ${res.statusMessage || ''} (${reqDuration}ms)`);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (useStreaming && accumulatedStreamText) {
              safeResolve(accumulatedStreamText);
              return;
            }

            // Fallback non-streaming parse
            try {
              const parsed = JSON.parse(rawData);
              const result = parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || '';
              safeResolve(result);
            } catch (err: any) {
              this.outputChannel.appendLine(`[Inline Completion] Failed to parse JSON response: ${err.message}`);
              safeResolve('');
            }
          } else {
            safeReject(new Error(`HTTP ${res.statusCode}: ${rawData}`));
          }
        });
      });

      // Request Timeout — abort if server doesn't respond in time
      const timeout = ConfigManager.inlineCompletionTimeout;
      req.setTimeout(timeout, () => {
        this.outputChannel.appendLine(`[Inline Completion] ⏱️ Request timed out after ${timeout}ms — aborting.`);
        req.destroy();
        safeResolve('');
      });

      req.on('error', (e) => {
        // Suppress "socket hang up" / "ECONNRESET" errors caused by intentional req.destroy()
        if (resolved) {
          return;
        }
        this.outputChannel.appendLine(`[Inline Completion] Network Error: ${e.message}`);
        safeReject(e);
      });

      // Register abort function for superseding cancellation
      this.abortInflightRequest = () => {
        req.destroy();
        safeResolve('');
      };

      req.write(bodyStr);
      req.end();
    });
  }
}

// ============================================================
// UTILITY HELPERS
// ============================================================

/**
 * Checks if the text after cursor consists only of closing brackets/braces.
 * In this case, we allow multi-line completion (e.g., filling a function body before `}`).
 */
function cursorIsOnlyClosingBracket(trimmedSuffix: string): boolean {
  return /^[)\]}>;\s]*$/.test(trimmedSuffix);
}

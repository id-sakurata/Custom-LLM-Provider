import * as vscode from 'vscode';
import { EventEmitter } from 'vscode';
import { getEncoding } from 'js-tiktoken';
import { ConfigManager } from './config';
import { fetchModelsFromEndpoint } from './modelFetcher';
import { ChatHandler } from './chatHandler';
import { RegisteredModel, FetchedModel, ModelCapabilities } from './types';
import { StatusBarManager, ProviderStatus } from './statusBar';

/**
 * Returns a formatted timestamp string for logging.
 */
function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Manages the registration and lifecycle of custom LLM models in VS Code.
 * Implements the LanguageModelChatProvider interface.
 */
export class ModelRegistry implements vscode.Disposable {
  private registeredModels = new Map<string, RegisteredModel>();
  private providerDisposable: vscode.Disposable | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly statusBar: StatusBarManager;
  
  // Encoding used for token counting (defaulting to cl100k_base used by GPT-4)
  private readonly encoding = getEncoding('cl100k_base');

  // Fired when the model list changes so the provider can notify VSCode
  private readonly _onDidChange = new EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(outputChannel: vscode.OutputChannel, statusBar: StatusBarManager) {
    this.outputChannel = outputChannel;
    this.statusBar = statusBar;
  }

  /**
   * Initializes the registry by registering the provider and fetching initial models.
   */
  async initialize(): Promise<void> {
    // Register the single vendor provider once
    this.providerDisposable = vscode.lm.registerLanguageModelChatProvider(
      'custom-llm',
      this.buildProvider()
    );
    await this.refreshModels();
    this.scheduleAutoRefresh();
  }

  /**
   * Builds the LanguageModelChatProvider object for VS Code.
   */
  private buildProvider(): vscode.LanguageModelChatProvider {
    const self = this;

    return {
      onDidChangeLanguageModelChatInformation: self._onDidChange.event,

      provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken
      ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
        return Array.from(self.registeredModels.values()).map((m) => ({
          id: m.id,
          name: m.id,
          family: m.id,
          version: '1',
          tooltip: `Custom LLM Provider — ${m.source} | ${m.capabilities.maxInputTokens} ctx`,
          maxInputTokens: m.capabilities.maxInputTokens,
          maxOutputTokens: m.capabilities.maxOutputTokens,
          capabilities: {
            toolCalling: m.capabilities.toolCalling,
            imageInput: m.capabilities.vision,
          },
        }));
      },

      async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
      ): Promise<void> {
        const registered = self.registeredModels.get(model.id);
        if (!registered) {
          throw vscode.LanguageModelError.NotFound(`Model ${model.id} not found`);
        }

        const handler = new ChatHandler(
          registered.chatEndpoint,
          registered.apiKey,
          registered.capabilities,
          self.outputChannel
        );

        for await (const part of handler.sendRequest(
          messages,
          options.tools ?? [],
          registered.originalId,
          token
        )) {
          progress.report(part);
        }
      },

      /**
       * Provides an accurate token count using the js-tiktoken library.
       */
      provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
      ): Thenable<number> {
        let content = '';
        if (typeof text === 'string') {
          content = text;
        } else {
          content = (text.content as unknown[])
            .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
            .map((p) => p.value)
            .join('');
        }
        
        try {
            const tokens = self.encoding.encode(content);
            return Promise.resolve(tokens.length);
        } catch (e) {
            // Fallback to simple estimation if encoding fails
            return Promise.resolve(Math.ceil(content.length / 4));
        }
      },
    };
  }

  /**
   * Helper to filter model IDs against include and exclude pattern arrays.
   */
  private filterModelIds(allIds: string[], include: string[], exclude: string[]): string[] {
    function matches(id: string, pattern: string): boolean {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.split('*').map(s => s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') + '$');
        return regex.test(id);
      }
      return id === pattern;
    }

    let filtered = [...allIds];
    if (include && include.length > 0) {
      filtered = filtered.filter(id => include.some(pat => matches(id, pat)));
    }

    if (exclude && exclude.length > 0) {
      filtered = filtered.filter(id => !exclude.some(pat => matches(id, pat)));
    }
    return filtered;
  }

  /**
   * Refreshes the list of models from the remote endpoint and additional configuration.
   */
  async refreshModels(): Promise<void> {
    if (!ConfigManager.enabled) {
      this.registeredModels.clear();
      this._onDidChange.fire();
      this.statusBar.update(ProviderStatus.Disabled);
      this.outputChannel.appendLine(`[${timestamp()}] Provider disabled — no models registered.`);
      return;
    }

    this.statusBar.update(ProviderStatus.Fetching);
    this.registeredModels.clear();

    // 1. Fetch from primary endpoint
    this.outputChannel.appendLine(`[${timestamp()}] Refreshing primary models from ${ConfigManager.modelsEndpoint}...`);
    let primaryFetched: FetchedModel[] = [];
    try {
      primaryFetched = await fetchModelsFromEndpoint(ConfigManager.modelsEndpoint, ConfigManager.apiKey, ConfigManager.retryConfig, ConfigManager.proxyUrl);
      this.outputChannel.appendLine(
        `[${timestamp()}] Primary endpoint fetched ${primaryFetched.length} model(s): ${primaryFetched.map(m => m.id).join(', ')}`
      );
    } catch (err) {
      this.outputChannel.appendLine(`[${timestamp()}] WARNING: Primary endpoint fetch failed: ${err}`);
      vscode.window.showWarningMessage(`Custom LLM Provider (Primary): Could not fetch models — ${err}`);
    }

    const primaryFetchedIds = primaryFetched.map(m => m.id);
    const primaryAllIds = Array.from(new Set([...primaryFetchedIds, ...ConfigManager.additionalModels]));
    const primaryFilteredIds = this.filterModelIds(primaryAllIds, ConfigManager.includeModels, ConfigManager.excludeModels);

    for (const modelId of primaryFilteredIds) {
      const source: 'fetched' | 'additional' = primaryFetchedIds.includes(modelId) ? 'fetched' : 'additional';
      const fetchedMeta = primaryFetched.find(m => m.id === modelId);
      const capabilities = this.resolveCapabilities(modelId, ConfigManager.modelOverrides, fetchedMeta);

      this.registeredModels.set(modelId, {
        id: modelId,
        originalId: modelId,
        capabilities,
        source,
        chatEndpoint: ConfigManager.chatEndpoint,
        apiKey: ConfigManager.apiKey
      });

      this.outputChannel.appendLine(
        `[${timestamp()}]   + [Primary] ${modelId} (${source}) ctx:${capabilities.maxInputTokens}/` +
        `${capabilities.maxOutputTokens} tools:${capabilities.toolCalling} vision:${capabilities.vision}`
      );
    }

    // 2. Fetch from additional endpoints
    const additionalEndpoints = ConfigManager.additionalEndpoints;
    for (const endpoint of additionalEndpoints) {
      if (!endpoint.id || !endpoint.url) {
        continue;
      }
      if (endpoint.enabled === false) {
        this.outputChannel.appendLine(`[${timestamp()}] Skipping disabled endpoint '${endpoint.id}'`);
        continue;
      }
      const prefix = endpoint.id;
      const cleanUrl = endpoint.url.replace(/\/$/, '');
      const modelsUrl = `${cleanUrl}/v1/models`;
      const chatEndpoint = `${cleanUrl}/v1/chat/completions`;
      const apiKey = endpoint.apiKey || '';
      const additionalModels = endpoint.additionalModels || endpoint.additional_models || [];
      const includeModels = endpoint.includeModels || [];
      const excludeModels = endpoint.excludeModels || [];
      const overrides = endpoint.modelOverrides || endpoint.models_overrides || {};

      this.outputChannel.appendLine(`[${timestamp()}] Refreshing models from additional endpoint '${prefix}' (${modelsUrl})...`);
      let fetched: FetchedModel[] = [];
      try {
        fetched = await fetchModelsFromEndpoint(modelsUrl, apiKey, ConfigManager.retryConfig, ConfigManager.proxyUrl);
        this.outputChannel.appendLine(
          `[${timestamp()}] Endpoint '${prefix}' fetched ${fetched.length} model(s): ${fetched.map(m => m.id).join(', ')}`
        );
      } catch (err) {
        this.outputChannel.appendLine(`[${timestamp()}] WARNING: Endpoint '${prefix}' fetch failed: ${err}`);
        vscode.window.showWarningMessage(`Custom LLM Provider (${prefix}): Could not fetch models — ${err}`);
      }

      const fetchedIds = fetched.map(m => m.id);
      const allIds = Array.from(new Set([...fetchedIds, ...additionalModels]));
      const filteredIds = this.filterModelIds(allIds, includeModels, excludeModels);

      for (const modelId of filteredIds) {
        const source: 'fetched' | 'additional' = fetchedIds.includes(modelId) ? 'fetched' : 'additional';
        const fetchedMeta = fetched.find(m => m.id === modelId);
        const capabilities = this.resolveCapabilities(modelId, overrides, fetchedMeta);
        const registeredId = `${prefix}:${modelId}`;

        this.registeredModels.set(registeredId, {
          id: registeredId,
          originalId: modelId,
          capabilities,
          source,
          chatEndpoint,
          apiKey
        });

        this.outputChannel.appendLine(
          `[${timestamp()}]   + [${prefix}] ${registeredId} (${source}) ctx:${capabilities.maxInputTokens}/` +
          `${capabilities.maxOutputTokens} tools:${capabilities.toolCalling} vision:${capabilities.vision}`
        );
      }
    }

    // 3. Register model aliases
    const aliases = ConfigManager.modelAliases;
    for (const [alias, targetId] of Object.entries(aliases)) {
      const targetModel = this.registeredModels.get(targetId);
      if (targetModel) {
        if (!this.registeredModels.has(alias)) {
          this.registeredModels.set(alias, {
            id: alias,
            originalId: targetModel.originalId,
            capabilities: targetModel.capabilities,
            source: targetModel.source,
            chatEndpoint: targetModel.chatEndpoint,
            apiKey: targetModel.apiKey
          });
          this.outputChannel.appendLine(`[${timestamp()}]   ~ alias '${alias}' -> '${targetId}'`);
        }
      } else {
        // Try to find alias target as a prefixed model (e.g., "ollama:qwen2.5" if alias target is "qwen2.5")
        for (const [registeredId, model] of this.registeredModels) {
          if (model.originalId === targetId && !this.registeredModels.has(alias)) {
            this.registeredModels.set(alias, {
              id: alias,
              originalId: model.originalId,
              capabilities: model.capabilities,
              source: model.source,
              chatEndpoint: model.chatEndpoint,
              apiKey: model.apiKey
            });
            this.outputChannel.appendLine(`[${timestamp()}]   ~ alias '${alias}' -> '${registeredId}' (originalId: ${targetId})`);
            break;
          }
        }
      }
    }

    if (this.registeredModels.size === 0) {
      this.outputChannel.appendLine(`[${timestamp()}] No models to register.`);
      this.statusBar.update(ProviderStatus.Error);
      vscode.window.showWarningMessage('Custom LLM Provider: No models found. Check endpoint or settings.');
      this._onDidChange.fire();
      return;
    }

    // Notify VSCode that the model list changed
    this._onDidChange.fire();
    this.statusBar.update(ProviderStatus.Ready, this.registeredModels.size);

    vscode.window.showInformationMessage(
      `Custom LLM Provider: ${this.registeredModels.size} model(s) registered.`
    );
    this.outputChannel.appendLine(
      `[${timestamp()}] Done — ${this.registeredModels.size} model(s) registered.`
    );
  }

  /**
   * Resolves capabilities for a model by merging:
   * 1. User Overrides (highest priority)
   * 2. API Metadata (if available)
   * 3. Global Fallback Config
   */
  private resolveCapabilities(
    modelId: string,
    overrides: Record<string, Partial<ModelCapabilities>>,
    apiMeta?: FetchedModel
  ): ModelCapabilities {
    const globalFallback = ConfigManager.modelFallbackConfigs;
    const userOverride = overrides[modelId] ?? {};
    
    // Extract capabilities from API metadata if present
    const apiCapabilities: Partial<ModelCapabilities> = {};
    if (apiMeta) {
      if (apiMeta.max_input_tokens) { apiCapabilities.maxInputTokens = apiMeta.max_input_tokens; }
      else if (apiMeta.context_length) { apiCapabilities.maxInputTokens = apiMeta.context_length; }
      
      if (apiMeta.max_output_tokens) { apiCapabilities.maxOutputTokens = apiMeta.max_output_tokens; }
      
      if (apiMeta.capabilities) {
        if (apiMeta.capabilities.vision !== undefined) { apiCapabilities.vision = apiMeta.capabilities.vision; }
        if (apiMeta.capabilities.tool_calling !== undefined) { apiCapabilities.toolCalling = apiMeta.capabilities.tool_calling; }
        if (apiMeta.capabilities.reasoning !== undefined) { apiCapabilities.reasoning = apiMeta.capabilities.reasoning; }
        if (apiMeta.capabilities.thinking !== undefined) { apiCapabilities.thinking = apiMeta.capabilities.thinking; }
      }
    }

    const merged = {
      ...globalFallback,
      ...apiCapabilities,
      ...userOverride
    };

    // If thinking or reasoning is globally disabled, enforce it unless explicitly overridden/enabled
    if (globalFallback.thinking === false && userOverride.thinking === undefined) {
      merged.thinking = false;
    }
    if (globalFallback.reasoning === false && userOverride.reasoning === undefined) {
      merged.reasoning = false;
    }

    return merged;
  }

  /**
   * Schedules or reschedules the automatic model refresh timer.
   */
  public scheduleAutoRefresh(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); }
    const minutes = ConfigManager.autoRefreshInterval;
    if (minutes > 0) {
      this.refreshTimer = setInterval(() => {
        this.refreshModels().catch((e) =>
          this.outputChannel.appendLine(`[${timestamp()}] Auto-refresh error: ${e}`)
        );
      }, minutes * 60_000);
      this.outputChannel.appendLine(`[${timestamp()}] Auto-refresh scheduled every ${minutes} min.`);
    } else {
      this.outputChannel.appendLine(`[${timestamp()}] Auto-refresh disabled.`);
    }
  }

  /**
   * Returns the current status of the registry.
   */
  getStatus() {
    const models = Array.from(this.registeredModels.values());
    return {
      total: models.length,
      fetched: models.filter((m) => m.source === 'fetched').length,
      additional: models.filter((m) => m.source === 'additional').length,
      models,
    };
  }

  /**
   * Disposes of resources used by the registry.
   */
  dispose(): void {
    this.providerDisposable?.dispose();
    this._onDidChange.dispose();
    if (this.refreshTimer) { clearInterval(this.refreshTimer); }
    this.registeredModels.clear();
  }
}

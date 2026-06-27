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
exports.ModelRegistry = void 0;
const vscode = __importStar(require("vscode"));
const vscode_1 = require("vscode");
const js_tiktoken_1 = require("js-tiktoken");
const config_1 = require("./config");
const modelFetcher_1 = require("./modelFetcher");
const chatHandler_1 = require("./chatHandler");
const statusBar_1 = require("./statusBar");
/**
 * Returns a formatted timestamp string for logging.
 */
function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
/**
 * Manages the registration and lifecycle of custom LLM models in VS Code.
 * Implements the LanguageModelChatProvider interface.
 */
class ModelRegistry {
    constructor(outputChannel, statusBar) {
        this.registeredModels = new Map();
        // Encoding used for token counting (defaulting to cl100k_base used by GPT-4)
        this.encoding = (0, js_tiktoken_1.getEncoding)('cl100k_base');
        // Fired when the model list changes so the provider can notify VSCode
        this._onDidChange = new vscode_1.EventEmitter();
        this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
        this.outputChannel = outputChannel;
        this.statusBar = statusBar;
    }
    /**
     * Initializes the registry by registering the provider and fetching initial models.
     */
    async initialize() {
        // Register the single vendor provider once
        this.providerDisposable = vscode.lm.registerLanguageModelChatProvider('custom-llm', this.buildProvider());
        await this.refreshModels();
        this.scheduleAutoRefresh();
    }
    /**
     * Builds the LanguageModelChatProvider object for VS Code.
     */
    buildProvider() {
        const self = this;
        return {
            onDidChangeLanguageModelChatInformation: self._onDidChange.event,
            provideLanguageModelChatInformation(_options, _token) {
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
            async provideLanguageModelChatResponse(model, messages, options, progress, token) {
                const registered = self.registeredModels.get(model.id);
                if (!registered) {
                    throw vscode.LanguageModelError.NotFound(`Model ${model.id} not found`);
                }
                const handler = new chatHandler_1.ChatHandler(registered.chatEndpoint, registered.apiKey, registered.capabilities, self.outputChannel);
                for await (const part of handler.sendRequest(messages, options.tools ?? [], registered.originalId, token)) {
                    progress.report(part);
                }
            },
            /**
             * Provides an accurate token count using the js-tiktoken library.
             */
            provideTokenCount(_model, text, _token) {
                let content = '';
                if (typeof text === 'string') {
                    content = text;
                }
                else {
                    content = text.content
                        .filter((p) => p instanceof vscode.LanguageModelTextPart)
                        .map((p) => p.value)
                        .join('');
                }
                try {
                    const tokens = self.encoding.encode(content);
                    return Promise.resolve(tokens.length);
                }
                catch (e) {
                    // Fallback to simple estimation if encoding fails
                    return Promise.resolve(Math.ceil(content.length / 4));
                }
            },
        };
    }
    /**
     * Helper to filter model IDs against include and exclude pattern arrays.
     */
    filterModelIds(allIds, include, exclude) {
        function matches(id, pattern) {
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
    async refreshModels() {
        if (!config_1.ConfigManager.enabled) {
            this.registeredModels.clear();
            this._onDidChange.fire();
            this.statusBar.update(statusBar_1.ProviderStatus.Disabled);
            this.outputChannel.appendLine(`[${timestamp()}] Provider disabled — no models registered.`);
            return;
        }
        this.statusBar.update(statusBar_1.ProviderStatus.Fetching);
        this.registeredModels.clear();
        // 1. Fetch from primary endpoint
        this.outputChannel.appendLine(`[${timestamp()}] Refreshing primary models from ${config_1.ConfigManager.modelsEndpoint}...`);
        let primaryFetched = [];
        try {
            primaryFetched = await (0, modelFetcher_1.fetchModelsFromEndpoint)(config_1.ConfigManager.modelsEndpoint, config_1.ConfigManager.apiKey, config_1.ConfigManager.retryConfig, config_1.ConfigManager.proxyUrl);
            this.outputChannel.appendLine(`[${timestamp()}] Primary endpoint fetched ${primaryFetched.length} model(s): ${primaryFetched.map(m => m.id).join(', ')}`);
        }
        catch (err) {
            this.outputChannel.appendLine(`[${timestamp()}] WARNING: Primary endpoint fetch failed: ${err}`);
            vscode.window.showWarningMessage(`Custom LLM Provider (Primary): Could not fetch models — ${err}`);
        }
        const primaryFetchedIds = primaryFetched.map(m => m.id);
        const primaryAllIds = Array.from(new Set([...primaryFetchedIds, ...config_1.ConfigManager.additionalModels]));
        const primaryFilteredIds = this.filterModelIds(primaryAllIds, config_1.ConfigManager.includeModels, config_1.ConfigManager.excludeModels);
        for (const modelId of primaryFilteredIds) {
            const source = primaryFetchedIds.includes(modelId) ? 'fetched' : 'additional';
            const fetchedMeta = primaryFetched.find(m => m.id === modelId);
            const capabilities = this.resolveCapabilities(modelId, config_1.ConfigManager.modelOverrides, fetchedMeta);
            this.registeredModels.set(modelId, {
                id: modelId,
                originalId: modelId,
                capabilities,
                source,
                chatEndpoint: config_1.ConfigManager.chatEndpoint,
                apiKey: config_1.ConfigManager.apiKey
            });
            this.outputChannel.appendLine(`[${timestamp()}]   + [Primary] ${modelId} (${source}) ctx:${capabilities.maxInputTokens}/` +
                `${capabilities.maxOutputTokens} tools:${capabilities.toolCalling} vision:${capabilities.vision}`);
        }
        // 2. Fetch from additional endpoints
        const additionalEndpoints = config_1.ConfigManager.additionalEndpoints;
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
            let fetched = [];
            try {
                fetched = await (0, modelFetcher_1.fetchModelsFromEndpoint)(modelsUrl, apiKey, config_1.ConfigManager.retryConfig, config_1.ConfigManager.proxyUrl);
                this.outputChannel.appendLine(`[${timestamp()}] Endpoint '${prefix}' fetched ${fetched.length} model(s): ${fetched.map(m => m.id).join(', ')}`);
            }
            catch (err) {
                this.outputChannel.appendLine(`[${timestamp()}] WARNING: Endpoint '${prefix}' fetch failed: ${err}`);
                vscode.window.showWarningMessage(`Custom LLM Provider (${prefix}): Could not fetch models — ${err}`);
            }
            const fetchedIds = fetched.map(m => m.id);
            const allIds = Array.from(new Set([...fetchedIds, ...additionalModels]));
            const filteredIds = this.filterModelIds(allIds, includeModels, excludeModels);
            for (const modelId of filteredIds) {
                const source = fetchedIds.includes(modelId) ? 'fetched' : 'additional';
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
                this.outputChannel.appendLine(`[${timestamp()}]   + [${prefix}] ${registeredId} (${source}) ctx:${capabilities.maxInputTokens}/` +
                    `${capabilities.maxOutputTokens} tools:${capabilities.toolCalling} vision:${capabilities.vision}`);
            }
        }
        // 3. Register model aliases
        const aliases = config_1.ConfigManager.modelAliases;
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
            }
            else {
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
            this.statusBar.update(statusBar_1.ProviderStatus.Error);
            vscode.window.showWarningMessage('Custom LLM Provider: No models found. Check endpoint or settings.');
            this._onDidChange.fire();
            return;
        }
        // Notify VSCode that the model list changed
        this._onDidChange.fire();
        this.statusBar.update(statusBar_1.ProviderStatus.Ready, this.registeredModels.size);
        vscode.window.showInformationMessage(`Custom LLM Provider: ${this.registeredModels.size} model(s) registered.`);
        this.outputChannel.appendLine(`[${timestamp()}] Done — ${this.registeredModels.size} model(s) registered.`);
    }
    /**
     * Resolves capabilities for a model by merging:
     * 1. User Overrides (highest priority)
     * 2. API Metadata (if available)
     * 3. Global Fallback Config
     */
    resolveCapabilities(modelId, overrides, apiMeta) {
        const globalFallback = config_1.ConfigManager.modelFallbackConfigs;
        const userOverride = overrides[modelId] ?? {};
        // Extract capabilities from API metadata if present
        const apiCapabilities = {};
        if (apiMeta) {
            if (apiMeta.max_input_tokens) {
                apiCapabilities.maxInputTokens = apiMeta.max_input_tokens;
            }
            else if (apiMeta.context_length) {
                apiCapabilities.maxInputTokens = apiMeta.context_length;
            }
            if (apiMeta.max_output_tokens) {
                apiCapabilities.maxOutputTokens = apiMeta.max_output_tokens;
            }
            if (apiMeta.capabilities) {
                if (apiMeta.capabilities.vision !== undefined) {
                    apiCapabilities.vision = apiMeta.capabilities.vision;
                }
                if (apiMeta.capabilities.tool_calling !== undefined) {
                    apiCapabilities.toolCalling = apiMeta.capabilities.tool_calling;
                }
                if (apiMeta.capabilities.reasoning !== undefined) {
                    apiCapabilities.reasoning = apiMeta.capabilities.reasoning;
                }
                if (apiMeta.capabilities.thinking !== undefined) {
                    apiCapabilities.thinking = apiMeta.capabilities.thinking;
                }
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
    scheduleAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        const minutes = config_1.ConfigManager.autoRefreshInterval;
        if (minutes > 0) {
            this.refreshTimer = setInterval(() => {
                this.refreshModels().catch((e) => this.outputChannel.appendLine(`[${timestamp()}] Auto-refresh error: ${e}`));
            }, minutes * 60000);
            this.outputChannel.appendLine(`[${timestamp()}] Auto-refresh scheduled every ${minutes} min.`);
        }
        else {
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
    dispose() {
        this.providerDisposable?.dispose();
        this._onDidChange.dispose();
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.registeredModels.clear();
    }
}
exports.ModelRegistry = ModelRegistry;

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
                const handler = new chatHandler_1.ChatHandler(config_1.ConfigManager.chatEndpoint, config_1.ConfigManager.apiKey, registered.capabilities);
                for await (const part of handler.sendRequest(messages, options.tools ?? [], model.id, token)) {
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
     * Refreshes the list of models from the remote endpoint and additional configuration.
     */
    async refreshModels() {
        this.outputChannel.appendLine(`[${timestamp()}] Refreshing models from ${config_1.ConfigManager.modelsEndpoint}...`);
        this.statusBar.update(statusBar_1.ProviderStatus.Fetching);
        let fetchedModels = [];
        try {
            fetchedModels = await (0, modelFetcher_1.fetchModelsFromEndpoint)(config_1.ConfigManager.modelsEndpoint, config_1.ConfigManager.apiKey);
            this.outputChannel.appendLine(`[${timestamp()}] Fetched ${fetchedModels.length} model(s): ${fetchedModels.map(m => m.id).join(', ')}`);
        }
        catch (err) {
            this.outputChannel.appendLine(`[${timestamp()}] WARNING: ${err}`);
            this.statusBar.update(statusBar_1.ProviderStatus.Error);
            const retryAction = 'Retry';
            const settingsAction = 'Open Settings';
            vscode.window.showWarningMessage(`Custom LLM Provider: Could not fetch models — ${err}`, retryAction, settingsAction).then(selection => {
                if (selection === retryAction) {
                    this.refreshModels();
                }
                else if (selection === settingsAction) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'customLlmProvider');
                }
            });
            // We continue with additionalModels only if any
        }
        const fetchedIds = fetchedModels.map(m => m.id);
        const additionalIds = config_1.ConfigManager.additionalModels;
        let allIds = Array.from(new Set([...fetchedIds, ...additionalIds]));
        // --- Filtering Logic ---
        const include = config_1.ConfigManager.includeModels;
        const exclude = config_1.ConfigManager.excludeModels;
        function matches(id, pattern) {
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.split('*').map(s => s.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('.*') + '$');
                return regex.test(id);
            }
            return id === pattern;
        }
        if (include.length > 0) {
            allIds = allIds.filter(id => include.some(pat => matches(id, pat)));
        }
        if (exclude.length > 0) {
            allIds = allIds.filter(id => !exclude.some(pat => matches(id, pat)));
        }
        // -----------------------
        if (allIds.length === 0) {
            this.outputChannel.appendLine(`[${timestamp()}] No models to register.`);
            this.statusBar.update(statusBar_1.ProviderStatus.Error);
            const addModelsAction = 'Add Models';
            vscode.window.showWarningMessage('Custom LLM Provider: No models found. Check endpoint or add to additionalModels config.', addModelsAction).then(selection => {
                if (selection === addModelsAction) {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'customLlmProvider.additionalModels');
                }
            });
            this.registeredModels.clear();
            this._onDidChange.fire();
            return;
        }
        this.registeredModels.clear();
        for (const modelId of allIds) {
            const source = fetchedIds.includes(modelId) ? 'fetched' : 'additional';
            const fetchedMeta = fetchedModels.find(m => m.id === modelId);
            const capabilities = this.resolveCapabilities(modelId, fetchedMeta);
            this.registeredModels.set(modelId, { id: modelId, capabilities, source });
            this.outputChannel.appendLine(`[${timestamp()}]   + ${modelId} (${source}) ctx:${capabilities.maxInputTokens}/` +
                `${capabilities.maxOutputTokens} tools:${capabilities.toolCalling} vision:${capabilities.vision}`);
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
    resolveCapabilities(modelId, apiMeta) {
        const globalFallback = config_1.ConfigManager.modelFallbackConfigs;
        const userOverride = config_1.ConfigManager.modelOverrides[modelId] ?? {};
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
        return {
            ...globalFallback,
            ...apiCapabilities,
            ...userOverride
        };
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

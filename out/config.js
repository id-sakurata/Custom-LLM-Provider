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
exports.ConfigManager = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Manages access to extension configuration settings.
 */
class ConfigManager {
    /**
     * Returns the VS Code configuration workspace for this extension.
     */
    static cfg() { return vscode.workspace.getConfiguration(this.S); }
    /**
     * Base URL of the OpenAI-compatible API endpoint.
     */
    static get endpoint() {
        return this.cfg().get('endpoint', 'http://localhost:20128').replace(/\/$/, '');
    }
    /**
     * API Key for authentication.
     */
    static get apiKey() {
        return this.cfg().get('apiKey', '');
    }
    /**
     * Interval in minutes for automatic model refresh.
     */
    static get autoRefreshInterval() {
        return this.cfg().get('autoRefreshInterval', 0);
    }
    /**
     * List of additional model IDs to register.
     */
    static get additionalModels() {
        return this.cfg().get('additionalModels', []);
    }
    static get includeModels() {
        return this.cfg().get('includeModels', []);
    }
    static get excludeModels() {
        return this.cfg().get('excludeModels', []);
    }
    /**
     * Reads each flat property and assembles a ModelCapabilities object.
     */
    static get modelFallbackConfigs() {
        const c = this.cfg();
        return {
            maxInputTokens: c.get('maxInputTokens', 160000),
            maxOutputTokens: c.get('maxOutputTokens', 32000),
            requestDelay: c.get('requestDelay', 1000),
            toolCalling: c.get('toolCalling', true),
            toolFlavor: c.get('toolFlavor', 'openai-tools'),
            vision: c.get('vision', false),
            thinking: c.get('thinking', true),
            reasoning: c.get('reasoning', true),
            reasoningEffort: c.get('reasoningEffort', 'medium'),
        };
    }
    /**
     * Per-model capability overrides.
     */
    static get modelOverrides() {
        return this.cfg().get('modelOverrides', {});
    }
    /**
     * Full URL for fetching the list of models.
     */
    static get modelsEndpoint() { return `${this.endpoint}/v1/models`; }
    /**
     * Full URL for chat completions.
     */
    static get retryConfig() {
        const c = this.cfg();
        return {
            maxRetries: c.get('maxRetries', 3),
            retryDelay: c.get('retryDelay', 1000),
            retryBackoff: c.get('retryBackoff', 'exponential'),
            retryOnStatus: c.get('retryOnStatus', [429, 500, 502, 503, 504]),
        };
    }
    static get chatEndpoint() { return `${this.endpoint}/v1/chat/completions`; }
    /**
     * Additional endpoints configured by the user.
     */
    static get additionalEndpoints() {
        return this.cfg().get('additionalEndpoints', []);
    }
}
exports.ConfigManager = ConfigManager;
ConfigManager.S = 'customLlmProvider';

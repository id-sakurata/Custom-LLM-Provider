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
exports.StatusBarManager = exports.ProviderStatus = void 0;
const vscode = __importStar(require("vscode"));
var ProviderStatus;
(function (ProviderStatus) {
    ProviderStatus["Ready"] = "ready";
    ProviderStatus["Error"] = "error";
    ProviderStatus["Fetching"] = "fetching";
})(ProviderStatus || (exports.ProviderStatus = ProviderStatus = {}));
/**
 * Manages the VS Code Status Bar item for the Custom LLM Provider.
 */
class StatusBarManager {
    constructor() {
        this.lastStatus = ProviderStatus.Fetching;
        this.lastModelCount = 0;
        StatusBarManager.instance = this;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'customLlmProvider.refreshModels';
        this.update(ProviderStatus.Fetching);
        this.statusBarItem.show();
    }
    /**
     * Updates the status bar appearance based on the current provider status.
     * @param status The new status of the provider.
     * @param modelCount Optional number of registered models.
     */
    update(status, modelCount = 0) {
        this.lastStatus = status;
        this.lastModelCount = modelCount;
        switch (status) {
            case ProviderStatus.Ready:
                this.statusBarItem.text = `$(check) Custom LLM: ${modelCount} Models`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = 'Custom LLM Provider is ready and connected.';
                break;
            case ProviderStatus.Error:
                this.statusBarItem.text = `$(error) Custom LLM: Error`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                this.statusBarItem.tooltip = 'Custom LLM Provider failed to fetch models. Click for details.';
                break;
            case ProviderStatus.Fetching:
                this.statusBarItem.text = `$(sync~spin) Custom LLM: Fetching...`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = 'Fetching models from endpoint...';
                break;
        }
    }
    /**
     * Displays a temporary cooldown/delay warning on the status bar.
     * @param remainingMs Remaining milliseconds.
     */
    showCooldown(remainingMs) {
        const seconds = remainingMs / 1000;
        this.statusBarItem.text = `$(watch) Custom LLM: Delay ${seconds.toFixed(1)}s`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.tooltip = `Delaying request to respect cooldown (rate limit).`;
    }
    /**
     * Restores the status bar to its last non-cooldown state.
     */
    restore() {
        this.update(this.lastStatus, this.lastModelCount);
    }
    dispose() {
        if (StatusBarManager.instance === this) {
            StatusBarManager.instance = undefined;
        }
        this.statusBarItem.dispose();
    }
}
exports.StatusBarManager = StatusBarManager;

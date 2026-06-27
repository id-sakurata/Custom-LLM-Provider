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
exports.DashboardProvider = void 0;
const vscode = __importStar(require("vscode"));
const config_1 = require("./config");
/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
/**
 * Provides a visual Dashboard for the Custom LLM Provider using Webview.
 */
class DashboardProvider {
    static createOrShow(extensionUri, registry) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        const panel = vscode.window.createWebviewPanel(DashboardProvider.viewType, 'Custom LLM Dashboard', column || vscode.ViewColumn.One, {
            enableScripts: true,
            localResourceRoots: [extensionUri]
        });
        panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri, registry);
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'refresh') {
                await registry.refreshModels();
                panel.webview.html = DashboardProvider._getHtmlForWebview(panel.webview, extensionUri, registry);
            }
        }, undefined);
    }
    static _getHtmlForWebview(webview, extensionUri, registry) {
        const status = registry.getStatus();
        const modelRows = status.models.map(m => `
            <div class="model-card">
                <div class="model-header">
                    <span class="model-id">${escapeHtml(m.id)}</span>
                    <span class="model-source tag-${m.source}">${m.source.toUpperCase()}</span>
                </div>
                <div class="model-details">
                    <p><strong>Context:</strong> ${m.capabilities.maxInputTokens} in / ${m.capabilities.maxOutputTokens} out</p>
                    <div class="caps">
                        ${m.capabilities.toolCalling ? '<span class="cap-tag">Tools</span>' : ''}
                        ${m.capabilities.vision ? '<span class="cap-tag">Vision</span>' : ''}
                        ${m.capabilities.reasoning ? '<span class="cap-tag">Reasoning</span>' : ''}
                        ${m.capabilities.thinking ? '<span class="cap-tag">Thinking</span>' : ''}
                    </div>
                </div>
            </div>
        `).join('');
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Custom LLM Dashboard</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; color: var(--vscode-foreground); background-color: var(--vscode-editor-background); }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-divider); padding-bottom: 10px; margin-bottom: 20px; }
                    .stats { display: flex; gap: 20px; margin-bottom: 30px; }
                    .stat-item { background: var(--vscode-editor-inactiveSelectionBackground); padding: 15px; border-radius: 8px; flex: 1; text-align: center; }
                    .stat-value { font-size: 24px; font-weight: bold; display: block; }
                    .stat-label { font-size: 12px; opacity: 0.8; }
                    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
                    .model-card { border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 15px; background: var(--vscode-sideBar-background); }
                    .model-header { display: flex; justify-content: space-between; margin-bottom: 10px; }
                    .model-id { font-weight: bold; color: var(--vscode-textLink-foreground); }
                    .model-source { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
                    .tag-fetched { background: var(--vscode-statusBarItem-remoteBackground); color: white; }
                    .tag-additional { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                    .caps { display: flex; gap: 5px; margin-top: 10px; }
                    .cap-tag { font-size: 10px; border: 1px solid var(--vscode-textLink-foreground); padding: 1px 5px; border-radius: 3px; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    .status-badge { font-size: 12px; padding: 4px 10px; border-radius: 10px; font-weight: bold; }
                    .status-badge.enabled { background: var(--vscode-testing-iconPassed); color: white; }
                    .status-badge.disabled { background: var(--vscode-statusBarItem-warningBackground); color: white; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Custom LLM Provider Dashboard</h1>
                    <span class="status-badge ${config_1.ConfigManager.enabled ? 'enabled' : 'disabled'}">${config_1.ConfigManager.enabled ? 'Enabled' : 'Disabled'}</span>
                    <button onclick="refresh()">Refresh Models</button>
                </div>

                <div class="stats">
                    <div class="stat-item">
                        <span class="stat-value">${status.total}</span>
                        <span class="stat-label">Total Models</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${status.fetched}</span>
                        <span class="stat-label">Fetched via API</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${status.additional}</span>
                        <span class="stat-label">Custom Config</span>
                    </div>
                </div>

                <div class="retry-section">
                    <h2>Retry Configuration</h2>
                    <div class="stats">
                        <div class="stat-item">
                            <span class="stat-value">${config_1.ConfigManager.retryConfig.maxRetries}</span>
                            <span class="stat-label">Max Retries</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${config_1.ConfigManager.retryConfig.retryDelay}ms</span>
                            <span class="stat-label">Base Delay</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${config_1.ConfigManager.retryConfig.retryBackoff}</span>
                            <span class="stat-label">Backoff</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">[${config_1.ConfigManager.retryConfig.retryOnStatus.join(', ')}]</span>
                            <span class="stat-label">Retry Status Codes</span>
                        </div>
                    </div>
                </div>

                <div class="grid">
                    ${modelRows}
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    function refresh() {
                        vscode.postMessage({ command: 'refresh' });
                    }
                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'reload') {
                            location.reload();
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}
exports.DashboardProvider = DashboardProvider;
DashboardProvider.viewType = 'customLlmDashboard';

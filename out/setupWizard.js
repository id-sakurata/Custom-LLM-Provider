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
exports.showSetupWizard = showSetupWizard;
const vscode = __importStar(require("vscode"));
/**
 * Provides an interactive Setup Wizard to configure the extension.
 */
async function showSetupWizard() {
    const config = vscode.workspace.getConfiguration('customLlmProvider');
    // Step 1: Endpoint
    const currentEndpoint = config.get('endpoint') || 'http://localhost:20128';
    const endpoint = await vscode.window.showInputBox({
        title: 'Custom LLM: Setup Endpoint',
        prompt: 'Enter the base URL of your OpenAI-compatible API (without /v1)',
        value: currentEndpoint,
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) {
                return 'Endpoint URL is required';
            }
            if (!value.startsWith('http')) {
                return 'Must start with http:// or https://';
            }
            return null;
        }
    });
    if (endpoint === undefined) {
        return;
    } // User cancelled
    // Step 2: API Key
    const currentApiKey = config.get('apiKey') || '';
    const apiKey = await vscode.window.showInputBox({
        title: 'Custom LLM: Setup API Key',
        prompt: 'Enter your API Key (leave empty if not required)',
        value: currentApiKey,
        password: true,
        ignoreFocusOut: true
    });
    if (apiKey === undefined) {
        return;
    } // User cancelled
    // Save configuration
    await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
    const refreshAction = 'Refresh Models Now';
    vscode.window.showInformationMessage('Configuration saved successfully!', refreshAction).then(selection => {
        if (selection === refreshAction) {
            vscode.commands.executeCommand('customLlmProvider.refreshModels');
        }
    });
}

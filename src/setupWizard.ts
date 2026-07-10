import * as vscode from 'vscode';
import { fetchModelsFromEndpoint } from './modelFetcher';
import { ConfigManager } from './config';

/**
 * Provides an interactive Setup Wizard to configure the extension.
 */
export async function showSetupWizard(): Promise<void> {
    const config = vscode.workspace.getConfiguration('customLlmProvider');

    // Step 1: Endpoint
    const currentEndpoint = config.get<string>('endpoint') || 'http://localhost:20128';
    const endpoint = await vscode.window.showInputBox({
        title: 'Custom LLM: Setup Endpoint',
        prompt: 'Enter the base URL of your OpenAI-compatible API (without /v1)',
        value: currentEndpoint,
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) { return 'Endpoint URL is required'; }
            if (!value.startsWith('http')) { return 'Must start with http:// or https://'; }
            return null;
        }
    });

    if (endpoint === undefined) { return; } // User cancelled

    // Step 2: API Key
    const currentApiKey = config.get<string>('apiKey') || '';
    const apiKey = await vscode.window.showInputBox({
        title: 'Custom LLM: Setup API Key',
        prompt: 'Enter your API Key (leave empty if not required)',
        value: currentApiKey,
        password: true,
        ignoreFocusOut: true
    });

    if (apiKey === undefined) { return; } // User cancelled

    // Save initial connection settings so they are configured
    await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

    // Step 3: Ask to enable Inline Completion
    const enableInline = await vscode.window.showQuickPick(
        ['Yes, enable Inline Code Completion', 'No, keep it disabled'],
        {
            title: 'Custom LLM: Setup Inline Completion',
            placeHolder: 'Do you want to enable auto-complete (ghost text) using your provider?',
            ignoreFocusOut: true
        }
    );

    if (enableInline === undefined) { return; }

    if (enableInline === 'Yes, enable Inline Code Completion') {
        let modelOptions: string[] = [];
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching available models for inline completion...",
            cancellable: false
        }, async () => {
            try {
                const modelsUrl = `${endpoint.replace(/\/$/, '')}/v1/models`;
                const fetched = await fetchModelsFromEndpoint(modelsUrl, apiKey, ConfigManager.retryConfig);
                modelOptions = fetched.map(m => m.id);
            } catch (e) {
                // Ignore, will allow manual entry
            }
        });

        const askManualModel = async (): Promise<string> => {
            return await vscode.window.showInputBox({
                title: 'Custom LLM: Enter Model ID',
                prompt: 'Type the exact model ID to use for inline completions',
                ignoreFocusOut: true,
                validateInput: (v) => !v ? 'Model ID cannot be empty' : null
            }) || '';
        };

        let selectedModel = '';
        if (modelOptions.length > 0) {
            const selectOptions = [...modelOptions, '$(pencil) Enter model ID manually...'];
            const pick = await vscode.window.showQuickPick(selectOptions, {
                title: 'Custom LLM: Select Inline Completion Model',
                placeHolder: 'Choose which model to use for inline completion',
                ignoreFocusOut: true
            });
            if (pick === undefined) { return; }
            if (pick === '$(pencil) Enter model ID manually...') {
                selectedModel = await askManualModel();
            } else {
                selectedModel = pick;
            }
        } else {
            vscode.window.showWarningMessage('Could not fetch models automatically. Please enter your model ID manually.');
            selectedModel = await askManualModel();
        }

        if (!selectedModel) { return; }

        // Select mode
        const modePick = await vscode.window.showQuickPick(
            [
                { label: 'chat-fim', description: 'Recommended - Instruct FIM via /v1/chat/completions (Works with any chat/instruct model)' },
                { label: 'completions-fim', description: 'Raw FIM formatting via /v1/completions (Requires Qwen-Coder, DeepSeek-Coder, etc.)' },
                { label: 'forward-only', description: 'Standard text continuation via /v1/chat/completions' }
            ],
            {
                title: 'Custom LLM: Select Completion Mode',
                placeHolder: 'Choose completion formatting mode',
                ignoreFocusOut: true
            }
        );

        if (modePick === undefined) { return; }

        // Update settings
        await config.update('inlineCompletion.enabled', true, vscode.ConfigurationTarget.Global);
        await config.update('inlineCompletion.model', selectedModel, vscode.ConfigurationTarget.Global);
        await config.update('inlineCompletion.mode', modePick.label, vscode.ConfigurationTarget.Global);
    } else {
        await config.update('inlineCompletion.enabled', false, vscode.ConfigurationTarget.Global);
    }

    const refreshAction = 'Refresh Models Now';
    vscode.window.showInformationMessage(
        'Configuration saved successfully!',
        refreshAction
    ).then(selection => {
        if (selection === refreshAction) {
            vscode.commands.executeCommand('customLlmProvider.refreshModels');
        }
    });
}

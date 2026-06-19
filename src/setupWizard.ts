import * as vscode from 'vscode';

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

    // Save configuration
    await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

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

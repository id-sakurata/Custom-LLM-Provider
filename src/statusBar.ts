import * as vscode from 'vscode';

export enum ProviderStatus {
    Ready = 'ready',
    Error = 'error',
    Fetching = 'fetching'
}

/**
 * Manages the VS Code Status Bar item for the Custom LLM Provider.
 */
export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'customLlmProvider.showStatus';
        this.update(ProviderStatus.Fetching);
        this.statusBarItem.show();
    }

    /**
     * Updates the status bar appearance based on the current provider status.
     * @param status The new status of the provider.
     * @param modelCount Optional number of registered models.
     */
    public update(status: ProviderStatus, modelCount: number = 0): void {
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

    dispose(): void {
        this.statusBarItem.dispose();
    }
}

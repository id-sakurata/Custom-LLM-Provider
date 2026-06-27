import * as vscode from 'vscode';

export enum ProviderStatus {
    Ready = 'ready',
    Error = 'error',
    Fetching = 'fetching',
    Disabled = 'disabled'
}

/**
 * Manages the VS Code Status Bar item for the Custom LLM Provider.
 */
export class StatusBarManager implements vscode.Disposable {
    public static instance: StatusBarManager | undefined;
    private statusBarItem: vscode.StatusBarItem;
    private lastStatus: ProviderStatus = ProviderStatus.Fetching;
    private lastModelCount: number = 0;

    constructor() {
        StatusBarManager.instance = this;
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'customLlmProvider.refreshModels';
        this.update(ProviderStatus.Fetching);
        this.statusBarItem.show();
    }

    /**
     * Updates the status bar appearance based on the current provider status.
     * @param status The new status of the provider.
     * @param modelCount Optional number of registered models.
     */
    public update(status: ProviderStatus, modelCount: number = 0): void {
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
            case ProviderStatus.Disabled:
                this.statusBarItem.text = `$(circle-slash) Custom LLM: Disabled`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.statusBarItem.tooltip = 'Custom LLM Provider is disabled. Enable it in settings.';
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
    public showCooldown(remainingMs: number): void {
        const seconds = remainingMs / 1000;
        this.statusBarItem.text = `$(watch) Custom LLM: Delay ${seconds.toFixed(1)}s`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.tooltip = `Delaying request to respect cooldown (rate limit).`;
    }

    /**
     * Restores the status bar to its last non-cooldown state.
     */
    public restore(): void {
        this.update(this.lastStatus, this.lastModelCount);
    }

    dispose(): void {
        if (StatusBarManager.instance === this) {
            StatusBarManager.instance = undefined;
        }
        this.statusBarItem.dispose();
    }
}

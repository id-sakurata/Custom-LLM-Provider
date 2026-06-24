import * as vscode from 'vscode';
import { ModelRegistry } from './modelRegistry';
import { StatusBarManager } from './statusBar';
import { showSetupWizard } from './setupWizard';
import { DashboardProvider } from './dashboardProvider';

/**
 * Global reference to the model registry, output channel, and status bar.
 */
let registry: ModelRegistry | undefined;
let outputChannel: vscode.OutputChannel;
let statusBar: StatusBarManager;

/**
 * Called when the extension is activated.
 * @param context The extension context provided by VS Code.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    // 1. Create Output Channel immediately
    outputChannel = vscode.window.createOutputChannel('Custom LLM Provider');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('Custom LLM Provider activating...');

    // 2. Instantiate Status Bar
    statusBar = new StatusBarManager();
    context.subscriptions.push(statusBar);

    // 3. Instantiate Registry
    registry = new ModelRegistry(outputChannel, statusBar);
    context.subscriptions.push(registry);

    // 4. Register commands IMMEDIATELY
    context.subscriptions.push(
      vscode.commands.registerCommand('customLlmProvider.refreshModels', async () => {
        outputChannel.show(true);
        if (registry) {
          await registry.refreshModels();
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('customLlmProvider.showStatus', async () => {
        if (!registry) {
          vscode.window.showInformationMessage('Custom LLM Provider is not active.');
          return;
        }
        
        const status = registry.getStatus();
        const items: vscode.QuickPickItem[] = status.models.map(m => ({
          label: `$(symbol-method) ${m.id}`,
          description: `[${m.source.toUpperCase()}]`,
          detail: `Context: ${m.capabilities.maxInputTokens} in / ${m.capabilities.maxOutputTokens} out • ` +
                  `Tools: ${m.capabilities.toolCalling ? '✅' : '❌'} • ` +
                  `Vision: ${m.capabilities.vision ? '✅' : '❌'} • ` +
                  `Reasoning: ${m.capabilities.reasoning ? '✅' : '❌'}`,
          alwaysShow: true
        }));

        if (items.length === 0) {
          vscode.window.showInformationMessage('No models registered yet.');
          return;
        }

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: `Custom LLM Provider Status: ${status.total} models registered`,
          title: 'Registered Models Information'
        });

        const logLines = [
          `Total registered: ${status.total}`,
          `  Fetched from endpoint: ${status.fetched}`,
          `  From additionalModels: ${status.additional}`,
          '',
          'Models:',
          ...status.models.map(m => `  • ${m.id} [${m.source}]`)
        ];
        outputChannel.appendLine('\n=== Status Checked ===\n' + logLines.join('\n') + '\n');

        if (selected) {
          outputChannel.show(true);
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('customLlmProvider.setupWizard', async () => {
        await showSetupWizard();
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('customLlmProvider.openDashboard', () => {
        if (registry) {
          DashboardProvider.createOrShow(context.extensionUri, registry);
        }
      })
    );

    // 5. Register config change listener
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        const affected = [
          'customLlmProvider.endpoint',
          'customLlmProvider.apiKey',
          'customLlmProvider.additionalModels',
          'customLlmProvider.includeModels',
          'customLlmProvider.excludeModels',
          'customLlmProvider.maxInputTokens',
          'customLlmProvider.maxOutputTokens',
          'customLlmProvider.requestDelay',
          'customLlmProvider.toolCalling',
          'customLlmProvider.toolFlavor',
          'customLlmProvider.vision',
          'customLlmProvider.thinking',
          'customLlmProvider.reasoning',
          'customLlmProvider.reasoningEffort',
          'customLlmProvider.modelOverrides',
          'customLlmProvider.autoRefreshInterval',
          'customLlmProvider.maxRetries',
          'customLlmProvider.retryDelay',
          'customLlmProvider.retryBackoff',
          'customLlmProvider.retryOnStatus',
        ].some((key) => e.affectsConfiguration(key));

        if (affected) {
          outputChannel.appendLine('Configuration changed — re-registering models...');
          await registry?.refreshModels();
          if (e.affectsConfiguration('customLlmProvider.autoRefreshInterval')) {
            registry?.scheduleAutoRefresh();
          }
        }
      })
    );

    // 6. Initialize Registry (fetch models)
    await registry.initialize();

    // 7. Check if we should show Setup Wizard
    const config = vscode.workspace.getConfiguration('customLlmProvider');
    const endpoint = config.get<string>('endpoint');
    if (!endpoint || endpoint === 'http://localhost:20128') {
        const setupAction = 'Open Setup Wizard';
        vscode.window.showInformationMessage(
            'Custom LLM Provider: Endpoint is not configured or using default.',
            setupAction
        ).then(selection => {
            if (selection === setupAction) {
                vscode.commands.executeCommand('customLlmProvider.setupWizard');
            }
        });
    }

    outputChannel.appendLine('Custom LLM Provider activated successfully.');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to activate Custom LLM Provider: ${errorMsg}`);
    if (outputChannel) {
      outputChannel.appendLine(`Fatal Activation Error: ${errorMsg}`);
    }
  }
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate(): void {
  outputChannel?.appendLine('Custom LLM Provider deactivated.');
}

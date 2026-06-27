import * as vscode from 'vscode';
import { ModelCapabilities, ToolFlavor, RetryConfig, AdditionalEndpointConfig } from './types';

/**
 * Manages access to extension configuration settings.
 */
export class ConfigManager {
  private static readonly S = 'customLlmProvider';
  
  /**
   * Returns the VS Code configuration workspace for this extension.
   */
  private static cfg() { return vscode.workspace.getConfiguration(this.S); }

  /**
   * Base URL of the OpenAI-compatible API endpoint.
   */
  static get enabled(): boolean {
    return this.cfg().get<boolean>('enabled', true);
  }

  static get endpoint(): string {
    return this.cfg().get<string>('endpoint', 'http://localhost:20128').replace(/\/$/, '');
  }

  /**
   * API Key for authentication.
   */
  static get apiKey(): string {
    return this.cfg().get<string>('apiKey', '');
  }

  /**
   * Interval in minutes for automatic model refresh.
   */
  static get autoRefreshInterval(): number {
    return this.cfg().get<number>('autoRefreshInterval', 0);
  }

  /**
   * List of additional model IDs to register.
   */
  static get additionalModels(): string[] {
    return this.cfg().get<string[]>('additionalModels', []);
  }

  static get includeModels(): string[] {
    return this.cfg().get<string[]>('includeModels', []);
  }

  static get excludeModels(): string[] {
    return this.cfg().get<string[]>('excludeModels', []);
  }

  /**
   * Reads each flat property and assembles a ModelCapabilities object.
   */
  static get modelFallbackConfigs(): ModelCapabilities {
    const c = this.cfg();
    return {
      maxInputTokens:  c.get<number>('maxInputTokens',  160000),
      maxOutputTokens: c.get<number>('maxOutputTokens', 32000),
      requestDelay:    c.get<number>('requestDelay',       1000),
      temperature:     c.get<number>('defaultTemperature', 1.0),
      topP:            c.get<number>('defaultTopP',        1.0),
      toolCalling:     c.get<boolean>('toolCalling',    true),
      toolFlavor:      c.get<ToolFlavor>('toolFlavor',  'openai-tools'),
      vision:          c.get<boolean>('vision',         false),
      thinking:        c.get<boolean>('thinking',       true),
      reasoning:       c.get<boolean>('reasoning',      true),
      reasoningEffort: c.get<'low'|'medium'|'high'>('reasoningEffort', 'medium'),
    };
  }

  /**
   * Per-model capability overrides.
   */
  static get modelOverrides(): Record<string, Partial<ModelCapabilities>> {
    return this.cfg().get<Record<string, Partial<ModelCapabilities>>>('modelOverrides', {});
  }

  /**
   * Full URL for fetching the list of models.
   */
  static get modelsEndpoint(): string { return `${this.endpoint}/v1/models`; }
  
  /**
   * Full URL for chat completions.
   */
  static get retryConfig(): RetryConfig {
    const c = this.cfg();
    return {
      maxRetries:    c.get<number>('maxRetries',    3),
      retryDelay:    c.get<number>('retryDelay',    1000),
      retryBackoff:  c.get<'fixed'|'linear'|'exponential'>('retryBackoff', 'exponential'),
      retryOnStatus: c.get<number[]>('retryOnStatus', [429, 500, 502, 503, 504]),
    };
  }

  static get chatEndpoint(): string   { return `${this.endpoint}/v1/chat/completions`; }

  /**
   * Additional endpoints configured by the user.
   */
  static get streamTimeout(): number {
    return this.cfg().get<number>('streamTimeout', 120000);
  }

  static get modelAliases(): Record<string, string> {
    return this.cfg().get<Record<string, string>>('modelAliases', {});
  }

  static get proxyUrl(): string {
    return this.cfg().get<string>('proxyUrl', '');
  }

  static get additionalEndpoints(): AdditionalEndpointConfig[] {
    return this.cfg().get<AdditionalEndpointConfig[]>('additionalEndpoints', []);
  }
}

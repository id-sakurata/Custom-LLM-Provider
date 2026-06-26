export type ToolFlavor = 'openai-tools' | 'openai-functions' | 'text-based';

export interface ModelCapabilities {
  maxInputTokens: number;
  maxOutputTokens: number;
  requestDelay: number;
  toolCalling: boolean;
  toolFlavor: ToolFlavor;
  vision: boolean;
  thinking: boolean;
  reasoning: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
}

export interface FetchedModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
  capabilities?: {
    vision?: boolean;
    tool_calling?: boolean;
    reasoning?: boolean;
    thinking?: boolean;
  };
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

export interface ModelsResponse {
  object: string;
  data: FetchedModel[];
}

export interface RetryConfig {
  maxRetries: number;
  retryDelay: number;
  retryBackoff: 'fixed' | 'linear' | 'exponential';
  retryOnStatus: number[];
}

export interface AdditionalEndpointConfig {
  id: string;
  url: string;
  apiKey?: string;
  includeModels?: string[];
  excludeModels?: string[];
  additionalModels?: string[];
  additional_models?: string[]; // fallback for snake_case
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
  models_overrides?: Record<string, Partial<ModelCapabilities>>; // fallback for snake_case
}

export interface RegisteredModel {
  id: string; // The registered ID in VS Code (possibly with prefix)
  originalId: string; // The raw ID to send to the provider
  capabilities: ModelCapabilities;
  source: 'fetched' | 'additional';
  chatEndpoint: string;
  apiKey: string;
}


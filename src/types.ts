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

export interface RegisteredModel {
  id: string;
  capabilities: ModelCapabilities;
  source: 'fetched' | 'additional';
}

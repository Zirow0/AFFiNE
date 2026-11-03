/**
 * Types shared between the Electron main process and the renderer for the
 * server-less ("local") AI backend. The renderer talks to an
 * OpenAI-compatible endpoint through the main process so that requests are
 * not subject to browser CORS rules and API keys never leave the device.
 */

export type LocalAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type LocalAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type LocalAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LocalAiContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: LocalAiToolCall[];
    }
  | { role: 'tool'; content: string; tool_call_id: string };

export type LocalAiToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type LocalAiEndpoint = {
  /** Base URL of an OpenAI-compatible API, e.g. `http://localhost:11434/v1` */
  baseUrl: string;
  apiKey?: string;
};

export type LocalAiChatRequest = LocalAiEndpoint & {
  model: string;
  messages: LocalAiMessage[];
  tools?: LocalAiToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** ask the model to answer with a JSON object */
  jsonMode?: boolean;
};

export type LocalAiImageRequest = LocalAiEndpoint & {
  model: string;
  prompt: string;
  size?: string;
};

export type LocalAiEmbeddingRequest = LocalAiEndpoint & {
  model: string;
  input: string[];
};

/** Events emitted from the main process for a running chat stream. */
export type LocalAiStreamEvent =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'reasoning'; textDelta: string }
  | { type: 'tool-calls'; toolCalls: LocalAiToolCall[] }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string; status?: number };

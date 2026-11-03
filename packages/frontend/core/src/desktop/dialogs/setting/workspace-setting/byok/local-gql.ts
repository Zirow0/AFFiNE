import { apis } from '@affine/electron-api';

import type { GqlFn } from './types';

/**
 * GraphQL stand-in for the AI provider settings of local workspaces in the
 * desktop app. There is no server to verify keys, so connection probes are
 * sent straight to the provider from this device.
 */

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

type ProbeInput = {
  provider: string;
  credential?: string | null;
  definition: {
    endpoint: { kind: string; url?: string | null };
    models: { modelId: string }[];
  };
  checks: { modelId: string; operation: string }[];
};

async function runCheck(
  endpoint: { baseUrl: string; apiKey?: string },
  modelId: string,
  operation: string
) {
  const localAi = apis?.localAi;
  if (!localAi)
    throw new Error('Local AI is only available in the desktop app');
  switch (operation) {
    case 'chat':
      await localAi.complete({
        ...endpoint,
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 8,
      });
      return;
    case 'structured':
      await localAi.complete({
        ...endpoint,
        model: modelId,
        jsonMode: true,
        messages: [
          {
            role: 'user',
            content:
              'Reply with the JSON object {"ok": true} and nothing else.',
          },
        ],
        maxTokens: 16,
      });
      return;
    case 'tool_calling':
      // accepted tool definitions are enough: small models may decide not to
      // call a tool for a trivial prompt
      await localAi.complete({
        ...endpoint,
        model: modelId,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ping',
              description: 'Connectivity check',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        maxTokens: 32,
      });
      return;
    case 'embedding':
      await localAi.embed({ ...endpoint, model: modelId, input: ['ok'] });
      return;
    case 'image':
      await localAi.generateImage({
        ...endpoint,
        model: modelId,
        prompt: 'a small blue square',
        size: '256x256',
      });
      return;
    default:
      throw new Error(`"${operation}" is not supported by local providers`);
  }
}

async function probeDraft(input: ProbeInput) {
  const baseUrl =
    input.definition.endpoint.kind === 'openai_compatible' &&
    input.definition.endpoint.url
      ? input.definition.endpoint.url
      : DEFAULT_BASE_URLS[input.provider];
  if (!baseUrl) {
    throw new Error(`${input.provider} is not supported for local AI`);
  }
  const endpoint = { baseUrl, apiKey: input.credential || undefined };
  const byModel = new Map<
    string,
    { operation: string; status: { kind: string; message?: string } }[]
  >();
  let anyVerified = false;
  let lastError = '';
  for (const check of input.checks) {
    let status: { kind: string; message?: string };
    try {
      await runCheck(endpoint, check.modelId, check.operation);
      status = { kind: 'verified' };
      anyVerified = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      status = { kind: 'failed', message: lastError };
    }
    const list = byModel.get(check.modelId) ?? [];
    list.push({ operation: check.operation, status });
    byModel.set(check.modelId, list);
  }
  if (lastError && !anyVerified) {
    console.warn('[local-ai] provider check failed:', lastError);
  }
  return {
    probeWorkspaceByokDraft: {
      connection: anyVerified
        ? { kind: 'verified' }
        : { kind: 'failed', message: lastError },
      models: [...byModel.entries()].map(([modelId, checks]) => ({
        modelId,
        checks,
      })),
    },
  };
}

export const localByokGql: GqlFn = (async (options: {
  query: { op: string };
  variables?: Record<string, any>;
}) => {
  switch (options.query.op) {
    case 'probeWorkspaceByokDraft':
      return probeDraft(options.variables?.input as ProbeInput);
    default:
      throw new Error(`${options.query.op} is not available offline`);
  }
}) as unknown as GqlFn;

export const LOCAL_BASE_URL_HINT = 'http://localhost:11434/v1';

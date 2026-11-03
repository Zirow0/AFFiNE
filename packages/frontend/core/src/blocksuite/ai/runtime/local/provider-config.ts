import { apis } from '@affine/electron-api';

/**
 * Resolves which endpoint and model the local (server-less) AI backend should
 * use for a given task, based on the provider keys stored on this device by
 * the desktop app (Workspace settings → Integrations → AI providers).
 */

export type LocalAiNeed =
  | 'chat'
  | 'tools'
  | 'vision'
  | 'structured'
  | 'image'
  | 'embedding';

export type ResolvedLocalModel = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  providerName: string;
};

type StoredCapability = {
  input: string[];
  output: string[];
  features: string[];
};

type StoredKey = Awaited<
  ReturnType<
    NonNullable<typeof apis>['byokStorage']['getWorkspaceLeaseProviders']
  >
>[number];

const DEFAULT_BASE_URLS: Record<string, string | undefined> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

export class LocalAiNotConfiguredError extends Error {
  constructor(need: LocalAiNeed) {
    super(
      need === 'chat'
        ? 'No local AI provider is configured. Add one in Workspace settings → Integrations → AI providers.'
        : `No configured local AI model supports "${need}". Enable it for a model in Workspace settings → Integrations → AI providers.`
    );
    this.name = 'LocalAiNotConfiguredError';
  }
}

function capabilityMatches(capability: StoredCapability, need: LocalAiNeed) {
  switch (need) {
    case 'chat':
      return capability.output.includes('text');
    case 'tools':
      return (
        capability.output.includes('text') &&
        capability.features.includes('tool_calling')
      );
    case 'vision':
      return (
        capability.output.includes('text') && capability.input.includes('image')
      );
    case 'structured':
      return (
        capability.output.includes('structured') ||
        capability.output.includes('object')
      );
    case 'image':
      return capability.output.includes('image');
    case 'embedding':
      return capability.output.includes('embedding');
  }
}

function baseUrlOf(key: StoredKey) {
  const endpoint = key.definition.endpoint;
  if (endpoint.kind === 'openai_compatible' && endpoint.url) {
    return endpoint.url;
  }
  return DEFAULT_BASE_URLS[key.provider];
}

export async function listLocalAiKeys(workspaceId: string) {
  const storage = apis?.byokStorage;
  if (!storage || !(await storage.isSupported())) return [];
  const keys = await storage.getWorkspaceLeaseProviders(workspaceId);
  return keys
    .filter(key => key.enabled !== false && !!baseUrlOf(key))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

/**
 * Picks the first enabled model (keys in list order, models top to bottom)
 * that satisfies every requested need. `preferred` narrows the choice to a
 * model id selected by the user, when it is suitable.
 */
export async function resolveLocalModel(
  workspaceId: string,
  needs: LocalAiNeed[],
  preferred?: string
): Promise<ResolvedLocalModel> {
  const keys = await listLocalAiKeys(workspaceId);
  const candidates: ResolvedLocalModel[] = [];
  for (const key of keys) {
    const baseUrl = baseUrlOf(key);
    if (!baseUrl) continue;
    for (const model of key.definition.models) {
      if (!model.enabled) continue;
      const caps = model.capabilities as StoredCapability[];
      const ok = needs.every(need =>
        caps.some(capability => capabilityMatches(capability, need))
      );
      if (!ok) continue;
      candidates.push({
        baseUrl,
        apiKey: key.credential || undefined,
        model: model.modelId,
        supportsTools: caps.some(c => capabilityMatches(c, 'tools')),
        supportsVision: caps.some(c => capabilityMatches(c, 'vision')),
        supportsReasoning: caps.some(c => c.features.includes('reasoning')),
        providerName: key.name,
      });
    }
  }
  const chosen =
    (preferred && candidates.find(c => c.model === preferred)) || candidates[0];
  if (!chosen) {
    throw new LocalAiNotConfiguredError(needs.at(-1) ?? 'chat');
  }
  return chosen;
}

/** Best effort: a chat model, preferring one that can call tools. */
export async function resolveChatModel(
  workspaceId: string,
  options: { tools?: boolean; vision?: boolean; preferred?: string } = {}
) {
  const tries: LocalAiNeed[][] = [];
  if (options.tools && options.vision) tries.push(['chat', 'tools', 'vision']);
  if (options.tools) tries.push(['chat', 'tools']);
  if (options.vision) tries.push(['chat', 'vision']);
  tries.push(['chat']);
  let lastError: unknown;
  for (const needs of tries) {
    try {
      return await resolveLocalModel(workspaceId, needs, options.preferred);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

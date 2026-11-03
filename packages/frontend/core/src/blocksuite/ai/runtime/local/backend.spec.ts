/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

type StreamEvent =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'reasoning'; textDelta: string }
  | {
      type: 'tool-calls';
      toolCalls: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string; status?: number };

const electron = vi.hoisted(() => {
  const listeners = new Set<(streamId: string, event: unknown) => void>();
  const state = {
    files: new Map<string, unknown>(),
    requests: [] as any[],
    /** one script per startChat call */
    scripts: [] as StreamEvent[][],
    keys: [] as any[],
  };
  let seq = 0;
  const apis = {
    byokStorage: {
      isSupported: async () => true,
      getWorkspaceLeaseProviders: async () => state.keys,
    },
    localAi: {
      startChat: async (request: unknown) => {
        state.requests.push(request);
        const streamId = `s${++seq}`;
        const script = state.scripts.shift() ?? [
          { type: 'text-delta', textDelta: 'ok' },
          { type: 'done' },
        ];
        setTimeout(() => {
          for (const event of script) {
            listeners.forEach(listener => listener(streamId, event));
          }
        }, 0);
        return streamId;
      },
      abort: async () => true,
      generateImage: async () => ['data:image/png;base64,AAAA'],
      loadSessions: async (workspaceId: string) =>
        structuredClone(state.files.get(workspaceId) ?? null),
      saveSessions: async (workspaceId: string, data: unknown) => {
        state.files.set(workspaceId, structuredClone(data));
        return true;
      },
    },
  };
  const events = {
    localAi: {
      chunk: (listener: (streamId: string, event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return { apis, events, state };
});

vi.mock('@affine/electron-api', () => ({
  apis: electron.apis,
  events: electron.events,
}));

const { createLocalAIRequestService } = await import('./index');

Object.defineProperty(globalThis, 'EventSource', {
  configurable: true,
  value: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
});

const WORKSPACE = 'ws1';

function ollamaKey(features: string[] = ['tool_calling']) {
  return {
    id: 'k1',
    provider: 'openai',
    name: 'Ollama',
    credential: 'ollama',
    enabled: true,
    sortOrder: 0,
    definition: {
      endpoint: {
        kind: 'openai_compatible',
        url: 'http://localhost:11434/v1',
        dialect: 'chat_completions',
      },
      models: [
        {
          modelId: 'qwen2.5',
          enabled: true,
          capabilities: [
            {
              input: ['text'],
              output: ['text', 'structured'],
              features,
              attachmentKinds: [],
              attachmentSources: [],
            },
          ],
        },
      ],
    },
  };
}

async function collect(stream: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: string[]) =>
  chunks
    .map(chunk => JSON.parse(chunk))
    .filter(object => object.type === 'text-delta')
    .map(object => object.textDelta)
    .join('');

beforeEach(() => {
  electron.state.files.clear();
  electron.state.requests = [];
  electron.state.scripts = [];
  electron.state.keys = [ollamaKey()];
});

describe('local (server-less) AI backend', () => {
  test('streams a chat answer and stores the conversation on device', async () => {
    electron.state.scripts.push([
      { type: 'text-delta', textDelta: 'Hello' },
      { type: 'text-delta', textDelta: ' there' },
      { type: 'done' },
    ]);
    const service = createLocalAIRequestService(WORKSPACE);
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    const stream = await service.executeAction('chat', {
      workspaceId: WORKSPACE,
      sessionId,
      input: 'Hi!',
      stream: true,
    } as any);
    const chunks = await collect(stream as AsyncIterable<string>);
    expect(textOf(chunks)).toBe('Hello there');

    const request = electron.state.requests[0];
    expect(request.baseUrl).toBe('http://localhost:11434/v1');
    expect(request.model).toBe('qwen2.5');
    expect(request.messages[0].role).toBe('system');
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'Hi!' });

    // a fresh service instance reads the persisted history back
    const reloaded = createLocalAIRequestService(WORKSPACE);
    const sessions = await reloaded.getSessions(WORKSPACE);
    expect(sessions).toHaveLength(1);
    expect(sessions![0].messages.map(m => [m.role, m.content])).toEqual([
      ['user', 'Hi!'],
      ['assistant', 'Hello there'],
    ]);
  });

  test('runs workspace tools requested by the model', async () => {
    electron.state.scripts.push(
      [
        {
          type: 'tool-calls',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'doc_keyword_search',
                arguments: '{"query":"budget"}',
              },
            },
          ],
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text-delta', textDelta: 'Found it.' }, { type: 'done' }]
    );
    const searchDocs = vi.fn(async () => [
      { docId: 'd1', title: 'Budget 2026', excerpt: 'total' },
    ]);
    const service = createLocalAIRequestService(WORKSPACE, {
      searchDocs,
      readDoc: async () => null,
    });
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    const chunks = await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        input: 'What is our budget?',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const objects = chunks.map(chunk => JSON.parse(chunk));
    expect(searchDocs).toHaveBeenCalledWith('budget', 10);
    expect(objects.map(o => o.type)).toEqual([
      'tool-call',
      'tool-result',
      'text-delta',
    ]);
    expect(objects[1].result).toEqual([
      { docId: 'd1', title: 'Budget 2026', excerpt: 'total' },
    ]);
    // the second round sends the tool result back to the model
    const second = electron.state.requests[1];
    expect(second.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
    });
    expect(
      electron.state.requests[0].tools.map((t: any) => t.function.name)
    ).toEqual(['doc_keyword_search', 'doc_read']);
  });

  test('uses its own prompt for text actions', async () => {
    const service = createLocalAIRequestService(WORKSPACE);
    const chunks = await collect(
      (await service.executeAction('translate', {
        workspaceId: WORKSPACE,
        input: 'Привіт, світе',
        lang: 'English',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    expect(textOf(chunks)).toBe('ok');
    const [system, user] = electron.state.requests[0].messages;
    expect(system.content).toContain('translator');
    expect(user.content).toContain('Translate into English');
    expect(user.content).toContain('Привіт, світе');
    // actions never get workspace tools
    expect(electron.state.requests[0].tools).toBeUndefined();
  });

  test('reports a clear error when no provider is configured', async () => {
    electron.state.keys = [];
    const service = createLocalAIRequestService(WORKSPACE);
    await expect(
      collect(
        (await service.executeAction('summary', {
          workspaceId: WORKSPACE,
          input: 'text',
          stream: true,
        } as any)) as AsyncIterable<string>
      )
    ).rejects.toThrow(/No local AI provider is configured/);
  });

  test('regenerates the last answer on retry', async () => {
    electron.state.scripts.push(
      [{ type: 'text-delta', textDelta: 'first' }, { type: 'done' }],
      [{ type: 'text-delta', textDelta: 'second' }, { type: 'done' }]
    );
    const service = createLocalAIRequestService(WORKSPACE);
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        input: 'Q',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        retry: true,
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const session = await service.getSession(WORKSPACE, sessionId);
    expect(session?.messages.map(m => m.content)).toEqual(['Q', 'second']);
  });
});

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
const { LocalSessionStore } = await import('./session-store');

Object.defineProperty(globalThis, 'EventSource', {
  configurable: true,
  value: { CONNECTING: 0, OPEN: 1, CLOSED: 2 },
});

const WORKSPACE = 'ws1';

function ollamaKey(
  features: string[] = ['tool_calling'],
  input: string[] = ['text']
) {
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
              input,
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
  LocalSessionStore.resetAll();
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
    LocalSessionStore.resetAll();
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

  test('shows tags and properties of the open document', async () => {
    const service = createLocalAIRequestService(WORKSPACE, {
      searchDocs: async () => [],
      readDoc: async docId => ({
        docId,
        title: 'Shopping list',
        markdown: '- [ ] Milk',
        images: [],
      }),
      getDocProperties: async docId => ({
        docId,
        title: 'Shopping list',
        properties: [
          {
            id: 'tags',
            name: 'Tags',
            type: 'tags',
            editable: true,
            value: ['Home', 'Food'],
          },
          {
            id: 'p1',
            name: 'Bought',
            type: 'checkbox',
            editable: true,
            value: 'false',
          },
          { id: 'p2', name: 'Due', type: 'date', editable: true, value: null },
        ],
      }),
    });
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      docId: 'doc1',
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        docId: 'doc1',
        sessionId,
        input: 'Which tags does it have?',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const system = electron.state.requests[0].messages[0].content as string;
    expect(system).toContain('- Tags: Home, Food');
    expect(system).toContain('- Bought: false');
    expect(system).not.toContain('Due');
    expect(system).toContain('- [ ] Milk');
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

  test('shows workspace images to a vision model', async () => {
    electron.state.keys = [ollamaKey(['tool_calling'], ['text', 'image'])];
    electron.state.scripts.push(
      [
        {
          type: 'tool-calls',
          toolCalls: [
            {
              id: 'v1',
              type: 'function',
              function: {
                name: 'doc_view_images',
                arguments: '{"blob_ids":["img1","missing"]}',
              },
            },
          ],
        },
        { type: 'done' },
      ],
      [{ type: 'text-delta', textDelta: 'A red square.' }, { type: 'done' }]
    );
    const getImage = vi.fn(async (id: string) =>
      id === 'img1' ? 'data:image/jpeg;base64,AAAA' : null
    );
    const service = createLocalAIRequestService(WORKSPACE, {
      searchDocs: async () => [],
      readDoc: async () => null,
      getImage,
    });
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    const chunks = await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        input: 'What is on the image?',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const objects = chunks.map(chunk => JSON.parse(chunk));
    expect(objects[1].result).toEqual({
      shown: ['img1'],
      missing: ['missing'],
    });
    expect(
      electron.state.requests[0].tools.map((t: any) => t.function.name)
    ).toContain('doc_view_images');
    const followUp = electron.state.requests[1].messages.at(-1);
    expect(followUp.role).toBe('user');
    expect(followUp.content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAAA' },
    });
  });

  test('creates and edits documents through write tools', async () => {
    electron.state.scripts.push(
      [
        {
          type: 'tool-calls',
          toolCalls: [
            {
              id: 'w1',
              type: 'function',
              function: {
                name: 'doc_create',
                arguments: '{"title":"Plan","content":"- step"}',
              },
            },
            {
              id: 'w2',
              type: 'function',
              function: {
                name: 'doc_update',
                arguments: '{"doc_id":"d1","content":"New body"}',
              },
            },
          ],
        },
        { type: 'done' },
      ],
      [{ type: 'text-delta', textDelta: 'Done.' }, { type: 'done' }]
    );
    const createDoc = vi.fn(async () => ({
      docId: 'new1',
      title: 'Plan',
      blocks: 1,
    }));
    const editDoc = vi.fn(async () => ({
      inserted: 1,
      updated: 0,
      deleted: 2,
      unchanged: 0,
    }));
    const service = createLocalAIRequestService(WORKSPACE, {
      searchDocs: async () => [],
      readDoc: async () => null,
      createDoc,
      editDoc,
    });
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    const chunks = await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        input: 'Make a plan and clean up d1',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const results = chunks
      .map(chunk => JSON.parse(chunk))
      .filter(o => o.type === 'tool-result');
    expect(createDoc).toHaveBeenCalledWith('Plan', '- step');
    expect(editDoc).toHaveBeenCalledWith('d1', 'New body');
    expect(results[0].result).toMatchObject({ success: true, docId: 'new1' });
    expect(results[1].result).toMatchObject({ success: true, deleted: 2 });
    const toolNames = electron.state.requests[0].tools.map(
      (t: any) => t.function.name
    );
    expect(toolNames).toEqual(
      expect.arrayContaining(['doc_create', 'doc_update', 'doc_append'])
    );
    // a model without vision is not offered the image tool
    expect(toolNames).not.toContain('doc_view_images');
    expect(electron.state.requests[0].messages[0].content).toContain(
      '# Working with documents'
    );
  });
});

describe('tags and properties tools', () => {
  test('offers meta tools and routes property changes', async () => {
    electron.state.scripts.push(
      [
        {
          type: 'tool-calls',
          toolCalls: [
            {
              id: 'm1',
              type: 'function',
              function: { name: 'tag_list', arguments: '{}' },
            },
            {
              id: 'm2',
              type: 'function',
              function: {
                name: 'doc_set_property',
                arguments: '{"doc_id":"d1","property":"Status","value":"Done"}',
              },
            },
            {
              id: 'm3',
              type: 'function',
              function: {
                name: 'doc_set_tags',
                arguments: '{"doc_id":"d1","add":"Work"}',
              },
            },
          ],
        },
        { type: 'done' },
      ],
      [{ type: 'text-delta', textDelta: 'Updated.' }, { type: 'done' }]
    );
    const setDocProperty = vi.fn(async () => ({
      id: 'p1',
      name: 'Status',
      type: 'text',
      value: 'Done',
    }));
    const setDocTags = vi.fn(async () => ({ tags: ['Work'], created: [] }));
    const service = createLocalAIRequestService(WORKSPACE, {
      searchDocs: async () => [],
      readDoc: async () => null,
      editDoc: async () => null,
      listTags: async () => [
        { id: 't1', name: 'Work', color: '#f00', docCount: 2 },
      ],
      setDocProperty,
      setDocTags,
    });
    const sessionId = await service.createSession({
      workspaceId: WORKSPACE,
      promptName: 'Chat With AFFiNE AI',
    } as BlockSuitePresets.AICreateSessionOptions);
    const chunks = await collect(
      (await service.executeAction('chat', {
        workspaceId: WORKSPACE,
        sessionId,
        input: 'Mark d1 as done and tag it Work',
        stream: true,
      } as any)) as AsyncIterable<string>
    );
    const results = chunks
      .map(chunk => JSON.parse(chunk))
      .filter(o => o.type === 'tool-result');
    expect(results[0].result).toEqual([
      { id: 't1', name: 'Work', color: '#f00', docCount: 2 },
    ]);
    expect(setDocProperty).toHaveBeenCalledWith('d1', 'Status', 'Done');
    expect(results[1].result).toMatchObject({ success: true });
    // a single string is accepted where a list is expected
    expect(setDocTags).toHaveBeenCalledWith('d1', {
      add: ['Work'],
      remove: [],
    });
    const toolNames = electron.state.requests[0].tools.map(
      (t: any) => t.function.name
    );
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'tag_list',
        'tag_docs',
        'property_list',
        'doc_properties',
        'doc_set_tags',
        'doc_set_property',
        'property_create',
      ])
    );
  });
});

describe('markdownArg', () => {
  test('unescapes double-escaped newlines only when there are no real ones', async () => {
    const { markdownArg } = await import('./backend');
    expect(markdownArg('Hello!\\n\\n- Milk\\n- Bread')).toBe(
      'Hello!\n\n- Milk\n- Bread'
    );
    expect(markdownArg('Code `a\\nb`\nnext')).toBe('Code `a\\nb`\nnext');
    expect(markdownArg(undefined)).toBe('');
  });
});

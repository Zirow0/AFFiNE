import type {
  LocalAiContentPart,
  LocalAiMessage,
  LocalAiStreamEvent,
  LocalAiToolCall,
  LocalAiToolDefinition,
} from '@affine/electron-api';
import { apis, events } from '@affine/electron-api';
import type { GraphQLQuery, QueryOptions } from '@affine/graphql';

import type { StreamObject } from '../../components/ai-chat-messages/type';
import { chatSystemPrompt, getLocalPrompt } from './prompts';
import {
  LocalAiNotConfiguredError,
  resolveChatModel,
  type ResolvedLocalModel,
  resolveLocalModel,
} from './provider-config';
import {
  CHAT_PROMPT,
  type LocalChatMessage,
  type LocalChatSession,
  LocalSessionStore,
} from './session-store';

/**
 * Access to the current workspace's content for AI context and tools.
 * Implemented by the app shell (see `workspace-side-effects.tsx`).
 */
export interface LocalWorkspaceContent {
  searchDocs(
    query: string,
    limit?: number
  ): Promise<{ docId: string; title: string; excerpt?: string }[]>;
  /** Markdown of a page; block-tagged when the doc can be edited */
  readDoc(docId: string): Promise<{
    docId: string;
    title: string;
    markdown: string;
    images?: { blockId: string; blobId: string; caption: string }[];
  } | null>;
  createDoc?(
    title: string,
    markdown: string
  ): Promise<{ docId: string; title: string; blocks: number }>;
  editDoc?(
    docId: string,
    markdown: string
  ): Promise<{
    inserted: number;
    updated: number;
    deleted: number;
    unchanged: number;
  } | null>;
  appendToDoc?(
    docId: string,
    markdown: string,
    afterBlockId?: string
  ): Promise<{ inserted: number } | null>;
  renameDoc?(docId: string, title: string): Promise<boolean>;
  /** a downscaled data URL of a workspace image blob */
  getImage?(blobId: string): Promise<string | null>;
}

const MAX_DOC_CHARS = 24_000;

/** image-to-image style transfer has no OpenAI-compatible equivalent */
const UNSUPPORTED_PROMPTS = new Set([
  'image.filter.sketch',
  'image.filter.clay',
  'image.filter.anime',
  'image.filter.pixel',
  'Convert to Anime style',
  'Convert to Clay style',
  'Convert to Pixel style',
  'Convert to Sketch style',
  'Convert to sticker',
  'Upscale image',
  'Remove background',
  'Transcript audio',
]);
const MAX_TOOL_ROUNDS = 6;

// ---------------------------------------------------------------------------
// EventSource emulation

type Listener = (event: MessageEvent | Event) => void;

/**
 * Minimal EventSource-compatible object used by `toTextStream`. A finished
 * stream is signalled with an `error` event without data, like the server.
 */
class LocalEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = LocalEventSource.CONNECTING;
  readonly url: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly controller = new AbortController();

  constructor(
    url: string,
    run: (source: LocalEventSource, signal: AbortSignal) => Promise<void>
  ) {
    this.url = url;
    // start on the next tick so `toTextStream` can attach listeners first
    setTimeout(() => {
      if (this.readyState === LocalEventSource.CLOSED) return;
      this.readyState = LocalEventSource.OPEN;
      run(this, this.controller.signal)
        .then(() => this.finish())
        .catch(error => this.fail(error));
    }, 0);
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string, data?: string) {
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data });
    this.listeners.get(type)?.forEach(listener => listener(event));
  }

  message(data: string) {
    if (this.readyState === LocalEventSource.CLOSED) return;
    this.dispatch('message', data);
  }

  attachment(url: string) {
    if (this.readyState === LocalEventSource.CLOSED) return;
    this.dispatch('attachment', url);
  }

  streamObject(object: StreamObject) {
    this.message(JSON.stringify(object));
  }

  private finish() {
    if (this.readyState === LocalEventSource.CLOSED) return;
    this.dispatch('error');
    this.close();
  }

  fail(error: unknown) {
    if (this.readyState === LocalEventSource.CLOSED) return;
    const status =
      error instanceof LocalAiNotConfiguredError
        ? 400
        : ((error as { status?: number })?.status ?? 500);
    const message = error instanceof Error ? error.message : String(error);
    const errorEvent = new MessageEvent('error', {
      data: JSON.stringify({
        status,
        code: 'LOCAL_AI_ERROR',
        type: 'INTERNAL_SERVER_ERROR',
        name: 'LOCAL_AI_ERROR',
        message,
      }),
    });
    this.listeners.get('error')?.forEach(listener => listener(errorEvent));
    this.close();
  }

  close() {
    this.readyState = LocalEventSource.CLOSED;
    this.controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Streaming helper on top of the Electron main process

class LocalAiStreamHub {
  private readonly handlers = new Map<
    string,
    (event: LocalAiStreamEvent) => void
  >();
  private readonly pending = new Map<string, LocalAiStreamEvent[]>();
  private unsubscribe?: () => void;

  private ensureSubscribed() {
    if (this.unsubscribe || !events?.localAi) return;
    this.unsubscribe = events.localAi.chunk(
      (streamId: string, event: LocalAiStreamEvent) => {
        const handler = this.handlers.get(streamId);
        if (handler) {
          handler(event);
        } else {
          // the event may arrive before `startChat` resolved
          const queue = this.pending.get(streamId) ?? [];
          queue.push(event);
          this.pending.set(streamId, queue);
        }
      }
    );
  }

  async *stream(
    request: Parameters<NonNullable<typeof apis>['localAi']['startChat']>[0],
    signal: AbortSignal
  ): AsyncGenerator<LocalAiStreamEvent> {
    if (!apis?.localAi) {
      throw new Error('Local AI is only available in the desktop app');
    }
    this.ensureSubscribed();
    const queue: LocalAiStreamEvent[] = [];
    let wake: (() => void) | undefined;
    const push = (event: LocalAiStreamEvent) => {
      queue.push(event);
      wake?.();
    };
    const streamId = await apis.localAi.startChat(request);
    this.handlers.set(streamId, push);
    this.pending.get(streamId)?.forEach(push);
    this.pending.delete(streamId);
    const onAbort = () => {
      apis?.localAi.abort(streamId).catch(console.error);
      push({ type: 'done', finishReason: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        if (!queue.length) {
          await new Promise<void>(resolve => (wake = resolve));
          wake = undefined;
          continue;
        }
        const event = queue.shift();
        if (!event) continue;
        if (event.type === 'error') {
          throw Object.assign(new Error(event.message), {
            status: event.status,
          });
        }
        yield event;
        if (event.type === 'done') return;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.handlers.delete(streamId);
    }
  }
}

const streamHub = new LocalAiStreamHub();

// ---------------------------------------------------------------------------
// helpers

function textOf(message: LocalChatMessage) {
  if (message.content) return message.content;
  return (message.streamObjects ?? [])
    .map(object => (object.type === 'text-delta' ? object.textDelta : ''))
    .join('');
}

function truncate(text: string, max = MAX_DOC_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

async function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function userContent(
  text: string,
  attachments: string[],
  model: ResolvedLocalModel
): string | LocalAiContentPart[] {
  const images = attachments.filter(
    url => url.startsWith('data:image/') || /^https?:\/\//.test(url)
  );
  if (!images.length || !model.supportsVision) return text;
  return [
    { type: 'text', text },
    ...images.map(url => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ];
}

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): LocalAiToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required },
  },
});

const READ_TOOLS: LocalAiToolDefinition[] = [
  fn(
    'doc_keyword_search',
    'Search the documents of the current workspace by keywords. Returns matching document ids, titles and excerpts.',
    { query: { type: 'string', description: 'Keywords to search for' } },
    ['query']
  ),
  fn(
    'doc_read',
    'Read a document of the current workspace as block-tagged Markdown (each top-level block is preceded by <!-- block_id=... flavour=... -->). Also lists the images it contains.',
    { doc_id: { type: 'string', description: 'The document id' } },
    ['doc_id']
  ),
];

const IMAGE_TOOL = fn(
  'doc_view_images',
  'Look at images stored in the workspace (for example images listed by doc_read). The images are shown to you right after this call.',
  {
    blob_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Image blob ids (at most 4)',
    },
  },
  ['blob_ids']
);

const WRITE_TOOLS: LocalAiToolDefinition[] = [
  fn(
    'doc_create',
    'Create a new page document with a title and Markdown body. Supports headings, paragraphs with bold/italic/strikethrough/inline code/links, bulleted/numbered/todo lists (nested), quotes, code blocks with language, tables, dividers and LaTeX ($$...$$). Returns the new doc id.',
    {
      title: { type: 'string', description: 'Document title' },
      content: {
        type: 'string',
        description: 'Markdown body (do not repeat the title as a heading)',
      },
    },
    ['title', 'content']
  ),
  fn(
    'doc_update',
    'Edit a document body. Pass the COMPLETE new body as block-tagged Markdown: keep the <!-- block_id=... --> marker (unchanged) above every block you keep, edit the Markdown under a marker to change that block, add new blocks without a marker (or with block_id=new), and omit blocks to delete them. Blocks you do not touch are preserved exactly. Images cannot be created or changed, only kept, moved or removed. Without any markers the whole body is replaced.',
    {
      doc_id: { type: 'string', description: 'The document id' },
      content: {
        type: 'string',
        description: 'The complete new body as block-tagged Markdown',
      },
    },
    ['doc_id', 'content']
  ),
  fn(
    'doc_append',
    'Insert Markdown blocks into a document without rewriting it: at the end, or right after the block with after_block_id.',
    {
      doc_id: { type: 'string', description: 'The document id' },
      content: { type: 'string', description: 'Markdown to insert' },
      after_block_id: {
        type: 'string',
        description: 'Optional block id to insert after',
      },
    },
    ['doc_id', 'content']
  ),
  fn(
    'doc_update_meta',
    'Rename a document (change its title).',
    {
      doc_id: { type: 'string', description: 'The document id' },
      title: { type: 'string', description: 'The new title' },
    },
    ['doc_id', 'title']
  ),
];

const DOC_EDITING_GUIDE = `# Working with documents
- Documents are AFFiNE pages. doc_read and the context show them as block-tagged Markdown; the markers are only addresses for editing — never show them to the user.
- To change a document use doc_update (full new body with markers kept), doc_append (add content), doc_create (new doc) or doc_update_meta (rename). Only edit when the user asked you to change or create something; otherwise answer in chat.
- After editing, briefly tell the user what you changed.
- Images appear as ![caption](affine-image:<blob id>); call doc_view_images with those blob ids to see them.`;

type GqlResult = Record<string, unknown>;

// ---------------------------------------------------------------------------

/**
 * A drop-in replacement for the server copilot API used by `CopilotClient`:
 * it answers the GraphQL operations and SSE endpoints the AI UI relies on,
 * storing sessions on this device and calling the configured provider
 * directly from the desktop app.
 */
export class LocalCopilotBackend {
  readonly store: LocalSessionStore;

  constructor(
    readonly workspaceId: string,
    private readonly content?: LocalWorkspaceContent
  ) {
    this.store = LocalSessionStore.for(workspaceId);
  }

  // ---- GraphQL emulation --------------------------------------------------

  gql = async <Query extends GraphQLQuery>(
    options: QueryOptions<Query>
  ): Promise<any> => {
    const op = options.query.op;
    const variables = (options.variables ?? {}) as Record<string, any>;
    const handler = (
      this.operations as Record<string, (v: any) => Promise<GqlResult>>
    )[op];
    if (!handler) {
      throw Object.assign(
        new Error(`"${op}" is not available in offline AI mode`),
        { status: 400, name: 'LOCAL_AI_UNSUPPORTED' }
      );
    }
    return handler(variables);
  };

  private chatsResult(sessions: LocalChatSession[]) {
    return {
      currentUser: {
        copilot: {
          chats: {
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
            edges: sessions.map(node => ({ cursor: node.sessionId, node })),
          },
        },
      },
    };
  }

  private async querySessions(variables: {
    docId?: string | null;
    pagination?: { first?: number | null; offset?: number | null };
    options?: Record<string, any> | null;
  }) {
    const options = variables.options ?? {};
    let sessions = (await this.store.all()).slice();
    if (options.sessionId) {
      sessions = sessions.filter(s => s.sessionId === options.sessionId);
    }
    if (variables.docId) {
      sessions = sessions.filter(s => s.docId === variables.docId);
    }
    if (options.action === true) sessions = sessions.filter(s => !!s.action);
    if (options.action === false) sessions = sessions.filter(s => !s.action);
    if (options.fork === false) {
      sessions = sessions.filter(s => !s.parentSessionId);
    }
    if (typeof options.pinned === 'boolean') {
      sessions = sessions.filter(s => s.pinned === options.pinned);
    }
    const desc = options.sessionOrder !== 'asc';
    sessions.sort((a, b) =>
      desc
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.updatedAt.localeCompare(b.updatedAt)
    );
    const offset = variables.pagination?.offset ?? options.skip ?? 0;
    const limit = variables.pagination?.first ?? options.limit ?? undefined;
    sessions = sessions.slice(offset, limit ? offset + limit : undefined);
    const withMessages = options.withMessages !== false;
    const messageDesc = options.messageOrder === 'desc';
    return sessions.map(session => ({
      ...session,
      messages: withMessages
        ? messageDesc
          ? session.messages.slice().reverse()
          : session.messages
        : [],
    }));
  }

  private readonly operations = {
    createCopilotSession: async ({ options }: { options: any }) => {
      return {
        createCopilotSession: (await this.createSession(options)).sessionId,
      };
    },
    createCopilotSessionWithHistory: async ({ options }: { options: any }) => {
      return {
        createCopilotSessionWithHistory: await this.createSession(options),
      };
    },
    updateCopilotSession: async ({ options }: { options: any }) => {
      const patch: Record<string, unknown> = {};
      if (options.docId !== undefined) patch.docId = options.docId;
      if (options.pinned !== undefined && options.pinned !== null) {
        patch.pinned = options.pinned;
      }
      if (options.promptName) patch.promptName = options.promptName;
      await this.store.update(options.sessionId, patch);
      return { updateCopilotSession: options.sessionId };
    },
    forkCopilotSession: async ({ options }: { options: any }) => {
      const source = await this.store.require(options.sessionId);
      const index = options.latestMessageId
        ? source.messages.findIndex(m => m.id === options.latestMessageId)
        : source.messages.length - 1;
      const forked = await this.store.create({
        docId: options.docId ?? source.docId,
        promptName: source.promptName,
        parentSessionId: source.sessionId,
        messages: source.messages
          .slice(0, index + 1)
          .map(message => ({ ...message })),
      });
      return { forkCopilotSession: forked.sessionId };
    },
    createCopilotMessage: async ({ options }: { options: any }) => {
      const blobs: Blob[] = [
        ...(options.blobs ?? []),
        ...(options.blob ? [options.blob] : []),
      ];
      const blobUrls = await Promise.all(blobs.map(blobToDataUrl));
      const message = await this.store.addMessage(options.sessionId, {
        role: 'user',
        content: options.content ?? '',
        attachments: [...(options.attachments ?? []), ...blobUrls],
        params: options.params ?? null,
        streamObjects: null,
      });
      return { createCopilotMessage: message.id };
    },
    getCopilotSession: async (variables: any) =>
      this.chatsResult(
        await this.querySessions({
          options: { sessionId: variables.sessionId },
        })
      ),
    getCopilotSessions: async (variables: any) =>
      this.chatsResult(await this.querySessions(variables)),
    getCopilotHistories: async (variables: any) =>
      this.chatsResult(await this.querySessions(variables)),
    getCopilotHistoryIds: async (variables: any) =>
      this.chatsResult(await this.querySessions(variables)),
    getCopilotRecentSessions: async (variables: any) =>
      this.chatsResult(
        await this.querySessions({
          pagination: {
            first: variables.limit ?? 10,
            offset: variables.offset ?? 0,
          },
          options: { action: false, fork: false, withMessages: false },
        })
      ),
    cleanupCopilotSession: async ({ input }: { input: any }) => ({
      cleanupCopilotSession: await this.store.remove(input.sessionIds ?? []),
    }),
    getCopilotRouteOptions: async () => ({
      currentUser: { copilot: { routeOptions: null } },
    }),
    // keys already live on this device; nothing to lease
    createWorkspaceByokLocalLease: async () => ({
      createWorkspaceByokLocalLease: {
        leaseId: 'local',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  };

  private async createSession(options: {
    docId?: string | null;
    promptName: string;
    pinned?: boolean | null;
    reuseLatestChat?: boolean | null;
  }) {
    if (
      options.promptName === CHAT_PROMPT &&
      options.reuseLatestChat !== false
    ) {
      const sessions = await this.querySessions({
        docId: options.docId ?? undefined,
        options: { action: false, fork: false },
      });
      const reusable = sessions.find(
        s =>
          (s.docId ?? null) === (options.docId ?? null) &&
          s.messages.length === 0
      );
      if (reusable) {
        if (options.pinned) {
          await this.store.update(reusable.sessionId, { pinned: true });
        }
        return reusable;
      }
    }
    return this.store.create(options);
  }

  // ---- SSE emulation ------------------------------------------------------

  eventSource = (url: string): EventSource => {
    const parsed = new URL(url, 'http://local');
    const query = Object.fromEntries(parsed.searchParams.entries());
    const parts = parsed.pathname.split('/').filter(Boolean);
    // /api/copilot/chat/:sessionId/:endpoint | /api/copilot/actions/:sessionId/stream
    const sessionId = parts[3] ?? '';
    const endpoint = parts[2] === 'actions' ? 'action' : (parts[4] ?? '');
    const source = new LocalEventSource(url, async (src, signal) => {
      if (endpoint === 'images') {
        await this.runImage(src, sessionId, query, signal);
      } else {
        await this.runText(src, sessionId, query, signal);
      }
    });
    return source as unknown as EventSource;
  };

  private async runText(
    source: LocalEventSource,
    sessionId: string,
    query: Record<string, string>,
    signal: AbortSignal
  ) {
    if (query.retry === 'true') {
      await this.store.dropTrailingAssistant(sessionId);
    }
    const session = await this.store.require(sessionId);
    if (UNSUPPORTED_PROMPTS.has(session.promptName)) {
      throw Object.assign(
        new Error(
          `"${session.promptName}" is not available with local AI providers yet.`
        ),
        { status: 400 }
      );
    }
    const isChat = session.promptName === CHAT_PROMPT;
    const lastUser = session.messages.findLast(m => m.role === 'user');
    const hasImages = !!lastUser?.attachments.some(a =>
      a.startsWith('data:image/')
    );
    const useTools = isChat && !!this.content;
    const model = await resolveChatModel(this.workspaceId, {
      tools: useTools,
      // prefer a vision model for chat so it can look at document images
      vision: hasImages || useTools,
    });

    const messages = isChat
      ? await this.buildChatMessages(session, model)
      : this.buildActionMessages(session, model);
    const prompt = isChat ? null : getLocalPrompt(session.promptName);
    const tools =
      useTools && model.supportsTools ? this.toolsFor(model) : undefined;

    const objects: StreamObject[] = [];
    const emit = (object: StreamObject) => {
      objects.push(object);
      source.streamObject(object);
    };

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let toolCalls: LocalAiToolCall[] = [];
        let text = '';
        for await (const event of streamHub.stream(
          {
            baseUrl: model.baseUrl,
            apiKey: model.apiKey,
            model: model.model,
            messages,
            tools: round < MAX_TOOL_ROUNDS ? tools : undefined,
            temperature: prompt?.temperature,
          },
          signal
        )) {
          if (event.type === 'text-delta') {
            text += event.textDelta;
            emit({ type: 'text-delta', textDelta: event.textDelta });
          } else if (event.type === 'reasoning') {
            emit({ type: 'reasoning', textDelta: event.textDelta });
          } else if (event.type === 'tool-calls') {
            toolCalls = event.toolCalls;
          }
        }
        if (signal.aborted || !toolCalls.length) break;

        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls,
        });
        const viewedImages: string[] = [];
        for (const call of toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            args = {};
          }
          emit({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.function.name,
            args,
          });
          const result = await this.runTool(
            call.function.name,
            args,
            model,
            viewedImages
          );
          emit({
            type: 'tool-result',
            toolCallId: call.id,
            toolName: call.function.name,
            args,
            result,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncate(JSON.stringify(result)),
          });
        }
        if (viewedImages.length) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Images requested with doc_view_images:',
              },
              ...viewedImages.map(url => ({
                type: 'image_url' as const,
                image_url: { url },
              })),
            ],
          });
        }
      }
    } finally {
      if (objects.length) {
        await this.store.addMessage(sessionId, {
          role: 'assistant',
          content: objects
            .map(o => (o.type === 'text-delta' ? o.textDelta : ''))
            .join(''),
          attachments: [],
          params: null,
          streamObjects: objects,
        });
      }
    }
  }

  private toolsFor(model: ResolvedLocalModel) {
    const content = this.content;
    if (!content) return undefined;
    const tools = [...READ_TOOLS];
    if (model.supportsVision && content.getImage) tools.push(IMAGE_TOOL);
    if (content.editDoc) tools.push(...WRITE_TOOLS);
    return tools;
  }

  private async runTool(
    name: string,
    args: Record<string, any>,
    model?: ResolvedLocalModel,
    viewedImages: string[] = []
  ) {
    const notFound = {
      type: 'error',
      name: 'Not found',
      message: 'Document not found',
    };
    try {
      const content = this.content;
      if (!content) throw new Error('Workspace access is unavailable');
      const docId = String(args.doc_id ?? '');
      switch (name) {
        case 'doc_keyword_search': {
          const hits = await content.searchDocs(String(args.query ?? ''), 10);
          return hits.map(hit => ({
            docId: hit.docId,
            title: hit.title,
            excerpt: hit.excerpt,
          }));
        }
        case 'doc_read': {
          const doc = await content.readDoc(docId);
          if (!doc) return notFound;
          return { ...doc, markdown: truncate(doc.markdown) };
        }
        case 'doc_view_images': {
          if (!model?.supportsVision || !content.getImage) {
            return {
              type: 'error',
              name: 'No vision',
              message:
                'The current model cannot view images. Enable "Image understanding" for a vision-capable model.',
            };
          }
          const ids = (Array.isArray(args.blob_ids) ? args.blob_ids : [])
            .map(String)
            .slice(0, 4);
          const shown: string[] = [];
          for (const id of ids) {
            const url = await content.getImage(id).catch(() => null);
            if (url) {
              viewedImages.push(url);
              shown.push(id);
            }
          }
          return { shown, missing: ids.filter(id => !shown.includes(id)) };
        }
        case 'doc_create': {
          if (!content.createDoc) throw new Error('Editing is unavailable');
          const created = await content.createDoc(
            String(args.title ?? 'Untitled'),
            String(args.content ?? '')
          );
          return { success: true, ...created };
        }
        case 'doc_update': {
          if (!content.editDoc) throw new Error('Editing is unavailable');
          const stats = await content.editDoc(
            docId,
            String(args.content ?? '')
          );
          return stats ? { success: true, docId, ...stats } : notFound;
        }
        case 'doc_append': {
          if (!content.appendToDoc) throw new Error('Editing is unavailable');
          const appended = await content.appendToDoc(
            docId,
            String(args.content ?? ''),
            args.after_block_id ? String(args.after_block_id) : undefined
          );
          return appended ? { success: true, docId, ...appended } : notFound;
        }
        case 'doc_update_meta': {
          if (!content.renameDoc) throw new Error('Editing is unavailable');
          const ok = await content.renameDoc(docId, String(args.title ?? ''));
          return ok ? { success: true, docId } : notFound;
        }
        default:
          return {
            type: 'error',
            name: 'Unknown tool',
            message: `Unknown tool ${name}`,
          };
      }
    } catch (error) {
      return {
        type: 'error',
        name: 'Tool failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async buildChatMessages(
    session: LocalChatSession,
    model: ResolvedLocalModel
  ): Promise<LocalAiMessage[]> {
    const lastUser = session.messages.findLast(m => m.role === 'user');
    const params = (lastUser?.params ?? {}) as Record<string, any>;
    const context: string[] = [];

    if (
      typeof params.liveEditorContext === 'string' &&
      params.liveEditorContext
    ) {
      context.push(
        `## Current editor state\n${truncate(params.liveEditorContext, 8000)}`
      );
    }

    // documents explicitly attached to the message, plus the current doc
    const docIds = new Set<string>();
    for (const doc of (params.docs ?? []) as { docId?: string }[]) {
      if (doc?.docId) docIds.add(doc.docId);
    }
    for (const selector of [
      ...((params.scopeSelectors ?? []) as { kind: string; id: string }[]),
      ...((params.focusSelectors ?? []) as { kind: string; id: string }[]),
    ]) {
      if (selector?.kind === 'document' && selector.id) docIds.add(selector.id);
    }
    const currentDocId =
      typeof params.currentDocId === 'string'
        ? params.currentDocId
        : session.docId;
    if (currentDocId) docIds.add(currentDocId);

    if (this.content) {
      let budget = MAX_DOC_CHARS * 2;
      for (const docId of docIds) {
        if (budget <= 0) break;
        const doc = await this.content.readDoc(docId).catch(() => null);
        if (!doc) continue;
        const body = truncate(doc.markdown, budget);
        budget -= body.length;
        context.push(
          `## Document "${doc.title || 'Untitled'}" (id: ${doc.docId}${docId === currentDocId ? ', currently open' : ''})\n${body}`
        );
      }
    }
    for (const file of (params.files ?? []) as {
      fileName?: string;
      fileContent?: string;
    }[]) {
      if (file?.fileContent) {
        context.push(
          `## File "${file.fileName ?? 'file'}"\n${truncate(file.fileContent, 12000)}`
        );
      }
    }

    const system = [
      chatSystemPrompt(),
      this.content?.editDoc && model.supportsTools ? DOC_EDITING_GUIDE : '',
      context.length ? `# Context\n\n${context.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const history: LocalAiMessage[] = session.messages.map(message =>
      message.role === 'user'
        ? {
            role: 'user' as const,
            content: userContent(message.content, message.attachments, model),
          }
        : { role: 'assistant' as const, content: textOf(message) }
    );
    return [{ role: 'system', content: system }, ...history];
  }

  private buildActionMessages(
    session: LocalChatSession,
    model: ResolvedLocalModel
  ): LocalAiMessage[] {
    const prompt = getLocalPrompt(session.promptName);
    const lastUser = session.messages.findLast(m => m.role === 'user');
    if (!lastUser) throw new Error('Nothing to process');
    const content = lastUser.content ?? '';
    const user = prompt?.user ? prompt.user(content, lastUser.params) : content;
    return [
      {
        role: 'system',
        content:
          prompt?.system ??
          `Perform the task "${session.promptName}" on the provided content. Reply with the result only, in Markdown.`,
      },
      { role: 'user', content: userContent(user, lastUser.attachments, model) },
    ];
  }

  private async runImage(
    source: LocalEventSource,
    sessionId: string,
    _query: Record<string, string>,
    signal: AbortSignal
  ) {
    const session = await this.store.require(sessionId);
    if (UNSUPPORTED_PROMPTS.has(session.promptName)) {
      throw Object.assign(
        new Error(
          `"${session.promptName}" is not available with local AI providers yet.`
        ),
        { status: 400 }
      );
    }
    const lastUser = session.messages.findLast(m => m.role === 'user');
    const model = await resolveLocalModel(this.workspaceId, ['image']);
    const prompt = lastUser?.content || 'An abstract illustration';
    if (!apis?.localAi) {
      throw new Error('Local AI is only available in the desktop app');
    }
    const images = await apis.localAi.generateImage({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      prompt,
    });
    if (signal.aborted) return;
    images.forEach(url => source.attachment(url));
    await this.store.addMessage(sessionId, {
      role: 'assistant',
      content: '',
      attachments: images,
      params: null,
      streamObjects: null,
    });
  }
}

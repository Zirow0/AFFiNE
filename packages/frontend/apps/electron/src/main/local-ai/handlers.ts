import fs from 'node:fs/promises';
import path from 'node:path';

import { app, net } from 'electron';
import { Subject } from 'rxjs';

import { beforeAppQuit } from '../cleanup';
import { logger } from '../logger';
import type { NamespaceHandlers } from '../type';
import type {
  LocalAiChatRequest,
  LocalAiEmbeddingRequest,
  LocalAiEndpoint,
  LocalAiImageRequest,
  LocalAiStreamEvent,
  LocalAiToolCall,
} from './types';

const chunk$ = new Subject<{ streamId: string; event: LocalAiStreamEvent }>();
const running = new Map<string, AbortController>();
let streamSeq = 0;

function normalizeBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) endpoints are supported');
  }
  return url.toString().replace(/\/+$/, '');
}

function headers({ apiKey }: LocalAiEndpoint) {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function readError(res: Response) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return (
      json?.error?.message ??
      json?.message ??
      text ??
      res.statusText
    ).toString();
  } catch {
    return text || res.statusText;
  }
}

async function postJson(
  endpoint: LocalAiEndpoint,
  pathname: string,
  body: unknown,
  signal?: AbortSignal
) {
  const res = await net.fetch(
    `${normalizeBaseUrl(endpoint.baseUrl)}${pathname}`,
    {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify(body),
      signal,
    }
  );
  if (!res.ok) {
    const error = new Error(await readError(res)) as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
  return (await res.json()) as any;
}

/**
 * Reads an OpenAI-compatible `/chat/completions` SSE stream and forwards it
 * as {@link LocalAiStreamEvent}s. Tool call deltas are accumulated and emitted
 * once, when the model finishes the turn.
 */
async function runChatStream(
  streamId: string,
  request: LocalAiChatRequest,
  controller: AbortController
) {
  const emit = (event: LocalAiStreamEvent) => chunk$.next({ streamId, event });
  const toolCalls = new Map<number, LocalAiToolCall>();
  let finishReason: string | undefined;
  try {
    const res = await net.fetch(
      `${normalizeBaseUrl(request.baseUrl)}/chat/completions`,
      {
        method: 'POST',
        headers: { ...headers(request), accept: 'text/event-stream' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          ...(request.tools?.length ? { tools: request.tools } : {}),
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.jsonMode
            ? { response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: controller.signal,
      }
    );
    if (!res.ok || !res.body) {
      emit({
        type: 'error',
        message: await readError(res),
        status: res.status,
      });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = res.body.getReader();
    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      if (json.error) {
        throw new Error(json.error.message ?? String(json.error));
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        emit({ type: 'reasoning', textDelta: reasoning });
      }
      if (typeof delta.content === 'string' && delta.content) {
        emit({ type: 'text-delta', textDelta: delta.content });
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === 'number' ? call.index : 0;
        const current = toolCalls.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) {
          current.function.arguments += call.function.arguments;
        }
        toolCalls.set(index, current);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    }
    if (buffer) handleLine(buffer);

    if (toolCalls.size) {
      emit({
        type: 'tool-calls',
        toolCalls: [...toolCalls.values()].map((call, index) => ({
          ...call,
          id: call.id || `call_${streamId}_${index}`,
        })),
      });
    }
    emit({ type: 'done', finishReason });
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: 'done', finishReason: 'aborted' });
      return;
    }
    logger.error('[local-ai] chat stream failed', error);
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(streamId);
  }
}

// ---------------------------------------------------------------------------
// Local session storage: one JSON file per workspace under userData.

const sessionsDir = () => path.join(app.getPath('userData'), 'local-ai');

function sessionFile(workspaceId: string) {
  if (!/^[\w-]+$/.test(workspaceId)) {
    throw new Error('Invalid workspace id');
  }
  return path.join(sessionsDir(), `${workspaceId}.json`);
}

const writeQueue = new Map<string, Promise<void>>();

export const localAiHandlers = {
  /** Starts a streaming chat completion; events arrive via `localAi:chunk`. */
  startChat: async (_e, request: LocalAiChatRequest) => {
    const streamId = `${Date.now().toString(36)}-${++streamSeq}`;
    const controller = new AbortController();
    running.set(streamId, controller);
    // run in the background; the renderer subscribes to chunk events first
    setTimeout(() => {
      runChatStream(streamId, request, controller).catch(error =>
        logger.error('[local-ai] unexpected stream failure', error)
      );
    }, 0);
    return streamId;
  },
  abort: async (_e, streamId: string) => {
    running.get(streamId)?.abort();
    running.delete(streamId);
    return true;
  },
  /** Non-streaming completion, used for structured/background tasks. */
  complete: async (_e, request: LocalAiChatRequest) => {
    const json = await postJson(request, '/chat/completions', {
      model: request.model,
      messages: request.messages,
      stream: false,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });
    const message = json?.choices?.[0]?.message ?? {};
    return {
      content: (message.content ?? '') as string,
      toolCalls: (message.tool_calls ?? []) as LocalAiToolCall[],
    };
  },
  listModels: async (_e, endpoint: LocalAiEndpoint) => {
    const res = await net.fetch(
      `${normalizeBaseUrl(endpoint.baseUrl)}/models`,
      { headers: headers(endpoint) }
    );
    if (!res.ok) throw new Error(await readError(res));
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map(model => model.id).sort();
  },
  generateImage: async (_e, request: LocalAiImageRequest) => {
    const json = await postJson(request, '/images/generations', {
      model: request.model,
      prompt: request.prompt,
      size: request.size ?? '1024x1024',
      response_format: 'b64_json',
    });
    return ((json?.data ?? []) as { b64_json?: string; url?: string }[])
      .map(item =>
        item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url
      )
      .filter((url): url is string => !!url);
  },
  embed: async (_e, request: LocalAiEmbeddingRequest) => {
    const json = await postJson(request, '/embeddings', {
      model: request.model,
      input: request.input,
    });
    return ((json?.data ?? []) as { embedding: number[]; index: number }[])
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);
  },
  loadSessions: async (_e, workspaceId: string) => {
    try {
      return JSON.parse(await fs.readFile(sessionFile(workspaceId), 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  },
  saveSessions: async (_e, workspaceId: string, data: unknown) => {
    const file = sessionFile(workspaceId);
    const previous = writeQueue.get(file) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(sessionsDir(), { recursive: true });
        const tmp = `${file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data));
        await fs.rename(tmp, file);
      });
    writeQueue.set(file, next);
    await next;
    return true;
  },
} satisfies NamespaceHandlers;

export const localAiEvents = {
  chunk: (emit: (streamId: string, event: LocalAiStreamEvent) => void) => {
    const subscription = chunk$.subscribe(({ streamId, event }) =>
      emit(streamId, event)
    );
    return () => subscription.unsubscribe();
  },
};

export function abortAllLocalAiStreams() {
  running.forEach(controller => controller.abort());
  running.clear();
}

beforeAppQuit(abortAllLocalAiStreams);

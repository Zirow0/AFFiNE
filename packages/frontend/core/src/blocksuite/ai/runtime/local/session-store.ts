import { apis } from '@affine/electron-api';
import { nanoid } from 'nanoid';

import type { StreamObject } from '../../components/ai-chat-messages/type';

/**
 * On-device storage of AI chat sessions for the server-less AI backend.
 * Shapes mirror the server's `CopilotChatHistory` GraphQL fragment so the
 * existing chat UI can consume them unchanged.
 */

export const CHAT_PROMPT = 'Chat With AFFiNE AI';

export type LocalChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments: string[];
  params?: Record<string, unknown> | null;
  streamObjects: StreamObject[] | null;
  scopeSnapshot: null;
  createdAt: string;
};

export type LocalChatSession = {
  sessionId: string;
  workspaceId: string;
  docId: string | null;
  parentSessionId: string | null;
  promptName: string;
  action: string | null;
  pinned: boolean;
  title: string | null;
  messages: LocalChatMessage[];
  createdAt: string;
  updatedAt: string;
};

type StoredData = { version: 1; sessions: LocalChatSession[] };

/** keep the file bounded: drop the oldest unpinned action sessions */
const MAX_ACTION_SESSIONS = 200;

export class LocalSessionStore {
  private sessions: LocalChatSession[] | null = null;
  private loading: Promise<LocalChatSession[]> | null = null;

  constructor(readonly workspaceId: string) {}

  private async load() {
    if (this.sessions) return this.sessions;
    if (!this.loading) {
      this.loading = (async () => {
        const data = (await apis?.localAi.loadSessions(this.workspaceId)) as
          | StoredData
          | null
          | undefined;
        this.sessions = data?.version === 1 ? data.sessions : [];
        return this.sessions;
      })();
    }
    return this.loading;
  }

  private async persist() {
    if (!this.sessions) return;
    const actions = this.sessions.filter(s => s.action && !s.pinned);
    if (actions.length > MAX_ACTION_SESSIONS) {
      const drop = new Set(
        actions
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
          .slice(0, actions.length - MAX_ACTION_SESSIONS)
          .map(s => s.sessionId)
      );
      this.sessions = this.sessions.filter(s => !drop.has(s.sessionId));
    }
    await apis?.localAi.saveSessions(this.workspaceId, {
      version: 1,
      sessions: this.sessions,
    } satisfies StoredData);
  }

  async all() {
    return this.load();
  }

  async get(sessionId: string) {
    return (await this.load()).find(s => s.sessionId === sessionId) ?? null;
  }

  async require(sessionId: string) {
    const session = await this.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Chat session ${sessionId} not found`), {
        status: 404,
      });
    }
    return session;
  }

  async create(input: {
    docId?: string | null;
    promptName: string;
    pinned?: boolean | null;
    parentSessionId?: string | null;
    messages?: LocalChatMessage[];
  }) {
    const sessions = await this.load();
    const now = new Date().toISOString();
    const session: LocalChatSession = {
      sessionId: nanoid(),
      workspaceId: this.workspaceId,
      docId: input.docId ?? null,
      parentSessionId: input.parentSessionId ?? null,
      promptName: input.promptName,
      action: input.promptName === CHAT_PROMPT ? null : input.promptName,
      pinned: !!input.pinned,
      title: null,
      messages: input.messages ?? [],
      createdAt: now,
      updatedAt: now,
    };
    if (session.pinned) {
      sessions.forEach(s => (s.pinned = false));
    }
    sessions.push(session);
    await this.persist();
    return session;
  }

  async update(
    sessionId: string,
    patch: Partial<
      Pick<LocalChatSession, 'docId' | 'pinned' | 'promptName' | 'title'>
    >
  ) {
    const sessions = await this.load();
    const session = await this.require(sessionId);
    if (patch.pinned) {
      sessions.forEach(s => (s.pinned = false));
    }
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    if (patch.promptName) {
      session.action =
        patch.promptName === CHAT_PROMPT ? null : patch.promptName;
    }
    await this.persist();
    return session;
  }

  async addMessage(
    sessionId: string,
    message: Omit<LocalChatMessage, 'id' | 'createdAt' | 'scopeSnapshot'>
  ) {
    const session = await this.require(sessionId);
    const stored: LocalChatMessage = {
      ...message,
      id: nanoid(),
      scopeSnapshot: null,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(stored);
    session.updatedAt = stored.createdAt;
    if (!session.title && message.role === 'user' && message.content) {
      session.title = message.content.slice(0, 60);
    }
    await this.persist();
    return stored;
  }

  /** removes trailing assistant messages (used for "regenerate") */
  async dropTrailingAssistant(sessionId: string) {
    const session = await this.require(sessionId);
    while (session.messages.at(-1)?.role === 'assistant') {
      session.messages.pop();
    }
    await this.persist();
    return session;
  }

  async remove(sessionIds: string[]) {
    const ids = new Set(sessionIds);
    const sessions = await this.load();
    this.sessions = sessions.filter(s => !ids.has(s.sessionId));
    await this.persist();
    return sessionIds;
  }
}

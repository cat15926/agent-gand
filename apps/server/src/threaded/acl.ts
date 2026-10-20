import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Server-owned subjects. Browser input cannot choose an Agent viewer or system producer. */
export type ThreadedMessageViewer = { kind: 'owner' } | { kind: 'agent'; agentId: string };
export interface ThreadedMessageReadScope { ownerId: string; threadId: string; viewer: ThreadedMessageViewer }
export interface ThreadedAclMessage {
  id: string; ownerId: string; threadId: string;
  sender: { kind: 'user' | 'agent' | 'system'; agentId?: string };
  state: 'published' | 'draft'; visibility: 'public' | 'private'; audience: string[]; sourceRefs: string[];
}
export interface ThreadedMessageWriteAccess {
  ownerId: string; threadId: string;
  actor: { kind: 'owner' } | { kind: 'agent'; agentId: string; sourceThreadId: string } | { kind: 'system'; key: string };
  state: 'published' | 'draft'; visibility: 'public' | 'private'; audience: string[];
  targets: string[]; sourceRefs: string[];
}
export class ThreadedMessageAclError extends Error {
  readonly status = 403;
  readonly code = 'THREADED_MESSAGE_FORBIDDEN';
  constructor() { super('持续协作消息不存在或无权访问'); }
}
function deny(): never { throw new ThreadedMessageAclError(); }

/** Reads, attachments, search and derived sources all use this same authorization decision. */
export function createThreadedMessageAcl(db: Database.Database, options: {
  loadMessage?: (messageId: string) => ThreadedAclMessage | null;
} = {}) {
  const loadMessage = options.loadMessage ?? ((id: string) => {
    const row = db.prepare('SELECT record FROM threaded_messages WHERE id=?').get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as ThreadedAclMessage : null;
  });
  function threadOwned(threadId: string, ownerId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM threaded_threads t JOIN threaded_instances i
      ON i.singleton=1 AND i.instance_owner_id=t.owner_id WHERE t.id=? AND t.owner_id=? AND t.mode='threaded'`)
      .get(threadId, ownerId);
  }
  function member(threadId: string, ownerId: string, agentId: string): boolean {
    return !!db.prepare(`SELECT 1 FROM threaded_members m JOIN agents a ON a.id=m.agent_id
      WHERE m.thread_id=? AND m.owner_id=? AND m.agent_id=? AND m.status='joined'
      AND a.enabled=1 AND m.role_version=a.version`).get(threadId, ownerId, agentId);
  }
  function readable(scope: ThreadedMessageReadScope, message: ThreadedAclMessage, path: Set<string>,
    memo: Map<string, boolean>, sources: Map<string, ThreadedAclMessage | null>): boolean {
    if (!scope || !message || scope.ownerId !== message.ownerId || scope.threadId !== message.threadId
      || !threadOwned(scope.threadId, scope.ownerId) || path.has(message.id) || path.size >= 32) return false;
    const memoKey = `${message.id}:${path.size}`;
    if (memo.has(memoKey)) return memo.get(memoKey)!;
    if (scope.viewer.kind === 'agent') {
      if (!member(scope.threadId, scope.ownerId, scope.viewer.agentId)) return false;
      if (message.state === 'draft') {
        if (message.sender.kind !== 'agent' || message.sender.agentId !== scope.viewer.agentId) return false;
      } else if (message.visibility === 'private' && !message.audience.includes(scope.viewer.agentId)) return false;
    } else if (scope.viewer.kind !== 'owner') return false;
    const next = new Set(path); next.add(message.id);
    for (const sourceId of message.sourceRefs) {
      if (!sources.has(sourceId)) sources.set(sourceId, loadMessage(sourceId));
      const source = sources.get(sourceId);
      if (!source || !readable({ ...scope, threadId: source.threadId }, source, next, memo, sources)) {
        memo.set(memoKey, false); return false;
      }
    }
    memo.set(memoKey, true);
    return true;
  }
  function canRead(scope: ThreadedMessageReadScope, message: ThreadedAclMessage): boolean {
    // A fresh cache per decision preserves revocation checks while preventing a
    // diamond-shaped provenance graph from expanding exponentially on each read.
    return readable(scope, message, new Set(), new Map(), new Map());
  }
  function authorizeWrite(input: ThreadedMessageWriteAccess): void {
    if (!threadOwned(input.threadId, input.ownerId) || !input.actor
      || !['published', 'draft'].includes(input.state) || !['public', 'private'].includes(input.visibility)) deny();
    if (input.actor.kind === 'agent') {
      if (!member(input.actor.sourceThreadId, input.ownerId, input.actor.agentId)
        || !member(input.threadId, input.ownerId, input.actor.agentId)) deny();
      if (input.visibility === 'private' && !input.audience.includes(input.actor.agentId)) deny();
      if (input.actor.sourceThreadId !== input.threadId && !input.targets.length) deny();
    } else if (input.actor.kind !== 'owner' && (input.actor.kind !== 'system' || !input.actor.key)) deny();
    if (input.visibility === 'public' && input.audience.length) deny();
    if (input.state === 'draft' && input.targets.length) deny();
    for (const agentId of [...input.audience, ...input.targets]) if (!member(input.threadId, input.ownerId, agentId)) deny();
    // Delivery targets must be able to read, but they never grant additional audience membership.
    if (input.state === 'published' && input.visibility === 'private'
      && input.targets.some(agentId => !input.audience.includes(agentId))) deny();
    const viewer: ThreadedMessageViewer = input.actor.kind === 'agent'
      ? { kind: 'agent', agentId: input.actor.agentId } : { kind: 'owner' };
    for (const id of input.sourceRefs) {
      const source = loadMessage(id);
      if (!source || !canRead({ ownerId: input.ownerId, threadId: source.threadId, viewer }, source)) deny();
      const crossThread = source.threadId !== input.threadId;
      if (crossThread && (!input.targets.length || source.visibility !== 'public' || source.state !== 'published')) deny();
      if (input.state === 'published' && source.state !== 'published') deny();
      if (source.visibility === 'private') {
        if (input.visibility !== 'private' || input.audience.some(agentId => !source.audience.includes(agentId))) deny();
      }
    }
    // Evaluate the new node as well as its ancestors. Otherwise a reference at the
    // maximum allowed depth could create a committed message that nobody can read.
    const candidate: ThreadedAclMessage = { id: randomUUID(), ownerId: input.ownerId, threadId: input.threadId,
      sender: input.actor.kind === 'agent' ? { kind: 'agent', agentId: input.actor.agentId }
        : { kind: input.actor.kind === 'system' ? 'system' : 'user' },
      state: input.state, visibility: input.visibility, audience: input.audience, sourceRefs: input.sourceRefs };
    if (!canRead({ ownerId: input.ownerId, threadId: input.threadId, viewer }, candidate)) deny();
    // Every eligible reader must retain access to all explicit sources. Disabled
    // members cannot read now, and are checked again if their access later changes.
    const readers = input.state === 'draft' ? (viewer.kind === 'agent' ? [viewer.agentId] : [])
      : input.visibility === 'private' ? input.audience
        : (db.prepare(`SELECT m.agent_id FROM threaded_members m JOIN agents a ON a.id=m.agent_id
          WHERE m.thread_id=? AND m.owner_id=? AND m.status='joined' AND a.enabled=1 AND m.role_version=a.version`)
          .all(input.threadId, input.ownerId) as Array<{ agent_id: string }>).map(row => row.agent_id);
    for (const agentId of readers) if (!canRead({ ownerId: input.ownerId, threadId: input.threadId,
      viewer: { kind: 'agent', agentId } }, candidate)) deny();
  }
  return { authorizeWrite, canRead };
}

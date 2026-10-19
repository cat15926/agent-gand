import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedMemberRecord, ThreadedThreadRecord } from '@agent-gand/shared';

export type { ThreadedMemberRecord, ThreadedThreadRecord } from '@agent-gand/shared';

export interface CreateThreadedThreadInput {
  title: string;
  members: Array<{
    agentId: string;
    handle: string;
    roleVersion: number;
    accountVersion?: number | null;
    permissionVersion: number;
  }>;
  clientRequestId?: string;
}

export class ThreadedStoreError extends Error {
  constructor(readonly code: 'THREADED_INVALID_INPUT' | 'THREADED_IDEMPOTENCY_CONFLICT' | 'THREADED_SCHEMA_UNAVAILABLE', message: string = code) {
    super(message);
    this.name = 'ThreadedStoreError';
  }
}

type ThreadRow = {
  id: string; conversation_id: string; owner_id: string; title: string;
  schema_version: 1; mode: 'threaded'; state: ThreadedThreadRecord['state'];
  version: number; policy_version: number; authority_epoch: number;
  created_at: string; updated_at: string; request_hash: string;
};
type MemberRow = {
  thread_id: string; owner_id: string; agent_id: string; handle: string;
  schema_version: 1; role_version: number; account_version: number | null;
  permission_version: number; status: ThreadedMemberRecord['status']; version: number;
  created_at: string; updated_at: string;
};

function threadRecord(row: ThreadRow): ThreadedThreadRecord {
  return {
    schemaVersion: row.schema_version, id: row.id, conversationId: row.conversation_id,
    ownerId: row.owner_id, mode: row.mode, state: row.state, title: row.title,
    version: row.version, policyVersion: row.policy_version, authorityEpoch: row.authority_epoch,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function memberRecord(row: MemberRow): ThreadedMemberRecord {
  return {
    schemaVersion: row.schema_version, threadId: row.thread_id, ownerId: row.owner_id,
    agentId: row.agent_id, handle: row.handle, roleVersion: row.role_version,
    accountVersion: row.account_version, permissionVersion: row.permission_version,
    status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ThreadedStoreError('THREADED_INVALID_INPUT');
  }
  return value.trim();
}

function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ThreadedStoreError('THREADED_INVALID_INPUT');
  }
  return value;
}

/** Inject the database: importing this repository never opens the business database. */
export function createThreadedStore(db: Database.Database) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new ThreadedStoreError('THREADED_SCHEMA_UNAVAILABLE', 'Threaded storage requires foreign key enforcement');
  }

  const getInstanceOwnerId = (): string => {
    const row = db.prepare('SELECT instance_owner_id FROM threaded_instances WHERE singleton=1').get() as { instance_owner_id: string } | undefined;
    if (!row) throw new ThreadedStoreError('THREADED_SCHEMA_UNAVAILABLE');
    return row.instance_owner_id;
  };
  const getThread = (threadId: string, ownerId: string): ThreadedThreadRecord | null => {
    const row = db.prepare('SELECT * FROM threaded_threads WHERE id=? AND owner_id=?').get(threadId, ownerId) as ThreadRow | undefined;
    return row ? threadRecord(row) : null;
  };

  return {
    getInstanceOwnerId,
    getThread,
    listThreads(ownerId: string): ThreadedThreadRecord[] {
      return (db.prepare('SELECT * FROM threaded_threads WHERE owner_id=? ORDER BY created_at,id').all(ownerId) as ThreadRow[]).map(threadRecord);
    },
    listMembers(threadId: string, ownerId: string): ThreadedMemberRecord[] {
      if (!getThread(threadId, ownerId)) return [];
      return (db.prepare('SELECT * FROM threaded_members WHERE thread_id=? AND owner_id=? ORDER BY rowid').all(threadId, ownerId) as MemberRow[]).map(memberRecord);
    },
    /** Trusted server input only. It creates a closed room, never a Run or execution. */
    createThread(input: CreateThreadedThreadInput): ThreadedThreadRecord {
      const title = text(input.title, 200);
      if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 32) {
        throw new ThreadedStoreError('THREADED_INVALID_INPUT');
      }
      const members = input.members.map(member => {
        if (!member || typeof member !== 'object') throw new ThreadedStoreError('THREADED_INVALID_INPUT');
        const handle = text(member.handle, 80).normalize('NFC').toLowerCase();
        if (/[\s@]/u.test(handle)) throw new ThreadedStoreError('THREADED_INVALID_INPUT');
        return {
          agentId: text(member.agentId, 200), handle, roleVersion: positiveVersion(member.roleVersion),
          accountVersion: member.accountVersion == null ? null : positiveVersion(member.accountVersion),
          permissionVersion: positiveVersion(member.permissionVersion),
        };
      });
      if (new Set(members.map(m => m.agentId)).size !== members.length || new Set(members.map(m => m.handle)).size !== members.length) {
        throw new ThreadedStoreError('THREADED_INVALID_INPUT');
      }
      const clientRequestId = input.clientRequestId === undefined ? null : text(input.clientRequestId, 200);
      const requestHash = createHash('sha256').update(JSON.stringify({ title, members })).digest('hex');

      return db.transaction(() => {
        const ownerId = getInstanceOwnerId();
        if (clientRequestId !== null) {
          const existing = db.prepare('SELECT * FROM threaded_threads WHERE owner_id=? AND client_request_id=?').get(ownerId, clientRequestId) as ThreadRow | undefined;
          if (existing) {
            if (existing.request_hash !== requestHash) throw new ThreadedStoreError('THREADED_IDEMPOTENCY_CONFLICT');
            return threadRecord(existing);
          }
        }
        for (const member of members) {
          if (!db.prepare('SELECT 1 FROM agents WHERE id=? AND enabled=1').get(member.agentId)) {
            throw new ThreadedStoreError('THREADED_INVALID_INPUT', 'Thread member is unavailable');
          }
        }
        const id = randomUUID();
        const conversationId = randomUUID();
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO conversations(id,title,mode,agent_ids,members_version,created_at,updated_at)
          VALUES(?,?,'threaded',?,1,?,?)`).run(conversationId, title, JSON.stringify(members.map(m => m.agentId)), now, now);
        db.prepare(`INSERT INTO threaded_threads(id,conversation_id,owner_id,title,client_request_id,request_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(id, conversationId, ownerId, title, clientRequestId, requestHash, now, now);
        const insertMember = db.prepare(`INSERT INTO threaded_members(thread_id,owner_id,agent_id,handle,role_version,account_version,permission_version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`);
        for (const member of members) insertMember.run(id, ownerId, member.agentId, member.handle, member.roleVersion, member.accountVersion, member.permissionVersion, now, now);
        return getThread(id, ownerId)!;
      }).immediate();
    },
  };
}

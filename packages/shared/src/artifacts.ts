import type { MessageAccess } from './message.ts';
import type { RuntimeEvidenceRef } from './runtime.ts';

export interface SnapshotFile extends MessageAccess {
  path: string; sourceRunId: string; stageId: string | null; deliverableId: string | null;
  acceptanceVersion: number | null; sha256: string | null; size: number; mimeType: string;
  mode: number; sourceMode?: number; change: 'added' | 'modified' | 'unchanged' | 'deleted';
  storage: 'workspace' | 'managed'; artifactId?: string; artifactVersion?: number;
  workspaceScope?: string;
}
export interface ArtifactSnapshot {
  version: 1; id: string; runId: string; sourceVersion: number; sourceCreatedAt: string;
  stageIds: string[]; complete: boolean;
  declarations: Array<{ stageId: string; deliverableId: string; title: string; kind: 'text' | 'file'; present: boolean; sha256: string | null }>;
  files: SnapshotFile[];
  texts: Array<MessageAccess & {stageId:string;deliverableId:string;sourceRunId:string;acceptanceVersion:number|null;mimeType:'text/plain';ref:RuntimeEvidenceRef;sha256:string;size:number}>;
  git: null | { commit: string; tree: string; packSha256: string; files: Array<{ path: string; sha256: string; size: number; mode: number; objectId: string }> };
  omissions: Array<{ path: string; reason: string }>;
  limits: { fileBytes: number; totalBytes: number; maxFiles: number };
  payloadSha256: string;
}
export interface SnapshotPreview {
  snapshot: ArtifactSnapshot; fingerprint: string; blocked: string[];
}
export interface SnapshotRestorePreview {
  snapshot: ArtifactSnapshot; digest: string; fingerprint: string;
  /** Private managed bytes stay encrypted and are never copied into a native working directory. */
  encryptedFiles: number; physicalFiles: number;
}

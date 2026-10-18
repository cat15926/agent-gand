import { createHash, randomUUID } from 'node:crypto';
import { isMessageVisibleTo, isMessageWithinScope, intersectMessageAccess, type MessageAccess, type ExecutionScopeV1,
  type ContextManifestV1, type ScopedSourceRef, type InputProvenanceV1, type ScopedCollaborationErrorCode } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { runSourceAccess, attemptAccess } from '../messaging/access.ts';
import { getManagedArtifact, readManagedArtifact } from '../artifacts/store.ts';
import { loadRuntimeContract, resolveRunPolicy } from './runPolicy.ts';
import { persistRuntimeContextAssembly } from './context.ts';
import { captureExecutionBinding, assertBindingAuthorized } from '../execution/authority.ts';
import {assertAutonomousGrant} from './autonomousTasks.ts';
import {autonomousDigest} from './autonomousPolicy.ts';
import {validateAutonomousDerivedSource} from './autonomousResults.ts';

export class ScopedCollaborationError extends Error {
  readonly retryable = false;
  readonly allowedRecovery: string[] = [];
  readonly diagnosticRef = null;
  constructor(readonly code: ScopedCollaborationErrorCode) { super(code); }
}
const fail = (code: ScopedCollaborationErrorCode): never => { throw new ScopedCollaborationError(code); };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function access(value: MessageAccess): MessageAccess {
  if (!value || !['public', 'private'].includes(value.visibility) || !Array.isArray(value.audience)
    || value.audience.some(id => typeof id !== 'string' || !id)) return fail('SCOPE_NOT_READABLE');
  return { visibility: value.visibility, audience: value.visibility === 'public' ? [] : [...new Set(['user', ...value.audience])].sort() };
}
function contract(runId: string) {
  const c = loadRuntimeContract(runId);
  resolveRunPolicy(runId);
  if ([1,2].includes(c?.features?.coordinationScopes ?? 0)) return c!;
  if(c?.features?.autonomousCollaboration?.delegationVersion===1)return c;
  if (!c?.features?.scopedCollaboration || c.features.controlActionVersion !== 3 || c.executionPolicy?.toolApiVersion !== 3) fail('SCOPE_BINDING_INVALID');
  return c!;
}
/** Source references are compiled by the server, never accepted as evidence of authority. */
function source(runId: string, kind: ScopedSourceRef['kind'], id: string, viewer: string) {
  let bytes: Buffer, policy: MessageAccess, version: number;
  if (kind === 'message') {
    const row = get<{ body: string; visibility: 'public' | 'private'; audience: string; seq: number }>(
      'SELECT body,visibility,audience,seq FROM messages WHERE id=? AND run_id=?', id, runId);
    if (!row) return fail('SCOPE_NOT_READABLE');
    policy = access({ visibility: row.visibility, audience: JSON.parse(row.audience) });
    if (!isMessageVisibleTo(policy, viewer)) return fail('SCOPE_NOT_READABLE');
    bytes = Buffer.from(row.body); version = row.seq;
  } else if (kind === 'artifact') {
    try {
      const item = getManagedArtifact(id, viewer);
      if (item.runId !== runId) return fail('SCOPE_NOT_READABLE');
      bytes = readManagedArtifact(id, viewer); policy = access(item); version = item.version;
    } catch { return fail('SCOPE_NOT_READABLE'); }
  } else if (kind === 'tool_execution') {
    const row = get<{ output: string | null; attempt_id: string; agent_id: string }>(
      "SELECT output,attempt_id,agent_id FROM tool_executions WHERE id=? AND run_id=? AND status='completed'", id, runId);
    if (!row || row.output === null || !row.attempt_id || (viewer !== 'user' && row.agent_id !== viewer)) return fail('SCOPE_NOT_READABLE');
    policy = access(attemptAccess(row.attempt_id));
    if (!isMessageVisibleTo(policy, viewer)) return fail('SCOPE_NOT_READABLE');
    bytes = Buffer.from(row.output); version = 1;
  } else return fail('SCOPE_NOT_READABLE');
  // Includes ACL/run/version: editing metadata cannot preserve a reference fingerprint.
  const ref: ScopedSourceRef = { kind, id, version, sha256: hash(JSON.stringify({ runId, version, policy, content: hash(bytes) })) };
  return { ref, bytes, policy };
}
export function compileScopedSource(runId: string, kind: ScopedSourceRef['kind'], id: string): ScopedSourceRef {
  contract(runId);
  return source(runId, kind, id, 'user').ref;
}
/** Trusted policy compiler only. Returns identity/ACL, never content to a model. */
export function inspectScopedSource(runId:string,kind:ScopedSourceRef['kind'],id:string):{ref:ScopedSourceRef;access:MessageAccess} {
  const value=source(runId,kind,id,'user');
  return {ref:value.ref,access:value.policy};
}
/** Trusted Owner preview/transport only; never exposed as a model tool. */
export function readScopedSourceForOwner(runId:string,ref:ScopedSourceRef):Buffer {
  const value=source(runId,ref.kind,ref.id,'user');
  if(JSON.stringify(value.ref)!==JSON.stringify(ref))fail('SOURCE_VERSION_CHANGED');
  return value.bytes;
}
/** Validate opaque forwarding authority without exposing its bytes to the coordinator. */
export function assertScopedSourceForRecipient(runId: string, ref: ScopedSourceRef, recipient: string): void {
  const c = contract(runId);
  if (!c.participantIds.includes(recipient)) fail('SCOPE_NOT_READABLE');
  const value = source(runId, ref.kind, ref.id, recipient);
  if (JSON.stringify(value.ref) !== JSON.stringify(ref)) fail('SOURCE_VERSION_CHANGED');
  if (!isMessageWithinScope(value.policy, { visibility: 'private', audience: ['user', recipient] })) fail('SCOPE_NOT_READABLE');
}
const key = (ref: ScopedSourceRef) => JSON.stringify([ref.kind, ref.id, ref.version, ref.sha256]);
function checkedSource(scope: ExecutionScopeV1, ref: ScopedSourceRef) {
  const value = source(scope.runId, ref.kind, ref.id, scope.agentId);
  if (key(value.ref) !== key(ref)) return fail('SOURCE_VERSION_CHANGED');
  if(contract(scope.runId).features?.autonomousCollaboration?.deliveryVersion===1)validateAutonomousDerivedSource(scope.runId,ref);
  if (!isMessageWithinScope(value.policy, scope.defaultOutputAccess)) return fail('SCOPE_NOT_READABLE');
  return value;
}
function assertScope(scope: ExecutionScopeV1) {
  const c = contract(scope.runId);
  const runState = get<{ status: string }>('SELECT status FROM runs WHERE id=?', scope.runId);
  if (!runState || ['completed', 'failed', 'cancelled'].includes(runState.status)) fail('SCOPE_BINDING_INVALID');
  const rootMessage = get<{ id: string }>("SELECT id FROM messages WHERE run_id=? AND kind='user' ORDER BY seq LIMIT 1", scope.runId);
  if (!rootMessage) return fail('SCOPE_BINDING_INVALID');
  const root = intersectMessageAccess([runSourceAccess(scope.runId), source(scope.runId, 'message', rootMessage.id, scope.agentId).policy]);
  if (!c.participantIds.includes(scope.agentId) || !isMessageVisibleTo(root, scope.agentId)
    || !isMessageVisibleTo(scope.defaultOutputAccess, scope.agentId)
    || !isMessageWithinScope(root, scope.defaultOutputAccess)
    || scope.defaultOutputAccess.audience.some(id => id !== 'user' && !c.participantIds.includes(id))) fail('SCOPE_NOT_READABLE');
  const subject = get<{ status: string }>('SELECT status FROM runtime_subjects WHERE id=? AND run_id=?', scope.subjectId, scope.runId);
  const custody = get<{ holder_agent_id: string; generation: number; state: string }>('SELECT holder_agent_id,generation,state FROM runtime_custody WHERE subject_id=?', scope.subjectId);
  if (!subject || subject.status !== 'active' || custody?.holder_agent_id !== scope.agentId
    || custody.generation !== scope.recoveryGeneration || custody.state !== 'owned') fail('SCOPE_BINDING_INVALID');
  if ((c.features!.scopedCollaboration?.policyRevision ?? 1) !== scope.policyRevision) fail('SCOPE_BINDING_INVALID');
  if(c.features?.autonomousCollaboration){
    const binding=get<{grant_id:string;attempt_id:string}>(`SELECT b.grant_id,b.attempt_id FROM autonomous_attempt_grants b
      JOIN autonomous_task_grants g ON g.id=b.grant_id JOIN collaboration_attempts a ON a.id=b.attempt_id
      WHERE b.run_id=? AND g.subject_id=? AND g.agent_id=? AND b.generation=? AND a.status='running'`,scope.runId,scope.subjectId,scope.agentId,scope.recoveryGeneration);
    if(!binding)fail('SCOPE_BINDING_INVALID');
    const {grant}=assertAutonomousGrant({runId:scope.runId,grantId:binding!.grant_id,attemptId:binding!.attempt_id});
    if(!isMessageWithinScope(grant.outputAccess,scope.defaultOutputAccess))fail('SCOPE_NOT_READABLE');
  }
  if (c.features!.scopedCollaboration?.deliveryVersion === 1) {
    const deadline = get<{ deadline: string }>("SELECT json_extract(record,'$.deadlineAt') deadline FROM scoped_delivery_plans WHERE run_id=?",scope.runId)?.deadline;
    if (!deadline || Date.now() >= Date.parse(deadline)) fail('SCOPE_BINDING_INVALID');
  }
}
export function createExecutionScope(input: {
  runId: string; subjectId: string; agentId: string; kind: 'control' | 'content';
  defaultOutputAccess: MessageAccess; recoveryGeneration: number;
  objective: ScopedSourceRef; inputs: ScopedSourceRef[]; dynamicInputs?: ScopedSourceRef[]; allowedTools?: string[];
}): ExecutionScopeV1 {
  return tx(() => {
    const features=contract(input.runId).features!;
    const c = features.autonomousCollaboration ?? features.scopedCollaboration ?? { policyRevision:1, capabilityPackage:'scoped-control-v1' as const };
    if (!['control', 'content'].includes(input.kind)) return fail('SCOPE_BINDING_INVALID');
    const id = randomUUID(), manifestId = randomUUID();
    const scope: ExecutionScopeV1 = { version: 1, id, runId: input.runId, subjectId: input.subjectId,
      agentId: input.agentId, kind: input.kind, contextManifestId: manifestId, contextManifestRevision: 1,
      defaultOutputAccess: access(input.defaultOutputAccess), policyRevision: c.policyRevision,
      recoveryGeneration: input.recoveryGeneration, sessionBoundaryId: randomUUID() };
    assertScope(scope);
    const unique = (refs: ScopedSourceRef[]) => [...new Map(refs.map(ref => [key(ref), ref])).values()];
    const unsigned = { version: 1 as const, id: manifestId, runId: input.runId, scopeId: id, revision: 1 as const,
      objective: input.objective, inputs: unique(input.inputs), dynamicInputs: unique(input.dynamicInputs ?? []),
      allowedTools: [...new Set(input.allowedTools ?? [])].sort(), policyRevision: c.policyRevision, capabilityPackage: c.capabilityPackage };
    if (unsigned.allowedTools.some(name => typeof name !== 'string' || !name.trim())) fail('SCOPE_BINDING_INVALID');
    for (const ref of [unsigned.objective, ...unsigned.inputs, ...unsigned.dynamicInputs]) checkedSource(scope, ref);
    const manifest: ContextManifestV1 = { ...unsigned, sha256: hash(JSON.stringify(unsigned)) };
    const now = new Date().toISOString();
    run('INSERT INTO runtime_execution_scopes VALUES (?,?,?,?,?,?)', id, input.runId, input.subjectId, manifestId, JSON.stringify(scope), now);
    run('INSERT INTO runtime_context_manifests VALUES (?,?,?,?)', manifestId, id, JSON.stringify(manifest), now);
    return scope;
  });
}
export interface ScopedAttemptBinding { runId: string; scopeId: string; attemptId: string; agentId: string; }
function bound(input: ScopedAttemptBinding, requireBound = true) {
  const row = get<{ record: string }>('SELECT record FROM runtime_execution_scopes WHERE id=? AND run_id=?', input.scopeId, input.runId);
  if (!row) return fail('SCOPE_BINDING_INVALID');
  const scope = JSON.parse(row.record) as ExecutionScopeV1;
  if (scope.agentId !== input.agentId) return fail('SCOPE_BINDING_INVALID');
  assertScope(scope);
  let attempt = get<{ subject_id: string; expected_generation: number; status: string; lease_expires_at: string }>(`SELECT s.subject_id,
    CASE WHEN json_extract(c.payload,'$.features.scopedCollaboration.deliveryVersion')=1 OR json_extract(c.payload,'$.features.autonomousCollaboration.delegationVersion')=1
      THEN (SELECT generation FROM runtime_custody_events WHERE source_event_id='claim:' || a.id)
      ELSE s.expected_generation END expected_generation,a.status,a.lease_expires_at
    FROM collaboration_attempts a JOIN runtime_dispatch_subjects s ON s.dispatch_id=a.dispatch_id
    JOIN runtime_contracts c ON c.run_id=a.run_id
    WHERE a.id=? AND a.run_id=? AND a.agent_id=?`, input.attemptId, input.runId, input.agentId);
  if (!attempt && [1,2].includes(contract(input.runId).features?.coordinationScopes ?? 0)) {
    try {
      const authority = captureExecutionBinding(input.runId,input.agentId,input.attemptId);
      assertBindingAuthorized(authority);
      if (authority.origin !== 'coordination_step_attempt') return fail('SCOPE_BINDING_INVALID');
      attempt = { subject_id:authority.subjectId, expected_generation:authority.generation, status:'running', lease_expires_at:authority.leaseExpiresAt };
    } catch { return fail('SCOPE_BINDING_INVALID'); }
  }
  if (!attempt || attempt.subject_id !== scope.subjectId || attempt.expected_generation !== scope.recoveryGeneration
    || attempt.status !== 'running' || !attempt.lease_expires_at || !Number.isFinite(Date.parse(attempt.lease_expires_at))
    || Date.parse(attempt.lease_expires_at) <= Date.now()) return fail('SCOPE_BINDING_INVALID');
  const binding = get<{ scope_id: string }>('SELECT scope_id FROM runtime_scope_attempts WHERE attempt_id=?', input.attemptId);
  if ((requireBound && !binding) || (binding && binding.scope_id !== scope.id)) return fail('SCOPE_BINDING_INVALID');
  const record = get<{ record: string }>('SELECT record FROM runtime_context_manifests WHERE id=? AND scope_id=?', scope.contextManifestId, scope.id);
  if (!record) return fail('CONTEXT_MANIFEST_DRIFT');
  const manifest = JSON.parse(record.record) as ContextManifestV1;
  const { sha256, ...unsigned } = manifest;
  if (hash(JSON.stringify(unsigned)) !== sha256 || manifest.scopeId !== scope.id || manifest.runId !== scope.runId
    || manifest.policyRevision !== scope.policyRevision) return fail('CONTEXT_MANIFEST_DRIFT');
  if(contract(input.runId).features?.autonomousCollaboration){
    const binding=get<{grant_id:string}>('SELECT grant_id FROM autonomous_attempt_grants WHERE attempt_id=? AND run_id=?',input.attemptId,input.runId);
    if(!binding)fail('SCOPE_BINDING_INVALID');
    const {grant}=assertAutonomousGrant({runId:input.runId,grantId:binding!.grant_id,attemptId:input.attemptId});
    if(grant.subjectId!==scope.subjectId||manifest.capabilityPackage!=='autonomous-collaboration-v1'||manifest.allowedTools.some(name=>!grant.allowedTools.includes(name)))fail('SCOPE_BINDING_INVALID');
  }
  return { scope, manifest };
}
function append(input: ScopedAttemptBinding, ref: ScopedSourceRef, channel: InputProvenanceV1['channel']) {
  const sequence = inputLedgerRevision(input.attemptId) + 1;
  const record: InputProvenanceV1 = { version: 1, attemptId: input.attemptId, sequence, scopeId: input.scopeId,
    source: ref, channel, accessDecision: 'allowed', exposure: 'possibly_exposed', createdAt: new Date().toISOString() };
  run('INSERT INTO runtime_input_provenance VALUES (?,?,?,?)', input.attemptId, sequence, input.scopeId, JSON.stringify(record));
}
export function inputLedgerRevision(attemptId: string): number {
  return get<{ n: number }>('SELECT COALESCE(MAX(sequence),0) n FROM runtime_input_provenance WHERE attempt_id=?', attemptId)!.n;
}
/** All bytes are resolved from the whitelist; no room history, root goal fallback or native history. */
export function assembleScopedContext(input: ScopedAttemptBinding): string {
  return tx(() => {
    const { scope, manifest } = bound(input, false);
    const refs = [manifest.objective, ...manifest.inputs];
    const context = refs.map(ref => checkedSource(scope, ref).bytes.toString('utf8')).join('\n\n');
    if (context.length > 24_000) return fail('CONTEXT_MANIFEST_DRIFT');
    const existing = get<{ context_sha256: string }>('SELECT context_sha256 FROM runtime_scope_attempts WHERE attempt_id=?', input.attemptId);
    if (existing && existing.context_sha256 !== hash(context)) return fail('CONTEXT_MANIFEST_DRIFT');
    persistRuntimeContextAssembly({ runId: input.runId, workItemId: scope.subjectId, attemptId: input.attemptId,
      segments: [], context, access: scope.defaultOutputAccess });
    if (!existing) {
      run('INSERT INTO runtime_scope_attempts VALUES (?,?,?,?)', input.attemptId, scope.id, hash(context), new Date().toISOString());
      for (const ref of refs) append(input, ref, 'prompt');
    }
    return context;
  });
}
/** Unknown bytes are refused. Tool/MCP results require a completed, same-Attempt execution ledger. */
export function exposeScopedInput(input: ScopedAttemptBinding, ref: ScopedSourceRef,
  channel: InputProvenanceV1['channel'], toolName?: string): Buffer {
  return tx(() => {
    const { scope, manifest } = bound(input);
    if (!['file_read', 'tool_result', 'mcp_result', 'supplement'].includes(channel)) return fail('SCOPE_NOT_READABLE');
    if (channel !== 'supplement' && (!toolName || !manifest.allowedTools.includes(toolName))) return fail('SCOPE_NOT_READABLE');
    const producedHere = ref.kind === 'tool_execution' && ['tool_result', 'mcp_result'].includes(channel)
      && Boolean(get("SELECT 1 FROM tool_executions WHERE id=? AND run_id=? AND attempt_id=? AND agent_id=? AND tool_name=? AND status='completed'",
        ref.id, input.runId, input.attemptId, input.agentId, toolName));
    const ownArtifact = ref.kind === 'artifact' && channel === 'file_read' && Boolean(get("SELECT 1 FROM managed_artifact_versions WHERE id=? AND run_id=? AND json_extract(record,'$.attemptId')=? AND json_extract(record,'$.createdBy')=?",ref.id,input.runId,input.attemptId,input.agentId));
    const receipt=ref.kind==='message'&&channel==='supplement'&&contract(input.runId).features?.autonomousCollaboration?.deliveryVersion===1&&get<{record:string;sha256:string}>('SELECT record,sha256 FROM autonomous_tool_receipts WHERE message_id=? AND attempt_id=? AND scope_id=?',ref.id,input.attemptId,input.scopeId);
    if(receipt&&(autonomousDigest(JSON.parse(receipt.record))!==receipt.sha256||autonomousDigest(ref)!==receipt.sha256))return fail('SOURCE_VERSION_CHANGED');
    const instruction=ref.kind==='message'&&channel==='supplement'&&contract(input.runId).features?.autonomousCollaboration?.entryVersion===1&&get('SELECT 1 FROM autonomous_user_instructions WHERE run_id=? AND message_id=?',input.runId,ref.id);
    if (!producedHere && !ownArtifact && !receipt && !instruction && ![manifest.objective, ...manifest.inputs, ...manifest.dynamicInputs].some(item => key(item) === key(ref))) return fail('SCOPE_NOT_READABLE');
    const value = checkedSource(scope, ref);
    append(input, ref, channel); // commit before returning bytes; crashes retain conservative exposure
    return value.bytes;
  });
}
export function assertScopedOutput(input: ScopedAttemptBinding & { ledgerRevision: number; outputAccess: MessageAccess }): void {
  if (!Number.isSafeInteger(input.ledgerRevision) || input.ledgerRevision < 1) fail('INPUT_LEDGER_STALE');
  const { scope } = bound(input);
  if (inputLedgerRevision(input.attemptId) !== input.ledgerRevision) fail('INPUT_LEDGER_STALE');
  const output = access(input.outputAccess);
  if (!isMessageWithinScope(scope.defaultOutputAccess, output)) fail('PRIVATE_OUTPUT_REQUIRES_RELEASE');
  const rows = all<{ record: string }>('SELECT record FROM runtime_input_provenance WHERE attempt_id=? ORDER BY sequence', input.attemptId);
  for (const row of rows) {
    const entry = JSON.parse(row.record) as InputProvenanceV1;
    if (entry.scopeId !== scope.id) fail('SCOPE_BINDING_INVALID');
    const value = checkedSource(scope, entry.source);
    if (!isMessageWithinScope(value.policy, output)) fail('PRIVATE_OUTPUT_REQUIRES_RELEASE');
  }
}
/** Callbacks are synchronous SQLite effects; no network/async work belongs in the transaction. */
export function commitScopedOutput<T>(input: ScopedAttemptBinding & { ledgerRevision: number; outputAccess: MessageAccess }, execute: () => T): T {
  return tx(() => {
    assertScopedOutput(input);
    const value = execute();
    if (value && typeof (value as { then?: unknown }).then === 'function') fail('SCOPE_BINDING_INVALID');
    // Legitimate effects may complete/transfer the Subject. Only the exposure revision must remain fixed.
    if (inputLedgerRevision(input.attemptId) !== input.ledgerRevision) fail('INPUT_LEDGER_STALE');
    return value;
  });
}
export function scopedSessionBoundary(input: ScopedAttemptBinding) {
  const { scope, manifest } = bound(input);
  return { scopeId: scope.id, manifestId: manifest.id, manifestRevision: manifest.revision, manifestSha256: manifest.sha256,
    policyRevision: scope.policyRevision, recoveryGeneration: scope.recoveryGeneration,
    sessionBoundaryId: scope.sessionBoundaryId, resumeAllowed: false as const };
}

/** Check both declaration and invocation; a mutable role tool list grants no Scope authority. */
export function assertScopedTool(input: ScopedAttemptBinding, name: string): void {
  const { scope, manifest } = bound(input);
  if (!manifest.allowedTools.includes(name)) fail('SCOPE_NOT_READABLE');
  assertScopedOutput({ ...input, ledgerRevision: inputLedgerRevision(input.attemptId), outputAccess: scope.defaultOutputAccess });
}

/** Read server-frozen authority; callers cannot add tool names or source identities. */
export function scopedToolPolicy(input: ScopedAttemptBinding) {
  const {scope,manifest}=bound(input);
  return {access:scope.defaultOutputAccess,tools:[...manifest.allowedTools],sources:[manifest.objective,...manifest.inputs,...manifest.dynamicInputs]};
}

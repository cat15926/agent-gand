import {randomUUID} from 'node:crypto';

export function nativeScopeFixture({db,scopes,policy,freezeRuntimeContract,post}, privateRoot = false, scoped = true) {
  const now=new Date().toISOString(),privateAccess={visibility:'private',audience:['a','user']};
  const runId = randomUUID(), roomId = randomUUID(), subjectId = randomUUID(), dispatchId = randomUUID();
  db.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)', roomId, 'G1 fixture', 'collaboration', '["a","b"]', now, now);
  db.run('INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,?,?,?,?,?,?)', runId, 'ROOT_MUST_NOT_BE_INJECTED', 'collaboration', roomId, 'running', '["a","b"]', now);
  const rootMessage = post({ runId, from: 'user', to: 'a', kind: 'user', body: 'ROOT_MUST_NOT_BE_INJECTED', ...(privateRoot ? privateAccess : {}) });
  const contract = { version: 1, runId, objective: 'ROOT_MUST_NOT_BE_INJECTED', participantIds: ['a', 'b'], requiredSubjectKeys: ['root:a'],
    completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
    executionPolicy: policy.executionPolicyForProfile('execute', { toolApiVersion: scoped ? 3 : 2, implicitAnswerPolicy: 'explicit_only' }),
    features: { completionEngine: true, controlActionVersion: scoped ? 3 : 2, messageVisibilityVersion: 1,
      completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1, contextContributorVersion: 1,
      durableHoldVersion: 2, exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 },
      ...(scoped ? {scopedCollaboration: { boundaryVersion: 2, manifestVersion: 1, provenanceVersion: 1, policyRevision: 1, capabilityPackage: 'scoped-control-v1' }} : {}) } };
  freezeRuntimeContract(contract);
  db.run('INSERT INTO runtime_subjects VALUES(?,?,?,?,?,?,?,?,?)', subjectId, runId, 'root:a', 'root', null, 'active', 'review', now, now);
  db.run('INSERT INTO runtime_custody VALUES(?,?,?,?,?,?,?)', subjectId, 'owned', 'a', null, 1, 1, now);
  db.run('INSERT INTO collaboration_dispatches(id,run_id,conversation_id,source_message_id,kind,from_actor,target_agent_id,status,depth,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', dispatchId, runId, roomId, rootMessage.id, 'initial', 'user', 'a', 'running', 0, dispatchId, now);
  db.run('INSERT INTO runtime_dispatch_subjects VALUES(?,?,?)', dispatchId, subjectId, 1);
  let attemptNo = 0;
  const attempt = () => {
    const id = randomUUID();
    db.run('INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_owner,lease_expires_at,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, dispatchId, runId, roomId, 'a', ++attemptNo, 'running', 'g1-fixture', new Date(Date.now() + 60000).toISOString(), now, now);
    db.run('INSERT INTO runtime_custody_events(id,run_id,subject_id,source_event_id,kind,holder_agent_id,generation,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)',randomUUID(),runId,subjectId,'claim:'+id,'custody.acquired','a',1,'{}',now);
    return id;
  };
  const message = (body, acl = privateAccess) => scopes.compileScopedSource(runId, 'message', post({ runId, from: 'user', to: acl.visibility === 'private' && !acl.audience.includes('a') ? 'b' : 'a', kind: 'agent', body, ...acl }).id);
  const create = (objective, more = {}) => scopes.createExecutionScope({ runId, subjectId, agentId: 'a', kind: 'content', recoveryGeneration: 1, defaultOutputAccess: privateAccess, objective, inputs: [], ...more });
  const binding = scope => ({ runId, scopeId: scope.id, attemptId: attempt(), agentId: 'a' });
  return { runId, roomId, subjectId, dispatchId, contract, message, create, binding };
}

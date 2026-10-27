import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { createExecutionResourceCoordinator } from '../execution/resources/coordinator.ts';
import { assertExpectedNativeSession, canonicalWorkspace } from '../execution/resources/sessions.ts';
import { createThreadedAuthority } from './authority.ts';
import { createThreadedContext } from './context.ts';
import { createThreadedSessionContext } from './sessionContext.ts';
import { createThreadedRuntime } from './runtime.ts';
import { recoverThreadedBackendFacts } from './backendRecovery.ts';
import { ThreadedAuthorityError, type InvocationExecutionPort } from './contracts.ts';
import type { BudgetQuote } from './budgetTypes.ts';
import type { ThreadedQueuePreparationContext, ThreadedQueueClaim } from './queueContracts.ts';
import type { ThreadedSessionContextDecision, ThreadedSessionAnchorEvidence } from './sessionContextTypes.ts';
import type { ThreadedContextBudget } from './contextTypes.ts';
import type { BackendAdapterOptions, BackendExecuteInput, BackendPreparedInput, BackendRequestDescription, BackendFetch, BackendSdkProcess } from './backends/types.ts';
import { createApiBackend } from './backends/api.ts';
import { createClaudeSdkBackend } from './backends/claudeSdk.ts';
import { createThreadedBackendRegistry } from './backends/registry.ts';
import type { ThreadedTrackingSource } from './tracking.ts';
import { createThreadedBackendEvidence, verifyThreadedBackendUsage, verifyThreadedBackendDelivery,
  verifyThreadedBackendAnchor, verifyThreadedBackendCompaction } from './backends/evidence.ts';

/** Server-selected configuration. HTTP/model callers cannot provide connections or identities. */
export interface ThreadedBackendAgentConfiguration {
  kind: 'api' | 'claude-sdk';
  backendVersion: string;
  model: string;
  instructions: string;
  workspace: string;
  configDir: string;
  informationBoundary: string;
  contextBudget: ThreadedContextBudget;
  quote: BudgetQuote;
  maxRequests?: number;
  connection: BackendPreparedInput['connection'];
  apiProtocol?: BackendPreparedInput['apiProtocol'];
  price?: BackendPreparedInput['price'];
  applicationTools?: string[];
}
type StoredPreparation = { session: ThreadedSessionContextDecision['session'];
  threadedContext: { decision: ThreadedSessionContextDecision; configurationHash: string } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code: string): never => { throw new ThreadedAuthorityError(code); };
const configurationHash = (value: ThreadedBackendAgentConfiguration) => hash({
  kind: value.kind, backendVersion: value.backendVersion, model: value.model, instructions: value.instructions,
  workspace: canonicalWorkspace(value.workspace), configDir: canonicalWorkspace(value.configDir), informationBoundary: value.informationBoundary,
  contextBudget: value.contextBudget, quote: value.quote, maxRequests: value.maxRequests ?? 4,
  endpoint: value.connection.baseUrl, timeoutMs: value.connection.timeoutMs,
  apiProtocol: value.apiProtocol ?? null, price: value.price ?? null,
  applicationTools: value.applicationTools ?? [],
});

/** T07 composition. Its explicit caller supplies isolated DB/resources and selected account access. */
export function createThreadedBackendRuntime(db: Database.Database, options: {
  resources: ReturnType<typeof createExecutionResourceCoordinator>;
  messaging?:ReturnType<typeof import('./messaging.ts').createThreadedMessaging>;
  executionPolicy?:import('./runtime.ts').ThreadedProductionExecutionPolicy;
  ingress?:import('./collaborationTypes.ts').CollaborationOptions['ingress'];
  holdPolicy?:import('./collaborationTypes.ts').CollaborationOptions['holdPolicy'];
  waitSourceAuthorization?:import('./collaborationTypes.ts').CollaborationOptions['waitSourceAuthorization'];
  deferDispatchUntilStart?:boolean;
  notificationsEnabled?:boolean;
  resolveAgent: (scope: { ownerId: string; threadId: string; agentId: string }) => ThreadedBackendAgentConfiguration;
  fetch?: BackendFetch;
  sdkProcess?: BackendSdkProcess;
  now?: () => number;
  dispatchEnabled?: boolean;
  autoStart?: boolean;
  repairIntervalMs?: number;
  ownerNonce?: string;
  trackingSources?:Record<string,ThreadedTrackingSource>;
  actions?:import('./actionTypes.ts').ActionOptions;
  /** Optional additional operator acceptance cap; reserve runs in the admission transaction. */
  onRequestReserved?: (authorizationId: string, request: BackendRequestDescription) => void;
  onRequestSettled?: (authorizationId: string, receipt: { inputTokens: number | null; outputTokens: number | null }) => void;
}) {
  const authority = createThreadedAuthority(db, options.resources);
  const evidence = createThreadedBackendEvidence(db, { now: options.now });
  let runtime: ReturnType<typeof createThreadedRuntime>;
  const context = createThreadedContext(db, { authority, now: options.now,
    assertExecutable: binding => runtime.queue.assertExecutable(binding),
    verifyDeliveryEvidence: (binding, manifest, _intent, outcome) => verifyThreadedBackendDelivery(db, binding, manifest, outcome),
  });
  const sessionContext = createThreadedSessionContext(db, { authority, context, now: options.now,
    verifyAnchor: (binding, manifest, decision, value, proof) => verifyThreadedBackendAnchor(db, binding, manifest, decision, value, proof),
    verifyCompaction: (binding, manifest, decision, value) => verifyThreadedBackendCompaction(db, binding, manifest, decision, value),
  });
  function stored(binding: ThreadedBinding): StoredPreparation {
    const row = db.prepare(`SELECT q.preparation FROM threaded_wake_queue q JOIN threaded_invocation_wakes w
      ON w.queue_id=q.id WHERE w.invocation_id=? AND q.owner_id=? AND q.thread_id=? AND q.agent_id=?`)
      .get(binding.invocationId, binding.ownerId, binding.threadId, binding.agentId) as { preparation: string | null } | undefined;
    if (!row?.preparation) return fail('THREADED_BACKEND_PREPARATION_REQUIRED');
    const result = JSON.parse(row.preparation) as StoredPreparation;
    if (!result.threadedContext?.decision) return fail('THREADED_BACKEND_PREPARATION_REQUIRED');
    return result;
  }
  function configuration(binding: ThreadedBinding) {
    const value = options.resolveAgent(binding), preparation = stored(binding);
    if (configurationHash(value) !== preparation.threadedContext.configurationHash) fail('THREADED_BACKEND_CONFIGURATION_CHANGED');
    return { value, decision: preparation.threadedContext.decision };
  }
  function assertContext(binding: ThreadedBinding) {
    const { decision } = configuration(binding);
    const row = db.prepare(`SELECT id FROM threaded_context_manifests WHERE binding_id=? ORDER BY rowid DESC LIMIT 1`)
      .get(binding.id) as { id: string } | undefined;
    if (!row) fail('THREADED_CONTEXT_MANIFEST_REQUIRED');
    sessionContext.assertForManifest(binding, row!.id, decision);
  }
  function prepareResources(scope: ThreadedQueuePreparationContext) {
    const value = options.resolveAgent(scope.queue);
    const decision = sessionContext.prepare({ ownerId: scope.queue.ownerId, threadId: scope.queue.threadId,
      agentId: scope.queue.agentId, backend: value.kind, backendVersion: value.backendVersion, model: value.model,
      workspace: value.workspace, informationBoundary: `${value.informationBoundary}:execution:${hash({
        instructions: value.instructions, configDir: canonicalWorkspace(value.configDir),
        nativeTools: value.kind === 'claude-sdk' ? ['Read', 'Grep', 'Glob'] : [], applicationTools: value.applicationTools ?? [],
      })}`, inputMaxSeq: scope.queue.inputMaxSeq });
    const policy = db.prepare('SELECT record FROM execution_resource_sessions WHERE id=? AND version=?')
      .get(decision.session.id, decision.session.version) as { record: string };
    const account = (JSON.parse(policy.record) as { policy: { account: { id: string; identity_generation: number | null } | null } }).policy.account;
    const accountProvider = account ? (db.prepare('SELECT provider FROM accounts WHERE id=?').get(account.id) as
      { provider: string } | undefined)?.provider : undefined;
    const modelProvider = value.model.split(':')[0] ?? '';
    // Match legacy capacity identity so new and old calls share the stricter provider cap.
    const providerKey = value.kind === 'claude-sdk' ? value.kind : accountProvider
      ?? (['openai', 'anthropic', 'mock'].includes(modelProvider) ? modelProvider : 'builtin-llm');
    return { session: decision.session, workspaces: [{ path: canonicalWorkspace(value.workspace), access: 'read' as const }],
      providerKey, accountId: account?.id, accountIdentityGeneration: account?.identity_generation ?? undefined,
      quote: value.quote, threadedContext: { decision, configurationHash: configurationHash(value) } };
  }
  function instructions(base:string,binding:ThreadedBinding) {
    return [base,runtime.collaboration?.routing.prompt(binding),runtime.collaboration?.routing.warning(binding)].filter(Boolean).join('\n');
  }
  function prepareExecution(claim: ThreadedQueueClaim) {
    const { value, decision } = configuration(claim.binding);
    if (Buffer.byteLength(instructions(value.instructions,claim.binding), 'utf8') > value.contextBudget.reservedSystemTokens) {
      fail('THREADED_CONTEXT_SYSTEM_OVER_BUDGET');
    }
    const prepared = context.prepareManifest(claim.binding, { session: decision.session,
      mode: value.kind === 'api' ? 'reconstructed' : 'native_incremental', budget: value.contextBudget,
      requestKey: `backend-context:${claim.binding.attemptId}` });
    if (prepared.manifest.state !== 'ready') fail(prepared.manifest.reason ?? 'THREADED_CONTEXT_BUDGET_BLOCKED');
    sessionContext.assertForManifest(claim.binding, prepared.manifest.id, decision);
    return { contextManifestId: prepared.manifest.id, sessionBindingId: decision.session.id };
  }
  function loadInput(input: BackendExecuteInput): BackendPreparedInput {
    const binding = input.binding, { value, decision } = configuration(binding);
    sessionContext.assertForManifest(binding, input.contextManifestId, decision);
    if (input.sessionBindingId !== decision.session.id) fail('THREADED_BACKEND_SESSION_MISMATCH');
    const payload = context.getPayload(binding, input.contextManifestId);
    const resumeAnchor = decision.mode === 'resume' && decision.anchorId
      ? sessionContext.getAnchor(binding, decision.anchorId) : null;
    if (decision.mode === 'resume' && (!resumeAnchor || resumeAnchor.session.id !== decision.session.id
      || resumeAnchor.session.version !== decision.session.version || resumeAnchor.session.nativeId !== decision.session.nativeId)) {
      fail('THREADED_BACKEND_RESUME_ANCHOR_REQUIRED');
    }
    const inputRequestId = `input:${binding.attemptId}`;
    function recordInputExposure() {
      sessionContext.recordInputIntent(binding, { manifestId: input.contextManifestId, decision, requestId: inputRequestId });
      context.markSending(binding, input.contextManifestId, inputRequestId);
    }
    // The SDK receives its prompt locally before its first HTTP request. API
    // input is exposed only after request admission, in the receipt transaction.
    if (value.kind === 'claude-sdk') db.transaction(recordInputExposure).immediate();
    const requests: BackendPreparedInput['requests'] = {
      begin(requestKey, description) {
        return db.transaction(() => {
          authority.assertAuthorized(binding); runtime.queue.assertExecutable(binding); assertContext(binding);
          if (description.model !== value.model || !Number.isSafeInteger(description.inputBytes) || description.inputBytes < 0
            || !Number.isSafeInteger(description.maxOutputTokens) || description.maxOutputTokens < 1
            || description.maxOutputTokens > (value.quote.maxOutputTokens ?? 24_576)) fail('THREADED_BACKEND_REQUEST_SCOPE');
          if (description.inputBytes > value.contextBudget.maxInputTokens) fail('THREADED_BACKEND_INPUT_OVER_BUDGET');
          if (db.prepare("SELECT 1 FROM threaded_budget_requests WHERE attempt_id=? AND execution_state='unknown'").get(binding.attemptId)) {
            fail('THREADED_BACKEND_REQUEST_RECONCILIATION_REQUIRED');
          }
          const initial = runtime.queue.authorizationForBinding(binding);
          const authorization = initial.executionState === 'reserved' && !db.prepare('SELECT 1 FROM threaded_backend_requests WHERE authorization_id=?').get(initial.id)
            ? initial : runtime.budget.reserveRequest(binding, `backend:${requestKey}`, { ...value.quote, maxOutputTokens: description.maxOutputTokens });
          options.onRequestReserved?.(authorization.id, description);
          runtime.budget.markStartedWithinTransaction(binding, authorization.id);
          if (value.kind === 'api') recordInputExposure();
          input.setBudgetAuthorization?.(authorization.id);
          return { id: authorization.id, maxOutputTokens: authorization.maxOutputTokens };
        }).immediate();
      },
      settle(id, usage) {
        db.transaction(() => {
          runtime.budget.settleRequest(binding, id, usage);
          const receipt = evidence.getReceipt(usage.evidenceReference);
          if (receipt) options.onRequestSettled?.(id, { inputTokens: receipt.input_tokens, outputTokens: receipt.output_tokens });
        }).immediate();
        input.setBudgetAuthorization?.(null);
      },
      unknown(id) { runtime.budget.markRequestUnknown(binding, id); },
    };
    return { kind: value.kind, model: value.model, instructions: instructions(value.instructions,binding), serializedContext: payload.serialized,
      tools:runtime.collaboration!.tools.allowed(binding,value.applicationTools??[]),
      executeTool:async(name,args,key)=>{input.assertAuthorized();assertContext(binding);
        return runtime.collaboration!.tools.execute(binding,name,args,key,value.applicationTools??[]);},
      contextManifestId: input.contextManifestId, maxOutputTokens: value.quote.maxOutputTokens ?? 24_576,
      maxRequests: value.maxRequests ?? 4, requests, connection: value.connection, apiProtocol: value.apiProtocol, price: value.price,
      session: { bindingId: decision.session.id, nativeId: decision.session.nativeId, version: decision.session.version,
        backendVersion: value.backendVersion, cwd: canonicalWorkspace(value.workspace), configDir: canonicalWorkspace(value.configDir),
        resume: decision.mode === 'resume', compactionBoundary: resumeAnchor?.evidence.compactionBoundary },
      assertCurrent() { input.assertAuthorized(); sessionContext.assertForManifest(binding, input.contextManifestId, decision); },
      delivery(status, reference) {
        // Never cache an ID created in requests.begin: its outer receipt write
        // may have rolled back. Historical delivery uses only persisted input.
        const intent = db.prepare('SELECT id FROM threaded_context_send_intents WHERE binding_id=? AND request_key=?')
          .get(binding.id, inputRequestId) as { id: string } | undefined;
        if (!intent) return fail('THREADED_CONTEXT_SEND_INTENT_REQUIRED');
        context.recordDeliveryOutcome(binding, { intentId: intent.id, status,
          evidence: { key: reference, reference, nativeId: decision.session.nativeId } });
      },
      nativeEvent(event) {
        if(event.type==='tool')db.prepare('INSERT OR IGNORE INTO threaded_tool_receipts VALUES(?,?,?,?,?,?,?)').run(binding.id,
          `native:${event.id}`,event.name,hash(event),JSON.stringify({result:{native:true,completed:true},readSourceIds:[]}),1,options.now?.()??Date.now());
        if (event.type === 'bound') assertExpectedNativeSession(db, decision.session, event.nativeId);
        if (event.type === 'compact') {
          sessionContext.recordCompaction(binding, { manifestId: input.contextManifestId, decision,
            requestId: `compact:${hash(event.evidence.reference)}`, evidence: event.evidence });
        }
      },
    };
  }
  const adapterOptions: BackendAdapterOptions = { loadInput, evidence, fetch: options.fetch,
    recordQuiescence(binding, value) { return options.resources.recordQuiescence(authority.claim(binding), value); } };
  const registry = createThreadedBackendRegistry({ api: createApiBackend(adapterOptions),
    claudeSdk: createClaudeSdkBackend({ ...adapterOptions, sdkProcess: options.sdkProcess }),
    resolveKind: binding => configuration(binding).value.kind });
  const executor: InvocationExecutionPort = { async execute(input) {
    const outcome = await registry.execute(input);
    if (outcome.kind === 'unknown' || outcome.kind === 'not_started') return outcome;
    try {
      if (configuration(input.binding).value.kind === 'claude-sdk'
        && authority.authorized(input.binding, { quiescence: outcome.quiescence })) {
        const row = db.prepare(`SELECT record FROM threaded_backend_native_events WHERE binding_id=? AND manifest_id=?
          AND kind='anchor' ORDER BY rowid DESC LIMIT 1`).get(input.binding.id, input.contextManifestId) as { record: string } | undefined;
        if (row) sessionContext.recordAnchor(input.binding, { manifestId: input.contextManifestId,
          decision: configuration(input.binding).decision, requestId: `anchor:${input.binding.attemptId}`,
          evidence: JSON.parse(row.record) as ThreadedSessionAnchorEvidence, quiescence: outcome.quiescence });
      }
    } catch {
      // A missing recovery anchor cannot erase already verified transport/process quiescence.
      // Retain the input exposure; the next Invocation must cold-start instead of replaying it.
      return { kind: 'failed', reason: 'THREADED_BACKEND_ANCHOR_UNCONFIRMED', retryable: false,
        budgetState: outcome.budgetState, quiescence: outcome.quiescence };
    }
    return outcome;
  } };
  runtime = createThreadedRuntime(db, { ...options, executor, prepareResources, prepareExecution, assertExecutionContext: assertContext,
    collaborationEnabled:true,collaborationContext:context,
    deferRequestStart: true, verifyUsage: (binding, authorization, usage) => verifyThreadedBackendUsage(db, binding, authorization, usage),
    autoStart: false });
  if (options.autoStart !== false) runtime.wakeup();
  function recover() {
    const result = runtime.recover();
    return { ...result, ...recoverThreadedBackendFacts(db, authority, { budget: runtime.budget, now: options.now }) };
  }
  return { ...runtime, recover, context, sessionContext, backendEvidence: evidence };
}

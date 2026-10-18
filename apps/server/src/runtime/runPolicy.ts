import type {
  RuntimeAdmissionProfile,
  RuntimeExecutionPolicyV1,
  RuntimeRunContract,
} from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { autonomousDigest, loadAutonomousTaskPolicy } from './autonomousPolicy.ts';
import {config} from '../config.ts';

export type RuntimePolicyErrorCode =
  | 'RUNTIME_CONTRACT_CORRUPT'
  | 'RUNTIME_CONTRACT_MISMATCH'
  | 'RUNTIME_POLICY_UNKNOWN_VERSION'
  | 'RUNTIME_POLICY_INVALID'
  | 'RUNTIME_POLICY_AMBIGUOUS_HISTORY'
  | 'RUNTIME_POLICY_RETIRED'
  | 'RUNTIME_CAPABILITY_UNAVAILABLE';

export class RuntimePolicyError extends Error {
  constructor(readonly code: RuntimePolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
  }
}

export function executionPolicyForProfile(
  profile: RuntimeAdmissionProfile,
  options: {
    toolApiVersion?: 1 | 2 | 3 | 4;
    implicitAnswerPolicy?: RuntimeExecutionPolicyV1['implicitAnswerPolicy'];
  } = {},
): RuntimeExecutionPolicyV1 {
  const common = {
    policyVersion: 1 as const,
    profile,
    toolApiVersion: options.toolApiVersion ?? 2,
    implicitAnswerPolicy: options.implicitAnswerPolicy ?? 'initial_and_consultation' as const,
  };
  if (profile === 'legacy') return { ...common, authority: 'legacy', runtimeStateMode: 'off', atomicity: 'legacy' };
  if (profile === 'shadow') return { ...common, authority: 'legacy', runtimeStateMode: 'shadow', atomicity: 'legacy' };
  if (profile === 'atomic_compat') {
    return { ...common, authority: 'legacy', runtimeStateMode: 'authoritative', atomicity: 'custody_v1' };
  }
  return { ...common, authority: 'runtime', runtimeStateMode: 'authoritative', atomicity: 'commands_v1' };
}

function isExecutionPolicy(value: unknown): value is RuntimeExecutionPolicyV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Partial<RuntimeExecutionPolicyV1>;
  if (policy.policyVersion !== 1
    || !['legacy', 'shadow', 'atomic_compat', 'execute'].includes(policy.profile ?? '')
    || !['legacy', 'runtime'].includes(policy.authority ?? '')
    || !['off', 'shadow', 'authoritative'].includes(policy.runtimeStateMode ?? '')
    || !['legacy', 'custody_v1', 'commands_v1'].includes(policy.atomicity ?? '')
    || ![1, 2, 3, 4].includes(policy.toolApiVersion ?? 0)
    || !['initial_and_consultation', 'explicit_only'].includes(policy.implicitAnswerPolicy ?? '')) return false;
  const expected = executionPolicyForProfile(policy.profile!, {
    toolApiVersion: policy.toolApiVersion,
    implicitAnswerPolicy: policy.implicitAnswerPolicy,
  });
  return policy.authority === expected.authority
    && policy.runtimeStateMode === expected.runtimeStateMode
    && policy.atomicity === expected.atomicity;
}

/** 统一 Contract 读取器：缺失可兼容，损坏和错绑必须明确失败。 */
export function loadRuntimeContract(runId: string): RuntimeRunContract | null {
  const row = get<{ version: number; payload: string }>('SELECT version,payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload) as unknown;
  } catch {
    throw new RuntimePolicyError('RUNTIME_CONTRACT_CORRUPT', `Run ${runId} 的 Runtime Contract 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimePolicyError('RUNTIME_CONTRACT_CORRUPT', `Run ${runId} 的 Runtime Contract 不是对象`);
  }
  const contract = parsed as RuntimeRunContract;
  if (row.version !== 1 || contract.version !== 1) {
    throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', `Run ${runId} 的 Contract 版本不受支持`);
  }
  if (contract.runId !== runId) {
    throw new RuntimePolicyError('RUNTIME_CONTRACT_MISMATCH', `Contract 绑定 ${contract.runId}，实际请求 ${runId}`);
  }
  if (contract.features?.messageVisibilityVersion !== undefined && contract.features.messageVisibilityVersion !== 1) {
    throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', `Run ${runId} 的消息可见性版本不受支持`);
  }
  const f = contract.features;
  if (f?.controlActionVersion !== undefined && ![1, 2, 3, 4].includes(f.controlActionVersion)) {
    throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown control action version');
  }
  if (contract.executionPolicy && ![1, 2, 3, 4].includes(contract.executionPolicy.toolApiVersion)) {
    throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown tool API version');
  }
  const scoped = f?.scopedCollaboration;
  const autonomous = f?.autonomousCollaboration;
  if(autonomous!==undefined||f?.controlActionVersion===4||contract.executionPolicy?.toolApiVersion===4){
    if(!autonomous||autonomous.version!==1||autonomous.capabilityPackage!=='autonomous-collaboration-v1'||autonomous.boundaryVersion!==2||autonomous.policyRevision!==1)
      throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION','Unknown autonomous capability contract');
    if(autonomous.delegationVersion!==undefined&&autonomous.delegationVersion!==1)throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION','Unknown autonomous delegation version');
    if(autonomous.deliveryVersion!==undefined&&(autonomous.deliveryVersion!==1||autonomous.delegationVersion!==1))throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION','Unknown autonomous delivery version');
    if(autonomous.entryVersion!==undefined&&(autonomous.entryVersion!==1||autonomous.deliveryVersion!==1))throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION','Unknown autonomous entry version');
    if(autonomous.rootRunId!==runId||autonomous.budgetRunId!==runId||f?.controlActionVersion!==4||contract.executionPolicy?.toolApiVersion!==4
      ||contract.executionPolicy.profile!=='execute'||contract.executionPolicy.implicitAnswerPolicy!=='explicit_only'||f.messageVisibilityVersion!==1||scoped||f.coordinationKernel||f.coordinationScopes)
      throw new RuntimePolicyError('RUNTIME_POLICY_INVALID','Autonomous authority requires an independent v4 root contract');
    try {
      const p=loadAutonomousTaskPolicy(runId);
      if(!p||p.id!==autonomous.policyId||autonomousDigest(p)!==autonomous.policySha256||JSON.stringify(p.participantIds)!==JSON.stringify(contract.participantIds))throw new Error('policy mismatch');
    } catch {throw new RuntimePolicyError('RUNTIME_POLICY_INVALID','Autonomous task policy is missing or drifted');}
  }
  if (f?.coordinationScopes !== undefined && (![1,2].includes(f.coordinationScopes) || f.coordinationKernel !== 'execute' || f.controlActionVersion !== 2 || scoped)) throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown coordination scope version');
  if (scoped?.recoveryVersion !== undefined && (scoped.recoveryVersion !== 1 || scoped.deliveryVersion !== 1)) throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown scoped recovery version');
  if (scoped?.releaseVersion !== undefined && (scoped.releaseVersion !== 1 || scoped.capabilityPackage !== 'scoped-release-v1' || scoped.deliveryVersion !== 1)) throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown scoped release version');
  if (scoped?.deliveryVersion !== undefined && scoped.deliveryVersion !== 1) throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown scoped delivery version');
  if (scoped !== undefined || f?.controlActionVersion === 3 || contract.executionPolicy?.toolApiVersion === 3) {
    if (!scoped || scoped.boundaryVersion !== 2 || scoped.manifestVersion !== 1 || scoped.provenanceVersion !== 1
      || !['scoped-control-v1', 'scoped-release-v1'].includes(scoped.capabilityPackage)) {
      throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', 'Unknown or missing scoped capability contract');
    }
    if (!Number.isSafeInteger(scoped.policyRevision) || scoped.policyRevision < 1 || f?.controlActionVersion !== 3
      || contract.executionPolicy?.toolApiVersion !== 3 || contract.executionPolicy.profile !== 'execute'
      || contract.executionPolicy.implicitAnswerPolicy !== 'explicit_only' || f.messageVisibilityVersion !== 1
      || f.coordinationKernel) {
      throw new RuntimePolicyError('RUNTIME_POLICY_INVALID', 'Scoped contract must explicitly freeze v3 execute boundaries');
    }
  }
  return contract;
}

function hasAmbiguousHistoricalRuntimeState(contract: RuntimeRunContract): boolean {
  const features = contract.features;
  return Boolean(features?.completionCandidateVersion
    || features?.successorObligationVersion
    || features?.evidenceBundleVersion
    || features?.evidenceLoopGuardVersion
    || features?.contextContributorVersion
    || features?.durableHoldVersion
    || features?.externalWaitVersion
    || features?.consultAnyVersion
    || features?.progressDigestVersion);
}

function assertPolicyCapabilities(runId: string, contract: RuntimeRunContract, policy: RuntimeExecutionPolicyV1): void {
  const features = contract.features;
  const invalid = (reason: string): never => {
    throw new RuntimePolicyError('RUNTIME_POLICY_INVALID', `Run ${runId} ${reason}`);
  };
  if (policy.toolApiVersion >= 2 && features?.controlActionVersion !== policy.toolApiVersion) {
    invalid(`声明 toolApiVersion=${policy.toolApiVersion}，但 controlActionVersion 不匹配`);
  }
  if (features?.coordinationKernel) {
    const expected = features.coordinationKernel === 'execute' ? 'execute' : 'shadow';
    if (policy.profile !== expected) invalid(`Coordination mode=${features.coordinationKernel} 与 profile=${policy.profile} 不一致`);
  }
  if ((features?.completionEngine === true) !== (policy.authority === 'runtime')) {
    invalid('completionEngine 与 authority 不一致');
  }
  const hasRuntimeState = hasAmbiguousHistoricalRuntimeState(contract);
  if (policy.runtimeStateMode === 'off' && hasRuntimeState) invalid('关闭 Runtime 状态却声明了 Runtime 组件版本');
  if (policy.runtimeStateMode !== 'off' && !hasRuntimeState) invalid('启用 Runtime 状态但缺少组件版本');
  if (policy.profile === 'execute') {
    const complete = features?.completionCandidateVersion === 1
      && features.successorObligationVersion === 1
      && features.evidenceBundleVersion === 1
      && features.contextContributorVersion === 1
      && [1, 2].includes(features.durableHoldVersion ?? 0)
      && features.exitGuard?.version === 1;
    if (!complete) invalid('execute 缺少 Candidate、typed obligations、Evidence、Context、Hold 或 ExitGuard 能力');
  }
}

/**
 * 返回 Run 已冻结的执行策略。无 Contract 的历史 Run 固定为 legacy；无法可靠区分
 * shadow/atomic 的历史 Contract 明确阻断，不能用当前进程环境变量猜测。
 */
export function resolveRunPolicy(runId: string): RuntimeExecutionPolicyV1 {
  const contract = loadRuntimeContract(runId);
  if (!contract) return executionPolicyForProfile('legacy', { toolApiVersion: 1 });
  if (contract.executionPolicy !== undefined) {
    if (!isExecutionPolicy(contract.executionPolicy)) {
      const version = (contract.executionPolicy as { policyVersion?: unknown } | null)?.policyVersion;
      if (version !== 1) {
        throw new RuntimePolicyError('RUNTIME_POLICY_UNKNOWN_VERSION', `Run ${runId} 的 policyVersion=${String(version)} 不受支持`);
      }
      throw new RuntimePolicyError('RUNTIME_POLICY_INVALID', `Run ${runId} 的冻结执行策略字段组合无效`);
    }
    assertPolicyCapabilities(runId, contract, contract.executionPolicy);
    return contract.executionPolicy;
  }
  if (contract.features?.coordinationKernel) {
    return executionPolicyForProfile(contract.features.coordinationKernel === 'execute' ? 'execute' : 'shadow', {
      toolApiVersion: contract.features.controlActionVersion === 2 ? 2 : 1,
      implicitAnswerPolicy: 'explicit_only',
    });
  }
  if (contract.features?.completionEngine === true) {
    return executionPolicyForProfile('execute', {
      toolApiVersion: contract.features.controlActionVersion === 2 ? 2 : 1,
    });
  }
  if (hasAmbiguousHistoricalRuntimeState(contract)) {
    throw new RuntimePolicyError('RUNTIME_POLICY_AMBIGUOUS_HISTORY',
      `Run ${runId} 的历史 Contract 无法可靠区分 shadow 与 atomic_compat`);
  }
  return executionPolicyForProfile('legacy', {
    toolApiVersion: contract.features?.controlActionVersion === 2 ? 2 : 1,
  });
}

export function runtimeStateEnabled(policy: RuntimeExecutionPolicyV1): boolean {
  return policy.runtimeStateMode !== 'off';
}

export function runtimeStateAuthoritative(policy: RuntimeExecutionPolicyV1): boolean {
  return policy.runtimeStateMode === 'authoritative';
}

export function runtimeStateShadow(policy: RuntimeExecutionPolicyV1): boolean {
  return policy.runtimeStateMode === 'shadow';
}

export function runtimeOwnsCompletion(policy: RuntimeExecutionPolicyV1): boolean {
  return policy.authority === 'runtime';
}

/** 历史 Profile 仍可读取，但 Collaboration worker 只执行已冻结的 execute Run。 */
export function assertExecutableCollaborationPolicy(runId: string): RuntimeExecutionPolicyV1 {
  const policy = resolveRunPolicy(runId);
  if(policy.toolApiVersion===4){
    if(loadRuntimeContract(runId)?.features?.autonomousCollaboration?.delegationVersion!==1||config.autonomousCollaborationMode!=='execute')throw new RuntimePolicyError('RUNTIME_CAPABILITY_UNAVAILABLE','Autonomous execution requires an AC2 root and execute mode');
    return policy;
  }
  if (policy.toolApiVersion === 3) {
    const c = loadRuntimeContract(runId)?.features?.scopedCollaboration;
    if ((c?.capabilityPackage === 'scoped-control-v1' || (c?.capabilityPackage === 'scoped-release-v1' && c.releaseVersion === 1 && get('SELECT 1 FROM information_release_workflows WHERE run_id=?',runId))) && c.deliveryVersion === 1
      && get('SELECT 1 FROM scoped_delivery_plans WHERE run_id=?', runId)) return policy;
    throw new RuntimePolicyError('RUNTIME_CAPABILITY_UNAVAILABLE', 'Scoped delivery/resume requires a confirmed G2 plan');
  }
  if (policy.profile !== 'execute' || policy.authority !== 'runtime'
    || policy.atomicity !== 'commands_v1' || policy.toolApiVersion !== 2) {
    throw new RuntimePolicyError('RUNTIME_POLICY_RETIRED',
      `Run ${runId} 使用已退役的 Collaboration 执行策略 ${policy.profile}`);
  }
  return policy;
}

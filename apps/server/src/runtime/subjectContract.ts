import type { CollaborationDispatchKind, RuntimeContractEvaluation, RuntimeRunContract, RuntimeSubjectSeed, RuntimeSubjectStatus } from '@agent-gand/shared';

export function planCollaborationAdmission(input: {
  runId: string;
  objective: string;
  participantIds: string[];
  targetAgentIds: string[];
  completionEngine?: boolean;
  controlActionVersion?: 1 | 2;
  exitGuard?: { version: 1; maxCorrections: number; correctionMaxTokens: number };
  completionCandidateVersion?: 1;
}): { contract: RuntimeRunContract; subjects: RuntimeSubjectSeed[] } {
  const participants = new Set(input.participantIds);
  const targets = [...new Set(input.targetAgentIds)];
  if (targets.length === 0 || targets.some((id) => !participants.has(id))) throw new Error('初始 Subject 目标必须是非空的 Run 成员集合');
  const subjects = targets.map((agentId): RuntimeSubjectSeed => ({
    key: `root:${agentId}`, runId: input.runId, kind: 'root', parentKey: null,
    objective: input.objective, initialHolderAgentId: agentId,
  }));
  return {
    contract: {
      version: 1, runId: input.runId, objective: input.objective,
      participantIds: [...input.participantIds], requiredSubjectKeys: subjects.map((item) => item.key),
      completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
      features: {
        controlActionVersion: input.controlActionVersion ?? 2,
        ...(input.exitGuard ? { exitGuard: input.exitGuard } : {}),
        ...(input.completionCandidateVersion ? { completionCandidateVersion: input.completionCandidateVersion } : {}),
        ...(input.completionEngine ? { completionEngine: true } : {}),
      },
    },
    subjects,
  };
}

/** Dispatch 与责任的关系；fanout 才创建子 Subject，handoff 不创建新 root。 */
export function subjectRelationForDispatch(kind: CollaborationDispatchKind): 'root' | 'same' | 'consultation_child' | 'consultation_parent' {
  if (kind === 'initial') return 'root';
  if (kind === 'fanout') return 'consultation_child';
  if (kind === 'aggregate') return 'consultation_parent';
  return 'same';
}

export function evaluateRequiredSubjects(contract: RuntimeRunContract, statuses: ReadonlyMap<string, RuntimeSubjectStatus>): RuntimeContractEvaluation {
  const missing = contract.requiredSubjectKeys.filter((key) => !statuses.has(key));
  const failed = contract.requiredSubjectKeys.filter((key) => ['failed', 'cancelled'].includes(statuses.get(key) ?? ''));
  const pending = contract.requiredSubjectKeys.filter((key) => statuses.get(key) !== 'completed');
  if (missing.length > 0 || failed.length > 0) return { status: 'needs_attention', pending, failed: [...failed, ...missing] };
  if (pending.length > 0) return { status: 'active', pending };
  return { status: 'completed', pending: [] };
}

import { randomUUID } from 'node:crypto';
import type { AgentDefinition, CoordinationDraft, CoordinationPlan, CoordinationPlanStep, CoordinationPreview,
  OrchestrationDecision, OrchestrationRequest } from '@agent-gand/shared';
import { createCapabilitySnapshot } from '../coordination/capabilities.ts';
import { validateCoordinationPlan } from '../coordination/validator.ts';
import { externalCoordinationIssues } from '../coordination/externalAdmission.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import type { DecomposedTask } from './supervisor.ts';

/** Stable, inspectable templates. There is no planner invocation in compilation. */
export function compileWorkflow(request: OrchestrationRequest, decision: OrchestrationDecision, agents: AgentDefinition[],
  decomposition?: DecomposedTask[]): CoordinationPreview {
  const snapshot = createCapabilitySnapshot(decision.execution!.participantIds, agents);
  const protocol = decision.protocol;
  const steps: CoordinationPlanStep[] = [];
  const bindings: Record<string, string> = {};
  const add = (id: string, actor: string | null, deps: string[], type: CoordinationPlanStep['type'] = 'agent_turn',
    meta: CoordinationPlanStep['metadata'] = {}, stepProtocol = protocol) => {
    const agent = agents.find(a => a.id === actor);
    const readonly = decision.execution!.readonly || type === 'review' || type === 'aggregate';
    if (actor) bindings[id] = actor;
    steps.push({ id, protocol: stepProtocol, type, actorRole: id, actorCapability: type === 'review' ? 'review' : type === 'aggregate' && !agent?.capabilities.includes('execute') ? 'coordinate' : 'execute',
      agentId: actor, dependsOn: [...deps], completion: type === 'review' ? '独立评审通过，失败必须返工并重新评审' : '提供完整且可验收的结果',
      maxAttempts: stepProtocol === 'review_revision' ? 3 : 2, tokenBudget: Math.min(4000, request.constraints.maxTokens ?? 4000),
      timeoutMs: Math.min(300000, request.constraints.deadlineMs ?? 300000),
      onFailure: type === 'review' && stepProtocol === 'review_revision' ? 'retry_dependencies' : 'fail_plan',
      toolPolicy: { allowedTools: agent?.tools.filter(name => snapshot.tools.some(t => t.name === name) && (!readonly || READONLY_TOOLS.has(name))) ?? [],
        requiresApproval: !readonly }, metadata: { ...meta, readonly, templateVersion: 'o4-workflows-v1' } });
  };
  let tail: string[] = [];
  if (request.workflow === 'development_review') {
    add('review-implement', decision.targetIds[0]!, [], 'agent_turn', {}, 'review_revision');
    add('review-independent', request.defaultReviewerId!, ['review-implement'], 'review', { reviewTargetStepIds: ['review-implement'], independent: true }, 'review_revision');
    tail = ['review-independent'];
  } else if (request.workflow === 'bounded_debate') {
    const all: string[] = [];
    for (let round = 1; round <= request.constraints.rounds!; round++) {
      const pro = `debate-r${round}-pro`, con = `debate-r${round}-con`;
      add(pro, decision.targetIds[0]!, tail, 'agent_turn', { round, position: 'pro', positionsFixed: true });
      add(con, decision.targetIds[1]!, [pro], 'agent_turn', { round, position: 'con', positionsFixed: true });
      all.push(pro, con); tail = [con];
    }
    if (request.defaultReviewerId) {
      add('debate-judge', request.defaultReviewerId, all, 'review', { reviewTargetStepIds: all, afterAllRounds: true }); tail = ['debate-judge'];
    } else if (request.aggregatorId) {
      add('debate-summary', request.aggregatorId, all, 'aggregate'); tail = ['debate-summary'];
    }
  } else if (request.workflow === 'supervisor_decomposition') {
    if (!decomposition?.length) throw new Error('主管步骤图尚未生成');
    const terminalByTitle = new Map<string, string>();
    for (const [index, task] of decomposition.entries()) {
      const id = `dag-task-${index + 1}`;
      const deps = [...new Set([...task.blockedByTitles.map(title => terminalByTitle.get(title)!), ...(request.strategy === 'serial' ? [...terminalByTitle.values()].slice(-1) : [])])];
      // A review barrier is the dependency of downstream tasks, not just the implementation.
      add(id, task.assignee, deps, 'agent_turn', { title: task.title, objective: task.body ?? task.title,
        acceptanceCriteria: task.acceptanceCriteria }, task.reviewer ? 'review_revision' : 'supervisor_dag');
      if (task.reviewer) {
        add(`${id}-review`, task.reviewer, [id], 'review', { reviewTargetStepIds: [id], independent: true }, 'review_revision');
        terminalByTitle.set(task.title, `${id}-review`);
      } else terminalByTitle.set(task.title, id);
    }
    add('dag-summary', request.supervisorId!, [...terminalByTitle.values()], 'aggregate'); tail = ['dag-summary'];
  } else {
    for (const [index, actor] of decision.targetIds.entries()) {
      const id = `work-${index + 1}`;
      add(id, actor, decision.effectiveStrategy === 'serial' ? tail : [], decision.effectiveStrategy === 'parallel' ? 'fanout' : 'agent_turn',
        { independent: decision.effectiveStrategy === 'parallel' }, request.workflow === 'analysis_summary' ? 'parallel_fanout' : protocol);
      tail = decision.effectiveStrategy === 'serial' ? [id] : [...tail, id];
    }
    if (request.workflow === 'analysis_summary') { add('analysis-summary', request.aggregatorId!, tail, 'aggregate'); tail = ['analysis-summary']; }
  }
  add('complete', null, tail, 'completion_gate');
  const now = new Date().toISOString();
  const draft: CoordinationDraft = { id: randomUUID(), capabilitySnapshotId: snapshot.id,
    taskBrief: { objective: request.goal, deliverable: null, participantIds: [...decision.execution!.participantIds],
      reviewerId: request.defaultReviewerId, hardConstraints: {}, inferredConstraints: {}, constraintEvidence: [],
      qualityRequirements: ['全部必要步骤完成', '独立评审门禁不得省略'], risk: decision.execution!.readonly ? 'low' : 'medium', missingInformation: [] },
    protocols: request.workflow === 'analysis_summary' ? [{ protocol: 'parallel_fanout', version: 1 }, { protocol: 'supervisor_aggregation', version: 1 }] : [{ protocol, version: 1 }], displayName: request.workflow, summary: decision.reason, reasonCodes: ['O4_EXPLICIT_WORKFLOW'], evidence: [], alternatives: [],
    planning: { source: decomposition ? 'model' : 'deterministic', model: null, attempts: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbackReason: null },
    modelConfidence: null, platformConfidence: 1, risk: decision.execution!.readonly ? 'low' : 'medium',
    decision: decision.requiresConfirmation ? 'recommend' : 'auto_start', clarificationQuestion: null, clarificationOptions: [], validationIssues: [], validationErrors: [],
    runtimeMode: 'pipeline', createdAt: now };
  const plan: CoordinationPlan = { id: randomUUID(), runId: null, draftId: draft.id, capabilitySnapshotId: snapshot.id,
    executionVersion: 'o4-workflows-v1', revision: 1, status: 'draft', protocols: draft.protocols, protocolComposition: draft.protocols,
    templateExpansions: request.workflow === 'analysis_summary' ? [
      { protocolIndex: 0, protocol: 'parallel_fanout', inputStepIds: [], stepIds: steps.filter(s=>s.protocol==='parallel_fanout').map(s=>s.id), outputStepIds: steps.filter(s=>s.protocol==='parallel_fanout').map(s=>s.id) },
      { protocolIndex: 1, protocol: 'supervisor_aggregation', inputStepIds: steps.filter(s=>s.protocol==='parallel_fanout').map(s=>s.id), stepIds: ['analysis-summary','complete'], outputStepIds: ['analysis-summary'] }
    ] : [{ protocolIndex: 0, protocol, inputStepIds: [], stepIds: steps.map(s => s.id), outputStepIds: tail }],
    runtimeMode: 'pipeline', actorBindings: bindings, hardConstraintBindings: [], steps,
    completion: { requiredSteps: steps.map(s => s.id), terminalSteps: ['complete'] },
    budget: { maximumSteps: 64, maximumAttemptsPerStep: 3, maximumTokensPerStep: Math.min(4000, request.constraints.maxTokens ?? 4000) },
    validationIssues: [], createdAt: now, updatedAt: now };
  plan.validationIssues = [...validateCoordinationPlan(plan, draft, snapshot), ...externalCoordinationIssues(plan, agents)];
  draft.validationIssues = plan.validationIssues; draft.validationErrors = [...new Set(plan.validationIssues.filter(i => i.severity === 'error').map(i => i.code))];
  if (draft.validationErrors.length) draft.decision = 'unavailable';
  return { snapshot, draft, plan };
}

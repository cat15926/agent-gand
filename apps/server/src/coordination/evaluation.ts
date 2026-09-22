import type { CoordinationDecision, CoordinationDraft, CoordinationPlan, CoordinationProtocolId } from '@agent-gand/shared';

export interface CoordinationEvaluationRecord {
  id: string;
  expectedProtocols: CoordinationProtocolId[];
  expectedDecision: CoordinationDecision;
  draft: CoordinationDraft;
  plan: CoordinationPlan;
  outcome?: {
    completed: boolean;
    runtimeCostUsd: number;
    humanCorrected: boolean;
  };
}

export interface CoordinationEvaluationMetrics {
  samples: number;
  selectionAccuracy: number;
  decisionAccuracy: number;
  hardConstraintCoverage: number;
  executablePlanRate: number;
  observedCompletionRate: number | null;
  averagePlanningCostUsd: number;
  averageObservedTotalCostUsd: number | null;
  observedHumanCorrectionRate: number | null;
}

const ratio = (value: number, total: number): number => total === 0 ? 0 : Math.round((value / total) * 10_000) / 10_000;
const same = (left: string[], right: string[]): boolean => left.length === right.length && left.every((item, index) => right[index] === item);

export function evaluateCoordinationPlanning(records: CoordinationEvaluationRecord[]): CoordinationEvaluationMetrics {
  let constraintCount = 0;
  let coveredConstraints = 0;
  for (const record of records) {
    const bindings = new Map(record.plan.hardConstraintBindings.map((item) => [item.constraint, item.planPaths]));
    for (const constraint of Object.keys(record.draft.taskBrief.hardConstraints)) {
      constraintCount += 1;
      if ((bindings.get(constraint)?.length ?? 0) > 0) coveredConstraints += 1;
    }
  }
  const observed = records.filter((record) => record.outcome !== undefined);
  const planningCost = records.reduce((sum, record) => sum + record.draft.planning.costUsd, 0);
  const observedTotalCost = observed.reduce((sum, record) => sum + record.draft.planning.costUsd + record.outcome!.runtimeCostUsd, 0);
  return {
    samples: records.length,
    selectionAccuracy: ratio(records.filter((record) => same(record.expectedProtocols, record.draft.protocols.map((item) => item.protocol))).length, records.length),
    decisionAccuracy: ratio(records.filter((record) => record.expectedDecision === record.draft.decision).length, records.length),
    hardConstraintCoverage: ratio(coveredConstraints, constraintCount),
    executablePlanRate: ratio(records.filter((record) => record.draft.validationErrors.length === 0 && record.plan.runtimeMode !== null && !record.plan.validationIssues.some((item) => item.severity === 'error')).length, records.length),
    observedCompletionRate: observed.length > 0 ? ratio(observed.filter((record) => record.outcome?.completed).length, observed.length) : null,
    averagePlanningCostUsd: records.length > 0 ? planningCost / records.length : 0,
    averageObservedTotalCostUsd: observed.length > 0 ? observedTotalCost / observed.length : null,
    observedHumanCorrectionRate: observed.length > 0 ? ratio(observed.filter((record) => record.outcome?.humanCorrected).length, observed.length) : null,
  };
}

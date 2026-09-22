import { randomUUID } from 'node:crypto';
import type { CoordinationProtocolSelection } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, run } from '../db/database.ts';

interface FeedbackRow { corrected: number; original_confidence: number }

export interface CoordinationCalibration {
  threshold: number;
  sampleCount: number;
  correctionRate: number;
  baseline: number;
}

export function recordPlannerFeedback(input: {
  originalDraftId: string;
  chosenProtocols: CoordinationProtocolSelection[];
  originalConfidence: number;
  corrected: boolean;
  source: 'alternative_selected' | 'plan_revision';
}): void {
  run('INSERT INTO coordination_planner_feedback (id,original_draft_id,chosen_protocols,original_confidence,corrected,source,created_at) VALUES (?,?,?,?,?,?,?)',
    randomUUID(), input.originalDraftId, JSON.stringify(input.chosenProtocols), input.originalConfidence, input.corrected ? 1 : 0, input.source, new Date().toISOString());
}

export function getCoordinationCalibration(): CoordinationCalibration {
  const rows = all<FeedbackRow>('SELECT corrected,original_confidence FROM coordination_planner_feedback ORDER BY created_at DESC LIMIT 100');
  const correctionRate = rows.length === 0 ? 0 : rows.filter((row) => row.corrected === 1).length / rows.length;
  const baseline = config.coordinationPlanner.autoStartThreshold;
  // 少量样本只收集不调参；>=5 后按纠正率保守抬高阈值，>=20 且稳定时才允许小幅降低。
  const delta = rows.length < 5 ? 0
    : correctionRate > 0.3 ? 0.12
      : correctionRate > 0.15 ? 0.06
        : rows.length >= 20 && correctionRate < 0.05 ? -0.03 : 0;
  return {
    threshold: Math.min(0.97, Math.max(0.65, baseline + delta)),
    sampleCount: rows.length,
    correctionRate: Math.round(correctionRate * 10_000) / 10_000,
    baseline,
  };
}

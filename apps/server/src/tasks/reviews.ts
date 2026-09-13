import type { ReviewIssue, ReviewVerdict, TaskReview } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, run } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface ReviewRow {
  id: string;
  task_id: string;
  attempt_id: string;
  reviewer_id: string;
  verdict: string;
  summary: string;
  issues: string;
  created_at: string;
}

function rowToReview(row: ReviewRow): TaskReview {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    reviewerId: row.reviewer_id,
    verdict: row.verdict as ReviewVerdict,
    summary: row.summary,
    issues: JSON.parse(row.issues) as ReviewIssue[],
    createdAt: row.created_at,
  };
}

export function listReviews(taskId: string): TaskReview[] {
  return all<ReviewRow>(
    'SELECT * FROM task_reviews WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
    taskId,
  ).map(rowToReview);
}

export function createReview(input: Omit<TaskReview, 'id' | 'createdAt'>): TaskReview {
  const review: TaskReview = {
    id: randomUUID(),
    ...input,
    createdAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO task_reviews (id, task_id, attempt_id, reviewer_id, verdict, summary, issues, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    review.id,
    review.taskId,
    review.attemptId,
    review.reviewerId,
    review.verdict,
    review.summary,
    JSON.stringify(review.issues),
    review.createdAt,
  );
  emit({ type: 'review.updated', review });
  return review;
}

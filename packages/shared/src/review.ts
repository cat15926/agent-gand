/** Reviewer 对一次工作 attempt 的结构化结论。 */
export type ReviewVerdict = 'PASS' | 'FAIL';
export type ReviewSeverity = 'blocking' | 'warning';

export interface ReviewIssue {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  problem: string;
  suggestion: string;
}

export interface TaskReview {
  id: string;
  taskId: string;
  attemptId: string;
  reviewerId: string;
  verdict: ReviewVerdict;
  summary: string;
  issues: ReviewIssue[];
  createdAt: string;
}

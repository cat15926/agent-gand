import type { AgentDefinition, ReviewIssue, Run, Task, TaskAttempt, TaskReview } from '@agent-gand/shared';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from './agentStep.ts';
import { buildReviewContext } from './contextBuilder.ts';

const REVIEW_PROTOCOL = `返回格式：
{"verdict":"PASS|FAIL","summary":"审查摘要","issues":[{"severity":"blocking|warning","file":"可选文件路径","line":1,"problem":"问题","suggestion":"修改建议"}]}
规则：FAIL 至少有一个 blocking issue；PASS 不得包含 blocking issue；problem 和 suggestion 必填。`;

function extractJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content.trim());
  const candidate = (fenced?.[1] ?? content).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  return first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
}

export function parseReview(content: string): Omit<TaskReview, 'id' | 'taskId' | 'attemptId' | 'reviewerId' | 'createdAt'> | null {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(content));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { verdict?: unknown; summary?: unknown; issues?: unknown };
  if ((raw.verdict !== 'PASS' && raw.verdict !== 'FAIL') || typeof raw.summary !== 'string' || !Array.isArray(raw.issues)) {
    return null;
  }
  const issues: ReviewIssue[] = [];
  for (const item of raw.issues) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const issue = item as Record<string, unknown>;
    if (
      (issue.severity !== 'blocking' && issue.severity !== 'warning') ||
      typeof issue.problem !== 'string' || issue.problem.trim() === '' ||
      typeof issue.suggestion !== 'string' || issue.suggestion.trim() === ''
    ) return null;
    issues.push({
      severity: issue.severity,
      problem: issue.problem,
      suggestion: issue.suggestion,
      ...(typeof issue.file === 'string' ? { file: issue.file } : {}),
      ...(typeof issue.line === 'number' && Number.isInteger(issue.line) && issue.line > 0 ? { line: issue.line } : {}),
    });
  }
  const blocking = issues.some((issue) => issue.severity === 'blocking');
  if ((raw.verdict === 'FAIL' && !blocking) || (raw.verdict === 'PASS' && blocking)) return null;
  return { verdict: raw.verdict, summary: raw.summary, issues };
}

export async function reviewTask(input: {
  run: Run;
  task: Task;
  workAttempt: TaskAttempt;
  reviewer: AgentDefinition;
  parentSpanId: string;
}): Promise<Omit<TaskReview, 'id' | 'taskId' | 'attemptId' | 'reviewerId' | 'createdAt'>> {
  const base = buildReviewContext(input.run, input.task, input.workAttempt);
  let previous = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0
      ? `${base}\n\n${REVIEW_PROTOCOL}`
      : `${base}\n\n${REVIEW_PROTOCOL}\n\n上一次输出无法通过协议校验：\n${previous}\n请重新输出合法 JSON。`;
    const turn = await runAgentTurn({
      run: input.run,
      agent: input.reviewer,
      parentSpanId: input.parentSpanId,
      messages: [
        { role: 'system', content: input.reviewer.systemPrompt },
        { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE },
        { role: 'user', content: prompt },
      ],
    });
    previous = turn.content;
    const parsed = parseReview(previous);
    if (parsed) return parsed;
  }
  throw new Error('Reviewer 连续两次返回无效结构，审查失败');
}

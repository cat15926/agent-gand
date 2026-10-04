import type { Run, Task, TaskAttempt } from '@agent-gand/shared';
import { getTask } from '../messaging/tasks.ts';
import { listAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';
import { listExecutions } from '../execution/store.ts';

function criteria(task: Task): string {
  return task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '1. 完成任务说明并给出可验证结果';
}

function dependencyResults(task: Task): string {
  if (task.blockedBy.length === 0) return '无';
  return task.blockedBy
    .map((id) => getTask(id))
    .filter((item): item is Task => item !== undefined)
    .map((item) => `【${item.title}】\n${item.result ?? '（无结果）'}`)
    .join('\n\n');
}

export function buildWorkContext(run: Run, task: Task): string {
  const sections = [
    `总体目标：${run.goal}`,
    `当前任务：${task.title}\n任务说明：${task.body ?? '-'}`,
    `验收标准：\n${criteria(task)}`,
    `依赖任务的最终结果：\n${dependencyResults(task)}`,
  ];
  if (task.status === 'in_progress' && task.attempt > 1) {
    const previousWork = listAttempts(task.id)
      .filter((attempt) => attempt.kind === 'work' && attempt.status === 'completed')
      .at(-1);
    const review = listReviews(task.id).at(-1);
    sections.push(
      `这是第 ${task.attempt}/${task.maxAttempts} 次执行。`,
      `上一次执行结果：\n${previousWork?.output ?? '（无）'}`,
      review
        ? `Reviewer 反馈：${review.summary}\n${review.issues
            .map((issue, index) =>
              `${index + 1}. [${issue.severity}] ${issue.file ?? '-'}${issue.line ? `:${issue.line}` : ''} ${issue.problem}\n   建议：${issue.suggestion}`,
            )
            .join('\n')}`
        : 'Reviewer 反馈：无',
    );
  }
  return sections.join('\n\n');
}

export function buildReviewContext(run: Run, task: Task, workAttempt: TaskAttempt): string {
  const execution = listExecutions(run.id).find((execution) => execution.scopeId === `task:${task.id}:work:${workAttempt.attemptNo}` && execution.agentId === workAttempt.agentId);
  const evidence = execution?.evidence;
  return [
    '__AGENT_GAND_REVIEW_JSON__',
    `总体目标：${run.goal}`,
    `待审任务：${task.title}\n任务说明：${task.body ?? '-'}`,
    `当前实现轮次：${task.attempt}`,
    `验收标准：\n${criteria(task)}`,
    `依赖任务结果：\n${dependencyResults(task)}`,
    `Coder 本次输出：\n${workAttempt.output ?? '（空）'}`,
    ...(execution?.snapshot ? [`本次审查使用固定快照：${execution.snapshot.commit}，目录 ${execution.snapshot.path}。`] : []),
    ...(evidence ? [`平台采集的 Git HEAD：${evidence.head ?? '未知'}；证据${evidence.truncated ? '已截断，需检查真实文件' : '未截断'}\n执行前 diff：\n${evidence.beforeDiff || '（无）'}\n执行后 diff：\n${evidence.afterDiff || '（无）'}\n原生工具结果：\n${evidence.commands.map((command) => `${command.name} exit=${command.exitCode ?? '未知'}\n${command.output}`).join('\n')}`] : []),
    '请检查当前工作区中的真实产物。严格只输出 JSON，不要附加 Markdown 围栏或其他文字。',
  ].join('\n\n');
}

export function buildSupervisorSummaryContext(run: Run, tasks: Task[]): string {
  const results = tasks.map((task) => {
    const review = listReviews(task.id).at(-1);
    return [
      `任务：${task.title}`,
      `状态：${task.status}`,
      `执行次数：${task.attempt}/${task.maxAttempts}`,
      `最终结果：${task.result ?? '（无）'}`,
      review ? `最终审查：${review.verdict} — ${review.summary}` : '最终审查：无需审查或未完成',
      task.lastError ? `错误：${task.lastError}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    `总体目标：${run.goal}`,
    '以下是各任务的真实执行与审查结果：',
    results.join('\n\n---\n\n'),
    '请依据以上结果向用户汇总。不得把 failed/cancelled 任务描述为已完成。',
  ].join('\n\n');
}

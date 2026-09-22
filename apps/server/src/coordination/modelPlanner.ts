import type {
  CapabilitySnapshot,
  CoordinationAlternative,
  CoordinationProtocolId,
  CoordinationProtocolSelection,
  TaskBrief,
} from '@agent-gand/shared';
import { config } from '../config.ts';
import { resolveProvider } from '../llm/router.ts';
import { validateProtocolComposition } from './protocols.ts';

export interface CoordinationModelProposal {
  taskType: string;
  protocols: CoordinationProtocolSelection[];
  reasonCodes: string[];
  evidence: Array<{ source: 'user_constraint' | 'task_semantics' | 'capability'; field: string }>;
  missingInformation: string[];
  alternatives: CoordinationAlternative[];
  confidence: number;
  clarificationQuestion: string | null;
}

export interface CoordinationModelPlanningResult {
  proposal: CoordinationModelProposal | null;
  model: string | null;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  fallbackReason: string | null;
}

function plannerModel(snapshot: CapabilitySnapshot): string | null {
  if (config.coordinationPlanner.model) return config.coordinationPlanner.model;
  return snapshot.agents.find((agent) => agent.enabled && agent.capabilities.includes('coordinate') && !agent.model.startsWith('mock:'))?.model ?? null;
}

function jsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('MODEL_OUTPUT_NOT_JSON');
  const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_OUTPUT_NOT_OBJECT');
  return value as Record<string, unknown>;
}

function strings(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, maximum);
}

function selections(value: unknown, snapshot: CapabilitySnapshot): CoordinationProtocolSelection[] {
  if (!Array.isArray(value)) throw new Error('MODEL_PROTOCOLS_REQUIRED');
  const definitions = new Map(snapshot.protocols.map((item) => [item.id, item]));
  const result: CoordinationProtocolSelection[] = [];
  for (const item of value.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('MODEL_PROTOCOL_INVALID');
    const row = item as Record<string, unknown>;
    if (typeof row.protocol !== 'string' || !definitions.has(row.protocol as CoordinationProtocolId)) throw new Error(`MODEL_PROTOCOL_NOT_FOUND:${String(row.protocol)}`);
    const definition = definitions.get(row.protocol as CoordinationProtocolId)!;
    const version = typeof row.version === 'number' ? row.version : definition.version;
    if (version !== definition.version) throw new Error(`MODEL_PROTOCOL_VERSION_INVALID:${row.protocol}@${version}`);
    if (!result.some((selected) => selected.protocol === row.protocol)) result.push({ protocol: row.protocol as CoordinationProtocolId, version });
  }
  if (result.length === 0) throw new Error('MODEL_PROTOCOLS_REQUIRED');
  return result;
}

function evidence(value: unknown): CoordinationModelProposal['evidence'] {
  if (!Array.isArray(value)) return [{ source: 'task_semantics', field: 'objective' }];
  const allowed = new Set(['user_constraint', 'task_semantics', 'capability']);
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.source !== 'string' || !allowed.has(row.source) || typeof row.field !== 'string' || !row.field.trim()) return [];
    return [{ source: row.source as CoordinationModelProposal['evidence'][number]['source'], field: row.field.trim().slice(0, 80) }];
  }).slice(0, 12);
}

function alternatives(value: unknown, snapshot: CapabilitySnapshot): CoordinationAlternative[] {
  if (!Array.isArray(value)) return [];
  const result: CoordinationAlternative[] = [];
  for (const item of value.slice(0, 2)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    try {
      const protocols = selections(row.protocols, snapshot);
      const displayName = typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim().slice(0, 80) : protocols.map((entry) => entry.protocol).join(' → ');
      const suitableWhen = typeof row.suitableWhen === 'string' ? row.suitableWhen.trim().slice(0, 240) : '';
      result.push({ protocols, displayName, suitableWhen });
    } catch {
      // 非法替代项不影响首选候选，直接丢弃。
    }
  }
  return result;
}

function parseProposal(text: string, snapshot: CapabilitySnapshot): CoordinationModelProposal {
  const value = jsonObject(text);
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence)) : 0.5;
  return {
    taskType: typeof value.taskType === 'string' && value.taskType.trim() ? value.taskType.trim().slice(0, 80) : 'general',
    protocols: selections(value.protocols, snapshot),
    reasonCodes: strings(value.reasonCodes, 8),
    evidence: evidence(value.evidence),
    missingInformation: strings(value.missingInformation, 3),
    alternatives: alternatives(value.alternatives, snapshot),
    confidence,
    clarificationQuestion: typeof value.clarificationQuestion === 'string' && value.clarificationQuestion.trim()
      ? value.clarificationQuestion.trim().slice(0, 300) : null,
  };
}

function validateProposal(proposal: CoordinationModelProposal, snapshot: CapabilitySnapshot): string[] {
  const issues: string[] = [];
  for (const selected of proposal.protocols) {
    const protocol = snapshot.protocols.find((item) => item.id === selected.protocol && item.version === selected.version);
    if (!protocol) { issues.push(`PROTOCOL_NOT_FOUND:${selected.protocol}`); continue; }
    if (snapshot.agents.length < protocol.minimumAgents) issues.push(`AGENT_COUNT_BELOW_MINIMUM:${selected.protocol}`);
    if (protocol.maximumAgents !== null && snapshot.agents.length > protocol.maximumAgents) issues.push(`AGENT_COUNT_ABOVE_MAXIMUM:${selected.protocol}`);
    if (!protocol.runtimeMode) issues.push(`PROTOCOL_RUNTIME_UNAVAILABLE:${selected.protocol}`);
    for (const capability of protocol.requiredCapabilities) {
      if (!snapshot.agents.some((agent) => agent.enabled && agent.capabilities.includes(capability))) issues.push(`AGENT_CAPABILITY_MISSING:${capability}`);
    }
  }
  if (proposal.protocols.length > 1) {
    for (const selected of proposal.protocols) {
      if (!snapshot.protocols.find((item) => item.id === selected.protocol)?.composable) issues.push(`PROTOCOL_NOT_COMPOSABLE:${selected.protocol}`);
    }
  }
  issues.push(...validateProtocolComposition(proposal.protocols.map((item) => item.protocol)));
  if (proposal.missingInformation.length > 0 && !proposal.clarificationQuestion) issues.push('CLARIFICATION_QUESTION_REQUIRED');
  return [...new Set(issues)];
}

function promptPayload(taskBrief: TaskBrief, snapshot: CapabilitySnapshot, repairErrors: string[]): Record<string, unknown> {
  return {
    taskBrief,
    capabilitySnapshot: {
      schemaVersion: snapshot.schemaVersion,
      protocols: snapshot.protocols.map((item) => ({
        id: item.id, version: item.version, description: item.description, requiredCapabilities: item.requiredCapabilities,
        roleSlots: item.roleSlots, parameters: item.parameterSchema, composable: item.composable,
        inputTypes: item.inputTypes, outputTypes: item.outputTypes, allowedSuccessors: item.allowedSuccessors,
        runtimeAvailable: item.runtimeMode !== null, risk: item.risk,
      })),
      agents: snapshot.agents.map((item) => ({ id: item.id, capabilities: item.capabilities, tools: item.tools, permissionMode: item.permissionMode, enabled: item.enabled })),
      tools: snapshot.tools.map((item) => ({ name: item.name, readonly: item.readonly, risk: item.risk, requiresApproval: item.requiresApproval })),
      policy: snapshot.policy,
    },
    ...(repairErrors.length > 0 ? { repairErrors } : {}),
  };
}

const SYSTEM_PROMPT = `你是受约束的协作规划器。只能从能力快照选择协议，不得声明新协议、Agent、工具或权限。
输出一个 JSON 对象，不要输出 Markdown 或解释。Schema：
{"taskType":"string","protocols":[{"protocol":"registered_id","version":1}],"reasonCodes":["STABLE_CODE"],"evidence":[{"source":"user_constraint|task_semantics|capability","field":"field_name"}],"missingInformation":["field_name"],"alternatives":[{"protocols":[{"protocol":"registered_id","version":1}],"displayName":"用户可理解名称","suitableWhen":"条件"}],"confidence":0.0,"clarificationQuestion":null}
协议组合最多四项，替代方案最多两项。显式用户约束优先；缺少会改变协议或交付物的信息时只提出一个决定性业务问题。不要输出思维过程。`;

export async function planCoordinationWithModel(taskBrief: TaskBrief, snapshot: CapabilitySnapshot): Promise<CoordinationModelPlanningResult> {
  const model = plannerModel(snapshot);
  if (!model) return { proposal: null, model: null, attempts: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbackReason: null };
  let provider;
  try {
    provider = resolveProvider(model);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { proposal: null, model, attempts: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbackReason: reason.slice(0, 240) };
  }
  let repairErrors: string[] = [];
  let attempts = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let lastError = 'MODEL_PLANNER_FAILED';
  while (attempts < config.coordinationPlanner.maxAttempts) {
    attempts += 1;
    try {
      const response = await provider.chat({
        model,
        maxTokens: config.coordinationPlanner.maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `__AGENT_GAND_COORDINATION_PLANNER__\n${JSON.stringify(promptPayload(taskBrief, snapshot, repairErrors))}` },
        ],
      });
      tokensIn += response.usage.tokensIn;
      tokensOut += response.usage.tokensOut;
      costUsd += response.usage.costUsd;
      if (response.truncated) throw new Error('MODEL_OUTPUT_TRUNCATED');
      const proposal = parseProposal(response.content, snapshot);
      repairErrors = validateProposal(proposal, snapshot);
      if (repairErrors.length === 0) return { proposal, model, attempts, tokensIn, tokensOut, costUsd, fallbackReason: null };
      lastError = repairErrors.join(',');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      repairErrors = [lastError.slice(0, 240)];
    }
  }
  return { proposal: null, model, attempts, tokensIn, tokensOut, costUsd, fallbackReason: lastError.slice(0, 240) };
}

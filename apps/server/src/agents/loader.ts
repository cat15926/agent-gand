/**
 * agent 定义文件解析（规格 §4.2 agents/loader.ts）
 * *.agent.md = YAML frontmatter（--- 围栏）+ 正文（systemPrompt）
 * 手写拆分 frontmatter，不引 gray-matter
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { AgentDefinition, PermissionMode } from '@agent-gand/shared';

const PERMISSION_MODES: readonly PermissionMode[] = ['readonly', 'confirm', 'auto'];

/** 手写 frontmatter 拆分：首行 --- 到下一个独立 --- 行 */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error('缺少 frontmatter 起始围栏 ---');
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error('frontmatter 围栏未闭合（缺少第二个 ---）');
  return { frontmatter: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n').trim() };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function parseAgentMarkdown(fileName: string, raw: string): AgentDefinition {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parse(frontmatter);
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error(`${fileName}: frontmatter 必须是 YAML 映射`);
  }
  const fields = fm as Record<string, unknown>;

  const id = str(fields.id) ?? fileName.replace(/\.agent\.md$/, '');
  const model = str(fields.model);
  if (!model) throw new Error(`${fileName}: frontmatter 缺少 model 字段`);

  const rawPermission = str(fields.permissionMode) as PermissionMode | undefined;
  const permissionMode: PermissionMode =
    rawPermission && PERMISSION_MODES.includes(rawPermission) ? rawPermission : 'confirm';

  return {
    id,
    name: str(fields.name) ?? id,
    description: str(fields.description),
    systemPrompt: body,
    model,
    tools: strArray(fields.tools),
    disallowedTools: strArray(fields.disallowedTools),
    permissionMode,
    color: str(fields.color) ?? '#7c8a9c',
    source: 'file',
  };
}

export interface LoadedAgentFile {
  definition: AgentDefinition;
  file: string;
}

/** 读取目录下全部 *.agent.md（排序保证确定性） */
export function loadAgentsFromDir(dir: string): LoadedAgentFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.agent.md'))
    .sort();
  return files.map((file) => ({
    definition: parseAgentMarkdown(file, readFileSync(path.join(dir, file), 'utf-8')),
    file,
  }));
}

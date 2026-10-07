/** 与服务端相同的最长名称匹配和边界规则，避免 @短ID 误匹配其他名称。 */
export function mentionedRecipients(goal: string, agents: Array<{id: string; name: string}>): string[] {
  const found: string[] = [];
  for (const match of goal.matchAll(/(?:^|[\s，,；;、])@/gu)) {
    const rest = goal.slice(match.index! + match[0].length);
    const matches = agents.flatMap(agent => [agent.id,agent.name].filter(name => rest.startsWith(name) && (!rest[name.length] || /[\s，,。！？!?:：；;、]/u.test(rest[name.length]!))).map(name => ({id:agent.id,length:name.length}))).sort((a,b) => b.length-a.length);
    const ids = [...new Set(matches.filter(item => item.length === matches[0]?.length).map(item => item.id))];
    if (ids.length === 1 && !found.includes(ids[0]!)) found.push(ids[0]!);
  }
  return found;
}

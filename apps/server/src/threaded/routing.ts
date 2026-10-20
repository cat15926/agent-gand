import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageReceipt } from '@agent-gand/shared';
import type { QuiescenceProof } from './contracts.ts';
import type { ThreadedMessagePayload, ThreadedUserMessageInput } from './messageContracts.ts';
import { digest, reject, text, strings, object, integer, type CollaborationOptions, type RoutingDecision, type RoutingPolicy } from './collaborationTypes.ts';

type Member = { agent_id: string; handle: string; enabled: number; status: string; role_version: number; agent_version: number };
const stripCode = (body: string) => body.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1|$)/g, match => ' '.repeat(match.length))
  .replace(/`[^`\n]*`/g, match => ' '.repeat(match.length));
const boundary = (next: string | undefined) => !next || /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/.test(next)||!/[a-z0-9_.-]/i.test(next);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userText=(body:string)=>stripCode(body).replace(/[\u200b-\u200d\ufeff\u00ad\u2060]/g,'')
  .replace(/^[ \t]*>[^\n]*/gm,m=>' '.repeat(m.length)).replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』/g,m=>' '.repeat(m.length));
function userPositions(body:string,entries:Array<{id:string;handle:string}>) {
  const source=userText(body),result:Array<{id:string;position:number}>=[];
  for(let i=source.indexOf('@');i>=0;i=source.indexOf('@',i+1)){
    if(i&&/[a-z0-9_.\-/]/i.test(source[i-1]!))continue;
    const token=source.slice(Math.max(source.lastIndexOf(' ',i),source.lastIndexOf('\n',i))+1,i);
    if(token.includes('://'))continue;
    const m=[...entries].sort((a,b)=>b.handle.length-a.handle.length).find(m=>{
      const end=i+1+m.handle.length;return source.slice(i+1,end).toLowerCase()===m.handle.toLowerCase()&&boundary(source[end])
        &&!(source[end]==='.'&&/[\p{L}\p{N}]/u.test(source[end+1]??''));});
    if(m&&!result.some(r=>r.id===m.id))result.push({id:m.id,position:i});
  }
  return result;
}

/** Stable handles, longest match first. User and response parsing deliberately have separate policies. */
export function parseThreadedMentions(body: string, roster: Array<{ id: string; handle: string }>, agent?: string): string[] {
  const entries = roster.filter(m => m.id !== agent).sort((a,b) => b.handle.length-a.handle.length);
  let source = stripCode(body).replace(/[\u200b-\u200d\ufeff\u00ad\u2060]/g, '');
  if (!agent) return userPositions(body,entries).map(r=>r.id);
  const found: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    let rest = line.replace(/^\s*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))*/, '').trimStart();
    while (rest.startsWith('@') && found.length<2) {
      const m = entries.find(m => new RegExp(`^@\\s*${Array.from(m.handle).map(escape).join('\\s*')}(?=$|[\\s,.:;!?，。！？、：；]|[^a-z0-9_.-])`,'iu').test(rest));
      if (!m) break;
      const match = rest.match(new RegExp(`^@\\s*${Array.from(m.handle).map(escape).join('\\s*')}`,'iu'))!;
      if (!found.includes(m.id)) found.push(m.id);
      rest = rest.slice(match[0].length).replace(/^[\s,.:;!?，。！？、：；]+/, '');
    }
  }
  return agent ? found.slice(0,2) : found;
}

export function createThreadedRouting(db: Database.Database, options: CollaborationOptions & {identity?:(scope:{ownerId:string;threadId:string;agentId:string})=>string|null}) {
  const roster = (ownerId: string, threadId: string) => db.prepare(`SELECT m.agent_id,m.handle,m.status,m.role_version,
    a.enabled,a.version agent_version FROM threaded_members m JOIN agents a ON a.id=m.agent_id
    JOIN threaded_threads t ON t.id=m.thread_id AND t.owner_id=m.owner_id
    JOIN threaded_instances i ON i.instance_owner_id=t.owner_id AND i.singleton=1
    WHERE m.owner_id=? AND m.thread_id=?`).all(ownerId, threadId) as Member[];
  const available = (m: Member) => m.enabled===1 && m.status==='joined' && m.role_version===m.agent_version;
  function policy(ownerId: string, threadId: string): RoutingPolicy {
    const row = db.prepare('SELECT record FROM threaded_routing_policies WHERE owner_id=? AND thread_id=?').get(ownerId,threadId) as {record:string}|undefined;
    return row ? JSON.parse(row.record) as RoutingPolicy : reject('THREADED_ROUTING_POLICY_REQUIRED');
  }
  function configure(ownerId: string, threadId: string, input: RoutingPolicy, expectedVersion: number) {
    return db.transaction(() => {
      object(input);integer(expectedVersion,0,1_000_000);
      if(Object.keys(input).some(k=>!['preferred','defaultAgent','duty','groups'].includes(k)))reject('THREADED_ROUTING_POLICY_INVALID',400);
      const members = roster(ownerId,threadId), ids = members.filter(available).map(m=>m.agent_id);
      const normalized = { preferred: strings(input.preferred), defaultAgent: text(input.defaultAgent),
        ...(input.duty ? {duty:text(input.duty)} : {}), groups: object(input.groups ?? {}) as Record<string,string[]> };
      const names=new Set<string>();
      for (const [name,targets] of Object.entries(normalized.groups)) {
        if(!/^[\p{L}\p{N}_.-]+$/u.test(text(name))||names.has(name.toLowerCase())||members.some(m=>m.handle.toLowerCase()===name.toLowerCase())
          ||['all','全体','thread','本帖','全体参与者'].includes(name.toLowerCase()))reject('THREADED_ROUTING_GROUP_INVALID',400);
        names.add(name.toLowerCase());if(!strings(targets).length)reject('THREADED_ROUTING_GROUP_INVALID',400);
      }
      const targets = [...normalized.preferred,normalized.defaultAgent,...(normalized.duty?[normalized.duty]:[]),...Object.values(normalized.groups).flat()];
      if (targets.some(id=>!ids.includes(id))) reject('THREADED_ROUTING_TARGET_UNAVAILABLE');
      const row = db.prepare('SELECT version FROM threaded_routing_policies WHERE owner_id=? AND thread_id=?').get(ownerId,threadId) as {version:number}|undefined;
      if ((row?.version??0)!==expectedVersion) reject('THREADED_ROUTING_POLICY_CONFLICT');
      db.prepare(`INSERT INTO threaded_routing_policies VALUES(?,?,?,?) ON CONFLICT(thread_id)
        DO UPDATE SET version=excluded.version,record=excluded.record`).run(threadId,ownerId,expectedVersion+1,JSON.stringify(normalized));
      return { version:expectedVersion+1,policy:normalized };
    }).immediate();
  }
  function preview(input: {ownerId:string;threadId:string;body:string;targets?:string[]}): RoutingDecision {
    if(typeof input.body!=='string'||Buffer.byteLength(input.body)>1_048_576)reject('THREADED_ROUTING_INPUT_INVALID',400);
    const members=roster(input.ownerId,input.threadId), active=members.filter(available), ids=active.map(m=>m.agent_id);
    const parsed=parseThreadedMentions(input.body,members.map(m=>({id:m.agent_id,handle:m.handle})));
    const warnings=parsed.filter(id=>!ids.includes(id)).map(id=>`unavailable:${id}`);
    const tags=[...input.body.matchAll(/#(\w+)/gi)].map(m=>m[1]!.toLowerCase());
    const intentTag=tags.filter(t=>t==='ideate'||t==='execute').at(-1);
    const promptTags=tags.filter(t=>t==='critique');
    const p=policy(input.ownerId,input.threadId);
    const groups:Record<string,string[]>={...p.groups,all:ids,全体:ids,thread:ids,本帖:ids,全体参与者:ids};
    const groupPositions=userPositions(input.body,Object.keys(groups).map(handle=>({id:handle,handle})));
    const group=groupPositions.sort((a,b)=>b.id.length-a.id.length)[0];
    const individual=userPositions(input.body,members.map(m=>({id:m.agent_id,handle:m.handle})));
    const ordered=group?[...individual.filter(m=>m.position<group.position).map(m=>m.id),...groups[group.id]!,...individual.filter(m=>m.position>=group.position).map(m=>m.id)]:parsed;
    const groupTargets=group?groups[group.id]!:[];
    const mentions=[...new Set(ordered)].filter(id=>ids.includes(id));
    let targets:string[]=[], reason='current_message_mentions';
    if (input.targets!==undefined) {
      targets=strings(input.targets);
      if (!targets.length || targets.some(id=>!ids.includes(id))) reject('THREADED_ROUTING_TARGET_UNAVAILABLE');
      if (mentions.length && digest([...mentions].sort())!==digest([...targets].sort())) reject('THREADED_ROUTING_TARGET_CONFLICT');
      reason='structured_targets';
    } else targets=mentions;
    if (!targets.length && (parsed.length || groupTargets.length)) reject('THREADED_ROUTING_TARGET_UNAVAILABLE');
    if (!targets.length) {
      const pref=p.preferred.filter(id=>ids.includes(id));
      const last=db.prepare(`SELECT record FROM threaded_messages WHERE owner_id=? AND thread_id=? AND origin='user'
        AND state='published' ORDER BY seq DESC LIMIT 1`).get(input.ownerId,input.threadId) as {record:string}|undefined;
      const previous=last?JSON.parse(last.record) as {body:string}:null;
      const previousTargets=previous?parseThreadedMentions(previous.body,members.map(m=>({id:m.agent_id,handle:m.handle}))).filter(id=>ids.includes(id)):[];
      const replies=db.prepare(`SELECT m.sender_agent_id FROM threaded_messages m JOIN threaded_invocations i ON i.id=m.source_invocation_id
        WHERE m.owner_id=? AND m.thread_id=? AND m.origin='agent_response' AND m.state='published' AND i.status='completed'
        ORDER BY m.seq DESC`).all(input.ownerId,input.threadId) as Array<{sender_agent_id:string}>;
      const healthy=replies.find(r=>ids.includes(r.sender_agent_id))?.sender_agent_id;
      if (intentTag==='ideate' && pref.length>1) {targets=pref;reason='preferred_parallel';}
      else if (p.duty && ids.includes(p.duty)) {targets=[p.duty];reason='duty';}
      else if (previousTargets.length) {targets=[previousTargets[0]!];reason='previous_user_mentions';}
      else if (healthy) {targets=[healthy];reason='recent_healthy_replier';}
      else if (pref.length) {targets=[pref[0]!];reason='preferred';}
      else if (ids.includes(p.defaultAgent)) {targets=[p.defaultAgent];reason='default';}
      else reject('THREADED_ROUTING_NO_AVAILABLE_TARGET');
    }
    const intent=(intentTag??(targets.length>=2?'ideate':'execute')) as RoutingDecision['intent'];
    return {targets,strategy:intent==='ideate'&&targets.length>1?'parallel':'serial',intent,promptTags,intentExplicit:!!intentTag,reason,warnings,
      explicit:mentions.length>0||input.targets!==undefined};
  }
  function save(receipt:ThreadedMessageReceipt,decision:RoutingDecision,kind:string,extra:Record<string,unknown>={}) {
    db.prepare('INSERT OR IGNORE INTO threaded_message_routes VALUES(?,?,?,?,?,?,?)').run(receipt.message.id,receipt.message.ownerId,
      receipt.message.threadId,kind,decision.strategy,JSON.stringify(decision.targets),JSON.stringify({...decision,...extra}));
  }
  function acceptUserMessage(input:ThreadedUserMessageInput) {
    if(db.inTransaction) reject('THREADED_COLLABORATION_OUTERMOST_REQUIRED');
    const result=db.transaction(()=>{
      const fingerprint=digest(input), prior=db.prepare(`SELECT request_hash,record FROM threaded_user_route_requests
        WHERE owner_id=? AND thread_id=? AND request_key=?`).get(input.ownerId,input.threadId,input.clientRequestId) as {request_hash:string;record:string}|undefined;
      if(prior) {if(prior.request_hash!==fingerprint)reject('THREADED_ROUTING_IDEMPOTENCY_CONFLICT');return JSON.parse(prior.record) as {receipt:ThreadedMessageReceipt;route:RoutingDecision};}
      const route=preview(input), targets=route.strategy==='serial'?route.targets.slice(0,1):route.targets;
      const receipt=options.messages.acceptUserMessageWithinTransaction({...input,targets});
      save(receipt,route,'user',{originalBody:input.body,targetIdentities:Object.fromEntries(route.targets.map(agentId=>[agentId,options.identity?.({...input,agentId})]))});
      const value={receipt,route};
      db.prepare('INSERT INTO threaded_user_route_requests VALUES(?,?,?,?,?,?)').run(input.ownerId,input.threadId,input.clientRequestId,fingerprint,receipt.message.id,JSON.stringify(value));
      return value;
    }).immediate(); options.onCommitted?.(); return result;
  }
  function agentRouting(binding:ThreadedBinding,body:string,targets?:string[]) {
    const members=roster(binding.ownerId,binding.threadId), ids=members.filter(available).map(m=>m.agent_id);
    const parsed=parseThreadedMentions(body,members.map(m=>({id:m.agent_id,handle:m.handle})),binding.agentId);
    const source=db.prepare(`SELECT q.source_message_id FROM threaded_invocation_wakes q WHERE q.invocation_id=?`).get(binding.invocationId) as {source_message_id:string};
    const route=db.prepare('SELECT strategy FROM threaded_message_routes WHERE message_id=?').get(source.source_message_id) as {strategy:string}|undefined;
    if(targets!==undefined && parsed.length && digest([...parsed].sort())!==digest([...targets].sort()))reject('THREADED_ROUTING_TARGET_CONFLICT');
    let selected=targets===undefined?(route?.strategy==='parallel'?[]:parsed):strings(targets);
    if(selected.some(id=>!ids.includes(id)||id===binding.agentId))reject('THREADED_ROUTING_TARGET_UNAVAILABLE');
    const reset=(db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM threaded_messages WHERE thread_id=? AND origin='user'").get(binding.threadId) as {seq:number}).seq;
    const prior=db.prepare('SELECT pair,streak,reset_seq FROM threaded_relay_events WHERE message_id=?').get(source.source_message_id) as {pair:string|null;streak:number;reset_seq:number}|undefined;
    const substantive=!!db.prepare('SELECT 1 FROM threaded_tool_receipts WHERE binding_id=? AND substantive=1').get(binding.id)||body.length>200;
    const pair=selected.length===1?JSON.stringify([binding.agentId,selected[0]!].sort())
      :selected.length===0&&!substantive&&prior?.reset_seq===reset?prior.pair:null;
    const streak=selected.length===0?(pair?prior?.streak??0:0)
      :pair && prior?.pair===pair && prior.reset_seq===reset && !substantive?prior.streak+1:1;
    const blocked=selected.length>0&&!!pair&&streak>=4, warning=!!pair&&streak>=2&&streak<4;
    if(blocked)selected=[];
    return {targets:selected,pair,streak,reset,blocked,warning};
  }
  function recordRelay(receipt:ThreadedMessageReceipt, result:ReturnType<typeof agentRouting>) {
    db.prepare('INSERT OR IGNORE INTO threaded_relay_events VALUES(?,?,?,?,?,?,?,?,?)').run(receipt.message.id,receipt.message.causalRootId,
      receipt.message.threadId,result.reset,result.pair,result.streak,result.warning?1:0,result.blocked?1:0,JSON.stringify(result));
    save(receipt,{targets:result.targets,strategy:result.targets.length>1?'parallel':'serial',intent:result.targets.length>1?'ideate':'execute',
      intentExplicit:false,promptTags:[],reason:'agent_addressing',warnings:result.warning?['ping_pong_warning']:result.blocked?['ping_pong_blocked']:[],explicit:true},'agent');
  }
  function sourceRoute(binding:ThreadedBinding) {
    return db.prepare(`SELECT r.*,q.source_message_id FROM threaded_invocation_wakes q JOIN threaded_message_routes r
      ON r.message_id=q.source_message_id WHERE q.invocation_id=?`).get(binding.invocationId) as
      {kind:string;strategy:string;record:string;source_message_id:string}|undefined;
  }
  return {configure,preview,acceptUserMessage,agentRouting,recordRelay,save,sourceRoute,
    prompt(binding:ThreadedBinding){const route=sourceRoute(binding);const tags=route?(JSON.parse(route.record) as {promptTags?:string[]}).promptTags:[];
      return tags?.includes('critique')?'本次采用批判性分析：检查假设、证据、风险和反例，明确说明不同意见。该提示不改变收件人、执行顺序或业务授权。':null;},
    warning(binding:ThreadedBinding){const row=db.prepare(`SELECT r.streak,r.reset_seq,r.pair FROM threaded_relay_events r
      JOIN threaded_invocation_wakes q ON q.source_message_id=r.message_id WHERE q.invocation_id=? AND r.warning=1`).get(binding.invocationId) as {streak:number;reset_seq:number;pair:string|null}|undefined;
      const reset=(db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM threaded_messages WHERE thread_id=? AND origin='user'").get(binding.threadId) as {seq:number}).seq;
      return row&&row.reset_seq===reset&&row.pair&&(JSON.parse(row.pair) as string[]).includes(binding.agentId)?`协作提示：同一成员对已连续进行了 ${row.streak} 次短回复接力。请推进实质工作或明确结束接力；第 4 次无实质进展的接力将被阻断。`:null;},
    getPolicy(ownerId:string,threadId:string){const row=db.prepare('SELECT version,record FROM threaded_routing_policies WHERE owner_id=? AND thread_id=?').get(ownerId,threadId) as {version:number;record:string}|undefined;
      return row?{version:row.version,policy:JSON.parse(row.record) as RoutingPolicy}:null;},
    postWithin(binding:ThreadedBinding,key:string,input:ThreadedMessagePayload) {
      const route=agentRouting(binding,input.body,input.targets), receipt=options.messages.postAgentMessageWithinTransaction({
        ...input,binding,toolCallId:key,targets:route.targets});
      recordRelay(receipt,route); return receipt;
    },
    responseWithin(binding:ThreadedBinding,key:string,proof:QuiescenceProof,input:ThreadedMessagePayload) {
      const route=agentRouting(binding,input.body,input.state==='draft'?[]:input.targets), receipt=options.messages.appendResponseWithinTransaction({
        ...input,binding,responseCommitKey:key,quiescence:proof,targets:route.targets});
      recordRelay(receipt,route);return receipt;
    },
  };
}

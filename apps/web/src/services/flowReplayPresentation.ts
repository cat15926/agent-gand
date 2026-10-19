import type {AutonomousTaskView,Message} from '@agent-gand/shared';

type Role='wolf'|'seer'|'villager';
export interface ReplayAction {actor:string;kind:'attack'|'inspect'|'vote'|'statement';target:string;claim?:'seer'|'villager'|'unspecified';confidence?:'low'|'medium'|'high';}
export interface ReplayLine {type:'night'|'statement'|'vote'|'exile'|'alive';actor?:string;target?:string;round?:number;votes?:number;players?:string[];claim?:ReplayAction['claim'];confidence?:ReplayAction['confidence'];}
export interface ReplayPresentation {rules:string;winner:'wolf'|'villagers';players:Array<{id:string;role:Role}>;stages:Array<{number:number;title:string;lines:ReplayLine[];actions:ReplayAction[]}>;}

/** Read-only presentation of the exact public terminal envelope. Never reads
 * private messages, changes stored bytes, or decides whether a game is valid. */
export type ReplayFlow=NonNullable<AutonomousTaskView['flows']>[number];
export function completedWerewolfReplay(message:Message,flow?:ReplayFlow):ReplayPresentation|null {
  if(message.kind!=='agent'||message.messageType!=='collaboration_result'||typeof message.meta?.autonomousEmissionId!=='string'
    ||message.meta.authorizedBy!=='task_sources'
    ||!flow||flow.protocol!=='werewolf-five-v1'||flow.status!=='completed'||flow.phase!=='terminal')return null;
  const match=message.body.match(/^流程结束 · werewolf-five-v1\n\n规则：([^\n]+)\n\n完整回放：\n([\s\S]+)\n\n已接受的独立行动：\n([\s\S]+)$/);
  if(!match)return null;
  const history=match[2]!.split(/\n\n(?=\d+\. )/),actionRows=match[3]!.split('\n');
  if(history.length!==flow.step||actionRows.length!==flow.step||flow.step<3||flow.step>4)return null;
  const terminal=history.at(-1)!.match(/\n本局结束：(狼人|好人阵营)获胜。终局身份：([^\n]+)。$/);
  if(!terminal)return null;
  const players:Array<{id:string;role:Role}>=[];
  for(const entry of terminal[2]!.split('、')){
    const pair=entry.match(/^(\S+)=(wolf|seer|villager)$/);if(!pair||players.some(p=>p.id===pair[1]))return null;
    players.push({id:pair[1]!,role:pair[2] as Role});
  }
  if(players.length!==5||players.filter(p=>p.role==='wolf').length!==1||players.filter(p=>p.role==='seer').length!==1)return null;
  const known=(id:string)=>players.some(p=>p.id===id),stages:ReplayPresentation['stages']=[];
  for(let i=0;i<history.length;i++){
    const entry=history[i]!.match(/^(\d+)\. ([\s\S]+)$/),row=actionRows[i]!.match(/^阶段 (\d+)：(.+)$/);
    if(!entry||!row||Number(entry[1])!==i+1||Number(row[1])!==i+1)return null;
    const actions:ReplayAction[]=[];
    for(const part of row[2]!.split('；')){
      const record=part.match(/^(\S+) (\{.*\})$/);if(!record||!known(record[1]!)||actions.some(a=>a.actor===record[1]))return null;
      let value:Record<string,unknown>;try{value=JSON.parse(record[2]!);}catch{return null;}
      if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.target!=='string'||!known(value.target)||record[1]===value.target)return null;
      const kind=value.kind,expected=i===0||i===3?['attack','inspect']:i===1?['statement']:['vote'];
      const keys=kind==='statement'?['kind','target','claim','confidence']:['kind','target'];
      if(!expected.includes(String(kind))||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))return null;
      if(kind==='statement'&&(!['seer','villager','unspecified'].includes(String(value.claim))||!['low','medium','high'].includes(String(value.confidence))))return null;
      if(kind==='attack'&&players.find(p=>p.id===record[1])?.role!=='wolf'||kind==='inspect'&&players.find(p=>p.id===record[1])?.role!=='seer')return null;
      actions.push({actor:record[1]!,...value} as ReplayAction);
    }
    const lines:ReplayLine[]=[];
    const eventLines=entry[2]!.split('\n');
    for(const line of eventLines){
      let parsed:RegExpMatchArray|null;
      if(line===terminal[0]!.slice(1)){if(i!==history.length-1)return null;continue;}
      if((parsed=line.match(/^第(\d+)夜结束：(\S+)死亡。$/))&&known(parsed[2]!))lines.push({type:'night',round:Number(parsed[1]),target:parsed[2]});
      else if((parsed=line.match(/^(\S+) 自称 (seer|villager|unspecified)，建议放逐 (\S+)，信心 (low|medium|high)。$/))&&known(parsed[1]!)&&known(parsed[3]!))lines.push({type:'statement',actor:parsed[1],claim:parsed[2] as ReplayAction['claim'],target:parsed[3],confidence:parsed[4] as ReplayAction['confidence']});
      else if((parsed=line.match(/^(\S+) 投给 (\S+)。$/))&&known(parsed[1]!)&&known(parsed[2]!))lines.push({type:'vote',actor:parsed[1],target:parsed[2]});
      else if((parsed=line.match(/^(\S+) 被放逐（(\d+)票；同票依初始座次）。$/))&&known(parsed[1]!))lines.push({type:'exile',target:parsed[1],votes:Number(parsed[2])});
      else if((parsed=line.match(/^存活：(.+)。$/))&&parsed[1]!.split('、').every(known))lines.push({type:'alive',players:parsed[1]!.split('、')});
      else return null;
    }
    stages.push({number:i+1,title:i===0?'第1夜':i===1?'第1天 · 声明':i===2?'第1天 · 投票':'第2夜',lines,actions});
  }
  return {rules:match[1]!,winner:terminal[1]==='狼人'?'wolf':'villagers',players,stages};
}

export const ROLE_LABEL={wolf:'狼人',seer:'预言家',villager:'村民',unspecified:'未表明身份'};
export const CONFIDENCE_LABEL={low:'低',medium:'中',high:'高'};

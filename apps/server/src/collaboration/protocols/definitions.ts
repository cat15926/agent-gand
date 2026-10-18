import {randomInt} from 'node:crypto';
import {autonomousDigest as digest,autonomousFail as fail,autonomousObject as object} from '../../runtime/autonomousPolicy.ts';

export type FlowAction={kind:string;target?:string;claim?:string;confidence?:string;verdict?:string};
export interface FlowState {
 phase:string;round:number;alive:string[];roles:Record<string,string>;clues:Record<string,Array<{target:string;result:string}>>;
 history:string[];winner:string|null;
}
export interface FlowDefinition {
 id:string;descriptor:string;rules:string;minActors:number;maxActors:number;maxSteps:number;
 initialize:(players:string[])=>FlowState;
 actors:(state:FlowState)=>string[];
 material:(state:FlowState,actor:string)=>Record<string,unknown>;
 action:(state:FlowState,actor:string,value:unknown)=>FlowAction;
 reduce:(state:FlowState,actions:Record<string,FlowAction>,players:string[])=>FlowState;
}
const reject=():never=>fail('AUTONOMOUS_FLOW_ACTION_INVALID');
const victory=(s:FlowState)=>{const wolves=s.alive.filter(id=>s.roles[id]==='wolf').length;s.winner=!wolves?'villagers':wolves*2>=s.alive.length?'wolf':null;};
const werewolf:FlowDefinition={
 id:'werewolf-five-v1',descriptor:'five-seats;crypto-shuffle;1-wolf-1-seer-3-villagers;simultaneous-night;seer-each-night;structured-claims;no-self-target;seat-order-tie;wolf-dead-villagers-win;wolf-parity-wins;terminal-reveal;max4-steps',
 rules:'五人简化狼人杀：1狼人、1预言家、3村民。夜间狼人击杀其他存活者，存活预言家查验其他存活者；同时结算，查验仅本人可见。白天先结构化声明再投票，不可自投。同票按最初座次优先放逐。狼人死亡则好人胜，狼人达到存活人数一半则狼人胜。终局才公开全部身份及行动回放。声明是真假自称，不是身份事实；不支持自由文字自动公开。',
 minActors:5,maxActors:5,maxSteps:4,
 initialize(players){const deck=['wolf','seer','villager','villager','villager'];for(let n=deck.length-1;n>0;n--){const i=randomInt(n+1);[deck[n],deck[i]]=[deck[i]!,deck[n]!];}return {phase:'night',round:1,alive:[...players],roles:Object.fromEntries(players.map((p,i)=>[p,deck[i]!])),clues:{},history:[],winner:null};},
 actors:s=>s.phase==='night'?s.alive.filter(id=>['wolf','seer'].includes(s.roles[id]!)):[...s.alive],
 material(s,actor){return {phase:s.phase,round:s.round,seat:actor,privateIdentity:s.roles[actor],privateClues:s.clues[actor]??[],alive:s.alive,publicHistory:s.history,
  requiredAction:s.phase==='night'?{kind:s.roles[actor]==='wolf'?'attack':'inspect',target:'其他存活玩家 ID'}:s.phase==='discussion'?{kind:'statement',target:'其他存活玩家 ID',claim:'seer | villager | unspecified',confidence:'low | medium | high'}:{kind:'vote',target:'其他存活玩家 ID'}};},
 action(s,actor,value){if(s.winner||!werewolf.actors(s).includes(actor))return reject();const kind=s.phase==='night'?(s.roles[actor]==='wolf'?'attack':'inspect'):s.phase==='discussion'?'statement':'vote';const keys=kind==='statement'?['kind','target','claim','confidence']:['kind','target'];const a=object(value,keys);if(Object.keys(a).length!==keys.length||a.kind!==kind||typeof a.target!=='string'||a.target===actor||!s.alive.includes(a.target))return reject();if(kind==='statement'&&(!['seer','villager','unspecified'].includes(String(a.claim))||!['low','medium','high'].includes(String(a.confidence))))return reject();return a as FlowAction;},
 reduce(previous,actions,players){const s=structuredClone(previous),actors=werewolf.actors(s);let event:string;
  if(s.phase==='night'){const wolf=actors.find(p=>s.roles[p]==='wolf')!,victim=actions[wolf]!.target!;for(const actor of actors.filter(p=>s.roles[p]==='seer')){const target=actions[actor]!.target!;s.clues[actor]=[...(s.clues[actor]??[]),{target,result:s.roles[target]==='wolf'?'wolf':'not-wolf'}];}s.alive=s.alive.filter(p=>p!==victim);event=`第${s.round}夜结束：${victim}死亡。`;s.phase='discussion';}
  else if(s.phase==='discussion'){event=actors.map(p=>`${p} 自称 ${actions[p]!.claim}，建议放逐 ${actions[p]!.target}，信心 ${actions[p]!.confidence}。`).join('\n');s.phase='vote';}
  else {const counts:Record<string,number>={};for(const p of actors){const target=actions[p]!.target!;counts[target]=(counts[target]??0)+1;}const victim=Object.keys(counts).sort((a,b)=>counts[b]!-counts[a]!||players.indexOf(a)-players.indexOf(b))[0]!;s.alive=s.alive.filter(p=>p!==victim);event=actors.map(p=>`${p} 投给 ${actions[p]!.target}。`).join('\n')+`\n${victim} 被放逐（${counts[victim]}票；同票依初始座次）。`;s.phase='night';s.round++;}
  victory(s);event+='\n存活：'+s.alive.join('、')+'。';if(s.winner){s.phase='terminal';event+=`\n本局结束：${s.winner==='wolf'?'狼人':'好人阵营'}获胜。终局身份：`+players.map(p=>`${p}=${s.roles[p]}`).join('、')+'。';}s.history.push(event);return s;
 },
};
const consensus:FlowDefinition={
 id:'review-ballot-v1',descriptor:'independent-review-ballot;2-to-8-actors;approve-revise-reject;fixed-count-projection;reject-first-then-revise;one-step',
 rules:'各成员独立阅读本轮获准材料，提交 approve（通过）、revise（需修改）或 reject（不接受）。平台仅公布计数；存在 reject 则不接受，否则存在 revise 则需修改，否则通过。该结论是成员评审意见，不等于用户业务验收。',minActors:2,maxActors:8,maxSteps:1,
 initialize:players=>({phase:'review',round:1,alive:[...players],roles:{},clues:{},history:[],winner:null}),actors:s=>[...s.alive],
 material:s=>({phase:s.phase,requiredAction:{kind:'review',verdict:'approve | revise | reject'},publicHistory:s.history}),
 action(s,actor,value){if(s.winner||!s.alive.includes(actor))return reject();const a=object(value,['kind','verdict']);if(Object.keys(a).length!==2||a.kind!=='review'||!['approve','revise','reject'].includes(String(a.verdict)))return reject();return a as FlowAction;},
 reduce(previous,actions){const s=structuredClone(previous),counts={approve:0,revise:0,reject:0};for(const a of Object.values(actions))counts[a.verdict as keyof typeof counts]++;s.winner=counts.reject?'reject':counts.revise?'revise':'approve';s.phase='terminal';s.history.push(`独立评审：通过 ${counts.approve}，需修改 ${counts.revise}，不接受 ${counts.reject}。结论：${s.winner}（成员意见，待用户验收）。`);return s;},
};
export const FLOW_DEFINITIONS=[werewolf,consensus];
export const flowCatalog=()=>FLOW_DEFINITIONS.map(d=>({id:d.id,sha256:digest({id:d.id,descriptor:d.descriptor,rules:d.rules}),rules:d.rules}));
export function flowDefinition(id:string):FlowDefinition{const d=FLOW_DEFINITIONS.find(d=>d.id===id);return d??fail('AUTONOMOUS_FLOW_INVALID');}
export function reduceFlow(id:string,state:FlowState,actions:Record<string,FlowAction>,players:string[]):FlowState{const d=flowDefinition(id),actors=d.actors(state);if(state.winner||Object.keys(actions).length!==actors.length||actors.some(p=>!actions[p]))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');for(const actor of actors)d.action(state,actor,actions[actor]);return d.reduce(state,actions,players);}

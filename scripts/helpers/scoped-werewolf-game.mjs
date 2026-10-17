import {randomBytes,randomInt} from 'node:crypto';
export const seats=['ww-a','ww-b','ww-c','ww-d','ww-e'];
export const label=id=>'玩家 '+id.slice(-1).toUpperCase();
export function createGame(random=randomInt){
  const deck=['wolf','seer','villager','villager','villager'];
  for(let i=deck.length-1;i>0;i--){const j=random(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
  return {roles:Object.fromEntries(seats.map((id,i)=>[id,deck[i]])),alive:[...seats],clues:{},events:[],privateTags:Object.fromEntries(seats.map(id=>[id,'PRIVATE_ROLE_GUARD_'+randomBytes(12).toString('hex')])),winner:null};
}
export const rules='五人简化狼人杀：1 狼人、1 预言家、3 村民。夜间狼人选择一名其他存活者击杀，预言家首夜查验一名其他存活者；身份和查验结果私密。白天存活者先作结构化声明，再投票放逐一名其他存活者。票数相同按座次 A→E 靠前者放逐。狼人死亡则好人胜；狼人达到存活人数一半则狼人胜。终局才公开全部身份。';
export function actors(game,phase){
  if(game.winner)throw new Error('GAME_ALREADY_FINISHED');
  if(phase==='night-1')return seats.filter(id=>['wolf','seer'].includes(game.roles[id]));
  if(phase==='night-2')return game.alive.filter(id=>game.roles[id]==='wolf');
  return [...game.alive];
}
export function material(game,id,phase){
  const kind=phase.startsWith('night')?(game.roles[id]==='wolf'?'attack':'inspect'):phase==='discussion'?'statement':'vote';
  const schema=kind==='statement'?{kind,target:'一个其他存活玩家 ID',claim:'seer / villager / unspecified',confidence:'low / medium / high'}:{kind,target:'一个其他存活玩家 ID'};
  return JSON.stringify({rules,seat:id,privateIdentity:game.roles[id],privateClues:game.clues[id]??[],privateBoundaryGuard:game.privateTags[id],alive:game.alive,publicHistory:game.events,phase,
    instruction:'为自己的真实阵营争取胜利；狼人可以策略性伪装。不要代替别人行动。必须调用 agent.complete，summary 是 requiredAction 所示对象的 JSON 字符串。kind/target 等字段直接放在最外层，不要 action 包装，不加 Markdown、解释、身份、私密标记或其他阶段的行动。夜间只提交 attack 或 inspect；statement 仅在 discussion 阶段提交，其 claim 是公开自称，可真可假；target 是建议放逐者。',requiredAction:schema});
}
export function parseAction(game,id,phase,raw){
  let action;try{action=JSON.parse(raw);}catch{throw new Error('GAME_ACTION_NOT_JSON');}
  if(!action||typeof action!=='object'||Array.isArray(action))throw new Error('GAME_ACTION_INVALID');
  // Some providers wrap a night decision with an unsolicited future statement.
  // Only the strictly validated action is consumed; the statement stays private and is never published.
  if(phase.startsWith('night')&&Object.keys(action).length===2&&Object.hasOwn(action,'action')&&Object.hasOwn(action,'statement')){
    const statement=action.statement;
    if(!statement||typeof statement!=='object'||Array.isArray(statement)||Object.keys(statement).some(k=>!['claim','target','confidence'].includes(k))||!['seer','villager','unspecified'].includes(statement.claim)||!game.alive.includes(statement.target)||statement.target===id||(statement.confidence!==undefined&&!['low','medium','high'].includes(statement.confidence)))throw new Error('GAME_ACTION_INVALID');
    action=action.action;
    if(!action||typeof action!=='object'||Array.isArray(action))throw new Error('GAME_ACTION_INVALID');
  }
  const kind=phase.startsWith('night')?(game.roles[id]==='wolf'?'attack':'inspect'):phase==='discussion'?'statement':'vote';
  const keys=kind==='statement'?['kind','target','claim','confidence']:['kind','target'];
  if(Object.keys(action).length!==keys.length||Object.keys(action).some(k=>!keys.includes(k))||action.kind!==kind||!game.alive.includes(action.target)||action.target===id)throw new Error('GAME_ACTION_INVALID');
  if(kind==='statement'&&(!['seer','villager','unspecified'].includes(action.claim)||!['low','medium','high'].includes(action.confidence)))throw new Error('GAME_STATEMENT_INVALID');
  return action;
}
function finish(game){const wolves=game.alive.filter(id=>game.roles[id]==='wolf').length;if(!wolves)game.winner='villagers';else if(wolves*2>=game.alive.length)game.winner='wolf';}
export function resolve(game,phase,actions){
  const expected=actors(game,phase);
  if(Object.keys(actions).length!==expected.length||expected.some(id=>!actions[id]))throw new Error('GAME_ACTION_SET_INCOMPLETE');
  for(const id of expected)parseAction(game,id,phase,JSON.stringify(actions[id]));
  let event;
  if(phase.startsWith('night')){
    const wolf=expected.find(id=>game.roles[id]==='wolf'),victim=actions[wolf].target;
    for(const id of expected.filter(id=>game.roles[id]==='seer')){const target=actions[id].target;game.clues[id]=[...(game.clues[id]??[]),{target,result:game.roles[target]==='wolf'?'wolf':'not-wolf'}];}
    game.alive=game.alive.filter(id=>id!==victim);event=`第 ${phase==='night-1'?1:2} 夜结束：${label(victim)} 死亡。`;
  }else if(phase==='discussion'){
    event=expected.map(id=>`${label(id)} 自称${{seer:'预言家',villager:'村民',unspecified:'不公开身份'}[actions[id].claim]}，建议放逐${label(actions[id].target)}，信心${{low:'低',medium:'中',high:'高'}[actions[id].confidence]}。`).join('\n');
  }else{
    const counts=Object.values(actions).reduce((map,a)=>(map[a.target]=(map[a.target]??0)+1,map),{});
    const victim=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]||seats.indexOf(a)-seats.indexOf(b))[0];
    game.alive=game.alive.filter(id=>id!==victim);event=expected.map(id=>`${label(id)} 投给${label(actions[id].target)}。`).join('\n')+`\n${label(victim)} 被放逐（${counts[victim]} 票；同票依座次裁定）。`;
  }
  finish(game);event+='\n存活：'+game.alive.map(label).join('、')+'。';
  if(game.winner)event+=`\n本局结束：${game.winner==='wolf'?'狼人':'好人阵营'}获胜。终局身份：`+seats.map(id=>`${label(id)}=${{wolf:'狼人',seer:'预言家',villager:'村民'}[game.roles[id]]}`).join('、')+'。';
  game.events.push(event);return event;
}

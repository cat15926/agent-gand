// Deterministic *mock Provider*, never a live-model quality claim. Choices depend only on this actor's prompt.
import assert from 'node:assert/strict';
export const flowCall=(name,input)=>({name,input:JSON.stringify(input)});
export const flowResponse=call=>({content:'',toolCalls:[call],usage:{tokensIn:5,tokensOut:8,costUsd:0,inputKnown:true,outputKnown:true,costKnown:true,costSource:'reported'},truncated:false,stopReason:'tool_use'});
export const flowMaterial=body=>{const line=body.split('\n').filter(l=>l.startsWith('{"flowId":')&&l.includes('requiredAction')).at(-1);return line?JSON.parse(line):null;};
export const flowPublicState=body=>JSON.parse([...body.matchAll(/当前流程公开状态：([^\n]+?)。如果需求/g)].at(-1)?.[1]??'null');
export function createStructuredFlowProvider({protocol='werewolf-five-v1',players,strategy='first',invalidOnce=false,onAction,onCall}={}){let invalid=false;return async req=>{
 const body=req.messages.map(m=>m.content).join('\n');await onCall?.(req,body);
 const m=flowMaterial(body);if(m){assert.equal((body.match(/"privateIdentity":/g)??[]).length,protocol==='werewolf-five-v1'?1:0);assert.equal(m.seat??req.model.slice(5),req.model.slice(5));assert.deepEqual(req.tools.map(t=>t.name),['agent.flow_action']);await onAction?.(m,req,body);
  const kind=m.requiredAction.kind;if(invalidOnce&&!invalid){invalid=true;return flowResponse(flowCall('agent.complete',{summary:'这是一条故意使用错误工具的模拟响应，必须纠正且不能完成玩家责任。'}));}
  const targets=m.alive?.filter(id=>id!==m.seat),target=strategy==='last'?targets?.at(-1):targets?.[0];
  const action=kind==='review'?{kind,verdict:'approve'}:{kind,target,...(kind==='statement'?{claim:'unspecified',confidence:'low'}:{})};return flowResponse(flowCall('agent.flow_action',action));
 }
 if(body.includes('【流程终局回执】'))return flowResponse(flowCall('agent.complete',{summary:'独立行动与规则裁决均已有实际记录，现交付平台核验的终局与完整回放。'}));
 const f=flowPublicState(body);return flowResponse(flowCall('agent.flow',f?{commandKey:'advance-'+f.step,flowId:f.flowId,expectedStep:f.step}:{commandKey:'start',protocol,players}));
};}

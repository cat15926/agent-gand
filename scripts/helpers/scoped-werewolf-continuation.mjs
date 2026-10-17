import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {actors,parseAction} from './scoped-werewolf-game.mjs';

export function enlargedLimits(previous){
  assert.deepEqual(previous,{maxStarts:36,maxOutputTokens:48000,maxDurationMs:600000,requestTimeoutMs:60000,perRequestMaxTokens:4096});
  return {...previous,maxOutputTokens:previous.maxOutputTokens*3,perRequestMaxTokens:previous.perRequestMaxTokens*3,requestTimeoutMs:600000,maxDurationMs:1800000};
}
export function recoverCompletedActions(game,phase,rows){
  const recovered=[];
  for(const target of actors(game,phase)){
    const matches=rows.filter(row=>row.agent_id===target);
    assert.ok(matches.length<=1,'DUPLICATE_PRIOR_PLAYER_ATTEMPT');
    const row=matches[0];if(!row||row.status!=='completed')continue;
    assert.ok(row.id&&row.output_message_id&&row.output===row.body&&row.visibility==='private');
    assert.deepEqual(JSON.parse(row.audience).sort(),['user',target].sort());
    recovered.push({target,attemptId:row.id,messageId:row.output_message_id,output:row.output,action:parseAction(game,target,phase,row.output)});
  }
  return {recovered,pending:actors(game,phase).filter(id=>!recovered.some(r=>r.target===id))};
}
export function historicalSnapshot(db,runIds){
  return Object.fromEntries(['runs','collaboration_attempts','scoped_delivery_plans','orchestration_model_calls','orchestration_token_reservations','messages'].map(table=>[table,
    runIds.flatMap(id=>db.all(`SELECT * FROM ${table} WHERE ${table==='runs'?'id':'run_id'}=? ORDER BY rowid`,id))]));
}
export const snapshotDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function prepareContinuation(db,previous,game){
  assert.equal(previous.status,'failed');assert.equal(previous.errorCode,'REAL_GAME_RUN_FAILED');
  assert.equal(previous.continuations?.length??0,0);
  assert.equal(previous.phases.length,2);assert.equal(previous.phases[0].status,'completed');assert.equal(previous.phases[0].phase,'night-1');
  const failed=previous.phases[1];assert.equal(failed.phase,'discussion');assert.ok(!failed.releaseRunId);
  assert.equal(game.events.length,1);assert.equal(game.winner,null);
  assert.equal(game.events[0],previous.phases[0].announcement);
  assert.equal(db.get('SELECT status FROM runs WHERE id=?',failed.runId)?.status,'failed');
  assert.equal(db.get("SELECT COUNT(*) n FROM runs WHERE status NOT IN ('completed','failed','cancelled')").n,0);
  assert.equal(db.get('SELECT COUNT(*) n FROM campaign_network_requests').n,previous.realSupplierRequests);
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_model_calls WHERE started_at IS NOT NULL').n,previous.starts);
  const unknown=db.all("SELECT id FROM orchestration_token_reservations WHERE status='unknown' ORDER BY id").map(row=>row.id);
  assert.equal(unknown.length,1);assert.equal(unknown.length,previous.tokens.unknownCalls);
  const rows=db.all(`SELECT a.id,a.agent_id,a.status,a.output,d.output_message_id,m.body,m.visibility,m.audience FROM collaboration_attempts a
    JOIN collaboration_dispatches d ON d.id=a.dispatch_id LEFT JOIN messages m ON m.id=d.output_message_id
    WHERE a.run_id=? AND a.agent_id IN ('ww-a','ww-b','ww-c','ww-d','ww-e')`,failed.runId);
  const actions=recoverCompletedActions(game,'discussion',rows);assert.equal(actions.recovered.length,2);assert.equal(actions.pending.length,2);
  const runIds=previous.phases.flatMap(p=>[p.runId,p.releaseRunId].filter(Boolean)),snapshot=historicalSnapshot(db,runIds);
  return {id:randomUUID(),authorizedAt:new Date().toISOString(),authorization:'用户明确要求：回复时限10分钟、Token限制提高3倍，继续同一轮游戏；保留旧未知占额，仅补缺项。',sourceRunId:failed.runId,
    historicalRunIds:runIds,historicalDigest:snapshotDigest(snapshot),acknowledgedUnknownCallIds:unknown,reusedResults:actions.recovered,pendingTargets:actions.pending,previousLimits:previous.limits,limits:enlargedLimits(previous.limits)};
}
/** Test-campaign guard only. Acknowledgements never settle or erase unknown reservations. */
export function installCampaignLimits(db,limits,deadline,continuation){
  for(const n of [limits.maxStarts,limits.maxOutputTokens,deadline])assert.ok(Number.isSafeInteger(n)&&n>0);
  db.db.exec(`CREATE TABLE IF NOT EXISTS campaign_network_requests(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,http_status INTEGER);
    CREATE TABLE IF NOT EXISTS campaign_continuations(id TEXT PRIMARY KEY,record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaign_acknowledged_unknowns(call_id TEXT PRIMARY KEY,continuation_id TEXT NOT NULL REFERENCES campaign_continuations(id));`);
  db.tx(()=>{
    if(continuation){
      db.run('INSERT INTO campaign_continuations VALUES (?,?)',continuation.id,JSON.stringify(continuation));
      for(const id of continuation.acknowledgedUnknownCallIds){
        assert.equal(db.get('SELECT status FROM orchestration_token_reservations WHERE id=?',id)?.status,'unknown');
        db.run('INSERT INTO campaign_acknowledged_unknowns VALUES (?,?)',id,continuation.id);
      }
    }
    db.db.exec(`DROP TRIGGER IF EXISTS campaign_start_limit;DROP TRIGGER IF EXISTS campaign_output_limit;
      CREATE TRIGGER campaign_start_limit BEFORE UPDATE OF started_at ON orchestration_model_calls WHEN NEW.started_at IS NOT NULL AND OLD.started_at IS NULL AND ((SELECT COUNT(*) FROM orchestration_model_calls WHERE started_at IS NOT NULL)>=${limits.maxStarts} OR CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)>${deadline}) BEGIN SELECT RAISE(ABORT,'REAL_GAME_START_LIMIT');END;
      CREATE TRIGGER campaign_output_limit BEFORE INSERT ON orchestration_token_reservations WHEN EXISTS(SELECT 1 FROM orchestration_token_reservations r WHERE status='unknown' AND NOT EXISTS(SELECT 1 FROM campaign_acknowledged_unknowns a WHERE a.call_id=r.id)) OR NEW.reserved+(SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) FROM orchestration_token_reservations)>${limits.maxOutputTokens} BEGIN SELECT RAISE(ABORT,'REAL_GAME_TOKEN_OR_UNKNOWN_LIMIT');END;`);
  });
}

import assert from 'node:assert/strict';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { migrateScopedAttemptBindings } from '../apps/server/src/db/orchestrationMigrations.ts';
const db=new Database(':memory:');
try{
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE collaboration_attempts(id TEXT PRIMARY KEY);
 CREATE TABLE runtime_execution_scopes(id TEXT PRIMARY KEY);
 CREATE TABLE runtime_scope_attempts(attempt_id TEXT PRIMARY KEY REFERENCES collaboration_attempts(id),scope_id TEXT NOT NULL REFERENCES runtime_execution_scopes(id),context_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE runtime_input_provenance(attempt_id TEXT NOT NULL REFERENCES runtime_scope_attempts(attempt_id),sequence INTEGER,record TEXT);
 CREATE TRIGGER provenance_immutable BEFORE UPDATE ON runtime_input_provenance BEGIN SELECT RAISE(ABORT,'immutable'); END;
 INSERT INTO collaboration_attempts VALUES('historical-attempt');INSERT INTO runtime_execution_scopes VALUES('historical-scope');
 INSERT INTO runtime_scope_attempts VALUES('historical-attempt','historical-scope','sha256-before-upgrade','2026-10-15');
 INSERT INTO runtime_input_provenance VALUES('historical-attempt',1,'{"exposure":"possibly_exposed","source":"historical"}');`);
 const before={binding:db.prepare('SELECT * FROM runtime_scope_attempts').all(),ledger:db.prepare('SELECT * FROM runtime_input_provenance').all()};
 migrateScopedAttemptBindings(db);migrateScopedAttemptBindings(db);
 assert.deepEqual({binding:db.prepare('SELECT * FROM runtime_scope_attempts').all(),ledger:db.prepare('SELECT * FROM runtime_input_provenance').all()},before);
 assert.equal(db.pragma('foreign_keys',{simple:true}),1);assert.deepEqual(db.pragma('foreign_key_check'),[]);
 assert.equal(db.pragma('foreign_key_list(runtime_scope_attempts)').some(k=>k.table==='collaboration_attempts'),false);
 assert.equal(db.pragma('foreign_key_list(runtime_input_provenance)')[0].table,'runtime_scope_attempts');
 assert.throws(()=>db.exec("UPDATE runtime_input_provenance SET record='changed'"),/immutable/);
 console.log('G5 migration verified: historical binding/ledger bytes preserved, foreign keys valid, repeatable upgrade, provenance remains immutable.');
}finally{db.close();}

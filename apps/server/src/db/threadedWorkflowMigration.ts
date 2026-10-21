import type Database from 'better-sqlite3';
import {applyThreadedReviewSchema} from './threadedReviewSchema.ts';
import {applyThreadedSopSchema} from './threadedSopSchema.ts';
import {applyThreadedKnowledgeSchema} from './threadedKnowledgeSchema.ts';

export const THREADED_WORKFLOW_MIGRATION={version:33,name:'threaded-review-sop-knowledge-v1',
  descriptor:'pre-v33-compatibility-admission-v1;accepted-source-author-review-rounds-v1;finding-revision-independent-gate-v1;descriptive-sop-domain-verification-v1;home-knowledge-literal-provenance-acl-v1'} as const;
export function applyThreadedWorkflowMigration(db:Database.Database){
  if(!db.inTransaction)throw new Error('THREADED_MIGRATION_REQUIRES_TRANSACTION');
  applyThreadedReviewSchema(db);applyThreadedSopSchema(db);applyThreadedKnowledgeSchema(db);
}

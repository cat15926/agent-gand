import { useEffect, useState } from 'react';
import type { Run, RunOrchestrationSnapshot } from '@agent-gand/shared';
import * as api from '../services/api';
import { taskLabel } from './TaskComposer';
const snapshots = new Map<string, RunOrchestrationSnapshot | null>();
export function RunSettingsLabel({ run }: { run: Run }) {
  const [value, setValue] = useState<{ snapshot: RunOrchestrationSnapshot | null; loaded: boolean }>({ snapshot: snapshots.get(run.id) ?? null, loaded: snapshots.has(run.id) });
  useEffect(() => { let live = true;
    if (snapshots.has(run.id)) { setValue({ snapshot: snapshots.get(run.id) ?? null, loaded: true }); return; }
    void api.getRunOrchestration(run.id).then(result => { snapshots.set(run.id,result.snapshot); if (live) setValue({ snapshot: result.snapshot, loaded: true }); }).catch(() => { if (live) setValue({ snapshot: null, loaded: false }); });
    return () => { live = false; };
  }, [run.id]);
  return <span>{value.loaded ? taskLabel(value.snapshot,run.mode) : '任务配置读取中'}</span>;
}

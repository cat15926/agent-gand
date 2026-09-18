import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunEvent, RunObservabilitySummary, ServerEvent, SpanSummary, TraceTreeSummaryNode } from '@agent-gand/shared';
import * as api from '../services/api';
import { onServerEvent, onWsStatus } from '../services/ws';

function preview(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\s+/gu, ' ').trim().slice(0, 180) || null;
}

function bytes(value: string | null): number {
  return value ? new TextEncoder().encode(value).length : 0;
}

function summarize(event: RunEvent): SpanSummary {
  const { input, output, ...span } = event;
  return {
    ...span,
    hasInput: Boolean(input), hasOutput: Boolean(output),
    inputBytes: bytes(input), outputBytes: bytes(output),
    inputPreview: preview(input), outputPreview: preview(output),
  };
}

function patchNodes(nodes: TraceTreeSummaryNode[], event: RunEvent): { nodes: TraceTreeSummaryNode[]; found: boolean } {
  let found = false;
  const next = nodes.map((node) => {
    if (node.span.id === event.id) {
      found = true;
      const durationMs = event.endedAt ? Math.max(0, new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime()) : null;
      return { ...node, span: summarize(event), durationMs };
    }
    const children = patchNodes(node.children, event);
    if (!children.found) return node;
    found = true;
    return { ...node, children: children.nodes };
  });
  return { nodes: next, found };
}

function patchDelta(nodes: TraceTreeSummaryNode[], spanId: string, text: string): TraceTreeSummaryNode[] {
  return nodes.map((node) => node.span.id === spanId
    ? { ...node, span: { ...node.span, hasOutput: true, outputPreview: `${node.span.outputPreview ?? ''}${text}`.slice(-180) } }
    : { ...node, children: patchDelta(node.children, spanId, text) });
}

export function useRunObservability(runId: string | null, live: boolean) {
  const [data, setData] = useState<RunObservabilitySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveDeltas, setLiveDeltas] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!runId) { setData(null); return; }
    const current = ++generation.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await api.getRunObservabilitySummary(runId);
      if (generation.current === current) setData(result);
    } catch (reason) {
      if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === current && !quiet) setLoading(false);
    }
  }, [runId]);

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(true), 180);
  }, [refresh]);

  useEffect(() => {
    setData(null); setLiveDeltas({});
    void refresh();
    return () => { generation.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);

  useEffect(() => {
    if (!runId || !live) return;
    const offEvent = onServerEvent((event: ServerEvent) => {
      if (event.type === 'run.event' && event.event.runId === runId) {
        setData((current) => {
          if (!current) return current;
          const patched = patchNodes(current.trace.roots, event.event);
          return patched.found ? { ...current, trace: { ...current.trace, roots: patched.nodes } } : current;
        });
        if (event.event.endedAt) setLiveDeltas((current) => {
          const next = { ...current }; delete next[event.event.id]; return next;
        });
        scheduleRefresh();
      } else if (event.type === 'llm.delta' && event.runId === runId && event.displayKind !== 'review_protocol') {
        setLiveDeltas((current) => ({ ...current, [event.spanId]: `${current[event.spanId] ?? ''}${event.text}` }));
        setData((current) => current ? { ...current, trace: { ...current.trace, roots: patchDelta(current.trace.roots, event.spanId, event.text) } } : current);
      } else if ((event.type === 'task.updated' && event.task.runId === runId)
        || (event.type === 'approval.updated' && event.approval.runId === runId)
        || (event.type === 'run.updated' && event.run.id === runId)) {
        scheduleRefresh();
      }
    });
    let connectedOnce = false;
    const offStatus = onWsStatus((connected) => {
      if (connected && connectedOnce) void refresh(true);
      if (connected) connectedOnce = true;
    });
    return () => { offEvent(); offStatus(); };
  }, [live, refresh, runId, scheduleRefresh]);

  return { data, loading, error, liveDeltas, refresh: () => void refresh() };
}

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RunGraph, RunGraphNode } from '@agent-gand/shared';
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const WIDTH = 210;
const HEIGHT = 76;

const NODE_META: Record<RunGraphNode['kind'], { label: string; color: string; border: string; background: string }> = {
  run: { label: 'Run', color: '#c4b5fd', border: '#7c3aed', background: '#24163d' },
  agent: { label: 'Agent', color: '#7dd3fc', border: '#0284c7', background: '#102839' },
  task: { label: '任务', color: '#6ee7b7', border: '#059669', background: '#102d25' },
  approval: { label: '审批', color: '#fcd34d', border: '#d97706', background: '#34260f' },
};

function statusColor(status: string | null): string {
  if (status === 'failed' || status === 'error' || status === 'rejected') return '#fb7185';
  if (status === 'running' || status === 'in_progress') return '#38bdf8';
  if (status === 'awaiting_approval' || status === 'pending') return '#fbbf24';
  if (status === 'completed' || status === 'ok' || status === 'approved') return '#34d399';
  return '#71717a';
}

function graphNode(node: RunGraphNode, selected: boolean): Node {
  const meta = NODE_META[node.kind];
  return {
    id: node.id,
    position: { x: 0, y: 0 },
    data: { label: <div className="w-full text-left"><div className="mb-1 flex items-center justify-between gap-2"><span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: meta.color }}>{meta.label}</span><span className="h-2 w-2 rounded-full" style={{ background: statusColor(node.status) }} /></div><div className="truncate text-xs font-medium text-zinc-100" title={node.label}>{node.label}</div><div className="mt-1 truncate font-mono text-[9px] text-zinc-500">{node.entityId}</div></div> },
    style: {
      width: WIDTH, height: HEIGHT, borderRadius: 12, padding: '10px 12px',
      border: `${selected ? 2 : 1}px solid ${selected ? '#ddd6fe' : meta.border}`,
      background: meta.background, boxShadow: selected ? '0 0 0 4px rgba(139,92,246,.2)' : '0 8px 24px rgba(0,0,0,.18)',
    } satisfies CSSProperties,
  };
}

function graphEdge(edge: RunGraph['edges'][number]): Edge {
  return {
    id: edge.id, source: edge.from, target: edge.to, label: edge.label ?? edge.kind,
    type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, color: '#52525b' },
    style: { stroke: '#52525b', strokeWidth: 1.4 },
    labelStyle: { fill: '#71717a', fontSize: 9 },
    labelBgStyle: { fill: '#111114', fillOpacity: 0.92 },
  };
}

async function layoutGraph(graph: RunGraph, selectedId: string | null): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '42',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: graph.nodes.map((node) => ({ id: node.id, width: WIDTH, height: HEIGHT })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  });
  const positions = new Map(result.children?.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]) ?? []);
  return {
    nodes: graph.nodes.map((node) => ({ ...graphNode(node, node.id === selectedId), position: positions.get(node.id) ?? { x: 0, y: 0 } })),
    edges: graph.edges.map(graphEdge),
  };
}

function FlowCanvas({ graph, selectedNodeId, onSelectNode }: { graph: RunGraph; selectedNodeId: string | null; onSelectNode?: (node: RunGraphNode | null) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutError, setLayoutError] = useState(false);
  const flow = useReactFlow();
  useEffect(() => {
    let active = true;
    setLayoutError(false);
    void layoutGraph(graph, selectedNodeId).then((layout) => {
      if (!active) return;
      setNodes(layout.nodes); setEdges(layout.edges);
      window.requestAnimationFrame(() => void flow.fitView({ padding: 0.18, duration: 280 }));
    }).catch(() => setLayoutError(true));
    return () => { active = false; };
  }, [flow, graph, selectedNodeId, setEdges, setNodes]);
  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  return <div className="relative h-full min-h-[360px] w-full" role="application" aria-label="只读编排拓扑，使用滚轮缩放、拖动画布、点击节点筛选轨迹">
    {layoutError && <div className="absolute left-3 top-3 z-10 rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-300">自动布局失败，请刷新重试</div>}
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => onSelectNode?.(byId.get(node.id) ?? null)} onPaneClick={() => onSelectNode?.(null)}
      nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} fitView minZoom={0.15} maxZoom={2.2}
      proOptions={{ hideAttribution: true }} colorMode="dark">
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#29292f" />
      <Controls showInteractive={false} position="bottom-right" />
      {graph.nodes.length > 8 && <MiniMap position="bottom-left" pannable zoomable nodeColor={(node) => String((node.style as CSSProperties | undefined)?.background ?? '#27272a')} maskColor="rgba(9,9,11,.72)" />}
    </ReactFlow>
  </div>;
}

export function RunGraphPanel({ graph, selectedNodeId = null, onSelectNode }: { graph: RunGraph; selectedNodeId?: string | null; onSelectNode?: (node: RunGraphNode | null) => void }) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return <div className="flex min-h-0 flex-1 flex-col bg-[#0b0b0d]">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2"><div><h3 className="text-xs font-medium text-zinc-200">只读编排拓扑</h3><p className="mt-0.5 text-[10px] text-zinc-600">{graph.nodes.length} 个节点 · {graph.edges.length} 条关系 · 点击节点联动轨迹</p></div><div className="flex gap-2 text-[9px] text-zinc-500">{Object.entries(NODE_META).map(([kind, meta]) => <span key={kind} className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: meta.background, border: `1px solid ${meta.border}` }} />{meta.label}</span>)}</div></div>
    <div className="min-h-0 flex-1"><ReactFlowProvider><FlowCanvas graph={graph} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} /></ReactFlowProvider></div>
    <details className="shrink-0 border-t border-zinc-800 bg-zinc-950/60 px-4 py-2 text-[10px] text-zinc-500"><summary className="cursor-pointer select-none hover:text-zinc-300">无障碍关系列表</summary><ul className="mt-2 grid gap-1 sm:grid-cols-2">{graph.edges.map((edge) => <li key={edge.id}><span className="text-zinc-300">{byId.get(edge.from)?.label ?? edge.from}</span> <span className="text-emerald-400">{edge.kind}</span> → <span className="text-zinc-300">{byId.get(edge.to)?.label ?? edge.to}</span></li>)}</ul></details>
  </div>;
}

import { lazy, Suspense, useEffect, useRef } from 'react';
const AccountsView = lazy(() => import('./views/AccountsView').then((module) => ({ default: module.AccountsView })));
export function RoleAccountsPanel({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  return <div className="fixed inset-0 z-50 bg-zinc-950 p-2 sm:p-5"><div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="管理角色账户" className="mx-auto flex h-full max-w-6xl flex-col" onKeyDown={(event) => {
    if ((event.target as HTMLElement).closest('[role="dialog"]') !== event.currentTarget) return;
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')).filter((node) => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><button className="mb-2 self-start rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300" onClick={onClose}>← 返回角色草稿</button><div className="min-h-0 flex-1"><Suspense fallback={<p className="p-6 text-sm text-zinc-500">正在加载账户…</p>}><AccountsView onRoles={onClose} /></Suspense></div></div></div>;
}

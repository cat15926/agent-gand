import { useEffect, useRef, type ReactNode } from 'react';

/** 原生 modal dialog 提供焦点约束、背景隔离和 Escape 关闭。 */
export function Drawer({ open, title, onClose, children, side = 'right' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; side?: 'left' | 'right' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = ref.current; if (open && node && !node.open) node.showModal(); else if (!open && node?.open) node.close(); }, [open]);
  return <dialog ref={ref} aria-label={title} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }} className={`chat-drawer ${side === 'left' ? 'chat-drawer-left' : ''}`}>
    <div className="flex h-full min-h-0 flex-col"><div className="flex shrink-0 items-center justify-between border-b border-zinc-700 px-4 py-2"><h2 className="text-sm font-semibold">{title}</h2><button aria-label={`关闭${title}`} className="h-11 w-11 rounded-lg text-xl hover:bg-zinc-800" onClick={onClose}>×</button></div><div className="min-h-0 flex-1 overflow-y-auto">{children}</div></div>
  </dialog>;
}

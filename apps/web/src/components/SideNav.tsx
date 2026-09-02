/**
 * 左侧导航：运行 / 编排(P1) / 舰队 / 观测 —— 对应报告 §5.1 模式 2/1/6/4
 */
import type { ViewKey } from '../App';

const ITEMS: Array<{ key: ViewKey; label: string; icon: string }> = [
  { key: 'run', label: '运行', icon: '▶' },
  { key: 'canvas', label: '编排', icon: '⬡' },
  { key: 'fleet', label: '舰队', icon: '▦' },
  { key: 'observe', label: '观测', icon: '◎' },
];

export function SideNav({ view, onChange }: { view: ViewKey; onChange: (v: ViewKey) => void }) {
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-900/60 py-3">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          title={item.label}
          onClick={() => onChange(item.key)}
          className={`flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] ${
            view === item.key
              ? 'bg-violet-500/15 text-violet-300'
              : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
          }`}
        >
          <span className="text-base leading-none">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </nav>
  );
}

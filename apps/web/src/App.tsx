/**
 * "1+3" 布局壳（报告 §7.3）：顶栏 + 左侧导航 + 主视图 + 右侧面板
 */
import { lazy, Suspense, useState } from 'react';
import { TopBar } from './components/TopBar';
import { SideNav } from './components/SideNav';
import { RightPanel } from './components/RightPanel';
import { RunView } from './components/views/RunView';
import { FleetView } from './components/views/FleetView';
const ObserveView = lazy(() => import('./components/views/ObserveView').then((module) => ({ default: module.ObserveView })));
const CanvasView = lazy(() => import('./components/views/CanvasView').then((module) => ({ default: module.CanvasView })));

export type ViewKey = 'run' | 'canvas' | 'fleet' | 'observe';

export function App() {
  const [view, setView] = useState<ViewKey>('run');
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <SideNav view={view} onChange={setView} />
        <main className="min-w-0 flex-1 overflow-hidden">
          {view === 'run' && <RunView />}
          {view === 'canvas' && <Suspense fallback={<ViewLoading />}><CanvasView /></Suspense>}
          {view === 'fleet' && <FleetView />}
          {view === 'observe' && <Suspense fallback={<ViewLoading />}><ObserveView /></Suspense>}
        </main>
        {view === 'run' && <RightPanel />}
      </div>
    </div>
  );
}

function ViewLoading() {
  return <div className="flex h-full items-center justify-center text-sm text-zinc-600">正在加载工作台…</div>;
}

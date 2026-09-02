/**
 * "1+3" 布局壳（报告 §7.3）：顶栏 + 左侧导航 + 主视图 + 右侧面板
 */
import { useState } from 'react';
import { TopBar } from './components/TopBar';
import { SideNav } from './components/SideNav';
import { RightPanel } from './components/RightPanel';
import { RunView } from './components/views/RunView';
import { FleetView } from './components/views/FleetView';
import { ObserveView } from './components/views/ObserveView';
import { CanvasView } from './components/views/CanvasView';

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
          {view === 'canvas' && <CanvasView />}
          {view === 'fleet' && <FleetView />}
          {view === 'observe' && <ObserveView />}
        </main>
        {view === 'run' && <RightPanel />}
      </div>
    </div>
  );
}

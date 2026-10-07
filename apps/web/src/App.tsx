/**
 * "1+3" 布局壳（报告 §7.3）：顶栏 + 左侧导航 + 主视图 + 右侧面板
 */
import { lazy, Suspense, useState } from 'react';
import { TopBar } from './components/TopBar';
import { SideNav } from './components/SideNav';
import { Drawer } from './components/Drawer';
import { RightPanel } from './components/RightPanel';
import { RunView } from './components/views/RunView';
import { FleetView } from './components/views/FleetView';
import { useStore } from './store';
import { useVisibleViewport } from './services/useVisibleViewport';
import { addRoleToRoomDraft } from './services/roomDraft';
const AccountsView = lazy(() => import('./components/views/AccountsView').then((module) => ({ default: module.AccountsView })));
const ObserveView = lazy(() => import('./components/views/ObserveView').then((module) => ({ default: module.ObserveView })));
const CanvasView = lazy(() => import('./components/views/CanvasView').then((module) => ({ default: module.CanvasView })));

export type ViewKey = 'run' | 'canvas' | 'fleet' | 'observe' | 'accounts';

export function App() {
  useVisibleViewport();
  const { state, setActiveConversation, detailsOpen, setDetailsOpen } = useStore();
  const [view, setView] = useState<ViewKey>('run');
  const [fleetTab, setFleetTab] = useState<'status' | 'roles'>('status');
  return (
    <div className="chat-app flex flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SideNav view={view} onChange={setView} />
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {view === 'run' && <RunView onManageRoles={() => { setFleetTab('roles'); setView('fleet'); }} />}
          {view === 'canvas' && <Suspense fallback={<ViewLoading />}><CanvasView /></Suspense>}
          {view === 'fleet' && <FleetView initialTab={fleetTab} onManageAccounts={() => setView('accounts')} onUseRole={(id) => { addRoleToRoomDraft(id); setActiveConversation(null); setView('run'); }} />}
          {view === 'accounts' && <Suspense fallback={<ViewLoading />}><AccountsView onRoles={() => { setFleetTab('roles'); setView('fleet'); }} /></Suspense>}
          {view === 'observe' && <Suspense fallback={<ViewLoading />}><ObserveView /></Suspense>}
        </main>
        {view === 'run' && state.activeConversationId && <Drawer open={detailsOpen} title="任务详情" onClose={() => setDetailsOpen(false)}><RightPanel /></Drawer>}
      </div>
    </div>
  );
}

function ViewLoading() {
  return <div className="flex h-full items-center justify-center text-sm text-zinc-600">正在加载工作台…</div>;
}

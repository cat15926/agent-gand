/**
 * 浏览器通知（规格 §8.2 审批提醒强化）
 * 首次交互（click/keydown）请求 Notification 权限；审批到达（pending）发系统通知，点击聚焦窗口。
 * 环境不支持/未授权时静默降级（不影响主流程）。
 */

let armed = false;

/** 首次交互时请求权限（浏览器要求用户手势内调用；一次性监听，触发后自摘除） */
export function armPermissionRequest(): void {
  if (armed || typeof window === 'undefined' || !('Notification' in window)) return;
  armed = true;
  const request = () => {
    void Notification.requestPermission?.();
    window.removeEventListener('click', request);
    window.removeEventListener('keydown', request);
  };
  window.addEventListener('click', request);
  window.addEventListener('keydown', request);
}

/** 新 pending 审批到达 → 系统通知（已授权时）；点击聚焦回页面 */
export function notifyApproval(approval: {
  id: string;
  toolName: string;
  agentId: string;
  reason: string | null;
}): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`待审批：${approval.toolName}`, {
      body: `${approval.agentId}${approval.reason ? ` — ${approval.reason}` : ''}`,
      tag: `approval-${approval.id}`, // 同一审批不重复弹
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // 通知构造失败（如移动端限制）静默忽略
  }
}

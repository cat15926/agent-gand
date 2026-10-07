export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([navigator.clipboard.writeText(text),new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error('clipboard timeout')),2000); })]); return; }
    catch { /* Try selection-based copy when browser clipboard permission is unavailable. */ }
    finally { clearTimeout(timer); }
  }
  const previous = document.activeElement as HTMLElement | null;
  const input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select();
  const ok = document.execCommand('copy'); input.remove(); previous?.focus({preventScroll:true}); if (!ok) throw new Error('复制失败，请手动选择内容复制');
}
export function revealMessage(id: string): void {
  const element = document.getElementById(`message-${id}`); if (!element) return;
  element.dispatchEvent(new Event('message-reveal'));
  const details = element.querySelector('details'); if (details) details.open = true;
  requestAnimationFrame(() => element.scrollIntoView({ behavior: 'smooth', block: 'center' })); element.classList.remove('message-highlight'); requestAnimationFrame(() => element.classList.add('message-highlight'));
}

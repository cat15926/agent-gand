import { useEffect } from 'react';

/** 软键盘改变可见视口时，让输入区和抽屉保持在可操作范围。 */
export function useVisibleViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 缩放时保留浏览器的阅读和无障碍缩放行为。
        if (Math.abs(viewport.scale-1) > .01) return;
        document.documentElement.style.setProperty('--visible-height',`${viewport.height}px`);
        document.documentElement.style.setProperty('--visible-top',`${viewport.offsetTop}px`);
        document.documentElement.classList.toggle('chat-keyboard',window.innerHeight-viewport.height > 150);
      });
    };
    update(); viewport.addEventListener('resize',update); viewport.addEventListener('scroll',update);
    return () => { cancelAnimationFrame(frame); viewport.removeEventListener('resize',update); viewport.removeEventListener('scroll',update); document.documentElement.style.removeProperty('--visible-height'); document.documentElement.style.removeProperty('--visible-top'); document.documentElement.classList.remove('chat-keyboard'); };
  }, []);
}

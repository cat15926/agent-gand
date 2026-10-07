import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../services/clipboard';
function plainText(node: ReactNode): string { return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : String(child)).join(''); }
function CodeBlock({ children }: { children?: ReactNode }) {
  const [status, setStatus] = useState('');
  const code = Children.toArray(children).find(child => isValidElement(child));
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace('language-', '') : undefined;
  async function copy() { try { await copyText(plainText(children).replace(/\n$/, '')); setStatus('已复制'); } catch { setStatus('复制失败，请手动复制'); } }
  return <div className="my-3 min-w-0 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950"><div className="flex items-center justify-between px-3 py-1 text-xs text-zinc-400"><span>{language ?? '代码'}</span><button aria-label={status || '复制代码'} onClick={() => void copy()} className="chat-touch-action rounded px-2 py-1 hover:bg-zinc-800">{status || '复制代码'}</button></div><pre className="!m-0 overflow-x-auto !rounded-none !bg-transparent !p-3">{children}</pre></div>;
}
export function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
    table: ({ children }) => <div className="my-2 max-w-full overflow-x-auto"><table>{children}</table></div>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  }}>{text}</ReactMarkdown>;
}
export function MarkdownBody({ text, onNavigate }: { text: string; onNavigate?: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<string[]>([]);
  useEffect(() => { if (text.length > 2400) setHeadings(Array.from(ref.current?.querySelectorAll('h1,h2,h3') ?? []).map(el => el.textContent ?? '')); else setHeadings([]); }, [text]);
  return <div ref={ref} className="min-w-0">
    {headings.length > 2 && <details className="mb-3 text-xs text-zinc-300"><summary className="cursor-pointer">报告目录 · {headings.length} 节</summary><div className="mt-2 flex flex-col items-start gap-1">{headings.map((title,i) => <button key={i} className="text-left text-violet-300 hover:underline" onClick={() => { onNavigate?.(); requestAnimationFrame(() => ref.current?.querySelectorAll('h1,h2,h3')[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }}>{title}</button>)}</div></details>}
    <div className="prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-headings:mb-1.5 prose-headings:mt-3 prose-headings:font-semibold prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-code:before:content-none prose-code:after:content-none prose-code:rounded prose-code:bg-zinc-900/80 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-blockquote:border-zinc-500 prose-blockquote:not-italic prose-th:px-2 prose-td:px-2 prose-hr:border-zinc-700"><Markdown text={text} /></div>
  </div>;
}

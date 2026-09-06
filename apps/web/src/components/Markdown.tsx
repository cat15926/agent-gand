/**
 * Markdown 渲染（agent 产出普遍是 GFM：标题/列表/表格/代码块）
 * - remark-gfm：表格、删除线、任务列表、自动链接
 * - typography(prose-invert prose-sm)：聊天气泡密度排版
 * - 宽表格横向滚动，不撑破气泡
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** 气泡内包装：prose 尺寸/颜色微调，适配深色聊天气泡 */
export function MarkdownBody({ text }: { text: string }): ReactNode {
  return (
    <div className="prose prose-sm prose-invert max-w-none prose-p:my-1.5 prose-headings:mb-1.5 prose-headings:mt-2.5 prose-headings:font-semibold prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none prose-code:rounded prose-code:bg-zinc-900/80 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-blockquote:border-zinc-600 prose-blockquote:not-italic prose-th:px-2 prose-td:px-2 prose-hr:border-zinc-700">
      <Markdown text={text} />
    </div>
  );
}

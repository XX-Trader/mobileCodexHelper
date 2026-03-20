import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { resolveMarkdownPreviewHref } from '../../../../chat/view/subcomponents/Markdown';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
  projectName?: string;
  currentFilePath?: string;
};

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
  ),
};

export default function MarkdownPreview({ content, projectName, currentFilePath }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const components = useMemo<Components>(() => ({
    ...markdownPreviewComponents,
    a: ({ href, children }) => {
      const resolvedHref = resolveMarkdownPreviewHref(href, { projectName, currentFilePath });
      return (
        <a
          href={resolvedHref}
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  }), [currentFilePath, projectName]);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

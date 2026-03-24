import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  currentFilePath?: string;
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  projectName?: string;
  currentFilePath?: string;
};

const EXTERNAL_LINK_PATTERN = /^(?:[a-z][a-z\d+\-.]*:|\/\/|#)/i;
const MARKDOWN_FILE_EXTENSION_PATTERN = /\.(md|markdown)$/i;
const MARKDOWN_AUTOLINK_SKIP_PATTERN = /(?:```[\s\S]*?```|`[^`\n]+`|!?\[[^\]]*]\([^)]+\))/g;
const MARKDOWN_FILE_PATH_PATTERN =
  /(^|[\s(>\[{'"\u201c\u2018\uFF1A:\uFF08\u3010\u300A\uFF0C\u3002\uFF1B\u3001])((?:\.\.?[\\/]|\/|[a-zA-Z]:[\\/])?(?:[^\s`[\](){}<>]+[\\/])*[^\s`[\](){}<>]+\.(?:md|markdown)(?:#[A-Za-z0-9._~!$&'()*+,;=:@/%-]+)?)(?=$|[\s)\].,!?;:'"\u201d\u2019\uFF09\u3011\u300B\uFF0C\u3002\uFF1B\u3001])/gi;

const decodeUriComponentSafely = (value: string) => {
  let decodedValue = value;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!decodedValue.includes('%')) {
      break;
    }

    try {
      const nextValue = decodeURIComponent(decodedValue);
      if (nextValue === decodedValue) {
        break;
      }
      decodedValue = nextValue;
    } catch {
      break;
    }
  }

  return decodedValue;
};

/**
 * Normalizes a file-preview path for routing and API calls.
 *
 * @param rawPath Raw path string; may include backslashes, URL encoding, or `/C:/` drive prefixes.
 * @returns Normalized path using forward slashes, or an empty string when the input is empty.
 * @throws Does not throw. Invalid URI escape sequences are preserved as-is.
 */
export const normalizePreviewFilePath = (rawPath: string) => {
  const normalizedInput = decodeUriComponentSafely(rawPath.replace(/\\/g, '/').trim());
  if (/^\/[a-zA-Z]:\//.test(normalizedInput)) {
    return normalizedInput.slice(1);
  }

  return normalizedInput;
};

const isMarkdownFileReference = (value: string) => {
  const normalizedPath = normalizePreviewFilePath(value);
  const pathnameOnly = normalizedPath.split('#', 1)[0].split('?', 1)[0];
  return MARKDOWN_FILE_EXTENSION_PATTERN.test(pathnameOnly);
};

const autoLinkMarkdownFilePathsInSegment = (segment: string) =>
  segment.replace(MARKDOWN_FILE_PATH_PATTERN, (match, prefix: string, rawPath: string) => {
    if (!isMarkdownFileReference(rawPath)) {
      return match;
    }

    return `${prefix}[${rawPath}](${rawPath})`;
  });

const autoLinkMarkdownFilePaths = (markdownContent: string) => {
  if (!/\.(?:md|markdown)\b/i.test(markdownContent)) {
    return markdownContent;
  }

  const skipMatcher = new RegExp(MARKDOWN_AUTOLINK_SKIP_PATTERN.source, 'g');
  let lastIndex = 0;
  let result = '';
  let match: RegExpExecArray | null = skipMatcher.exec(markdownContent);

  while (match) {
    result += autoLinkMarkdownFilePathsInSegment(markdownContent.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
    match = skipMatcher.exec(markdownContent);
  }

  result += autoLinkMarkdownFilePathsInSegment(markdownContent.slice(lastIndex));
  return result;
};

const CodeBlock = ({ node, inline, className, children, projectName, currentFilePath, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  const inlineDetected = inline || (node && node.type === 'inlineCode');
  const shouldInline = inlineDetected || !looksMultiline;
  const inlineFileReference = raw.trim();
  const inlineFileHref =
    shouldInline && projectName && isMarkdownFileReference(inlineFileReference)
      ? resolveMarkdownPreviewHref(inlineFileReference, { projectName, currentFilePath })
      : '';

  if (shouldInline) {
    const inlineCode = (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100 ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );

    if (inlineFileHref) {
      return (
        <a
          href={inlineFileHref}
          className="inline-flex max-w-full align-baseline"
          target="_blank"
          rel="noopener noreferrer"
        >
          {inlineCode}
        </a>
      );
    }

    return inlineCode;
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';

  return (
    <div className="group relative my-2">
      {language && language !== 'text' && (
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(raw).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })
        }
        className="absolute right-2 top-2 z-10 rounded-md border border-gray-600 bg-gray-700/80 px-2 py-1 text-xs text-white opacity-0 transition-opacity hover:bg-gray-700 focus:opacity-100 active:opacity-100 group-hover:opacity-100"
        title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
      >
        {copied ? (
          <span className="flex items-center gap-1">
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {t('codeBlock.copied')}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
            {t('codeBlock.copy')}
          </span>
        )}
      </button>

      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          borderRadius: '0.5rem',
          fontSize: '0.875rem',
          padding: language && language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem',
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );
};

const normalizePathSegments = (inputPath: string) => {
  const isAbsolutePath = inputPath.startsWith('/');
  const segments = inputPath.split('/').filter((segment) => segment.length > 0);
  const normalizedSegments: string[] = [];

  segments.forEach((segment) => {
    if (segment === '.') {
      return;
    }

    if (segment === '..') {
      if (normalizedSegments.length > 0) {
        normalizedSegments.pop();
      }
      return;
    }

    normalizedSegments.push(segment);
  });

  const normalizedPath = normalizedSegments.join('/');
  if (!normalizedPath) {
    return isAbsolutePath ? '/' : '';
  }

  return isAbsolutePath ? `/${normalizedPath}` : normalizedPath;
};

const resolveMarkdownFilePath = (href: string, currentFilePath?: string) => {
  const normalizedHref = normalizePreviewFilePath(href);
  if (!normalizedHref || EXTERNAL_LINK_PATTERN.test(normalizedHref)) {
    return null;
  }

  const pathOnly = normalizedHref.split('#', 1)[0].split('?', 1)[0];
  if (!pathOnly) {
    return null;
  }

  if (!currentFilePath) {
    return normalizePathSegments(pathOnly);
  }

  if (pathOnly.startsWith('/')) {
    return normalizePathSegments(pathOnly);
  }

  const normalizedCurrentFilePath = currentFilePath.replace(/\\/g, '/');
  const currentDirectory = normalizedCurrentFilePath.includes('/')
    ? normalizedCurrentFilePath.slice(0, normalizedCurrentFilePath.lastIndexOf('/'))
    : '';

  return normalizePathSegments(`${currentDirectory}/${pathOnly}`);
};

/**
 * Builds a `/file-preview` route for a project file.
 *
 * @param projectName Project name; must be present so the preview page can resolve the workspace.
 * @param filePath File path inside the project; supports relative paths, drive-letter paths, and URL-encoded input.
 * @returns Router href pointing to the file preview page.
 * @throws Does not throw. Unexpected paths are still encoded into the route.
 */
export const buildFilePreviewHref = (projectName: string, filePath: string) => {
  const baseName = typeof window !== 'undefined' ? window.__ROUTER_BASENAME__ || '' : '';
  const normalizedFilePath = normalizePreviewFilePath(filePath);
  const encodedProjectName = encodeURIComponent(projectName);
  const encodedFilePath = encodeURIComponent(normalizedFilePath);
  return `${baseName}/file-preview?projectName=${encodedProjectName}&filePath=${encodedFilePath}`;
};

/**
 * Resolves Markdown file links to the preview page while preserving external links.
 *
 * @param href Raw Markdown href; may be relative, absolute, external, or an anchor.
 * @param options.projectName Current project name; required for generating preview links.
 * @param options.currentFilePath Current Markdown file path; used to resolve relative links.
 * @returns A href suitable for rendering in `<a href>`. Falls back to the original href when unresolved.
 * @throws Does not throw. Resolution failures return the original href.
 */
export const resolveMarkdownPreviewHref = (
  href: string | undefined,
  options: { projectName?: string; currentFilePath?: string } = {},
) => {
  if (!href) {
    return '';
  }

  const resolvedFilePath = resolveMarkdownFilePath(href, options.currentFilePath);
  if (!resolvedFilePath || !options.projectName) {
    return href;
  }

  const hashPart = href.includes('#') ? href.slice(href.indexOf('#')) : '';
  return `${buildFilePreviewHref(options.projectName, resolvedFilePath)}${hashPart}`;
};

/**
 * Renders shared Markdown content for chat messages and file previews.
 *
 * @param children Raw Markdown content; may include code fences, tables, math, and local file paths.
 * @param className Optional wrapper class name.
 * @param projectName Current project name; used to resolve local files to the preview page.
 * @param currentFilePath Current Markdown file path; used to resolve relative links.
 * @returns Rendered Markdown element tree.
 * @throws Does not throw directly. Rendering failures are handled by React error boundaries.
 */
export function Markdown({ children, className, projectName, currentFilePath }: MarkdownProps) {
  const content = autoLinkMarkdownFilePaths(normalizeInlineCodeFences(String(children ?? '')));
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const markdownComponents = useMemo(() => ({
    code: (props: CodeBlockProps) => (
      <CodeBlock
        {...props}
        projectName={projectName}
        currentFilePath={currentFilePath}
      />
    ),
    blockquote: ({ children: blockquoteChildren }: { children?: React.ReactNode }) => (
      <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
        {blockquoteChildren}
      </blockquote>
    ),
    a: ({ href, children: anchorChildren }: { href?: string; children?: React.ReactNode }) => {
      const resolvedHref = resolveMarkdownPreviewHref(href, { projectName, currentFilePath });
      return (
        <a
          href={resolvedHref}
          className="text-blue-600 hover:underline dark:text-blue-400"
          target="_blank"
          rel="noopener noreferrer"
        >
          {anchorChildren}
        </a>
      );
    },
    p: ({ children: paragraphChildren }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{paragraphChildren}</div>,
    table: ({ children: tableChildren }: { children?: React.ReactNode }) => (
      <div className="my-2 overflow-x-auto">
        <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{tableChildren}</table>
      </div>
    ),
    thead: ({ children: headerChildren }: { children?: React.ReactNode }) => <thead className="bg-gray-50 dark:bg-gray-800">{headerChildren}</thead>,
    th: ({ children: headerCellChildren }: { children?: React.ReactNode }) => (
      <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{headerCellChildren}</th>
    ),
    td: ({ children: cellChildren }: { children?: React.ReactNode }) => (
      <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{cellChildren}</td>
    ),
  }), [currentFilePath, projectName]);

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents as any}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

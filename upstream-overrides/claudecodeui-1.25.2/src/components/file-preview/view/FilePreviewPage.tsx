import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../../utils/api';
import { Markdown, normalizePreviewFilePath } from '../../chat/view/subcomponents/Markdown';

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const isMarkdownFilePath = (filePath: string) => /\.(md|markdown)$/i.test(filePath);

/**
 * 独立文件预览页，供聊天中的文件链接在新窗口中打开。
 *
 * @returns Markdown 优先的只读文件预览页；缺少参数或读取失败时显示明确错误信息。
 * @throws 不主动抛出异常；文件读取失败会以内联错误状态展示。
 */
export default function FilePreviewPage() {
  const [searchParams] = useSearchParams();
  const projectName = searchParams.get('projectName') || '';
  const rawFilePath = searchParams.get('filePath') || '';
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const filePath = useMemo(() => normalizePreviewFilePath(rawFilePath), [rawFilePath]);

  const fileName = useMemo(() => {
    if (!filePath) {
      return '未选择文件';
    }

    const normalizedPath = filePath.replace(/\\/g, '/');
    return normalizedPath.split('/').pop() || filePath;
  }, [filePath]);

  const isMarkdownFile = useMemo(() => isMarkdownFilePath(filePath), [filePath]);

  useEffect(() => {
    const loadFile = async () => {
      if (!projectName || !filePath) {
        setError('缺少 projectName 或 filePath 参数。');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const response = await api.readFile(projectName, filePath);
        if (!response.ok) {
          throw new Error(`读取文件失败：${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setContent(typeof data.content === 'string' ? data.content : '');
      } catch (loadError) {
        setError(getErrorMessage(loadError));
      } finally {
        setLoading(false);
      }
    };

    void loadFile();
  }, [filePath, projectName]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{fileName}</div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {projectName}
              {filePath ? ` / ${filePath}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.close()}
              className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              关闭窗口
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {loading ? (
          <div className="rounded-3xl border border-border/60 bg-card/70 p-8 text-sm text-muted-foreground shadow-sm">
            正在加载文件内容...
          </div>
        ) : error ? (
          <div className="rounded-3xl border border-red-200 bg-red-50/80 p-8 text-sm text-red-700 shadow-sm dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
            {error}
          </div>
        ) : isMarkdownFile ? (
          <article className="rounded-[28px] border border-border/60 bg-card/80 p-6 shadow-sm backdrop-blur sm:p-8">
            <div className="mx-auto max-w-4xl">
              <Markdown
                className="markdown-preview space-y-4 text-[15px] leading-7 text-foreground"
                projectName={projectName}
                currentFilePath={filePath}
              >
                {content}
              </Markdown>
            </div>
          </article>
        ) : (
          <div className="overflow-hidden rounded-[28px] border border-border/60 bg-slate-950 shadow-sm">
            <div className="border-b border-white/10 px-4 py-3 text-xs uppercase tracking-[0.16em] text-slate-400">
              Read Only Preview
            </div>
            <pre className="overflow-x-auto p-4 text-sm leading-6 text-slate-100 sm:p-6">
              <code>{content}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

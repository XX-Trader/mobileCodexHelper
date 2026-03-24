import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatAttachment } from '../../types/types';
import { downloadChatAttachment, fetchChatAttachmentBlob, fetchChatAttachmentTextPreview } from '../../../../utils/api';
import {
  buildChatAttachmentPreviewHref,
  formatChatAttachmentSize,
  resolveChatAttachmentPreviewKind,
} from '../../utils/chatAttachments';
import { Markdown } from './Markdown';

type AttachmentViewerMode = 'modal' | 'page';

type AttachmentViewerProps = {
  attachment: ChatAttachment | null;
  projectName: string;
  mode?: AttachmentViewerMode;
  isOpen?: boolean;
  onClose?: () => void;
};

const TEXT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_SCALE_MIN = 0.5;
const IMAGE_SCALE_MAX = 4;
const IMAGE_SCALE_STEP = 0.25;

function clampImageScale(nextScale: number) {
  return Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, nextScale));
}

function ViewerLoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-[280px] items-center justify-center rounded-3xl border border-border/60 bg-card/70 px-6 py-10 text-sm text-muted-foreground shadow-sm">
      {label}
    </div>
  );
}

/**
 * Renders an in-app viewer for chat attachments.
 *
 * @param attachment Selected attachment metadata. When `null`, the viewer renders nothing in modal mode.
 * @param projectName Project name used to scope protected attachment fetches.
 * @param mode Rendering mode: `modal` overlays the chat, `page` renders as a standalone preview page.
 * @param isOpen Whether the modal viewer is open. Ignored in `page` mode.
 * @param onClose Close handler for modal mode.
 * @returns Attachment preview UI for images, Markdown, text files, and unsupported binaries.
 * @throws Does not throw directly. Preview failures are rendered inline with explicit error text.
 */
export default function AttachmentViewer({
  attachment,
  projectName,
  mode = 'modal',
  isOpen = false,
  onClose,
}: AttachmentViewerProps) {
  const { t } = useTranslation('chat');
  const [isLoading, setIsLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [textPreview, setTextPreview] = useState('');
  const [isTruncatedPreview, setIsTruncatedPreview] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [imageScale, setImageScale] = useState(1);

  const previewKind = useMemo(
    () => (attachment ? resolveChatAttachmentPreviewKind(attachment) : 'unsupported'),
    [attachment],
  );
  const isModal = mode === 'modal';
  const shouldRenderViewer = !isModal || (isOpen && attachment);
  const fileSizeText = attachment?.size ? formatChatAttachmentSize(attachment.size) : '';

  useEffect(() => {
    if (!shouldRenderViewer || !isModal || typeof document === 'undefined') {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isModal, shouldRenderViewer]);

  useEffect(() => {
    if (!shouldRenderViewer || !attachment || !projectName) {
      return undefined;
    }

    let isActive = true;
    let nextImageUrl = '';

    const loadPreview = async () => {
      setIsLoading(true);
      setPreviewError('');
      setTextPreview('');
      setIsTruncatedPreview(false);
      setImageUrl('');
      setImageScale(1);

      try {
        if (previewKind === 'image') {
          const { blob } = await fetchChatAttachmentBlob(projectName, attachment);
          if (!isActive) {
            return;
          }

          nextImageUrl = window.URL.createObjectURL(blob);
          setImageUrl(nextImageUrl);
          return;
        }

        if (previewKind === 'markdown' || previewKind === 'text') {
          const previewResult = await fetchChatAttachmentTextPreview(projectName, attachment, {
            maxBytes: TEXT_PREVIEW_MAX_BYTES,
          });
          if (!isActive) {
            return;
          }

          setTextPreview(previewResult.text);
          setIsTruncatedPreview(previewResult.truncated);
          return;
        }
      } catch (error) {
        console.error('Failed to load chat attachment preview:', error);
        if (isActive) {
          setPreviewError(error instanceof Error ? error.message : 'Failed to load attachment preview');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    };

    void loadPreview();

    return () => {
      isActive = false;
      if (nextImageUrl) {
        window.URL.revokeObjectURL(nextImageUrl);
      }
    };
  }, [attachment, previewKind, projectName, shouldRenderViewer]);

  useEffect(() => {
    if (!shouldRenderViewer || !isModal) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isModal, onClose, shouldRenderViewer]);

  const handleDownload = useCallback(async () => {
    if (!attachment || !projectName) {
      return;
    }

    try {
      await downloadChatAttachment(projectName, attachment);
    } catch (error) {
      console.error('Failed to download chat attachment:', error);
      setPreviewError(error instanceof Error ? error.message : 'Failed to download attachment');
    }
  }, [attachment, projectName]);

  const handleOpenInNewWindow = useCallback(() => {
    if (!attachment || !projectName) {
      return;
    }

    try {
      const previewHref = buildChatAttachmentPreviewHref(projectName, attachment);
      window.open(previewHref, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Failed to open chat attachment preview page:', error);
      setPreviewError(error instanceof Error ? error.message : 'Failed to open preview page');
    }
  }, [attachment, projectName]);

  const handleZoomIn = useCallback(() => {
    setImageScale((currentScale) => clampImageScale(currentScale + IMAGE_SCALE_STEP));
  }, []);

  const handleZoomOut = useCallback(() => {
    setImageScale((currentScale) => clampImageScale(currentScale - IMAGE_SCALE_STEP));
  }, []);

  const handleResetZoom = useCallback(() => {
    setImageScale(1);
  }, []);

  const content = useMemo(() => {
    if (!attachment) {
      return null;
    }

    if (isLoading) {
      return (
        <ViewerLoadingState
          label={t('attachmentViewer.loading', { defaultValue: '正在加载附件预览...' })}
        />
      );
    }

    if (previewError) {
      return (
        <div className="rounded-3xl border border-red-200 bg-red-50/80 px-5 py-4 text-sm text-red-700 shadow-sm dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          {previewError}
        </div>
      );
    }

    if (previewKind === 'image') {
      return (
        <div className="flex h-full min-h-[320px] flex-col gap-4 rounded-3xl border border-border/60 bg-card/70 p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleZoomOut}
              className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
            >
              {t('attachmentViewer.zoomOut', { defaultValue: '缩小' })}
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
            >
              {t('attachmentViewer.fitScreen', { defaultValue: '适配屏幕' })}
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              className="rounded-full border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
            >
              {t('attachmentViewer.zoomIn', { defaultValue: '放大' })}
            </button>
            <span className="text-xs text-muted-foreground">
              {Math.round(imageScale * 100)}%
            </span>
          </div>
          <div className="flex min-h-[260px] flex-1 items-center justify-center overflow-auto rounded-2xl bg-slate-950/95 p-4">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={attachment.name}
                className="max-h-full max-w-full object-contain transition-transform duration-150"
                style={{ transform: `scale(${imageScale})`, transformOrigin: 'center center' }}
              />
            ) : (
              <ViewerLoadingState
                label={t('attachmentViewer.loadingImage', { defaultValue: '正在加载图片...' })}
              />
            )}
          </div>
        </div>
      );
    }

    if (previewKind === 'markdown') {
      return (
        <article className="rounded-3xl border border-border/60 bg-card/80 p-5 shadow-sm sm:p-6">
          {isTruncatedPreview && (
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
              {t('attachmentViewer.truncated', {
                defaultValue: '当前为截断预览，仅显示前 4MB 内容。完整文件请下载查看。',
              })}
            </div>
          )}
          <Markdown className="markdown-preview space-y-4 text-[15px] leading-7 text-foreground">
            {textPreview}
          </Markdown>
        </article>
      );
    }

    if (previewKind === 'text') {
      return (
        <div className="overflow-hidden rounded-3xl border border-border/60 bg-slate-950 shadow-sm">
          {isTruncatedPreview && (
            <div className="border-b border-amber-300/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {t('attachmentViewer.truncated', {
                defaultValue: '当前为截断预览，仅显示前 4MB 内容。完整文件请下载查看。',
              })}
            </div>
          )}
          <pre className="max-h-[70vh] overflow-auto p-4 text-sm leading-6 text-slate-100 sm:p-6">
            <code>{textPreview}</code>
          </pre>
        </div>
      );
    }

    return (
      <div className="rounded-3xl border border-border/60 bg-card/80 px-5 py-8 text-sm text-muted-foreground shadow-sm">
        <div className="font-medium text-foreground">
          {t('attachmentViewer.unsupportedTitle', { defaultValue: '当前文件暂不支持站内预览' })}
        </div>
        <div className="mt-2">
          {attachment.mimeType || t('attachmentViewer.unknownType', { defaultValue: '未知类型' })}
        </div>
        <div className="mt-4">
          {t('attachmentViewer.unsupportedHint', {
            defaultValue: '可以直接下载该附件，必要时用外部工具查看。',
          })}
        </div>
      </div>
    );
  }, [
    attachment,
    handleResetZoom,
    handleZoomIn,
    handleZoomOut,
    imageScale,
    imageUrl,
    isLoading,
    isTruncatedPreview,
    previewError,
    previewKind,
    t,
    textPreview,
  ]);

  if (!shouldRenderViewer || !attachment) {
    return null;
  }

  const viewerShell = (
    <div className={`${isModal ? 'flex h-full max-h-[calc(100vh-3rem)] flex-col' : 'min-h-screen bg-background text-foreground'}`}>
      <div className={`${isModal ? 'mb-4 rounded-3xl border border-border/60 bg-background/95 shadow-sm backdrop-blur' : 'border-b border-border/60 bg-background/95 backdrop-blur'}`}>
        <div className={`${isModal ? 'flex items-start justify-between gap-4 px-4 py-4 sm:px-5' : 'mx-auto flex w-full max-w-6xl items-start justify-between gap-4 px-4 py-4 sm:px-6'}`}>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{attachment.name}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{attachment.mimeType || t('attachmentViewer.unknownType', { defaultValue: '未知类型' })}</span>
              {fileSizeText && <span>{fileSizeText}</span>}
              <span>{previewKind}</span>
            </div>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleDownload()}
              className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
            >
              {t('attachmentViewer.download', { defaultValue: '下载' })}
            </button>
            {previewKind === 'markdown' && (
              <button
                type="button"
                onClick={handleOpenInNewWindow}
                className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
              >
                {t('attachmentViewer.openInNewWindow', { defaultValue: '新窗口打开' })}
              </button>
            )}
            {isModal && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-foreground transition hover:bg-accent"
              >
                {t('attachmentViewer.close', { defaultValue: '关闭' })}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className={`${isModal ? 'flex-1 overflow-auto' : 'mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8'}`}>
        {content}
      </div>
    </div>
  );

  if (!isModal) {
    return viewerShell;
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 px-3 py-4 backdrop-blur-sm sm:px-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-6xl rounded-[28px] bg-transparent"
        onClick={(event) => event.stopPropagation()}
      >
        {viewerShell}
      </div>
    </div>
  );
}

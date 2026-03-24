import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ChatAttachment, ChatAttachmentPreviewKind } from '../../chat/types/types';
import AttachmentViewer from '../../chat/view/subcomponents/AttachmentViewer';

/**
 * Renders a standalone protected preview page for uploaded chat attachments.
 *
 * @returns Full-page attachment preview resolved from query parameters.
 * @throws Does not throw. Missing parameters render an explicit invalid-state page.
 */
export default function AttachmentPreviewPage() {
  const [searchParams] = useSearchParams();
  const projectName = searchParams.get('projectName') || '';
  const filePath = searchParams.get('filePath') || '';
  const fileName = searchParams.get('fileName') || '';
  const mimeType = searchParams.get('mimeType') || undefined;
  const previewKindParam = searchParams.get('previewKind');
  const previewKind = (
    previewKindParam === 'image' ||
    previewKindParam === 'markdown' ||
    previewKindParam === 'text' ||
    previewKindParam === 'unsupported'
      ? previewKindParam
      : undefined
  ) as ChatAttachmentPreviewKind | undefined;

  const attachment = useMemo<ChatAttachment | null>(() => {
    if (!projectName || !filePath) {
      return null;
    }

    return {
      name: fileName || filePath.split(/[\\/]/).pop() || 'attachment',
      path: filePath,
      kind: previewKind === 'image' ? 'image' : 'file',
      mimeType,
      previewKind,
    };
  }, [fileName, filePath, mimeType, previewKind, projectName]);

  if (!attachment) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center text-sm text-muted-foreground">
        缺少附件预览参数，无法打开预览页。
      </div>
    );
  }

  return (
    <AttachmentViewer
      attachment={attachment}
      projectName={projectName}
      mode="page"
    />
  );
}

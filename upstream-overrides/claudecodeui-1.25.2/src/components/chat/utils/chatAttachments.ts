import type { ChatAttachment, ChatAttachmentPreviewKind } from '../types/types';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.xml',
  '.csv',
  '.tsv',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
  '.bat',
  '.sql',
]);

const ATTACHMENT_PREVIEW_ROUTE_PATH = '/attachment-preview';

/**
 * Resolves the attachment preview strategy used by the in-app viewer.
 *
 * @param attachment Chat attachment metadata. Missing `previewKind` falls back to MIME type and extension inference.
 * @returns Attachment preview kind used by the UI renderer.
 * @throws Does not throw. Unknown inputs fall back to `unsupported`.
 */
export function resolveChatAttachmentPreviewKind(
  attachment: Pick<ChatAttachment, 'previewKind' | 'mimeType' | 'name' | 'path' | 'kind'>,
): ChatAttachmentPreviewKind {
  if (attachment.previewKind) {
    return attachment.previewKind;
  }

  const normalizedMimeType = String(attachment.mimeType || '').toLowerCase();
  const fileName = String(attachment.name || attachment.path || '');
  const normalizedExtension = (() => {
    const lastDotIndex = fileName.lastIndexOf('.');
    return lastDotIndex >= 0 ? fileName.slice(lastDotIndex).toLowerCase() : '';
  })();

  if (attachment.kind === 'image' || normalizedMimeType.startsWith('image/')) {
    return 'image';
  }

  if (
    normalizedMimeType === 'text/markdown' ||
    MARKDOWN_EXTENSIONS.has(normalizedExtension)
  ) {
    return 'markdown';
  }

  if (
    normalizedMimeType.startsWith('text/') ||
    normalizedMimeType === 'application/json' ||
    normalizedMimeType === 'application/xml' ||
    normalizedMimeType === 'application/yaml' ||
    normalizedMimeType === 'application/x-yaml' ||
    normalizedMimeType === 'application/toml' ||
    TEXT_EXTENSIONS.has(normalizedExtension)
  ) {
    return 'text';
  }

  return 'unsupported';
}

/**
 * Builds the standalone attachment preview route used for new-window Markdown previews.
 *
 * @param projectName Project name used to scope the attachment API.
 * @param attachment Chat attachment metadata.
 * @returns Router href for the attachment preview page.
 * @throws {Error} Throws when projectName or attachment path is missing.
 */
export function buildChatAttachmentPreviewHref(projectName: string, attachment: ChatAttachment) {
  if (!projectName || !attachment?.path) {
    throw new Error('Missing projectName or attachment path when building attachment preview href');
  }

  const baseName = typeof window !== 'undefined' ? window.__ROUTER_BASENAME__ || '' : '';
  const searchParams = new URLSearchParams({
    projectName,
    filePath: attachment.path,
    fileName: attachment.name || '',
    previewKind: resolveChatAttachmentPreviewKind(attachment),
  });

  if (attachment.mimeType) {
    searchParams.set('mimeType', attachment.mimeType);
  }

  return `${baseName}${ATTACHMENT_PREVIEW_ROUTE_PATH}?${searchParams.toString()}`;
}

/**
 * Formats attachment size values for compact display.
 *
 * @param sizeInBytes Attachment size in bytes.
 * @returns Human-readable file size or an empty string when size is unknown.
 * @throws Does not throw.
 */
export function formatChatAttachmentSize(sizeInBytes?: number) {
  if (!Number.isFinite(sizeInBytes) || !sizeInBytes || sizeInBytes <= 0) {
    return '';
  }

  if (sizeInBytes >= 1024 * 1024) {
    return `${(sizeInBytes / (1024 * 1024)).toFixed(sizeInBytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  if (sizeInBytes >= 1024) {
    return `${Math.max(1, Math.round(sizeInBytes / 1024))} KB`;
  }

  return `${sizeInBytes} B`;
}

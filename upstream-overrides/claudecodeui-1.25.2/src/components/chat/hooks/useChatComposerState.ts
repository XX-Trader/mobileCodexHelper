import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { api, authenticatedFetch } from '../../../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import { thinkingModes } from '../constants/thinkingModes';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import {
  getChatDraftStorageKey,
  safeLocalStorage,
  type ChatDraftSnapshot,
} from '../utils/chatStorage';
import {
  hasPendingTemplateSession,
  resolvePendingViewSessionId,
} from '../utils/pendingSession';
import type {
  ChatAttachment,
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
} from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type { SessionViewChatRuntime } from '../../../types/sessionView';
import { escapeRegExp } from '../utils/chatFormatting';
import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface QueuedCodexFollowUp {
  queueId: string;
  messageContent: string;
  projectPath: string;
  model: string;
  permissionMode: PermissionMode | string;
  modelReasoningEffort: string;
  resumeSessionId: string | null;
}

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  codexReasoningEffort: string;
  geminiModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onCreateOptimisticSession?: (
    project: Project,
    session: ProjectSession,
    initialChatRuntime?: Partial<SessionViewChatRuntime>,
  ) => void;
  pendingViewSessionRef: { current: PendingViewSession | null };
  scrollToBottom: () => void;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setSessionMessages?: Dispatch<SetStateAction<any[]>>;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_FILE_ATTACHMENTS = 10;
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_FILE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const createQueuedCodexFollowUpId = () =>
  `queued-codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

const shouldLogNewSessionDebug = () => {
  return false;
};

const logNewSessionDebug = (event: string, payload: Record<string, unknown>) => {
  if (!shouldLogNewSessionDebug()) {
    return;
  }

  console.debug('[new-session][composer]', {
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

const isImageMimeType = (mimeType: string | null | undefined) =>
  typeof mimeType === 'string' && mimeType.startsWith('image/');

const getFileIdentity = (file: File) => `${file.name}::${file.size}::${file.lastModified}`;

const dedupeFiles = (files: File[]) => {
  const seen = new Set<string>();
  return files.filter((file) => {
    const identity = getFileIdentity(file);
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
};

const normalizeAttachmentPromptPath = (filePath: string) => filePath.replace(/\\/g, '/');

const appendAttachmentContext = (messageContent: string, attachments: ChatAttachment[]) => {
  if (!attachments.length) {
    return messageContent;
  }

  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  const fileAttachments = attachments.filter((attachment) => attachment.kind === 'file');
  const sections: string[] = [];

  if (imageAttachments.length > 0) {
    sections.push(
      `\u5df2\u9644\u5e26\u56fe\u7247\uff1a${imageAttachments.map((attachment) => attachment.name).join('\u3001')}\u3002\u8bf7\u7ed3\u5408\u8fd9\u4e9b\u56fe\u7247\u4e00\u8d77\u5904\u7406\u3002`,
    );
  }

  if (fileAttachments.length > 0) {
    sections.push(
      [
        '\u5df2\u9644\u5e26\u672c\u5730\u9644\u4ef6\uff0c\u53ef\u76f4\u63a5\u8bfb\u53d6\u4ee5\u4e0b\u8def\u5f84\uff1a',
        ...fileAttachments.map((attachment) => `- ${normalizeAttachmentPromptPath(attachment.path)}`),
      ].join('\n'),
    );
  }

  const attachmentContext = sections.join('\n\n');
  return messageContent.trim() ? `${messageContent}\n\n${attachmentContext}` : attachmentContext;
};

const readDraftSnapshot = (storageKey: string | null): ChatDraftSnapshot | null => {
  if (!storageKey) {
    return null;
  }

  const saved = safeLocalStorage.getItem(storageKey);
  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as ChatDraftSnapshot;
    return {
      input: typeof parsed.input === 'string' ? parsed.input : '',
      thinkingMode: typeof parsed.thinkingMode === 'string' ? parsed.thinkingMode : 'none',
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now(),
    };
  } catch (error) {
    console.error('Failed to parse draft snapshot, resetting:', error);
    safeLocalStorage.removeItem(storageKey);
    return null;
  }
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  cursorModel,
  claudeModel,
  codexModel,
  codexReasoningEffort,
  geminiModel,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionActive,
  onSessionProcessing,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  onCreateOptimisticSession,
  pendingViewSessionRef,
  scrollToBottom,
  setChatMessages,
  setSessionMessages,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const resolveDraftScopedSessionId = () => {
    const pendingSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
    const cursorSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('cursorSessionId') : null;
    const pendingViewSessionId = resolvePendingViewSessionId(
      pendingViewSessionRef.current,
      pendingSessionId,
    );

    if (selectedSession?.id) {
      return selectedSession.id;
    }

    if (pendingViewSessionId) {
      return pendingViewSessionId;
    }

    if (pendingSessionId) {
      return pendingSessionId;
    }

    if (provider === 'cursor' && cursorSessionId) {
      return cursorSessionId;
    }

    if (currentSessionId && isTemporarySessionId(currentSessionId)) {
      return currentSessionId;
    }

    return null;
  };

  const draftStorageKey = getChatDraftStorageKey({
    projectName: selectedProject?.name,
    sessionId: resolveDraftScopedSessionId(),
    provider: selectedSession?.__provider || provider,
  });
  const initialDraftSnapshot =
    typeof window !== 'undefined' ? readDraftSnapshot(draftStorageKey) : null;
  const [input, setInput] = useState(() => initialDraftSnapshot?.input || '');
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(() => initialDraftSnapshot?.thinkingMode || 'none');
  const [queuedCodexFollowUpCount, setQueuedCodexFollowUpCount] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const queuedCodexFollowUpsRef = useRef<QueuedCodexFollowUp[]>([]);
  const isDispatchingQueuedCodexFollowUpRef = useRef(false);

  const syncQueuedCodexFollowUpCount = useCallback(() => {
    setQueuedCodexFollowUpCount(queuedCodexFollowUpsRef.current.length);
  }, []);

  const getConcreteSessionIdCandidates = useCallback(() => {
    const pendingSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
    const cursorSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('cursorSessionId') : null;
    const pendingViewSessionId = resolvePendingViewSessionId(
      pendingViewSessionRef.current,
      pendingSessionId,
    );
    const allowCurrentSessionIdReuse =
      Boolean(selectedSession?.id) ||
      hasPendingTemplateSession(pendingViewSessionRef.current, pendingSessionId) ||
      Boolean(currentSessionId && isTemporarySessionId(currentSessionId));

    return [
      allowCurrentSessionIdReuse ? currentSessionId : null,
      pendingViewSessionId,
      pendingSessionId,
      provider === 'cursor' ? cursorSessionId : null,
      selectedSession?.id || null,
    ];
  }, [currentSessionId, pendingViewSessionRef, provider, selectedSession?.id]);

  const resolveConcreteSessionId = useCallback(() => {
    const candidateSessionIds = getConcreteSessionIdCandidates();
    return (
      candidateSessionIds.find(
        (sessionId) => Boolean(sessionId) && !isTemporarySessionId(sessionId),
      ) || null
    );
  }, [getConcreteSessionIdCandidates]);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'clear':
          setChatMessages([]);
          setSessionMessages?.([]);
          break;

        case 'help':
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content: data.content,
              timestamp: Date.now(),
            },
          ]);
          break;

        case 'model':
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content: `**Current Model**: ${data.current.model}\n\n**Available Models**:\n\nClaude: ${data.available.claude.join(', ')}\n\nCursor: ${data.available.cursor.join(', ')}`,
              timestamp: Date.now(),
            },
          ]);
          break;

        case 'cost': {
          const costMessage = `**Token Usage**: ${data.tokenUsage.used.toLocaleString()} / ${data.tokenUsage.total.toLocaleString()} (${data.tokenUsage.percentage}%)\n\n**Estimated Cost**:\n- Input: $${data.cost.input}\n- Output: $${data.cost.output}\n- **Total**: $${data.cost.total}\n\n**Model**: ${data.model}`;
          setChatMessages((previous) => [
            ...previous,
            { type: 'assistant', content: costMessage, timestamp: Date.now() },
          ]);
          break;
        }

        case 'status': {
          const statusMessage = `**System Status**\n\n- Version: ${data.version}\n- Uptime: ${data.uptime}\n- Model: ${data.model}\n- Provider: ${data.provider}\n- Node.js: ${data.nodeVersion}\n- Platform: ${data.platform}`;
          setChatMessages((previous) => [
            ...previous,
            { type: 'assistant', content: statusMessage, timestamp: Date.now() },
          ]);
          break;
        }
        case 'memory':
          if (data.error) {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `\u5185\u5b58\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff1a${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          } else {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `\u5185\u5b58\u547d\u4ee4\u6267\u884c\u6210\u529f\uff1a${data.message}\n\nPath: \`${data.path}\``,
                timestamp: Date.now(),
              },
            ]);
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;
        case 'rewind':
          if (data.error) {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `\u56de\u6eda\u547d\u4ee4\u6267\u884c\u5931\u8d25\uff1a${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          } else {
            setChatMessages((previous) => previous.slice(0, -data.steps * 2));
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `\u5df2\u56de\u6eda\uff1a${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, setChatMessages, setSessionMessages],
  );

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        '\u8fd9\u4e2a\u547d\u4ee4\u5305\u542b\u5c06\u8981\u6267\u884c\u7684 bash \u547d\u4ee4\uff0c\u662f\u5426\u7ee7\u7eed\uff1f',
      );
      if (!confirmed) {
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: '\u5df2\u53d6\u6d88\u6267\u884c\u547d\u4ee4\u3002',
            timestamp: Date.now(),
          },
        ]);
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [setChatMessages]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectName: selectedProject.name,
          sessionId: currentSessionId,
          provider,
          model: provider === 'cursor' ? cursorModel : provider === 'codex' ? codexModel : provider === 'gemini' ? geminiModel : claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          setInput('');
          inputValueRef.current = '';
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: `\u6267\u884c\u547d\u4ee4\u5931\u8d25\uff1a${message}`,
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [
      claudeModel,
      codexModel,
      currentSessionId,
      cursorModel,
      geminiModel,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      setChatMessages,
      tokenBudget,
    ],
  );

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const pushImageError = useCallback((fileName: string, message: string) => {
    setImageErrors((previous) => {
      const next = new Map(previous);
      next.set(fileName, message);
      return next;
    });
  }, []);

  const pushFileError = useCallback((fileName: string, message: string) => {
    setFileErrors((previous) => {
      const next = new Map(previous);
      next.set(fileName, message);
      return next;
    });
  }, []);

  const handleSelectedFiles = useCallback(
    (files: File[]) => {
      const validImages: File[] = [];
      const validFiles: File[] = [];

      files.forEach((file) => {
        try {
          if (!file || typeof file !== 'object') {
            console.warn('Invalid file object:', file);
            return;
          }

          const fileName = file.name || 'Unknown file';
          if (!file.size) {
            if (isImageMimeType(file.type)) {
              pushImageError(fileName, '\u56fe\u7247\u4e3a\u7a7a\uff0c\u8bf7\u91cd\u65b0\u590d\u5236\u6216\u9009\u62e9\u6587\u4ef6\u3002');
            } else {
              pushFileError(fileName, '\u9644\u4ef6\u4e3a\u7a7a\uff0c\u8bf7\u91cd\u65b0\u590d\u5236\u6216\u9009\u62e9\u6587\u4ef6\u3002');
            }
            return;
          }

          if (isImageMimeType(file.type)) {
            if (provider !== 'codex' && IS_CODEX_ONLY_HARDENED) {
              pushImageError(fileName, '\u5f53\u524d\u53ea\u6709 Codex \u4f1a\u8bdd\u652f\u6301\u56fe\u7247\u4e0a\u4f20\uff0c\u8bf7\u5207\u6362\u5230 Codex \u540e\u518d\u53d1\u9001\u3002');
              return;
            }

            if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
              pushImageError(fileName, '\u56fe\u7247\u4f53\u79ef\u4e0d\u80fd\u8d85\u8fc7 5MB\u3002');
              return;
            }

            validImages.push(file);
            return;
          }

          if (provider !== 'codex') {
            pushFileError(fileName, '\u5f53\u524d\u53ea\u6709 Codex \u4f1a\u8bdd\u652f\u6301\u666e\u901a\u9644\u4ef6\uff0c\u8bf7\u5207\u6362\u5230 Codex \u540e\u518d\u53d1\u9001\u3002');
            return;
          }

          if (file.size > MAX_FILE_ATTACHMENT_BYTES) {
            pushFileError(fileName, '\u9644\u4ef6\u4f53\u79ef\u4e0d\u80fd\u8d85\u8fc7 20MB\u3002');
            return;
          }

          validFiles.push(file);
        } catch (error) {
          console.error('Error validating selected file:', error, file);
        }
      });

      if (validImages.length > 0) {
        setAttachedImages((previous) =>
          dedupeFiles([...previous, ...validImages]).slice(0, MAX_IMAGE_ATTACHMENTS),
        );
        setImageErrors((previous) => {
          const next = new Map(previous);
          validImages.forEach((file) => next.delete(file.name));
          return next;
        });
      }

      if (validFiles.length > 0) {
        setAttachedFiles((previous) =>
          dedupeFiles([...previous, ...validFiles]).slice(0, MAX_FILE_ATTACHMENTS),
        );
        setFileErrors((previous) => {
          const next = new Map(previous);
          validFiles.forEach((file) => next.delete(file.name));
          return next;
        });
      }
    },
    [provider, pushFileError, pushImageError],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboardFiles = Array.from(event.clipboardData.files || []);
      if (clipboardFiles.length > 0) {
        event.preventDefault();
        handleSelectedFiles(clipboardFiles);
        return;
      }

      const pastedFiles = Array.from(event.clipboardData.items)
        .map((item) => item.getAsFile())
        .filter((file): file is File => file instanceof File);

      if (pastedFiles.length > 0) {
        event.preventDefault();
        handleSelectedFiles(pastedFiles);
      }
    },
    [handleSelectedFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxFiles: MAX_IMAGE_ATTACHMENTS + MAX_FILE_ATTACHMENTS,
    onDrop: handleSelectedFiles,
    noClick: true,
    noKeyboard: true,
  });

  const resetComposerAfterSubmit = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    setAttachedImages([]);
    setAttachedFiles([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setFileErrors(new Map());
    setIsTextareaExpanded(false);
    setThinkingMode('none');

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (draftStorageKey) {
      safeLocalStorage.removeItem(draftStorageKey);
    }
  }, [draftStorageKey, resetCommandMenuState]);

  const markSessionSubmissionStarted = useCallback(
    (
      effectiveSessionId: string | null,
      sessionToActivate: string,
      submissionStartedAt = Date.now(),
    ) => {
      setIsLoading(true);
      setCanAbortSession(true);
      setClaudeStatus({
        text: 'Processing',
        tokens: 0,
        can_interrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      if (
        !effectiveSessionId &&
        !selectedSession?.id &&
        !pendingViewSessionRef.current?.sessionId
      ) {
        if (typeof window !== 'undefined') {
          sessionStorage.removeItem('pendingSessionId');
        }
        pendingViewSessionRef.current = {
          sessionId: null,
          startedAt: submissionStartedAt,
        };
      }

      onSessionActive?.(sessionToActivate);
      if (effectiveSessionId && !isTemporarySessionId(effectiveSessionId)) {
        onSessionProcessing?.(effectiveSessionId);
      }
    },
    [
      onSessionActive,
      onSessionProcessing,
      pendingViewSessionRef,
      scrollToBottom,
      selectedSession?.id,
      setCanAbortSession,
      setClaudeStatus,
      setIsLoading,
      setIsUserScrolledUp,
    ],
  );

  const markQueuedCodexMessageAsDispatched = useCallback(
    (queueId: string) => {
      setChatMessages((previous) =>
        previous.map((message) => {
          if (
            message.type === 'user' &&
            Boolean(message.isQueued) &&
            message.queuedFollowUpId === queueId
          ) {
            return {
              ...message,
              isQueued: false,
              queuedWhileStreaming: false,
            };
          }

          return message;
        }),
      );
    },
    [setChatMessages],
  );

  const handleRemoveQueuedCodexFollowUp = useCallback(
    (queueId: string) => {
      queuedCodexFollowUpsRef.current = queuedCodexFollowUpsRef.current.filter(
        (followUp) => followUp.queueId !== queueId,
      );
      syncQueuedCodexFollowUpCount();

      setChatMessages((previous) =>
        previous.filter(
          (message) =>
            !(
              message.type === 'user' &&
              Boolean(message.isQueued) &&
              message.queuedFollowUpId === queueId
            ),
        ),
      );
    },
    [setChatMessages, syncQueuedCodexFollowUpCount],
  );

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      const hasAttachments = attachedImages.length > 0 || attachedFiles.length > 0;

      if ((!currentInput.trim() && !hasAttachments) || !selectedProject) {
        return;
      }

      if (isLoading) {
        if (provider !== 'codex') {
          return;
        }

        if (hasAttachments) {
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: '\u5f53\u524d\u56de\u7b54\u8fd8\u5728\u5904\u7406\u4e2d\uff0c\u56fe\u7247\u548c\u9644\u4ef6\u8bf7\u7b49\u672c\u8f6e\u7ed3\u675f\u540e\u518d\u53d1\u9001\u3002',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        const selectedThinkingMode = thinkingModes.find(
          (mode: { id: string; prefix?: string }) => mode.id === thinkingMode,
        );
        const queuedMessageContent =
          selectedThinkingMode && selectedThinkingMode.prefix
            ? `${selectedThinkingMode.prefix}: ${currentInput}`
            : currentInput;
        const queueId = createQueuedCodexFollowUpId();

        queuedCodexFollowUpsRef.current.push({
          queueId,
          messageContent: queuedMessageContent,
          projectPath: selectedProject.fullPath || selectedProject.path || '',
          model: codexModel,
          permissionMode,
          modelReasoningEffort: codexReasoningEffort,
          resumeSessionId: resolveConcreteSessionId(),
        });
        syncQueuedCodexFollowUpCount();

        setChatMessages((previous) => [
          ...previous,
          {
            type: 'user',
            content: currentInput,
            timestamp: new Date(),
            isQueued: true,
            queuedWhileStreaming: true,
            queuedFollowUpId: queueId,
          },
        ]);

        resetComposerAfterSubmit();
        return;
      }

      const trimmedInput = currentInput.trim();
      if (trimmedInput.startsWith('/') && !hasAttachments) {
        const firstSpace = trimmedInput.indexOf(' ');
        const commandName = firstSpace > 0 ? trimmedInput.slice(0, firstSpace) : trimmedInput;
        const matchedCommand = slashCommands.find((cmd: SlashCommand) => cmd.name === commandName);
        if (matchedCommand) {
          executeCommand(matchedCommand, trimmedInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedImages([]);
          setAttachedFiles([]);
          setUploadingImages(new Map());
          setImageErrors(new Map());
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      let commandContent = currentInput;
      const selectedThinkingMode = thinkingModes.find(
        (mode: { id: string; prefix?: string }) => mode.id === thinkingMode,
      );
      if (selectedThinkingMode && selectedThinkingMode.prefix) {
        commandContent = `${selectedThinkingMode.prefix}: ${currentInput}`;
      }

      let displayContent = currentInput;
      let uploadedImages: unknown[] = [];
      let uploadedAttachments: ChatAttachment[] = [];

      if (provider === 'codex' && hasAttachments) {
        const formData = new FormData();
        [...attachedImages, ...attachedFiles].forEach((file) => {
          formData.append('files', file, file.name);
        });

        try {
          const response = await api.uploadChatAttachments(selectedProject.name, formData);
          if (!response.ok) {
            let errorMessage = '\u9644\u4ef6\u4e0a\u4f20\u5931\u8d25';
            try {
              const errorData = await response.json();
              errorMessage = errorData?.error || errorMessage;
            } catch {
              // Ignore response parse failures and use the fallback message.
            }
            throw new Error(errorMessage);
          }

          const result = (await response.json()) as { attachments?: ChatAttachment[] };
          uploadedAttachments = Array.isArray(result.attachments) ? result.attachments : [];
          commandContent = appendAttachmentContext(commandContent, uploadedAttachments);
          displayContent = appendAttachmentContext(displayContent, uploadedAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Attachment upload failed:', error);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: `\u9644\u4ef6\u4e0a\u4f20\u5931\u8d25\uff1a${message}`,
              timestamp: new Date(),
            },
          ]);
          return;
        }
      } else {
        if (IS_CODEX_ONLY_HARDENED && attachedImages.length > 0) {
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: '\u5f53\u524d\u53ea\u6709 Codex \u4f1a\u8bdd\u652f\u6301\u56fe\u7247\u4e0a\u4f20\uff0c\u8bf7\u5207\u5230 Codex \u4f1a\u8bdd\u540e\u518d\u53d1\u9001\u3002',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        if (attachedFiles.length > 0) {
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: '\u5f53\u524d provider \u6682\u4e0d\u652f\u6301\u666e\u901a\u9644\u4ef6\uff0c\u8bf7\u5207\u5230 Codex \u4f1a\u8bdd\u540e\u518d\u53d1\u9001\u3002',
              timestamp: new Date(),
            },
          ]);
          return;
        }

        if (!IS_CODEX_ONLY_HARDENED && attachedImages.length > 0) {
          const formData = new FormData();
          attachedImages.forEach((file) => {
            formData.append('images', file);
          });

          try {
            const response = await authenticatedFetch(`/api/projects/${selectedProject.name}/upload-images`, {
              method: 'POST',
              headers: {},
              body: formData,
            });

            if (!response.ok) {
              throw new Error('\u56fe\u7247\u4e0a\u4f20\u5931\u8d25');
            }

            const result = await response.json();
            uploadedImages = result.images;
            if (!displayContent.trim()) {
              displayContent = `\u5df2\u9644\u5e26\u56fe\u7247\uff1a${attachedImages.map((file) => file.name).join('\u3001')}`;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Image upload failed:', error);
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'error',
                content: `\u56fe\u7247\u4e0a\u4f20\u5931\u8d25\uff1a${message}`,
                timestamp: new Date(),
              },
            ]);
            return;
          }
        }
      }

      const userMessage: ChatMessage = {
        type: 'user',
        content: displayContent.trim() ? displayContent : commandContent,
        images: uploadedImages as any,
        attachments: uploadedAttachments,
        timestamp: new Date(),
      };

      setChatMessages((previous) => [...previous, userMessage]);
      const effectiveSessionId = resolveConcreteSessionId();
      const shouldCreateOptimisticSession =
        provider === 'codex' &&
        !effectiveSessionId &&
        !selectedSession?.id;
      const optimisticSessionId = shouldCreateOptimisticSession ? `new-session-${Date.now()}` : null;
      const sessionToActivate = effectiveSessionId || optimisticSessionId || `new-session-${Date.now()}`;
      const submissionStartedAt = Date.now();
      const initialOptimisticChatRuntime: Partial<SessionViewChatRuntime> = {
        isLoading: true,
        canAbortSession: true,
        claudeStatus: {
          text: 'Processing',
          tokens: 0,
          can_interrupt: true,
        },
        tokenBudget: null,
        pendingPermissionRequests: [],
        startedAt: submissionStartedAt,
        updatedAt: submissionStartedAt,
      };
      logNewSessionDebug('submit-resolved-session', {
        provider,
        selectedProjectName: selectedProject.name,
        selectedSessionId: selectedSession?.id || null,
        currentSessionId,
        effectiveSessionId,
        shouldCreateOptimisticSession,
        optimisticSessionId,
        sessionToActivate,
      });

      if (!effectiveSessionId && !selectedSession?.id) {
        if (typeof window !== 'undefined') {
          sessionStorage.removeItem('pendingSessionId');
        }
        pendingViewSessionRef.current = {
          sessionId: optimisticSessionId,
          startedAt: submissionStartedAt,
        };
      }

      if (shouldCreateOptimisticSession && optimisticSessionId) {
        const trimmedTitle = currentInput.trim();
        const optimisticTimestamp = new Date().toISOString();
        logNewSessionDebug('submit-create-optimistic-session', {
          optimisticSessionId,
          title: trimmedTitle || '\u65b0\u4f1a\u8bdd',
        });

        onCreateOptimisticSession?.(
          selectedProject,
          {
            id: optimisticSessionId,
            title: trimmedTitle || '\u65b0\u4f1a\u8bdd',
            summary: trimmedTitle || '\u65b0\u4f1a\u8bdd',
            created_at: optimisticTimestamp,
            updated_at: optimisticTimestamp,
            __provider: 'codex',
            __projectName: selectedProject.name,
          },
          initialOptimisticChatRuntime,
        );
      }
      markSessionSubmissionStarted(effectiveSessionId, sessionToActivate, submissionStartedAt);

      const getToolsSettings = () => {
        try {
          const settingsKey =
            provider === 'cursor'
              ? 'cursor-tools-settings'
              : provider === 'codex'
                ? 'codex-settings'
                : provider === 'gemini'
                  ? 'gemini-settings'
                  : 'claude-settings';
          const savedSettings = safeLocalStorage.getItem(settingsKey);
          if (savedSettings) {
            return JSON.parse(savedSettings);
          }
        } catch (error) {
          console.error('Error loading tools settings:', error);
        }

        return {
          allowedTools: [],
          disallowedTools: [],
          skipPermissions: false,
        };
      };

      const toolsSettings = getToolsSettings();
      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';

      if (provider === 'cursor') {
        sendMessage({
          type: 'cursor-command',
          command: commandContent,
          sessionId: effectiveSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: cursorModel,
            skipPermissions: toolsSettings?.skipPermissions || false,
            toolsSettings,
          },
        });
      } else if (provider === 'codex') {
        logNewSessionDebug('submit-send-codex-command', {
          effectiveSessionId,
          optimisticSessionId,
          resolvedProjectPath,
          permissionMode,
          model: codexModel,
        });
        sendMessage({
          type: 'codex-command',
          command: commandContent,
          sessionId: effectiveSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: codexModel,
            permissionMode,
            modelReasoningEffort: codexReasoningEffort,
            attachments: uploadedAttachments,
          },
        });
      } else if (provider === 'gemini') {
        sendMessage({
          type: 'gemini-command',
          command: commandContent,
          sessionId: effectiveSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: geminiModel,
            permissionMode,
            toolsSettings,
          },
        });
      } else {
        sendMessage({
          type: 'claude-command',
          command: commandContent,
          options: {
            projectPath: resolvedProjectPath,
            cwd: resolvedProjectPath,
            sessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            toolsSettings,
            permissionMode,
            model: claudeModel,
            images: uploadedImages,
          },
        });
      }

      resetComposerAfterSubmit();
    },
    [
      attachedFiles,
      attachedImages,
      claudeModel,
      codexModel,
      codexReasoningEffort,
      currentSessionId,
      cursorModel,
      executeCommand,
      geminiModel,
      isLoading,
      markSessionSubmissionStarted,
      onCreateOptimisticSession,
      pendingViewSessionRef,
      permissionMode,
      provider,
      resetComposerAfterSubmit,
      resolveConcreteSessionId,
      resetCommandMenuState,
      selectedProject,
      selectedSession?.id,
      sendMessage,
      setChatMessages,
      slashCommands,
      syncQueuedCodexFollowUpCount,
      thinkingMode,
    ],
  );
  useEffect(() => {
    if (provider !== 'codex') {
      return;
    }

    const activeQueuedFollowUps = queuedCodexFollowUpsRef.current;
    if (activeQueuedFollowUps.length === 0) {
      if (queuedCodexFollowUpCount !== 0) {
        setQueuedCodexFollowUpCount(0);
      }
      return;
    }

    const resumeSessionId = resolveConcreteSessionId();

    if (isLoading) {
      if (resumeSessionId) {
        activeQueuedFollowUps.forEach((followUp) => {
          if (!followUp.resumeSessionId) {
            followUp.resumeSessionId = resumeSessionId;
          }
        });
      }
      return;
    }

    if (isDispatchingQueuedCodexFollowUpRef.current) {
      return;
    }

    const nextFollowUp = activeQueuedFollowUps[0];
    if (!nextFollowUp) {
      return;
    }

    const effectiveSessionId = nextFollowUp.resumeSessionId || resolveConcreteSessionId();
    if (!effectiveSessionId) {
      return;
    }

    activeQueuedFollowUps.shift();
    syncQueuedCodexFollowUpCount();
    isDispatchingQueuedCodexFollowUpRef.current = true;

    markQueuedCodexMessageAsDispatched(nextFollowUp.queueId);
    markSessionSubmissionStarted(effectiveSessionId, effectiveSessionId);
    sendMessage({
      type: 'codex-command',
      command: nextFollowUp.messageContent,
      sessionId: effectiveSessionId,
      options: {
        cwd: nextFollowUp.projectPath,
        projectPath: nextFollowUp.projectPath,
        sessionId: effectiveSessionId,
        resume: true,
        model: nextFollowUp.model,
        permissionMode: nextFollowUp.permissionMode,
        modelReasoningEffort: nextFollowUp.modelReasoningEffort,
      },
    });

    window.setTimeout(() => {
      isDispatchingQueuedCodexFollowUpRef.current = false;
    }, 0);
  }, [
    isLoading,
    markQueuedCodexMessageAsDispatched,
    markSessionSubmissionStarted,
    provider,
    queuedCodexFollowUpCount,
    resolveConcreteSessionId,
    sendMessage,
    syncQueuedCodexFollowUpCount,
  ]);

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    const snapshot = readDraftSnapshot(draftStorageKey);
    const nextInput = snapshot?.input || '';
    const nextThinkingMode = snapshot?.thinkingMode || 'none';

    setInput((previous) => {
      const resolved = previous === nextInput ? previous : nextInput;
      inputValueRef.current = resolved;
      return resolved;
    });
    setThinkingMode((previous) => (previous === nextThinkingMode ? previous : nextThinkingMode));
    setAttachedImages([]);
    setAttachedFiles([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setFileErrors(new Map());
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey) {
      return;
    }

    if (input !== '' || thinkingMode !== 'none') {
      const snapshot: ChatDraftSnapshot = {
        input,
        thinkingMode,
        updatedAt: Date.now(),
      };
      safeLocalStorage.setItem(draftStorageKey, JSON.stringify(snapshot));
    } else {
      safeLocalStorage.removeItem(draftStorageKey);
    }
  }, [draftStorageKey, input, thinkingMode]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    // Re-run when input changes so restored drafts get the same autosize behavior as typed text.
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
    const expanded = textareaRef.current.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      target.style.height = 'auto';
      target.style.height = `${target.scrollHeight}px`;
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);

      const lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      setIsTextareaExpanded(target.scrollHeight > lineHeight * 2);
    },
    [setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    setAttachedImages([]);
    setAttachedFiles([]);
    setImageErrors(new Map());
    setFileErrors(new Map());
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId =
      getConcreteSessionIdCandidates().find(
        (sessionId) => Boolean(sessionId) && !isTemporarySessionId(sessionId),
      ) || null;

    if (!targetSessionId) {
      console.warn('Abort requested but no concrete session ID is available yet.');
      return;
    }

    sendMessage({
      type: 'abort-session',
      sessionId: targetSessionId,
      provider,
    });
  }, [canAbortSession, getConcreteSessionIdCandidates, provider, sendMessage]);

  const handleTranscript = useCallback((text: string) => {
    if (IS_CODEX_ONLY_HARDENED) {
      return;
    }

    if (!text.trim()) {
      return;
    }

    setInput((previousInput) => {
      const newInput = previousInput.trim() ? `${previousInput} ${text}` : text;
      inputValueRef.current = newInput;

      setTimeout(() => {
        if (!textareaRef.current) {
          return;
        }

        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
        setIsTextareaExpanded(textareaRef.current.scrollHeight > lineHeight * 2);
      }, 0);

      return newInput;
    });
  }, []);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'claude-permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) => {
        const next = previous.filter((request) => !validIds.includes(request.requestId));
        if (next.length === 0) {
          setClaudeStatus(null);
        }
        return next;
      });
    },
    [sendMessage, setClaudeStatus, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    queuedCodexFollowUpCount,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    attachedFiles,
    setAttachedFiles,
    uploadingImages,
    imageErrors,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleRemoveQueuedCodexFollowUp,
    handleAbortSession,
    handleTranscript,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
  };
}

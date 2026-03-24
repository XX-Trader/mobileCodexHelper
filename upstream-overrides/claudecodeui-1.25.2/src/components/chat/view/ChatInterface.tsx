import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, ChatMessage, Provider  } from '../types/types';
import type { SessionViewTarget } from '../../../types/sessionView';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { convertSessionMessages } from '../utils/messageTransforms';
import { hasPendingTemplateSession, resolvePendingViewSessionId } from '../utils/pendingSession';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type ViewScopedStartedAtState = {
  viewKey: string;
  startedAt: number | null;
};

type ViewScopedTokenBudgetState = {
  viewKey: string;
  tokenBudget: Record<string, unknown> | null;
};

const STARTED_AT_STALE_TOLERANCE_MS = 5000;

function normalizeStartedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  return null;
}

function findLatestUserMessageStartedAt(messages: ChatMessage[]): number | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const currentMessage = messages[messageIndex];
    if (currentMessage?.type !== 'user') {
      continue;
    }

    const normalizedStartedAt = normalizeStartedAt(currentMessage.timestamp);
    if (normalizedStartedAt !== null) {
      return normalizedStartedAt;
    }
  }

  return null;
}

function resolveViewScopedSessionId(
  selectedSession: ChatInterfaceProps['selectedSession'],
  currentSessionId: string | null,
  pendingViewSessionId: string | null,
): string | null {
  const selectedSessionId = selectedSession?.id ?? null;
  const hasTemporarySelectedSession =
    typeof selectedSessionId === 'string' && selectedSessionId.startsWith('new-session-');

  if (selectedSessionId && !hasTemporarySelectedSession) {
    return selectedSessionId;
  }

  if (pendingViewSessionId) {
    return pendingViewSessionId;
  }

  if (selectedSessionId) {
    return selectedSessionId;
  }

  if (currentSessionId && currentSessionId.startsWith('new-session-')) {
    return currentSessionId;
  }

  return null;
}

function isTransientClaudeStatus(
  status: { text?: string; can_interrupt?: boolean } | null | undefined,
) {
  if (!status) {
    return false;
  }

  const normalizedStatusText = status.text?.trim().toLowerCase().replace(/[.]+$/u, '') || '';
  return normalizedStatusText === 'processing' || normalizedStatusText === 'working';
}

function resolvePendingViewStartedAt(
  pendingViewSession: PendingViewSession | null,
  viewScopedSessionId: string | null,
) {
  if (!pendingViewSession || !viewScopedSessionId || pendingViewSession.sessionId !== viewScopedSessionId) {
    return null;
  }

  return normalizeStartedAt(pendingViewSession.startedAt);
}

function sanitizeStartedAtCandidate(
  candidate: number | null,
  latestUserMessageStartedAt: number | null,
) {
  if (candidate === null) {
    return null;
  }

  if (
    latestUserMessageStartedAt !== null &&
    candidate + STARTED_AT_STALE_TOLERANCE_MS < latestUserMessageStartedAt
  ) {
    return null;
  }

  return candidate;
}

function createSessionViewRuntimeTarget(
  projectName: string | null | undefined,
  sessionId: string | null,
  provider: Provider | null | undefined,
): SessionViewTarget {
  return {
    projectName: projectName ?? null,
    sessionId,
    provider: sessionId ? provider ?? null : null,
  };
}

function hasMeaningfulTokenBudget(
  tokenBudget: Record<string, unknown> | null | undefined,
): tokenBudget is Record<string, unknown> {
  if (!tokenBudget || typeof tokenBudget !== 'object') {
    return false;
  }

  const used = tokenBudget.used;
  const total = tokenBudget.total;
  return (
    (typeof used === 'number' && Number.isFinite(used) && used >= 0) ||
    (typeof total === 'number' && Number.isFinite(total) && total > 0)
  );
}

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onCreateOptimisticSession,
  onReplaceOptimisticSession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  getSessionViewChatRuntimeForTarget,
  updateSessionViewChatRuntimeForTarget,
  isChatTabActive,
  hasUnreadSelectedSession,
  onAcknowledgeUnreadSession,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');

  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const activeViewSessionKeyRef = useRef<string | null>(null);
  const previousViewSessionKeyRef = useRef<string | null>(null);
  const statusViewSessionKeyRef = useRef<string | null>(null);
  const wasDocumentHiddenRef = useRef(false);
  const lastForegroundSyncAtRef = useRef(0);
  const lastPersistedRuntimeViewKeyRef = useRef<string | null>(null);
  const stableTokenBudgetRef = useRef<ViewScopedTokenBudgetState>({
    viewKey: '',
    tokenBudget: null,
  });
  const lastUnreadAcknowledgeKeyRef = useRef<string | null>(null);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [hasWindowFocus, setHasWindowFocus] = useState(
    () => typeof document === 'undefined' || document.hasFocus(),
  );
  const pendingSessionId =
    typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
  const initialPendingViewSessionId = resolvePendingViewSessionId(
    pendingViewSessionRef.current,
    pendingSessionId,
  );
  const runtimeScopedSessionId = selectedSession?.id ?? initialPendingViewSessionId;
  const runtimeScopedSessionTarget = useMemo(
    () =>
      createSessionViewRuntimeTarget(
        selectedProject?.name,
        runtimeScopedSessionId,
        selectedSession?.__provider ?? null,
      ),
    [runtimeScopedSessionId, selectedProject?.name, selectedSession?.__provider],
  );
  const runtimeSnapshot = getSessionViewChatRuntimeForTarget(runtimeScopedSessionTarget);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    codexReasoningEffort,
    setCodexReasoningEffort,
    geminiModel,
    setGeminiModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({
    selectedProject,
    selectedSession,
    runtimeSnapshot,
  });

  const {
    chatMessages,
    setChatMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    sessionMessages,
    setSessionMessages,
    isSwitchingSessionView,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isSystemSessionChange,
    setIsSystemSessionChange,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    refreshTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    scrollToPreviousUserMessage,
    scrollToNextUserMessage,
    handleScroll,
    loadSessionMessages,
    loadCursorSessionMessages,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    resetStreamingState,
    pendingViewSessionRef,
    runtimeSnapshot,
  });

  const {
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
    filteredFiles,
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
    openAttachmentPicker,
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
  } = useChatComposerState({
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
  });

  // On WebSocket reconnect, re-fetch the current session's messages from JSONL so missed
  // streaming events (e.g. from long tool calls while iOS had the tab backgrounded) are shown.
  // Also reset isLoading — if the server restarted or the session died mid-stream, the client
  // would be stuck in "Processing..." forever without this reset.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;

    const sessionProvider = selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');

    if (sessionProvider === 'cursor') {
      const projectPath = selectedProject.fullPath || selectedProject.path || '';
      const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
      if (converted.length > 0) {
        setSessionMessages([]);
        setChatMessages(converted);
      }
    } else {
      const messages = await loadSessionMessages(
        selectedProject.name,
        selectedSession.id,
        false,
        sessionProvider,
      );

      if (messages && messages.length > 0) {
        // Reconnect returns provider-specific raw session history. Convert it before
        // hydrating chatMessages, otherwise the UI receives nested backend payloads
        // and renders empty assistant rows (only the provider icon remains visible).
        setSessionMessages(messages);
        setChatMessages(convertSessionMessages(messages));
      }
    }

    // Reset loading state — if the session is still active, new WebSocket messages will
    // set it back to true. If it died, this clears the permanent frozen state.
    setIsLoading(false);
    setCanAbortSession(false);
    setClaudeStatus(null);
  }, [
    selectedProject,
    selectedSession,
    loadCursorSessionMessages,
    loadSessionMessages,
    setSessionMessages,
    setChatMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
  ]);

  const handleForegroundSync = useCallback(() => {
    if (!selectedProject || !selectedSession) {
      return;
    }

    const provider = selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');
    const isTemporaryCodexSession =
      provider === 'codex' && selectedSession.id.startsWith('new-session-');

    if (isTemporaryCodexSession) {
      return;
    }

    const now = Date.now();
    if (now - lastForegroundSyncAtRef.current < 800) {
      return;
    }

    lastForegroundSyncAtRef.current = now;
    void handleWebSocketReconnect();
    sendMessage({
      type: 'check-session-status',
      sessionId: selectedSession.id,
      provider,
    });
  }, [handleWebSocketReconnect, selectedProject, selectedSession, sendMessage]);

  const reloadSessionHistory = useCallback(
    async (targetSessionId: string, providerOverride: Provider | string = provider) => {
      if (!selectedProject || !targetSessionId) {
        return;
      }

      if (providerOverride === 'cursor') {
        const projectPath = selectedProject.fullPath || selectedProject.path || '';
        const converted = await loadCursorSessionMessages(projectPath, targetSessionId);
        setSessionMessages([]);
        setChatMessages(converted);
        return;
      }

      const messages = await loadSessionMessages(
        selectedProject.name,
        targetSessionId,
        false,
        providerOverride,
      );
      setSessionMessages(messages);
    },
    [loadCursorSessionMessages, loadSessionMessages, provider, selectedProject, setChatMessages, setSessionMessages],
  );

  const activePendingViewSessionId = resolvePendingViewSessionId(
    pendingViewSessionRef.current,
    pendingSessionId,
  );
  const hasPendingTemplateSessionBinding = hasPendingTemplateSession(
    pendingViewSessionRef.current,
    pendingSessionId,
  );
  const viewScopedSessionId = resolveViewScopedSessionId(
    selectedSession,
    currentSessionId,
    activePendingViewSessionId,
  );
  const activeViewSessionTarget = useMemo(
    () =>
      createSessionViewRuntimeTarget(
        selectedProject?.name,
        viewScopedSessionId,
        selectedSession?.__provider ?? provider,
      ),
    [provider, selectedProject?.name, selectedSession?.__provider, viewScopedSessionId],
  );
  const activeSessionViewChatRuntime = getSessionViewChatRuntimeForTarget(activeViewSessionTarget);
  const activeViewSessionKey = [
    selectedProject?.name ?? 'no-project',
    viewScopedSessionId ?? 'no-session',
    selectedSession?.__provider ?? provider,
  ].join(':');
  const liveTokenBudget = hasMeaningfulTokenBudget(tokenBudget) ? tokenBudget : null;
  const runtimeTokenBudget = hasMeaningfulTokenBudget(activeSessionViewChatRuntime.tokenBudget)
    ? activeSessionViewChatRuntime.tokenBudget
    : null;

  if (stableTokenBudgetRef.current.viewKey !== activeViewSessionKey) {
    stableTokenBudgetRef.current = {
      viewKey: activeViewSessionKey,
      tokenBudget: liveTokenBudget ?? runtimeTokenBudget ?? null,
    };
  }

  const stableTokenBudget =
    stableTokenBudgetRef.current.viewKey === activeViewSessionKey
      ? stableTokenBudgetRef.current.tokenBudget
      : null;
  const isTemplatePageWithoutPendingSession =
    !selectedSession?.id &&
    !hasPendingTemplateSessionBinding &&
    !(currentSessionId && currentSessionId.startsWith('new-session-'));
  const shouldRenderTemplatePageSurface =
    isSwitchingSessionView || isTemplatePageWithoutPendingSession;
  const normalizedClaudeStatus =
    !isLoading &&
    !canAbortSession &&
    pendingPermissionRequests.length === 0 &&
    isTransientClaudeStatus(claudeStatus)
      ? null
      : claudeStatus;
  const displayedChatMessages = shouldRenderTemplatePageSurface ? [] : chatMessages;
  const displayedVisibleMessages = shouldRenderTemplatePageSurface ? [] : visibleMessages;
  const displayedSessionMessagesCount = shouldRenderTemplatePageSurface ? 0 : sessionMessages.length;
  const displayedIsLoading = shouldRenderTemplatePageSurface ? false : isLoading;
  const displayedClaudeStatus = shouldRenderTemplatePageSurface ? null : normalizedClaudeStatus;
  const displayedPendingPermissionRequests = shouldRenderTemplatePageSurface
    ? []
    : pendingPermissionRequests;
  const displayedTokenBudget = shouldRenderTemplatePageSurface
    ? null
    : liveTokenBudget ?? runtimeTokenBudget ?? stableTokenBudget;
  const displayedHasMessages = displayedChatMessages.length > 0;
  const chatPaneKey = [
    selectedProject?.name ?? 'no-project',
    viewScopedSessionId ?? 'no-session',
    selectedSession?.__provider ?? provider,
  ].join(':');
  const latestUserMessageStartedAt = findLatestUserMessageStartedAt(displayedChatMessages);
  const runtimeStartedAt = sanitizeStartedAtCandidate(
    normalizeStartedAt(activeSessionViewChatRuntime.startedAt),
    latestUserMessageStartedAt,
  );
  const pendingViewStartedAt = sanitizeStartedAtCandidate(
    resolvePendingViewStartedAt(pendingViewSessionRef.current, viewScopedSessionId),
    latestUserMessageStartedAt,
  );
  const [statusStartedAtState, setStatusStartedAtState] = useState<ViewScopedStartedAtState>(
    () => ({
      viewKey: activeViewSessionKey,
      startedAt: runtimeStartedAt,
    }),
  );
  const setStatusStartedAt = useCallback<Dispatch<SetStateAction<number | null>>>((nextStartedAt) => {
    setStatusStartedAtState((previousState) => {
      const currentViewKey = activeViewSessionKeyRef.current ?? activeViewSessionKey;
      const previousStartedAt =
        previousState.viewKey === currentViewKey ? previousState.startedAt : null;
      const resolvedStartedAt =
        typeof nextStartedAt === 'function'
          ? nextStartedAt(previousStartedAt)
          : nextStartedAt;

      return {
        viewKey: currentViewKey,
        startedAt: normalizeStartedAt(resolvedStartedAt),
      };
    });
  }, [activeViewSessionKey]);
  const statusStartedAt =
    statusStartedAtState.viewKey === activeViewSessionKey ? statusStartedAtState.startedAt : null;
  const canUseLatestUserMessageStartedAt = statusViewSessionKeyRef.current === activeViewSessionKey;
  const resolvedStatusStartedAt =
    statusStartedAt ??
    runtimeStartedAt ??
    pendingViewStartedAt ??
    (canUseLatestUserMessageStartedAt ? latestUserMessageStartedAt : null);
  const displayedStatusStartedAt = shouldRenderTemplatePageSurface
    ? null
    : resolvedStatusStartedAt;

  useEffect(() => {
    activeViewSessionKeyRef.current = activeViewSessionKey;
  }, [activeViewSessionKey]);

  useLayoutEffect(() => {
    if (statusStartedAtState.viewKey === activeViewSessionKey) {
      return;
    }

    setStatusStartedAtState({
      viewKey: activeViewSessionKey,
      startedAt: runtimeStartedAt ?? pendingViewStartedAt,
    });
  }, [
    activeViewSessionKey,
    pendingViewStartedAt,
    runtimeStartedAt,
    statusStartedAtState.viewKey,
  ]);

  useLayoutEffect(() => {
    if (
      previousViewSessionKeyRef.current &&
      previousViewSessionKeyRef.current !== activeViewSessionKey &&
      !isSystemSessionChange
    ) {
      resetStreamingState();
    }

    previousViewSessionKeyRef.current = activeViewSessionKey;
  }, [activeViewSessionKey, isSystemSessionChange, resetStreamingState]);

  useEffect(() => {
    const isSessionChanged = statusViewSessionKeyRef.current !== activeViewSessionKey;
    statusViewSessionKeyRef.current = activeViewSessionKey;

    if (!isLoading) {
      setStatusStartedAt(null);
      return;
    }

    const nextStartedAtCandidates = [
      runtimeStartedAt,
      pendingViewStartedAt,
      ...(isSessionChanged ? [] : [latestUserMessageStartedAt]),
    ].filter((candidate): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate));
    const nextStartedAt =
      nextStartedAtCandidates.length > 0 ? Math.min(...nextStartedAtCandidates) : null;

    setStatusStartedAt((previousStartedAt) => {
      if (isSessionChanged) {
        return nextStartedAt;
      }

      if (nextStartedAt !== null) {
        if (previousStartedAt === null) {
          return nextStartedAt;
        }

        return Math.min(previousStartedAt, nextStartedAt);
      }

      return previousStartedAt;
    });
  }, [
    activeViewSessionKey,
    isLoading,
    latestUserMessageStartedAt,
    pendingViewStartedAt,
    runtimeStartedAt,
  ]);

  useEffect(() => {
    if (shouldRenderTemplatePageSurface) {
      return;
    }

    if (liveTokenBudget || runtimeTokenBudget) {
      stableTokenBudgetRef.current = {
        viewKey: activeViewSessionKey,
        tokenBudget: liveTokenBudget ?? runtimeTokenBudget,
      };
    }
  }, [
    activeViewSessionKey,
    liveTokenBudget,
    runtimeTokenBudget,
    shouldRenderTemplatePageSurface,
  ]);

  useEffect(() => {
    if (shouldRenderTemplatePageSurface) {
      return;
    }

    if (lastPersistedRuntimeViewKeyRef.current !== activeViewSessionKey) {
      lastPersistedRuntimeViewKeyRef.current = activeViewSessionKey;
      return;
    }

    updateSessionViewChatRuntimeForTarget(activeViewSessionTarget, {
      isLoading,
      canAbortSession,
      claudeStatus: normalizedClaudeStatus,
      tokenBudget: displayedTokenBudget,
      pendingPermissionRequests: pendingPermissionRequests.map((request) => ({
        requestId: request.requestId,
        toolName: request.toolName,
        input: request.input,
        context: request.context,
        sessionId: request.sessionId ?? null,
        receivedAt: request.receivedAt,
      })),
      startedAt: resolvedStatusStartedAt,
      updatedAt: Date.now(),
    });
  }, [
    activeViewSessionTarget,
    canAbortSession,
    activeViewSessionKey,
    isLoading,
    normalizedClaudeStatus,
    pendingPermissionRequests,
    resolvedStatusStartedAt,
    shouldRenderTemplatePageSurface,
    displayedTokenBudget,
    updateSessionViewChatRuntimeForTarget,
  ]);

  useChatRealtimeHandlers({
    latestMessage,
    provider,
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setChatMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    refreshTokenBudget,
    setIsSystemSessionChange,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamBufferRef,
    streamTimerRef,
    setStatusStartedAt,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onReplaceOptimisticSession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    reloadSessionHistory,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    setIsDocumentVisible(document.visibilityState === 'visible');
    setHasWindowFocus(document.hasFocus());

    const syncIfNeeded = () => {
      if (!wasDocumentHiddenRef.current) {
        return;
      }

      wasDocumentHiddenRef.current = false;
      handleForegroundSync();
    };

    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';
      setIsDocumentVisible(isVisible);

      if (document.visibilityState === 'hidden') {
        wasDocumentHiddenRef.current = true;
        return;
      }

      if (document.visibilityState === 'visible') {
        syncIfNeeded();
      }
    };

    const handlePageHide = () => {
      wasDocumentHiddenRef.current = true;
      setHasWindowFocus(false);
    };

    const handleFocus = () => {
      setHasWindowFocus(true);
      syncIfNeeded();
    };

    const handleBlur = () => {
      setHasWindowFocus(false);
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        wasDocumentHiddenRef.current = true;
      }
      setIsDocumentVisible(document.visibilityState === 'visible');
      setHasWindowFocus(document.hasFocus());
      syncIfNeeded();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [handleForegroundSync]);

  useEffect(() => {
    if (!hasUnreadSelectedSession) {
      lastUnreadAcknowledgeKeyRef.current = null;
    }
  }, [hasUnreadSelectedSession, selectedSession?.__provider, selectedSession?.id]);

  useEffect(() => {
    if (
      !selectedSession?.id ||
      !hasUnreadSelectedSession ||
      !onAcknowledgeUnreadSession ||
      !isChatTabActive ||
      shouldRenderTemplatePageSurface ||
      isSwitchingSessionView ||
      isLoadingSessionMessages ||
      displayedIsLoading ||
      !isDocumentVisible ||
      !hasWindowFocus ||
      viewScopedSessionId !== selectedSession.id ||
      (!displayedSessionMessagesCount && displayedChatMessages.length === 0) ||
      typeof window === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return;
    }

    const providerForAcknowledge = (selectedSession.__provider || provider) as Provider;
    const nextAcknowledgeKey = [
      activeViewSessionKey,
      displayedSessionMessagesCount,
      displayedChatMessages.length,
    ].join(':');

    if (lastUnreadAcknowledgeKeyRef.current === nextAcknowledgeKey) {
      return;
    }

    let secondaryFrameId: number | null = null;
    const frameId = window.requestAnimationFrame(() => {
      secondaryFrameId = window.requestAnimationFrame(() => {
        if (document.visibilityState !== 'visible' || !document.hasFocus()) {
          return;
        }

        lastUnreadAcknowledgeKeyRef.current = nextAcknowledgeKey;
        void Promise.resolve(
          onAcknowledgeUnreadSession(selectedSession.id, providerForAcknowledge ?? null),
        ).catch((error) => {
          console.error('[ChatInterface] Failed to acknowledge unread session:', error);
          if (lastUnreadAcknowledgeKeyRef.current === nextAcknowledgeKey) {
            lastUnreadAcknowledgeKeyRef.current = null;
          }
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (secondaryFrameId !== null) {
        window.cancelAnimationFrame(secondaryFrameId);
      }
    };
  }, [
    activeViewSessionKey,
    displayedChatMessages.length,
    displayedIsLoading,
    displayedSessionMessagesCount,
    hasUnreadSelectedSession,
    hasWindowFocus,
    isChatTabActive,
    isDocumentVisible,
    isLoadingSessionMessages,
    isSwitchingSessionView,
    onAcknowledgeUnreadSession,
    provider,
    selectedSession?.__provider,
    selectedSession?.id,
    shouldRenderTemplatePageSurface,
    viewScopedSessionId,
  ]);

  if (!selectedProject) {
    const selectedProviderLabel = IS_CODEX_ONLY_HARDENED ? t('messageTypes.codex') : (
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'gemini'
            ? t('messageTypes.gemini')
            : t('messageTypes.claude')
    );

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <ChatMessagesPane
          key={chatPaneKey}
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={displayedChatMessages}
          selectedSession={selectedSession}
          currentSessionId={viewScopedSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={displayedSessionMessagesCount}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={displayedVisibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          onRemoveQueuedMessage={handleRemoveQueuedCodexFollowUp}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          isLoading={displayedIsLoading}
        />

        <ChatComposer
          pendingPermissionRequests={displayedPendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={displayedClaudeStatus}
          statusStartedAt={displayedStatusStartedAt}
          queuedCodexFollowUpCount={queuedCodexFollowUpCount}
          isLoading={displayedIsLoading}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          codexReasoningEffort={codexReasoningEffort}
          setCodexReasoningEffort={setCodexReasoningEffort}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          tokenBudget={displayedTokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim()) || attachedImages.length > 0 || attachedFiles.length > 0}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={displayedHasMessages}
          onScrollToBottom={scrollToBottomAndReset}
          onScrollToPreviousUserMessage={scrollToPreviousUserMessage}
          onScrollToNextUserMessage={scrollToNextUserMessage}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          attachedFiles={attachedFiles}
          onRemoveFile={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          isInputFocused={isInputFocused}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'gemini'
                    ? t('messageTypes.gemini')
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          onTranscript={handleTranscript}
        />
      </div>

      {!IS_CODEX_ONLY_HARDENED && <QuickSettingsPanel />}
    </>
  );
}

export default React.memo(ChatInterface);

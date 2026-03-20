import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { api, authenticatedFetch } from '../../../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import type { ChatMessage, Provider } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import {
  getChatMessageCacheKey,
  getChatScrollStorageKey,
  safeLocalStorage,
  type ChatScrollSnapshot,
} from '../utils/chatStorage';
import {
  convertCursorSessionMessages,
  convertSessionMessages,
  createCachedDiffCalculator,
  type DiffCalculator,
} from '../utils/messageTransforms';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;
const TEMPORARY_CODEX_SESSION_PREFIX = 'codex-';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  selectedSessionHasUnread?: boolean;
  processingSessions?: Set<string>;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
}

interface ScrollRestoreState {
  height: number;
  top: number;
}

const CHAT_SCROLL_DEBUG_STORAGE_KEY = 'chat-scroll-debug';
const CHAT_SCROLL_DEBUG_QUERY_KEY = 'chatScrollDebug';
const CHAT_SCROLL_DEBUG_MAX_ENTRIES = 400;

type ChatScrollDebugWindow = Window & {
  __CHAT_SCROLL_DEBUG_LOGS__?: Record<string, unknown>[];
  __CHAT_SCROLL_DEBUG_LAST__?: Record<string, unknown>;
};

type ProgrammaticScrollMutation = {
  source: string;
  at: number;
  requestedTop?: number;
  details?: Record<string, unknown>;
};

const isChatScrollDebugEnabled = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const isLocalDebugHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
  return (
    import.meta.env.DEV ||
    isLocalDebugHost ||
    params.get(CHAT_SCROLL_DEBUG_QUERY_KEY) === '1' ||
    safeLocalStorage.getItem(CHAT_SCROLL_DEBUG_STORAGE_KEY) === '1'
  );
};

const appendChatScrollDebugLog = (entry: Record<string, unknown>) => {
  if (typeof window === 'undefined') {
    return;
  }

  const debugWindow = window as ChatScrollDebugWindow;
  const nextEntries = [...(debugWindow.__CHAT_SCROLL_DEBUG_LOGS__ || []), entry].slice(-CHAT_SCROLL_DEBUG_MAX_ENTRIES);
  debugWindow.__CHAT_SCROLL_DEBUG_LOGS__ = nextEntries;
  debugWindow.__CHAT_SCROLL_DEBUG_LAST__ = entry;
  console.debug('[chat-scroll]', entry);
};

const getSessionStorageIdentity = (
  project: Project | null,
  session: ProjectSession | null,
  providerOverride?: Provider | string | null,
) => {
  const provider =
    providerOverride ||
    session?.__provider ||
    (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');

  return {
    projectName: project?.name ?? null,
    sessionId: session?.id ?? null,
    provider,
  };
};

const readCachedChatMessages = (
  project: Project | null,
  session: ProjectSession | null,
  providerOverride?: Provider | string | null,
): ChatMessage[] => {
  const storageKey = getChatMessageCacheKey(getSessionStorageIdentity(project, session, providerOverride));
  if (!storageKey) {
    return [];
  }

  const saved = safeLocalStorage.getItem(storageKey);
  if (!saved) {
    return [];
  }

  try {
    return JSON.parse(saved) as ChatMessage[];
  } catch (error) {
    console.error('Failed to parse cached chat messages, resetting cache:', error);
    safeLocalStorage.removeItem(storageKey);
    return [];
  }
};

const readSavedScrollSnapshot = (
  project: Project | null,
  session: ProjectSession | null,
  providerOverride?: Provider | string | null,
): ChatScrollSnapshot | null => {
  const storageKey = getChatScrollStorageKey(getSessionStorageIdentity(project, session, providerOverride));
  if (!storageKey) {
    return null;
  }

  const saved = safeLocalStorage.getItem(storageKey);
  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as ChatScrollSnapshot;
    if (!Number.isFinite(parsed.top) || parsed.top < 0) {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to parse saved chat scroll snapshot:', error);
    safeLocalStorage.removeItem(storageKey);
    return null;
  }
};

export function useChatSessionState({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  autoScrollToBottom,
  externalMessageUpdate,
  selectedSessionHasUnread,
  processingSessions,
  resetStreamingState,
  pendingViewSessionRef,
}: UseChatSessionStateArgs) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== 'undefined') {
      return readCachedChatMessages(selectedProject, selectedSession);
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isSystemSessionChange, setIsSystemSessionChange] = useState(false);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [claudeStatus, setClaudeStatus] = useState<{ text: string; tokens: number; can_interrupt: boolean } | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  const scrollDebugTraceIdRef = useRef(`scroll-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const lastProgrammaticScrollRef = useRef<ProgrammaticScrollMutation | null>(null);
  const lastObservedScrollTopRef = useRef<number | null>(null);
  const lastMeasuredContainerRef = useRef<{ clientHeight: number; scrollHeight: number }>({
    clientHeight: 0,
    scrollHeight: 0,
  });

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);
  const selectedProjectName = selectedProject?.name ?? null;
  const selectedProjectPath = selectedProject?.fullPath || selectedProject?.path || '';
  const selectedSessionId = selectedSession?.id ?? null;
  const selectedSessionProvider = (selectedSession?.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;

  const logScrollDebug = useCallback(
    (event: string, payload: Record<string, unknown> = {}) => {
      if (!isChatScrollDebugEnabled()) {
        return;
      }

      const container = scrollContainerRef.current;
      appendChatScrollDebugLog({
        event,
        traceId: scrollDebugTraceIdRef.current,
        timestamp: new Date().toISOString(),
        projectName: selectedProject?.name ?? null,
        sessionId: selectedSession?.id ?? currentSessionId ?? null,
        provider: selectedSession?.__provider ?? null,
        chatMessagesLength: chatMessages.length,
        visibleMessageCount,
        isLoading,
        isUserScrolledUp,
        autoScrollToBottom: Boolean(autoScrollToBottom),
        scrollTop: container?.scrollTop ?? null,
        scrollHeight: container?.scrollHeight ?? null,
        clientHeight: container?.clientHeight ?? null,
        ...payload,
      });
    },
    [
      autoScrollToBottom,
      chatMessages.length,
      currentSessionId,
      isLoading,
      isUserScrolledUp,
      selectedProject?.name,
      selectedSession?.__provider,
      selectedSession?.id,
      visibleMessageCount,
    ],
  );

  const markProgrammaticScrollIntent = useCallback(
    (source: string, details: Record<string, unknown> = {}) => {
      lastProgrammaticScrollRef.current = {
        source,
        at: Date.now(),
        details,
      };
      logScrollDebug('scroll-intent', {
        source,
        ...details,
      });
    },
    [logScrollDebug],
  );

  const setScrollTopWithDebug = useCallback(
    (source: string, nextTop: number, details: Record<string, unknown> = {}) => {
      const container = scrollContainerRef.current;
      if (!container) {
        return false;
      }

      const requestedTop = Math.max(nextTop, 0);
      const previousTop = container.scrollTop;

      lastProgrammaticScrollRef.current = {
        source,
        at: Date.now(),
        requestedTop,
        details,
      };

      logScrollDebug('scroll-set', {
        source,
        previousTop,
        requestedTop,
        ...details,
      });

      container.scrollTop = requestedTop;
      lastObservedScrollTopRef.current = container.scrollTop;

      window.requestAnimationFrame(() => {
        const activeContainer = scrollContainerRef.current;
        if (!activeContainer) {
          return;
        }

        logScrollDebug('scroll-settled', {
          source,
          previousTop,
          requestedTop,
          actualTop: activeContainer.scrollTop,
          ...details,
        });
      });

      return true;
    },
    [logScrollDebug],
  );

  const refreshTokenBudget = useCallback(
    async (
      sessionIdOverride?: string | null,
      providerOverride?: Provider | string,
    ) => {
      const targetSessionId = sessionIdOverride || selectedSession?.id || null;
      if (
        !selectedProject ||
        !targetSessionId ||
        targetSessionId.startsWith('new-session-')
      ) {
        setTokenBudget(null);
        return;
      }

      try {
        const sessionProvider =
          providerOverride ||
          selectedSession?.__provider ||
          (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');
        const isTemporaryCodexSession =
          sessionProvider === 'codex' &&
          targetSessionId.startsWith(TEMPORARY_CODEX_SESSION_PREFIX);

        if (isTemporaryCodexSession) {
          return;
        }

        const params = new URLSearchParams({ provider: sessionProvider });
        const url = `/api/projects/${selectedProject.name}/sessions/${targetSessionId}/token-usage?${params.toString()}`;
        const response = await authenticatedFetch(url);

        if (!response.ok) {
          setTokenBudget(null);
          return;
        }

        const data = await response.json();
        setTokenBudget(data);
      } catch (error) {
        console.error('Failed to fetch token usage:', error);
      }
    },
    [selectedProject, selectedSession?.id, selectedSession?.__provider],
  );

  const loadSessionMessages = useCallback(
    async (projectName: string, sessionId: string, loadMore = false, provider: Provider | string = 'claude') => {
      if (!projectName || !sessionId) {
        return [] as any[];
      }

      const isInitialLoad = !loadMore;
      if (isInitialLoad) {
        setIsLoadingSessionMessages(true);
      } else {
        setIsLoadingMoreMessages(true);
      }

      try {
        const currentOffset = loadMore ? messagesOffsetRef.current : 0;
        const response = await (api.sessionMessages as any)(
          projectName,
          sessionId,
          MESSAGES_PER_PAGE,
          currentOffset,
          provider,
        );
        if (!response.ok) {
          throw new Error('Failed to load session messages');
        }

        const data = await response.json();
        if (isInitialLoad && data.tokenUsage) {
          setTokenBudget(data.tokenUsage);
        }

        if (data.hasMore !== undefined) {
          const loadedCount = data.messages?.length || 0;
          setHasMoreMessages(Boolean(data.hasMore));
          setTotalMessages(Number(data.total || 0));
          messagesOffsetRef.current = currentOffset + loadedCount;
          return data.messages || [];
        }

        const messages = data.messages || [];
        setHasMoreMessages(false);
        setTotalMessages(messages.length);
        messagesOffsetRef.current = messages.length;
        return messages;
      } catch (error) {
        console.error('Error loading session messages:', error);
        return [];
      } finally {
        if (isInitialLoad) {
          setIsLoadingSessionMessages(false);
        } else {
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [],
  );

  const loadCursorSessionMessages = useCallback(async (projectPath: string, sessionId: string) => {
    if (!projectPath || !sessionId) {
      return [] as ChatMessage[];
    }

    setIsLoadingSessionMessages(true);
    try {
      const url = `/api/cursor/sessions/${encodeURIComponent(sessionId)}?projectPath=${encodeURIComponent(projectPath)}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const blobs = (data?.session?.messages || []) as any[];
      return convertCursorSessionMessages(blobs, projectPath);
    } catch (error) {
      console.error('Error loading Cursor session messages:', error);
      return [];
    } finally {
      setIsLoadingSessionMessages(false);
    }
  }, []);

  const convertedMessages = useMemo(() => {
    return convertSessionMessages(sessionMessages);
  }, [sessionMessages]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    setScrollTopWithDebug('scrollToBottom', container.scrollHeight, {
      reason: 'scroll-to-bottom',
    });
  }, [setScrollTopWithDebug]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const persistScrollPosition = useCallback(
    (
      projectOverride: Project | null = selectedProject,
      sessionOverride: ProjectSession | null = selectedSession,
      providerOverride?: Provider | string | null,
    ) => {
      const container = scrollContainerRef.current;
      if (!container || !projectOverride || !sessionOverride) {
        return;
      }

      const storageKey = getChatScrollStorageKey(
        getSessionStorageIdentity(projectOverride, sessionOverride, providerOverride),
      );

      if (!storageKey) {
        return;
      }

      const snapshot: ChatScrollSnapshot = {
        top: Math.max(container.scrollTop, 0),
        updatedAt: Date.now(),
      };

      safeLocalStorage.setItem(storageKey, JSON.stringify(snapshot));
    },
    [selectedProject, selectedSession],
  );

  const restoreScrollPosition = useCallback(() => {
    if (!selectedProject || !selectedSession || !scrollContainerRef.current) {
      return false;
    }

    const snapshot = readSavedScrollSnapshot(selectedProject, selectedSession);
    if (!snapshot) {
      return false;
    }

    return setScrollTopWithDebug('restoreScrollPosition', snapshot.top, {
      snapshotUpdatedAt: snapshot.updatedAt,
    });
  }, [selectedProject, selectedSession, setScrollTopWithDebug]);

  const scrollToLatestUserMessage = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }

    const userMessages = Array.from(
      container.querySelectorAll<HTMLElement>('[data-message-type="user"]'),
    );

    const latestUserMessage = userMessages[userMessages.length - 1];
    if (!latestUserMessage) {
      return false;
    }

    setScrollTopWithDebug('scrollToLatestUserMessage', Math.max(latestUserMessage.offsetTop - 24, 0), {
      latestUserMessageOffsetTop: latestUserMessage.offsetTop,
    });
    const previousOutline = latestUserMessage.style.outline;
    const previousOutlineOffset = latestUserMessage.style.outlineOffset;
    latestUserMessage.style.outline = '2px solid rgba(59, 130, 246, 0.25)';
    latestUserMessage.style.outlineOffset = '4px';
    window.setTimeout(() => {
      latestUserMessage.style.outline = previousOutline;
      latestUserMessage.style.outlineOffset = previousOutlineOffset;
    }, 1600);

    return true;
  }, [setScrollTopWithDebug]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) {
        return false;
      }
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) {
        return false;
      }

      const sessionProvider = selectedSession.__provider || 'claude';
      if (sessionProvider === 'cursor') {
        return false;
      }

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const moreMessages = await loadSessionMessages(
          selectedProject.name,
          selectedSession.id,
          true,
          sessionProvider,
        );

        if (moreMessages.length === 0) {
          return false;
        }

        pendingScrollRestoreRef.current = {
          height: previousScrollHeight,
          top: previousScrollTop,
        };
        setSessionMessages((previous) => [...moreMessages, ...previous]);
        // Keep the rendered window in sync with top-pagination so newly loaded history becomes visible.
        setVisibleMessageCount((previousCount) => previousCount + moreMessages.length);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, loadSessionMessages, selectedProject, selectedSession],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nearBottom = isNearBottom();
    const previousTop = lastObservedScrollTopRef.current;
    const currentTop = container.scrollTop;
    const delta = previousTop === null ? 0 : currentTop - previousTop;
    const activeMutation = lastProgrammaticScrollRef.current;
    const likelySource =
      activeMutation && Date.now() - activeMutation.at < 600
        ? activeMutation.source
        : 'user-or-layout';
    const scrolledNearTop = container.scrollTop < 100;

    if (likelySource !== 'user-or-layout' || Math.abs(delta) >= 48 || scrolledNearTop) {
      logScrollDebug('scroll-event', {
        likelySource,
        delta,
        nearBottom,
        nearTop: scrolledNearTop,
        mutationAgeMs: activeMutation ? Date.now() - activeMutation.at : null,
      });
    }

    lastObservedScrollTopRef.current = currentTop;
    setIsUserScrolledUp(!nearBottom);
    persistScrollPosition();

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) {
        topLoadLockRef.current = false;
        return;
      }

      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) {
          topLoadLockRef.current = false;
        }
        return;
      }

      const didLoad = await loadOlderMessages(container);
      if (didLoad) {
        topLoadLockRef.current = true;
      }
    }
  }, [isNearBottom, loadOlderMessages, logScrollDebug, persistScrollPosition]);

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) {
      return;
    }

    const { height, top } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const newScrollHeight = container.scrollHeight;
    const scrollDiff = newScrollHeight - height;
    setScrollTopWithDebug('pendingScrollRestore', top + Math.max(scrollDiff, 0), {
      previousHeight: height,
      previousTop: top,
      newScrollHeight,
      scrollDiff,
    });
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length, setScrollTopWithDebug]);

  const prevSessionMessagesLengthRef = useRef(0);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      pendingInitialScrollRef.current = true;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    prevSessionMessagesLengthRef.current = 0;
    isInitialLoadRef.current = true;
    setIsUserScrolledUp(false);
  }, [selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    return () => {
      persistScrollPosition();
    };
  }, [persistScrollPosition]);

  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) {
      return;
    }

    if (chatMessages.length === 0) {
      pendingInitialScrollRef.current = false;
      return;
    }

    pendingInitialScrollRef.current = false;
    if (!searchScrollActiveRef.current) {
      setTimeout(() => {
        if (selectedSessionHasUnread && scrollToLatestUserMessage()) {
          logScrollDebug('initial-scroll-branch', {
            branch: 'selectedSessionHasUnread',
          });
          persistScrollPosition();
          return;
        }

        if (restoreScrollPosition()) {
          logScrollDebug('initial-scroll-branch', {
            branch: 'restoreScrollPosition',
          });
          return;
        }

        logScrollDebug('initial-scroll-branch', {
          branch: 'scrollToBottom',
        });
        scrollToBottom();
        persistScrollPosition();
      }, 200);
    }
  }, [
    chatMessages.length,
    isLoadingSessionMessages,
    persistScrollPosition,
    restoreScrollPosition,
    scrollToBottom,
    scrollToLatestUserMessage,
    selectedSessionHasUnread,
    logScrollDebug,
  ]);

  useEffect(() => {
    const loadMessages = async () => {
      if (selectedSession && selectedProject && selectedSessionId && selectedProjectName) {
        const provider = selectedSessionProvider;
        const cachedMessages = readCachedChatMessages(selectedProject, selectedSession, provider);
        isLoadingSessionRef.current = true;

        const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
        if (sessionChanged) {
          if (!isSystemSessionChange) {
            resetStreamingState();
            pendingViewSessionRef.current = null;
            setChatMessages([]);
            setSessionMessages([]);
            setClaudeStatus(null);
            setCanAbortSession(false);
          }

          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);
          setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
          setAllMessagesLoaded(false);
          allMessagesLoadedRef.current = false;
          setIsLoadingAllMessages(false);
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
          if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
          setTokenBudget(null);
          setIsLoading(false);

          if (ws) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSessionId,
              provider,
            });
          }
        } else if (currentSessionId === null) {
          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);

          if (ws) {
            sendMessage({
              type: 'check-session-status',
              sessionId: selectedSessionId,
              provider,
            });
          }
        }

        const sessionKey = `${selectedSessionId}:${selectedProjectName}:${provider}`;
        const hasRenderableContent = cachedMessages.length > 0 || sessionMessages.length > 0 || chatMessages.length > 0;
        const isSameLoadedSession =
          lastLoadedSessionKeyRef.current === sessionKey &&
          currentSessionId === selectedSessionId;
        const shouldReuseLoadedSession = isSameLoadedSession && hasRenderableContent;
        const shouldHydrateCachedMessages =
          !isSystemSessionChange &&
          cachedMessages.length > 0 &&
          !isSameLoadedSession &&
          chatMessages.length === 0 &&
          sessionMessages.length === 0;

        logScrollDebug('load-session', {
          provider,
          sessionKey,
          cachedMessagesLength: cachedMessages.length,
          sessionMessagesLength: sessionMessages.length,
          renderableMessagesLength: chatMessages.length,
          isSameLoadedSession,
          shouldHydrateCachedMessages,
          shouldReuseLoadedSession,
          sessionChanged,
          isSystemSessionChange,
        });

        if (shouldHydrateCachedMessages) {
          setChatMessages(cachedMessages);
        }

        if (shouldReuseLoadedSession) {
          setTimeout(() => {
            isLoadingSessionRef.current = false;
          }, 250);
          return;
        }

        if (provider === 'cursor') {
          setCurrentSessionId(selectedSessionId);
          sessionStorage.setItem('cursorSessionId', selectedSessionId);

          if (!isSystemSessionChange) {
            const converted = await loadCursorSessionMessages(selectedProjectPath, selectedSessionId);
            setSessionMessages([]);
            setChatMessages(converted);
          } else {
            setIsSystemSessionChange(false);
          }
        } else {
          setCurrentSessionId(selectedSessionId);

          if (!isSystemSessionChange) {
            const messages = await loadSessionMessages(
              selectedProjectName,
              selectedSessionId,
              false,
              selectedSession.__provider || 'claude',
            );
            setSessionMessages(messages);
          } else {
            setIsSystemSessionChange(false);
          }
        }

        // Update the last loaded session key
        lastLoadedSessionKeyRef.current = sessionKey;
      } else {
        if (!isSystemSessionChange) {
          resetStreamingState();
          pendingViewSessionRef.current = null;
          setChatMessages([]);
          setSessionMessages([]);
          setClaudeStatus(null);
          setCanAbortSession(false);
          setIsLoading(false);
        }

        setCurrentSessionId(null);
        sessionStorage.removeItem('cursorSessionId');
        messagesOffsetRef.current = 0;
        setHasMoreMessages(false);
        setTotalMessages(0);
        setTokenBudget(null);
        lastLoadedSessionKeyRef.current = null;
      }

      setTimeout(() => {
        isLoadingSessionRef.current = false;
      }, 250);
    };

    loadMessages();
  }, [
    // Intentionally exclude currentSessionId: this effect sets it and should not retrigger another full load.
    isSystemSessionChange,
    loadCursorSessionMessages,
    loadSessionMessages,
    pendingViewSessionRef,
    resetStreamingState,
    selectedProjectName,
    selectedProjectPath,
    selectedSessionId,
    selectedSessionProvider,
    sendMessage,
    ws,
    logScrollDebug,
  ]);

  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) {
      return;
    }

    const reloadExternalMessages = async () => {
      try {
        const provider = (selectedSession.__provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude')) as Provider;

        if (provider === 'cursor') {
          const projectPath = selectedProject.fullPath || selectedProject.path || '';
          const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
          setSessionMessages([]);
          setChatMessages(converted);
          return;
        }

        const messages = await loadSessionMessages(
          selectedProject.name,
          selectedSession.id,
          false,
          selectedSession.__provider || 'claude',
        );
        setSessionMessages(messages);

        const shouldAutoScroll = Boolean(autoScrollToBottom) && isNearBottom();
        if (shouldAutoScroll) {
          setTimeout(() => {
            logScrollDebug('external-update-auto-scroll', {
              reason: 'externalMessageUpdate',
            });
            scrollToBottom();
          }, 200);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    externalMessageUpdate,
    isNearBottom,
    loadCursorSessionMessages,
    loadSessionMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    logScrollDebug,
  ]);

  // Detect search navigation target from selectedSession object reference change
  // This must be a separate effect because the loading effect depends on selectedSession?.id
  // which doesn't change when clicking a search result for the already-loaded session
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  useEffect(() => {
    if (selectedSession?.id) {
      pendingViewSessionRef.current = null;
    }
  }, [pendingViewSessionRef, selectedSession?.id]);

  useEffect(() => {
    // Only sync sessionMessages to chatMessages when:
    // 1. Not currently loading (to avoid overwriting user's just-sent message)
    // 2. SessionMessages actually changed (including from non-empty to empty)
    // 3. Either it's initial load OR sessionMessages increased (new messages from server)
    if (
      sessionMessages.length !== prevSessionMessagesLengthRef.current &&
      !isLoading
    ) {
      // Only update if this is initial load, sessionMessages grew, or was cleared to empty
      if (isInitialLoadRef.current || sessionMessages.length === 0 || sessionMessages.length > prevSessionMessagesLengthRef.current) {
        setChatMessages(convertedMessages);
        isInitialLoadRef.current = false;
      }
      prevSessionMessagesLengthRef.current = sessionMessages.length;
    }
  }, [convertedMessages, sessionMessages.length, isLoading, setChatMessages]);

  useEffect(() => {
    const storageKey = getChatMessageCacheKey(getSessionStorageIdentity(selectedProject, selectedSession));
    if (!storageKey) {
      return;
    }

    if (chatMessages.length > 0) {
      safeLocalStorage.setItem(storageKey, JSON.stringify(chatMessages));
      return;
    }

    safeLocalStorage.removeItem(storageKey);
  }, [chatMessages, selectedProject, selectedSession]);

  useEffect(() => {
    logScrollDebug('chat-messages-length-change', {
      lastMessageType: chatMessages[chatMessages.length - 1]?.type ?? null,
      lastToolName: chatMessages[chatMessages.length - 1]?.toolName ?? null,
    });
  }, [chatMessages.length, chatMessages, logScrollDebug]);

  // Scroll to search target message after messages are loaded
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    // Clear immediately to prevent re-triggering
    setSearchTarget(null);

    const scrollToTarget = async () => {
      // Always load all messages when navigating from search
      // (hasMoreMessages may not be set yet due to race with loading effect)
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
        const sessionProvider = selectedSession.__provider || 'claude';
        if (sessionProvider !== 'cursor') {
          try {
            const response = await (api.sessionMessages as any)(
              selectedProject.name,
              selectedSession.id,
              null,
              0,
              sessionProvider,
            );
            if (response.ok) {
              const data = await response.json();
              const allMessages = data.messages || data;
              setSessionMessages(Array.isArray(allMessages) ? allMessages : []);
              setHasMoreMessages(false);
              setTotalMessages(Array.isArray(allMessages) ? allMessages.length : 0);
              messagesOffsetRef.current = Array.isArray(allMessages) ? allMessages.length : 0;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              // Wait for messages to render after state update
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
        }
      }
      setVisibleMessageCount(Infinity);

      // Retry finding the element in the DOM until React finishes rendering all messages
      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        // Match by snippet text content (most reliable)
        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          // Use a contiguous substring from the snippet (don't filter words, it breaks matching)
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();

          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) {
                targetElement = el;
                break;
              }
            }
          }
        }

        // Fallback to timestamp matching
        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;

          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) {
              closestDiff = diff;
              targetElement = el;
            }
          }
        }

        if (targetElement) {
          markProgrammaticScrollIntent('searchTargetScrollIntoView', {
            targetTimestamp: target.timestamp ?? null,
            targetSnippetPreview: target.snippet?.slice(0, 40) ?? null,
          });
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      // Start polling after a short delay to let React begin rendering
      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }

    void refreshTokenBudget(selectedSession.id, selectedSession.__provider);
  }, [refreshTokenBudget, selectedProject, selectedSession?.id, selectedSession?.__provider]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) {
      return chatMessages;
    }
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) {
      return;
    }

    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) {
      return;
    }

    if (searchScrollActiveRef.current) {
      return;
    }

    if (autoScrollToBottom) {
      if (!isUserScrolledUp) {
        setTimeout(() => scrollToBottom(), 50);
      }
    }
  }, [autoScrollToBottom, chatMessages.length, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const measureContainer = (reason: string) => {
      const nextMetrics = {
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      };
      const previousMetrics = lastMeasuredContainerRef.current;

      if (
        nextMetrics.clientHeight === previousMetrics.clientHeight &&
        nextMetrics.scrollHeight === previousMetrics.scrollHeight
      ) {
        return;
      }

      lastMeasuredContainerRef.current = nextMetrics;
      logScrollDebug('container-metrics-change', {
        reason,
        previousClientHeight: previousMetrics.clientHeight,
        previousScrollHeight: previousMetrics.scrollHeight,
        nextClientHeight: nextMetrics.clientHeight,
        nextScrollHeight: nextMetrics.scrollHeight,
        childElementCount: container.childElementCount,
      });

      const shouldKeepPinnedToBottom =
        Boolean(autoScrollToBottom) &&
        !isUserScrolledUp &&
        !pendingScrollRestoreRef.current &&
        !searchScrollActiveRef.current &&
        !isLoadingMoreRef.current &&
        !isLoadingMoreMessages;

      if (shouldKeepPinnedToBottom) {
        setScrollTopWithDebug('containerMetricsAutoFollow', nextMetrics.scrollHeight, {
          reason,
          previousClientHeight: previousMetrics.clientHeight,
          previousScrollHeight: previousMetrics.scrollHeight,
          nextClientHeight: nextMetrics.clientHeight,
          nextScrollHeight: nextMetrics.scrollHeight,
        });
      }
    };

    let animationFrameId = 0;
    const scheduleMeasure = (reason: string) => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = window.requestAnimationFrame(() => {
        measureContainer(reason);
      });
    };

    measureContainer('observer-init');

    const resizeObserver = new ResizeObserver(() => {
      scheduleMeasure('resize-observer');
    });
    const mutationObserver = new MutationObserver(() => {
      scheduleMeasure('mutation-observer');
    });

    resizeObserver.observe(container);
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [autoScrollToBottom, isLoadingMoreMessages, isUserScrolledUp, logScrollDebug, setScrollTopWithDebug]);

  useEffect(() => {
    const activeViewSessionId = selectedSession?.id || currentSessionId;
    if (!activeViewSessionId || !processingSessions) {
      return;
    }

    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing && !isLoading) {
      setIsLoading(true);
      setCanAbortSession(true);
    }
  }, [currentSessionId, isLoading, processingSessions, selectedSession?.id]);

  // Show "Load all" overlay after a batch finishes loading, persist for 2s then hide
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingMoreMessages;

    if (wasLoading && !isLoadingMoreMessages && hasMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(true);
      loadAllOverlayTimerRef.current = setTimeout(() => {
        setShowLoadAllOverlay(false);
      }, 2000);
    }
    if (!hasMoreMessages && !isLoadingMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
    }
    return () => {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    };
  }, [isLoadingMoreMessages, hasMoreMessages]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const sessionProvider = selectedSession.__provider || 'claude';
    if (sessionProvider === 'cursor') {
      setVisibleMessageCount(Infinity);
      setAllMessagesLoaded(true);
      allMessagesLoadedRef.current = true;
      setLoadAllJustFinished(true);
      if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = setTimeout(() => {
        setLoadAllJustFinished(false);
        setShowLoadAllOverlay(false);
      }, 1000);
      return;
    }

    const requestSessionId = selectedSession.id;

    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      const response = await (api.sessionMessages as any)(
        selectedProject.name,
        requestSessionId,
        null,
        0,
        sessionProvider,
      );

      if (currentSessionId !== requestSessionId) return;

      if (response.ok) {
        const data = await response.json();
        const allMessages = data.messages || data;

        if (container) {
          pendingScrollRestoreRef.current = {
            height: previousScrollHeight,
            top: previousScrollTop,
          };
        }

        setSessionMessages(Array.isArray(allMessages) ? allMessages : []);
        setHasMoreMessages(false);
        setTotalMessages(Array.isArray(allMessages) ? allMessages.length : 0);
        messagesOffsetRef.current = Array.isArray(allMessages) ? allMessages.length : 0;

        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
        }, 1000);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((previousCount) => previousCount + 100);
  }, []);

  return {
    chatMessages,
    setChatMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    sessionMessages,
    setSessionMessages,
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
    isNearBottom,
    handleScroll,
    loadSessionMessages,
    loadCursorSessionMessages,
  };
}

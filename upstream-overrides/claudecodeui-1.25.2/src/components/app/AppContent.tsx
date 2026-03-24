import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { IS_CODEX_ONLY_HARDENED } from '../../constants/config';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import type { Project, SessionProvider } from '../../types/app';
import MobileNav from './MobileNav';

const TERMINAL_SESSION_MESSAGE_TYPES = new Set([
  'claude-complete',
  'codex-complete',
  'cursor-result',
  'session-aborted',
  'claude-error',
  'cursor-error',
  'codex-error',
  'gemini-error',
  'error',
]);

const PROCESSING_SIGNAL_MESSAGE_TYPES = new Set([
  'claude-status',
  'claude-permission-request',
]);

const isSessionProvider = (value: unknown): value is SessionProvider => {
  return value === 'claude' || value === 'cursor' || value === 'codex' || value === 'gemini';
};

const resolveSocketSessionProvider = (message: unknown): SessionProvider | null => {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const directProvider = (message as { provider?: unknown }).provider;
  if (isSessionProvider(directProvider)) {
    return directProvider;
  }

  const messageType = (message as { type?: unknown }).type;
  if (typeof messageType !== 'string') {
    return null;
  }

  if (messageType.startsWith('codex-')) {
    return 'codex';
  }

  if (messageType.startsWith('cursor-')) {
    return 'cursor';
  }

  if (messageType.startsWith('gemini-')) {
    return 'gemini';
  }

  if (messageType.startsWith('claude-')) {
    return 'claude';
  }

  return null;
};

const resolveSocketSessionId = (message: unknown): string | null => {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const directSessionId = (message as { sessionId?: unknown }).sessionId;
  if (typeof directSessionId === 'string' && directSessionId.length > 0) {
    return directSessionId;
  }

  const rawData = (message as { data?: unknown }).data;
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }

  const nestedSessionId =
    (rawData as { session_id?: unknown }).session_id ??
    (rawData as { sessionId?: unknown }).sessionId ??
    ((rawData as { message?: unknown }).message &&
    typeof (rawData as { message?: unknown }).message === 'object'
      ? ((rawData as { message: { session_id?: unknown; sessionId?: unknown } }).message.session_id ??
        (rawData as { message: { session_id?: unknown; sessionId?: unknown } }).message.sessionId)
      : null);

  return typeof nestedSessionId === 'string' && nestedSessionId.length > 0 ? nestedSessionId : null;
};

const shouldRefreshUnreadNotifications = (message: unknown): boolean => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const messageType = (message as { type?: unknown }).type;
  if (messageType === 'codex-complete' || messageType === 'cursor-result' || messageType === 'gemini-complete') {
    return true;
  }

  if (messageType !== 'claude-complete') {
    return false;
  }

  const exitCode = (message as { exitCode?: unknown }).exitCode;
  return exitCode === 0 || exitCode === undefined;
};

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const wasPageBackgroundedRef = useRef(false);
  const lastResumeSyncAtRef = useRef(0);
  const hasActiveSessionsBaselineRef = useRef(false);
  const unreadSyncInitializedRef = useRef(false);
  const notifiedUnreadSessionsRef = useRef<Set<string>>(new Set());
  const { preferences } = useUiPreferences();

  const {
    activeSessions,
    processingSessions,
    attentionProcessingSessions,
    unreadCompletedSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
    acknowledgeSession,
    syncProcessingSessions,
    syncUnreadCompletedSessions,
  } = useSessionProtection();

  const {
    projects,
    recentSessions,
    selectedProject,
    selectedSession,
    activeTab,
    mountedTabs,
    sidebarOpen,
    isLoadingProjects,
    isInputFocused,
    externalMessageUpdate,
    getChatRuntimeForTarget,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    updateChatRuntimeForTarget,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    createOptimisticSession,
    replaceOptimisticSession,
    dismissRecentSession,
    requestSessionDelete,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  useEffect(() => {
    // Expose a non-blocking refresh for chat/session flows.
    // Full loading refreshes are still available through direct fetchProjects calls.
    window.refreshProjects = refreshProjectsSilently;

    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    window.openSettings = openSettings;

    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  const hasSelectedSessionUnread = Boolean(selectedSession?.id && unreadCompletedSessions.has(selectedSession.id));
  const sessionRuntimeTargets = useMemo(() => {
    const runtimeTargets = new Map<string, { projectName: string; provider: SessionProvider }>();

    const registerSessions = (
      project: Project,
      sessions: Project['sessions'] | undefined,
      provider: SessionProvider,
    ) => {
      sessions?.forEach((session) => {
        runtimeTargets.set(session.id, {
          projectName: project.name,
          provider: session.__provider || provider,
        });
      });
    };

    projects.forEach((project) => {
      registerSessions(project, project.sessions, 'claude');
      registerSessions(project, project.codexSessions, 'codex');
      registerSessions(project, project.cursorSessions, 'cursor');
      registerSessions(project, project.geminiSessions, 'gemini');
    });

    return runtimeTargets;
  }, [projects]);
  const sessionMetadata = useMemo(() => {
    const metadata = new Map<string, { projectName: string; sessionTitle: string }>();

    projects.forEach((project) => {
      const allSessions = [
        ...(project.sessions ?? []),
        ...(project.codexSessions ?? []),
        ...(project.cursorSessions ?? []),
        ...(project.geminiSessions ?? []),
      ];

      allSessions.forEach((session) => {
        metadata.set(session.id, {
          projectName: project.displayName,
          sessionTitle: session.title || session.summary || session.name || '未命名对话',
        });
      });
    });

    return metadata;
  }, [projects]);

  const recentSessionShortcuts = useMemo(
    () =>
      recentSessions.map((sessionShortcut) => ({
        ...sessionShortcut,
        isProcessing: processingSessions.has(sessionShortcut.sessionId),
        hasUnread: unreadCompletedSessions.has(sessionShortcut.sessionId),
      })),
    [processingSessions, recentSessions, unreadCompletedSessions],
  );

  const clearSessionRuntimeSnapshot = useCallback(
    (targetSessionId: string, providerHint?: SessionProvider | null) => {
      const storedTarget = sessionRuntimeTargets.get(targetSessionId);
      const resolvedTarget = storedTarget || (
        selectedSession?.id === targetSessionId && selectedProject?.name
          ? {
              projectName: selectedProject.name,
              provider: selectedSession.__provider || providerHint || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude'),
            }
          : null
      );

      if (!resolvedTarget) {
        return;
      }

      updateChatRuntimeForTarget(
        {
          projectName: resolvedTarget.projectName,
          sessionId: targetSessionId,
          provider: resolvedTarget.provider,
        },
        (previousRuntime) => {
          if (
            !previousRuntime.isLoading &&
            !previousRuntime.canAbortSession &&
            previousRuntime.claudeStatus === null &&
            previousRuntime.pendingPermissionRequests.length === 0 &&
            previousRuntime.startedAt === null
          ) {
            return previousRuntime;
          }

          return {
            ...previousRuntime,
            isLoading: false,
            canAbortSession: false,
            claudeStatus: null,
            pendingPermissionRequests: [],
            startedAt: null,
          };
        },
      );
    },
    [
      selectedProject?.name,
      selectedSession?.__provider,
      selectedSession?.id,
      sessionRuntimeTargets,
      updateChatRuntimeForTarget,
    ],
  );

  useEffect(() => {
    if (!preferences.browserNotifications || typeof window === 'undefined' || !('Notification' in window)) {
      unreadSyncInitializedRef.current = false;
      notifiedUnreadSessionsRef.current = new Set(unreadCompletedSessions);
      return;
    }

    if (Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  }, [preferences.browserNotifications, unreadCompletedSessions]);

  useEffect(() => {
    if (!preferences.browserNotifications || typeof window === 'undefined' || !('Notification' in window)) {
      unreadSyncInitializedRef.current = false;
      notifiedUnreadSessionsRef.current = new Set(unreadCompletedSessions);
      return;
    }

    const currentUnreadSessions = new Set(unreadCompletedSessions);
    if (!unreadSyncInitializedRef.current) {
      unreadSyncInitializedRef.current = true;
      notifiedUnreadSessionsRef.current = currentUnreadSessions;
      return;
    }

    if (Notification.permission !== 'granted') {
      notifiedUnreadSessionsRef.current = currentUnreadSessions;
      return;
    }

    currentUnreadSessions.forEach((currentUnreadSessionId) => {
      const hasAlreadyNotified = notifiedUnreadSessionsRef.current.has(currentUnreadSessionId);
      if (hasAlreadyNotified || currentUnreadSessionId === selectedSession?.id) {
        return;
      }

      const metadata = sessionMetadata.get(currentUnreadSessionId);
      const notification = new Notification(metadata?.projectName || '对话有新回复', {
        body: metadata?.sessionTitle || '有一条新的未读回复，点击查看。',
        tag: `chat-unread-${currentUnreadSessionId}`,
      });

      notification.onclick = () => {
        window.focus();
        navigate(`/session/${currentUnreadSessionId}`);
        notification.close();
      };
    });

    notifiedUnreadSessionsRef.current = currentUnreadSessions;
  }, [
    navigate,
    preferences.browserNotifications,
    selectedSession?.id,
    sessionMetadata,
    unreadCompletedSessions,
  ]);

  useEffect(() => {
    if (!isConnected) {
      hasActiveSessionsBaselineRef.current = false;
      return;
    }

    hasActiveSessionsBaselineRef.current = false;
    sendMessage({ type: 'get-active-sessions' });
    sendMessage({ type: 'get-session-notifications' });
  }, [isConnected, sendMessage]);

  useEffect(() => {
    if (!isConnected || !shouldRefreshUnreadNotifications(latestMessage)) {
      return;
    }

    sendMessage({ type: 'get-session-notifications' });
  }, [isConnected, latestMessage, sendMessage]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    const syncIfNeeded = () => {
      if (!isConnected || !wasPageBackgroundedRef.current) {
        return;
      }

      const now = Date.now();
      if (now - lastResumeSyncAtRef.current < 800) {
        return;
      }

      lastResumeSyncAtRef.current = now;
      wasPageBackgroundedRef.current = false;
      hasActiveSessionsBaselineRef.current = false;
      sendMessage({ type: 'get-active-sessions' });
      sendMessage({ type: 'get-session-notifications' });

      if (selectedSession?.id) {
        sendMessage({
          type: 'get-pending-permissions',
          sessionId: selectedSession.id,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasPageBackgroundedRef.current = true;
        return;
      }

      if (document.visibilityState === 'visible') {
        syncIfNeeded();
      }
    };

    const handlePageHide = () => {
      wasPageBackgroundedRef.current = true;
    };

    const handleFocus = () => {
      syncIfNeeded();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        wasPageBackgroundedRef.current = true;
      }
      syncIfNeeded();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [isConnected, selectedSession?.id, sendMessage]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id,
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  useEffect(() => {
    if (!latestMessage || typeof latestMessage !== 'object' || (latestMessage as { type?: string }).type !== 'active-sessions') {
      return;
    }

    hasActiveSessionsBaselineRef.current = true;
    const rawSessions = (latestMessage as { sessions?: unknown }).sessions;
    if (!rawSessions || typeof rawSessions !== 'object') {
      return;
    }

    const activeSessionIds = Object.values(rawSessions).flatMap((sessionList) => {
      if (!Array.isArray(sessionList)) {
        return [];
      }

      return sessionList.flatMap((sessionEntry) => {
        if (typeof sessionEntry === 'string' && sessionEntry.length > 0) {
          return [sessionEntry];
        }

        if (
          sessionEntry &&
          typeof sessionEntry === 'object' &&
          typeof (sessionEntry as { id?: unknown }).id === 'string' &&
          (sessionEntry as { id: string }).id.length > 0
        ) {
          return [(sessionEntry as { id: string }).id];
        }

        return [];
      });
    });

    syncProcessingSessions(activeSessionIds);
    const activeSessionIdSet = new Set(activeSessionIds);
    sessionRuntimeTargets.forEach(({ provider }, knownSessionId) => {
      if (activeSessionIdSet.has(knownSessionId)) {
        return;
      }

      clearSessionRuntimeSnapshot(knownSessionId, provider);
    });
  }, [clearSessionRuntimeSnapshot, latestMessage, sessionRuntimeTargets, syncProcessingSessions]);

  useEffect(() => {
    if (!latestMessage || typeof latestMessage !== 'object') {
      return;
    }

    const messageType = (latestMessage as { type?: unknown }).type;
    if (typeof messageType !== 'string' || messageType.length === 0) {
      return;
    }

    const sessionIdFromMessage = resolveSocketSessionId(latestMessage);
    if (!sessionIdFromMessage) {
      return;
    }
    const sessionProviderFromMessage = resolveSocketSessionProvider(latestMessage);

    if (messageType === 'session-status') {
      if ((latestMessage as { isProcessing?: unknown }).isProcessing) {
        markSessionAsProcessing(sessionIdFromMessage);
        return;
      }

      clearSessionRuntimeSnapshot(sessionIdFromMessage, sessionProviderFromMessage);
      markSessionAsNotProcessing(sessionIdFromMessage);
      return;
    }

    if (PROCESSING_SIGNAL_MESSAGE_TYPES.has(messageType)) {
      if (!hasActiveSessionsBaselineRef.current) {
        return;
      }
      markSessionAsProcessing(sessionIdFromMessage);
      return;
    }

    if (TERMINAL_SESSION_MESSAGE_TYPES.has(messageType)) {
      clearSessionRuntimeSnapshot(sessionIdFromMessage, sessionProviderFromMessage);
      markSessionAsNotProcessing(sessionIdFromMessage);
    }
  }, [clearSessionRuntimeSnapshot, latestMessage, markSessionAsNotProcessing, markSessionAsProcessing]);

  useEffect(() => {
    if (
      !latestMessage ||
      typeof latestMessage !== 'object' ||
      (latestMessage as { type?: string }).type !== 'session-notifications-state'
    ) {
      return;
    }

    const unreadSessionIds = Array.isArray((latestMessage as { unreadCompletedSessions?: unknown[] }).unreadCompletedSessions)
      ? (latestMessage as { unreadCompletedSessions: unknown[] }).unreadCompletedSessions.filter(
          (currentSessionId: unknown): currentSessionId is string =>
            typeof currentSessionId === 'string' && currentSessionId.length > 0,
        )
      : [];

    syncUnreadCompletedSessions(unreadSessionIds);
  }, [latestMessage, syncUnreadCompletedSessions]);

  return (
    <div className="fixed inset-0 flex bg-background">
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar
            {...sidebarSharedProps}
            attentionProcessingSessions={attentionProcessingSessions}
            unreadCompletedSessions={unreadCompletedSessions}
          />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar
              {...sidebarSharedProps}
              attentionProcessingSessions={attentionProcessingSessions}
              unreadCompletedSessions={unreadCompletedSessions}
            />
          </div>
        </div>
      )}

      <div className={`flex min-w-0 flex-1 flex-col ${isMobile && !IS_CODEX_ONLY_HARDENED ? 'pb-mobile-nav' : ''}`}>
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          mountedTabs={mountedTabs}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          onReplaceTemporarySession={replaceTemporarySession}
          onCreateOptimisticSession={createOptimisticSession}
          onReplaceOptimisticSession={replaceOptimisticSession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          getSessionViewChatRuntimeForTarget={getChatRuntimeForTarget}
          updateSessionViewChatRuntimeForTarget={updateChatRuntimeForTarget}
          hasUnreadSelectedSession={hasSelectedSessionUnread}
          onAcknowledgeUnreadSession={acknowledgeSession}
          recentSessions={recentSessionShortcuts}
          onRecentSessionSelect={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onRecentSessionDismiss={dismissRecentSession}
          onDeleteCurrentSession={requestSessionDelete}
        />
      </div>

      {isMobile && !IS_CODEX_ONLY_HARDENED && (
        <MobileNav
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isInputFocused={isInputFocused}
        />
      )}

    </div>
  );
}

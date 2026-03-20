import { useEffect, useMemo, useRef } from 'react';
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
import MobileNav from './MobileNav';

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
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
    sidebarOpen,
    isLoadingProjects,
    isInputFocused,
    externalMessageUpdate,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    dismissRecentSession,
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

  useEffect(() => {
    if (!selectedSession?.id || !hasSelectedSessionUnread) {
      return;
    }

    void acknowledgeSession(selectedSession.id, selectedSession.__provider || null);
  }, [
    acknowledgeSession,
    hasSelectedSessionUnread,
    selectedSession?.__provider,
    selectedSession?.id,
  ]);

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
      return;
    }

    sendMessage({ type: 'get-active-sessions' });
    sendMessage({ type: 'get-session-notifications' });
  }, [isConnected, sendMessage]);

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

    const rawSessions = (latestMessage as { sessions?: unknown }).sessions;
    if (!rawSessions || typeof rawSessions !== 'object') {
      return;
    }

    const activeSessionIds = Object.values(rawSessions).flatMap((sessionList) =>
      Array.isArray(sessionList)
        ? sessionList.filter(
            (currentSessionId: unknown): currentSessionId is string =>
              typeof currentSessionId === 'string' && currentSessionId.length > 0,
          )
        : [],
    );

    syncProcessingSessions(activeSessionIds);
  }, [latestMessage, syncProcessingSessions]);

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
          processingSessions={processingSessions}
          onReplaceTemporarySession={replaceTemporarySession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          selectedSessionHasUnread={hasSelectedSessionUnread}
          recentSessions={recentSessionShortcuts}
          onRecentSessionSelect={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onRecentSessionDismiss={dismissRecentSession}
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, Trash2, X } from 'lucide-react';
import type { MainContentHeaderProps } from '../../types/types';
import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';
import DarkModeToggle from '../../../../shared/view/ui/DarkModeToggle';
import { IS_CODEX_ONLY_HARDENED } from '../../../../constants/config';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import type { SessionProvider } from '../../../../types/app';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

const CHAT_SCROLL_DEBUG_STORAGE_KEY = 'chat-scroll-debug';
const CHAT_SCROLL_DEBUG_QUERY_KEY = 'chatScrollDebug';

const resolveSessionProvider = (provider?: SessionProvider): SessionProvider =>
  provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');

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
    window.localStorage.getItem(CHAT_SCROLL_DEBUG_STORAGE_KEY) === '1'
  );
};

function RecentSessionStatusIndicators({
  isProcessing,
  hasUnread,
}: {
  isProcessing: boolean;
  hasUnread: boolean;
}) {
  return (
    <span className="inline-flex flex-shrink-0 items-center gap-1" aria-hidden="true">
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          isProcessing
            ? 'bg-emerald-400/80 shadow-[0_0_0_2px_rgba(74,222,128,0.14)]'
            : 'bg-transparent'
        }`}
      />
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          hasUnread
            ? 'bg-rose-400/80 shadow-[0_0_0_2px_rgba(251,113,133,0.14)]'
            : 'bg-transparent'
        }`}
      />
    </span>
  );
}

export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  isMobile,
  onMenuClick,
  recentSessions,
  onRecentSessionSelect,
  onRecentSessionDismiss,
  onDeleteCurrentSession,
}: MainContentHeaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const { t } = useTranslation('sidebar');
  const { preferences, setPreference } = useUiPreferences();
  const shouldReserveRecentSessionsRow = activeTab === 'chat';
  const shouldShowRecentSessions = recentSessions.length > 0;
  const currentSessionProvider = selectedSession ? resolveSessionProvider(selectedSession.__provider) : null;
  const canDeleteCurrentSession =
    activeTab === 'chat' &&
    Boolean(
      selectedSession &&
      currentSessionProvider &&
      currentSessionProvider !== 'cursor' &&
      (!IS_CODEX_ONLY_HARDENED || currentSessionProvider === 'codex'),
    );

  const logHeaderDebug = useCallback((event: string, payload: Record<string, unknown> = {}) => {
    if (!isChatScrollDebugEnabled()) {
      return;
    }

    console.debug('[chat-scroll]', {
      event,
      timestamp: new Date().toISOString(),
      activeTab,
      projectName: selectedProject?.name ?? null,
      selectedSessionId: selectedSession?.id ?? null,
      recentSessionsCount: recentSessions.length,
      shouldShowRecentSessions,
      headerHeight: headerRef.current?.offsetHeight ?? null,
      ...payload,
    });
  }, [activeTab, recentSessions.length, selectedProject?.name, selectedSession?.id, shouldShowRecentSessions]);

  const updateScrollState = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    setCanScrollLeft(container.scrollLeft > 2);
    setCanScrollRight(container.scrollLeft < container.scrollWidth - container.clientWidth - 2);
  }, []);

  const handleDeleteCurrentSession = useCallback(() => {
    if (!selectedSession || !currentSessionProvider) {
      return;
    }

    const sessionTitle =
      selectedSession.title || selectedSession.summary || selectedSession.name || t('sessions.unnamed');

    onDeleteCurrentSession(selectedProject.name, selectedSession.id, sessionTitle, currentSessionProvider);
  }, [currentSessionProvider, onDeleteCurrentSession, selectedProject.name, selectedSession, t]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    updateScrollState();
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateScrollState]);

  useEffect(() => {
    logHeaderDebug('header-recent-sessions-state-change');
  }, [logHeaderDebug]);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) {
      return;
    }

    const observer = new ResizeObserver(() => {
      logHeaderDebug('header-resize');
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [logHeaderDebug]);

  return (
    <div ref={headerRef} className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background px-3 py-1.5 sm:px-4 sm:py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
          <MainContentTitle
            activeTab={activeTab}
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            shouldShowTasksTab={shouldShowTasksTab}
          />
        </div>

        <div className="relative min-w-0 flex-shrink overflow-hidden sm:flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPreference('browserNotifications', !preferences.browserNotifications)}
              className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
                preferences.browserNotifications
                  ? 'border-emerald-200 bg-emerald-500/10 text-emerald-600 dark:border-emerald-900/60 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'border-border/60 bg-muted/50 text-muted-foreground hover:text-foreground'
              }`}
              title={preferences.browserNotifications ? '关闭提醒' : '开启提醒'}
            >
              {preferences.browserNotifications ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            </button>
            {canDeleteCurrentSession && (
              <button
                type="button"
                onClick={handleDeleteCurrentSession}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-red-200 bg-red-50 text-red-600 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40"
                title={t('tooltips.deleteSession')}
                aria-label={t('tooltips.deleteSession')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
            <DarkModeToggle ariaLabel="切换夜间模式" />
            <div className="relative min-w-0 overflow-hidden">
              {canScrollLeft && (
                <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent" />
              )}
              <div
                ref={scrollRef}
                onScroll={updateScrollState}
                className="scrollbar-hide overflow-x-auto"
              >
                <MainContentTabSwitcher
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  shouldShowTasksTab={shouldShowTasksTab}
                />
              </div>
              {canScrollRight && (
                <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent" />
              )}
            </div>
          </div>
        </div>
      </div>

      {shouldReserveRecentSessionsRow && (
        <div className="mt-2 min-h-8 overflow-x-auto">
          {shouldShowRecentSessions && (
            <div className="flex min-w-max items-center gap-2">
              {recentSessions.map((sessionShortcut) => {
                const isSelected = selectedSession?.id === sessionShortcut.sessionId;
                const statusLabel = [
                  sessionShortcut.isProcessing ? '处理中' : null,
                  sessionShortcut.hasUnread ? '未读' : null,
                ]
                  .filter(Boolean)
                  .join(' / ') || '已读';

                return (
                  <div
                    key={sessionShortcut.sessionId}
                    className={`flex h-8 max-w-[14rem] items-center rounded-full border text-left text-xs transition-colors ${
                      isSelected
                        ? 'border-primary/45 bg-primary/15 text-primary shadow-sm dark:bg-primary/20'
                        : 'border-border/60 bg-card/80 text-muted-foreground hover:border-border hover:text-foreground'
                    }`}
                    title={`${sessionShortcut.projectName} / ${sessionShortcut.sessionTitle}`}
                  >
                    <button
                      type="button"
                      onClick={() => onRecentSessionSelect(sessionShortcut.sessionId)}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 pr-1.5"
                      title={`${sessionShortcut.projectName} / ${sessionShortcut.sessionTitle} (${statusLabel})`}
                    >
                      <RecentSessionStatusIndicators
                        isProcessing={sessionShortcut.isProcessing}
                        hasUnread={sessionShortcut.hasUnread}
                      />
                      <SessionProviderLogo provider={sessionShortcut.provider} className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate font-medium">{sessionShortcut.sessionTitle}</span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRecentSessionDismiss(sessionShortcut.sessionId);
                      }}
                      className={`mr-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full transition-colors ${
                        isSelected
                          ? 'text-primary/80 hover:bg-primary/10 hover:text-primary'
                          : 'text-muted-foreground/80 hover:bg-muted hover:text-foreground'
                      }`}
                      aria-label={`仅从最近列表移除 ${sessionShortcut.sessionTitle}`}
                      title={`仅从最近列表移除 ${sessionShortcut.sessionTitle}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

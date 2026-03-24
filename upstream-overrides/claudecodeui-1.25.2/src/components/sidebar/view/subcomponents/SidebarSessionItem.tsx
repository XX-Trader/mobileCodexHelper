import { type RefObject, useEffect, useRef } from 'react';
import { Check, Clock, Edit2, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { IS_CODEX_ONLY_HARDENED } from '../../../../constants/config';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  needsAttentionProcessing: boolean;
  hasUnreadCompleted: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  t: TFunction;
};

type SessionRenameEditorProps = {
  className?: string;
  inputRef: RefObject<HTMLInputElement>;
  isMobile?: boolean;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onFocus: () => void;
  onSave: () => void;
  placeholder: string;
  t: TFunction;
};

const scrollRenameEditorIntoView = (container: HTMLElement | null) => {
  if (!container || typeof window === 'undefined') {
    return;
  }

  const isMobileViewport = window.matchMedia('(max-width: 767px)').matches;
  container.scrollIntoView({
    block: isMobileViewport ? 'center' : 'nearest',
    inline: 'nearest',
    behavior: isMobileViewport ? 'smooth' : 'auto',
  });
};

function SessionRenameEditor({
  className,
  inputRef,
  isMobile = false,
  value,
  onChange,
  onCancel,
  onFocus,
  onSave,
  placeholder,
  t,
}: SessionRenameEditorProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xl border border-primary/20 bg-gradient-to-r from-background via-background to-primary/[0.05] p-2 shadow-sm',
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <Edit2 className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={onFocus}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              onSave();
            } else if (event.key === 'Escape') {
              onCancel();
            }
          }}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground/60 focus:outline-none',
            isMobile ? 'h-9 text-sm' : 'h-8 text-xs',
          )}
          placeholder={placeholder}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          style={isMobile ? { fontSize: '16px', WebkitAppearance: 'none' } : undefined}
        />
      </div>

      <button
        className={cn(
          'flex items-center justify-center rounded-lg border border-emerald-200 bg-emerald-500/10 text-emerald-700 shadow-sm transition-all hover:bg-emerald-500/15 dark:border-emerald-900/60 dark:bg-emerald-500/15 dark:text-emerald-300',
          isMobile ? 'h-9 w-9' : 'h-8 w-8',
        )}
        onClick={(event) => {
          event.stopPropagation();
          onSave();
        }}
        title={t('tooltips.save')}
      >
        <Check className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
      </button>

      <button
        className={cn(
          'flex items-center justify-center rounded-lg border border-border/70 bg-muted/50 text-muted-foreground shadow-sm transition-all hover:bg-muted dark:bg-muted/30',
          isMobile ? 'h-9 w-9' : 'h-8 w-8',
        )}
        onClick={(event) => {
          event.stopPropagation();
          onCancel();
        }}
        title={t('tooltips.cancel')}
      >
        <X className={cn(isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
      </button>
    </div>
  );
}

function SessionStatusIndicators({
  needsAttentionProcessing,
  hasUnreadCompleted,
  className,
}: {
  needsAttentionProcessing: boolean;
  hasUnreadCompleted: boolean;
  className?: string;
}) {
  if (!needsAttentionProcessing && !hasUnreadCompleted) {
    return null;
  }

  return (
    <span className={cn('inline-flex flex-shrink-0 items-center gap-1', className)} aria-hidden="true">
      {needsAttentionProcessing && (
        <span
          className="h-2.5 w-2.5 rounded-full bg-emerald-400/80 shadow-[0_0_0_2px_rgba(74,222,128,0.12)]"
          title="处理中"
        />
      )}
      {hasUnreadCompleted && (
        <span
          className="h-2.5 w-2.5 rounded-full bg-rose-400/80 shadow-[0_0_0_2px_rgba(251,113,133,0.12)]"
          title="未读"
        />
      )}
    </span>
  );
}

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  needsAttentionProcessing,
  hasUnreadCompleted,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  t,
}: SidebarSessionItemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);
  const desktopInputRef = useRef<HTMLInputElement | null>(null);
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const canEditSessionName = !IS_CODEX_ONLY_HARDENED || session.__provider === 'codex';
  const isEditingSession = editingSession === session.id;

  useEffect(() => {
    if (!isEditingSession || typeof window === 'undefined') {
      return;
    }

    const focusAndRevealEditor = () => {
      const useMobileInput = window.matchMedia('(max-width: 767px)').matches;
      const activeInput = useMobileInput
        ? (mobileInputRef.current ?? desktopInputRef.current)
        : (desktopInputRef.current ?? mobileInputRef.current);

      if (activeInput) {
        activeInput.focus({ preventScroll: true });
        const cursorPosition = activeInput.value.length;
        activeInput.setSelectionRange(cursorPosition, cursorPosition);
      }

      scrollRenameEditorIntoView(containerRef.current);
    };

    const frameId = window.requestAnimationFrame(focusAndRevealEditor);
    const timeoutId = window.setTimeout(() => {
      scrollRenameEditorIntoView(containerRef.current);
    }, 180);
    const viewport = window.visualViewport;

    if (!viewport) {
      return () => {
        window.cancelAnimationFrame(frameId);
        window.clearTimeout(timeoutId);
      };
    }

    const handleViewportChange = () => {
      window.requestAnimationFrame(() => {
        scrollRenameEditorIntoView(containerRef.current);
      });
    };

    viewport.addEventListener('resize', handleViewportChange);
    viewport.addEventListener('scroll', handleViewportChange);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
      viewport.removeEventListener('resize', handleViewportChange);
      viewport.removeEventListener('scroll', handleViewportChange);
    };
  }, [isEditingSession]);

  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.name);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.name, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.name, session.id, sessionView.sessionName, session.__provider);
  };

  return (
    <div ref={containerRef} className="group relative">
      <SessionStatusIndicators
        needsAttentionProcessing={needsAttentionProcessing}
        hasUnreadCompleted={hasUnreadCompleted}
        className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2"
      />
      <div className="md:hidden">
        <div
          className={cn(
            'relative mx-3 my-0.5 rounded-xl border bg-card py-2.5 pr-2.5 pl-5 active:scale-[0.98] transition-all duration-150',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            isEditingSession && 'border-primary/30 bg-primary/[0.04] shadow-[0_10px_30px_rgba(15,23,42,0.08)]',
            !isSelected && hasUnreadCompleted
              ? 'border-red-500/30 bg-red-50/5 dark:bg-red-900/5'
              : !isSelected && needsAttentionProcessing
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
          )}
          onClick={selectMobileSession}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-foreground">{sessionView.sessionName}</div>
              <div className="mt-0.5 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(sessionView.sessionTime, currentTime, t)}
                </span>
                <span className="ml-1 opacity-70">
                  <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
                </span>
              </div>
            </div>

            <div className="ml-1 flex items-center gap-1">
              {canEditSessionName && !isEditingSession && (
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 bg-background/90 shadow-sm transition-transform active:scale-95 dark:bg-gray-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
                </button>
              )}
              {(!IS_CODEX_ONLY_HARDENED || session.__provider === 'codex') && !sessionView.isCursorSession && !isEditingSession && (
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-red-200/70 bg-red-50/90 shadow-sm transition-transform active:scale-95 dark:border-red-900/40 dark:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDeleteSession();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                </button>
              )}
            </div>
          </div>

          {canEditSessionName && isEditingSession && (
            <SessionRenameEditor
              className="mt-2 ml-7"
              inputRef={mobileInputRef}
              isMobile
              value={editingSessionName}
              onChange={onEditingSessionNameChange}
              onSave={saveEditedSession}
              onCancel={onCancelEditingSession}
              onFocus={() => scrollRenameEditorIntoView(containerRef.current)}
              placeholder={sessionView.sessionName}
              t={t}
            />
          )}
        </div>
      </div>

      <div className="hidden md:block">
        <Button
          variant="ghost"
          className={cn(
            'h-auto w-full justify-start py-2 pr-2 pl-5 font-normal text-left hover:bg-accent/50 transition-colors duration-200',
            isSelected && 'bg-accent text-accent-foreground',
            !isSelected && hasUnreadCompleted && 'bg-red-50/40 dark:bg-red-900/10',
            !isSelected && !hasUnreadCompleted && needsAttentionProcessing && 'bg-emerald-50/40 dark:bg-emerald-900/10',
          )}
          onClick={() => onSessionSelect(session, project.name)}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            <SessionProviderLogo provider={session.__provider} className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <div className="min-w-0 flex-1 pr-14">
              <div className="truncate text-xs font-medium text-foreground">{sessionView.sessionName}</div>
              <div className="mt-0.5 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(sessionView.sessionTime, currentTime, t)}
                </span>
                <span className="ml-1 opacity-70">
                  <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
                </span>
              </div>
            </div>
          </div>
        </Button>

        {!isEditingSession && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100">
            {canEditSessionName && (
              <button
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 bg-background/90 shadow-sm hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  onStartEditingSession(session.id, sessionView.sessionName);
                }}
                title={t('tooltips.editSessionName')}
              >
                <Edit2 className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
              </button>
            )}
            {!sessionView.isCursorSession && (
              <button
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-red-200/70 bg-red-50/90 shadow-sm hover:bg-red-100 dark:border-red-900/40 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  requestDeleteSession();
                }}
                title={t('tooltips.deleteSession')}
              >
                <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
              </button>
            )}
          </div>
        )}

        {canEditSessionName && isEditingSession && (
          <div className="px-5 pt-2">
            <SessionRenameEditor
              inputRef={desktopInputRef}
              value={editingSessionName}
              onChange={onEditingSessionNameChange}
              onSave={saveEditedSession}
              onCancel={onCancelEditingSession}
              onFocus={() => scrollRenameEditorIntoView(containerRef.current)}
              placeholder={sessionView.sessionName}
              t={t}
            />
          </div>
        )}
      </div>
    </div>
  );
}

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { AppTab, Project, ProjectSession, SessionProvider } from '../../../types/app';
import type {
  SessionViewChatRuntime,
  SessionViewChatRuntimeUpdater,
  SessionViewTarget,
} from '../../../types/sessionView';

export type SessionLifecycleHandler = (sessionId?: string | null) => void;
export type SessionUnreadAcknowledgeHandler = (
  sessionId: string,
  provider: SessionProvider | null,
) => Promise<void> | void;

export type TaskMasterTask = {
  id: string | number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  details?: string;
  testStrategy?: string;
  parentId?: string | number;
  dependencies?: Array<string | number>;
  subtasks?: TaskMasterTask[];
  [key: string]: unknown;
};

export type TaskReference = {
  id: string | number;
  title?: string;
  [key: string]: unknown;
};

export type TaskSelection = TaskMasterTask | TaskReference;

export type PrdFile = {
  name: string;
  content?: string;
  isExisting?: boolean;
  [key: string]: unknown;
};

export type RecentSessionShortcut = {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  provider: SessionProvider;
  isProcessing: boolean;
  hasUnread: boolean;
};

export type MainContentProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  mountedTabs: AppTab[];
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  latestMessage: unknown;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onInputFocusChange: (focused: boolean) => void;
  onSessionActive: SessionLifecycleHandler;
  onSessionInactive: SessionLifecycleHandler;
  onSessionProcessing: SessionLifecycleHandler;
  onSessionNotProcessing: SessionLifecycleHandler;
  onReplaceTemporarySession: SessionLifecycleHandler;
  onCreateOptimisticSession: (
    project: Project,
    session: ProjectSession,
    initialChatRuntime?: Partial<SessionViewChatRuntime>,
  ) => void;
  onReplaceOptimisticSession: (
    temporarySessionId: string | null | undefined,
    realSessionId: string,
  ) => void;
  onNavigateToSession: (targetSessionId: string) => void;
  onShowSettings: () => void;
  externalMessageUpdate: number;
  getSessionViewChatRuntimeForTarget: (target: SessionViewTarget) => SessionViewChatRuntime;
  updateSessionViewChatRuntimeForTarget: (
    target: SessionViewTarget,
    nextRuntime: SessionViewChatRuntimeUpdater,
  ) => void;
  hasUnreadSelectedSession: boolean;
  onAcknowledgeUnreadSession: SessionUnreadAcknowledgeHandler;
  recentSessions: RecentSessionShortcut[];
  onRecentSessionSelect: (sessionId: string) => void;
  onRecentSessionDismiss: (sessionId: string) => void;
  onDeleteCurrentSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
};

export type MainContentHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  recentSessions: RecentSessionShortcut[];
  onRecentSessionSelect: (sessionId: string) => void;
  onRecentSessionDismiss: (sessionId: string) => void;
  onDeleteCurrentSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
};

export type MainContentStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
  topWidget?: ReactNode;
};

export type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

export type TaskMasterPanelProps = {
  isVisible: boolean;
};

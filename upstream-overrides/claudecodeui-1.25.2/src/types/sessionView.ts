import type { AppTab, SessionProvider } from './app';

export interface SessionViewTarget {
  projectName?: string | null;
  sessionId?: string | null;
  provider?: SessionProvider | null;
}

export interface SessionViewPendingPermissionRequestSnapshot {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: string | number | Date;
}

export interface SessionViewChatRuntime {
  isLoading: boolean;
  canAbortSession: boolean;
  claudeStatus: {
    text: string;
    tokens: number;
    can_interrupt: boolean;
  } | null;
  tokenBudget: Record<string, unknown> | null;
  pendingPermissionRequests: SessionViewPendingPermissionRequestSnapshot[];
  startedAt: number | null;
  updatedAt: number;
}

export type SessionViewChatRuntimeUpdater =
  | SessionViewChatRuntime
  | Partial<SessionViewChatRuntime>
  | ((previousRuntime: SessionViewChatRuntime) => SessionViewChatRuntime | Partial<SessionViewChatRuntime>);

export interface SessionViewState {
  activeTab: AppTab;
  mountedTabs: AppTab[];
  lastVisitedAt: number;
  chatRuntime: SessionViewChatRuntime;
}

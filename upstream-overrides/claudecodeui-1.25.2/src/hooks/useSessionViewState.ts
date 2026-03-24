import { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_CODEX_ONLY_HARDENED } from '../constants/config';
import type { AppTab, Project, ProjectSession, SessionProvider } from '../types/app';
import type {
  SessionViewChatRuntime,
  SessionViewChatRuntimeUpdater,
  SessionViewPendingPermissionRequestSnapshot,
  SessionViewState,
  SessionViewTarget,
} from '../types/sessionView';

const SESSION_VIEW_STATE_STORAGE_KEY = 'sessionViewStates';

const VALID_TABS: Set<string> = IS_CODEX_ONLY_HARDENED
  ? new Set(['chat'])
  : new Set(['chat', 'files', 'shell', 'git', 'tasks', 'preview']);

type SessionViewStateRecord = Record<string, SessionViewState>;
type SessionViewStateUpdater =
  | SessionViewState
  | Partial<SessionViewState>
  | ((previousState: SessionViewState) => SessionViewState | Partial<SessionViewState>);

const SESSION_TEMPLATE_VIEW_KEY_PREFIX = 'draft:';
const SESSION_VIEW_KEY_PREFIX = 'session:';

interface UseSessionViewStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
}

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const isFiniteTimestamp = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
};

const normalizeClaudeStatus = (
  status: unknown,
): SessionViewChatRuntime['claudeStatus'] => {
  if (!status || typeof status !== 'object') {
    return null;
  }

  const parsedStatus = status as {
    text?: unknown;
    tokens?: unknown;
    can_interrupt?: unknown;
  };

  return {
    text: typeof parsedStatus.text === 'string' ? parsedStatus.text : '',
    tokens: typeof parsedStatus.tokens === 'number' && Number.isFinite(parsedStatus.tokens) ? parsedStatus.tokens : 0,
    can_interrupt: parsedStatus.can_interrupt !== false,
  };
};

const normalizePendingPermissionRequests = (
  value: unknown,
): SessionViewPendingPermissionRequestSnapshot[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (
        request,
      ): request is SessionViewPendingPermissionRequestSnapshot =>
        Boolean(request) &&
        typeof request === 'object' &&
        typeof (request as SessionViewPendingPermissionRequestSnapshot).requestId === 'string' &&
        typeof (request as SessionViewPendingPermissionRequestSnapshot).toolName === 'string',
    )
    .map((request) => ({
      requestId: request.requestId,
      toolName: request.toolName,
      input: request.input,
      context: request.context,
      sessionId: typeof request.sessionId === 'string' || request.sessionId === null ? request.sessionId : undefined,
      receivedAt: request.receivedAt,
    }));
};

const normalizeChatRuntime = (
  runtime: SessionViewChatRuntime | Partial<SessionViewChatRuntime> | null | undefined,
): SessionViewChatRuntime => {
  return {
    isLoading: Boolean(runtime?.isLoading),
    canAbortSession: Boolean(runtime?.canAbortSession),
    claudeStatus: normalizeClaudeStatus(runtime?.claudeStatus),
    tokenBudget:
      runtime?.tokenBudget && typeof runtime.tokenBudget === 'object'
        ? (runtime.tokenBudget as Record<string, unknown>)
        : null,
    pendingPermissionRequests: normalizePendingPermissionRequests(runtime?.pendingPermissionRequests),
    startedAt: isFiniteTimestamp(runtime?.startedAt) ? runtime.startedAt : null,
    updatedAt: isFiniteTimestamp(runtime?.updatedAt) ? runtime.updatedAt : Date.now(),
  };
};

const mergeMountedTabs = (mountedTabs: unknown, activeTab: AppTab): AppTab[] => {
  const dedupedTabs = new Set<AppTab>();
  dedupedTabs.add('chat');

  if (Array.isArray(mountedTabs)) {
    mountedTabs.forEach((tab) => {
      if (typeof tab === 'string' && isValidTab(tab)) {
        dedupedTabs.add(tab);
      }
    });
  }

  if (isValidTab(activeTab)) {
    dedupedTabs.add(activeTab);
  }

  if (IS_CODEX_ONLY_HARDENED) {
    return ['chat'];
  }

  return Array.from(dedupedTabs);
};

const normalizeSessionViewState = (
  value: SessionViewState | Partial<SessionViewState> | null | undefined,
  fallbackTab: AppTab = 'chat',
): SessionViewState => {
  const activeTab =
    typeof value?.activeTab === 'string' && isValidTab(value.activeTab)
      ? value.activeTab
      : fallbackTab;

  return {
    activeTab,
    mountedTabs: mergeMountedTabs(value?.mountedTabs, activeTab),
    lastVisitedAt: isFiniteTimestamp(value?.lastVisitedAt) ? value.lastVisitedAt : Date.now(),
    chatRuntime: normalizeChatRuntime(value?.chatRuntime),
  };
};

const normalizeTarget = ({ projectName, sessionId, provider }: SessionViewTarget) => {
  if (!projectName || projectName.trim().length === 0) {
    return {
      projectName: null,
      sessionId: null,
      provider: null,
    };
  }

  const normalizedSessionId =
    typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;

  return {
    projectName: projectName.trim(),
    sessionId: normalizedSessionId,
    provider: normalizedSessionId ? provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude') : null,
  };
};

const createChatRuntimeFingerprint = (runtime: SessionViewChatRuntime) => {
  return JSON.stringify({
    isLoading: runtime.isLoading,
    canAbortSession: runtime.canAbortSession,
    claudeStatus: runtime.claudeStatus,
    tokenBudget: runtime.tokenBudget,
    pendingPermissionRequests: runtime.pendingPermissionRequests,
    startedAt: runtime.startedAt,
  });
};

const hasMeaningfulRuntime = (runtime: SessionViewChatRuntime) => {
  return (
    runtime.isLoading ||
    runtime.canAbortSession ||
    runtime.claudeStatus !== null ||
    runtime.tokenBudget !== null ||
    runtime.pendingPermissionRequests.length > 0 ||
    runtime.startedAt !== null
  );
};

const mergeChatRuntime = (
  sourceRuntime: SessionViewChatRuntime,
  targetRuntime: SessionViewChatRuntime | null | undefined,
): SessionViewChatRuntime => {
  if (!targetRuntime) {
    return sourceRuntime;
  }

  if (!hasMeaningfulRuntime(targetRuntime)) {
    return sourceRuntime;
  }

  if (!hasMeaningfulRuntime(sourceRuntime)) {
    return targetRuntime;
  }

  return targetRuntime.updatedAt >= sourceRuntime.updatedAt ? targetRuntime : sourceRuntime;
};

const readPersistedSessionViewStates = (): SessionViewStateRecord => {
  try {
    const raw = localStorage.getItem(SESSION_VIEW_STATE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, SessionViewState | Partial<SessionViewState>>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce<SessionViewStateRecord>((stateRecord, [viewKey, value]) => {
      stateRecord[viewKey] = normalizeSessionViewState(value);
      return stateRecord;
    }, {});
  } catch (error) {
    console.error('Failed to parse persisted session view state, resetting:', error);
    return {};
  }
};

/**
 * 创建一个新的会话视图状态模板。
 *
 * @param activeTab 当前会话默认显示的页签；无效值会回退到 `chat`。
 * @returns 标准化后的会话视图状态，默认只挂载 `chat` 页。
 * @throws 不直接抛出异常；输入无效时自动回退到默认模板。
 */
export function createDefaultSessionViewState(activeTab: AppTab = 'chat'): SessionViewState {
  return normalizeSessionViewState({
    activeTab,
    mountedTabs: [activeTab],
    lastVisitedAt: Date.now(),
    chatRuntime: {
      isLoading: false,
      canAbortSession: false,
      claudeStatus: null,
      tokenBudget: null,
      pendingPermissionRequests: [],
      startedAt: null,
      updatedAt: Date.now(),
    },
  });
}

/**
 * 创建“会话模板页”对应的视图目标。
 *
 * @param projectName 项目名；为空时返回不可解析的模板目标。
 * @returns 指向当前项目会话模板页的视图目标，始终不绑定真实 `sessionId`。
 */
export function createSessionTemplateViewTarget(projectName: string | null | undefined): SessionViewTarget {
  return {
    projectName: projectName ?? null,
    sessionId: null,
    provider: null,
  };
}

/**
 * 判断某个视图 Key 是否指向“会话模板页”。
 *
 * @param viewKey 已持久化的视图 Key。
 * @returns `true` 表示该 Key 属于项目级会话模板页。
 */
export function isSessionTemplateViewKey(viewKey: string | null | undefined): boolean {
  return typeof viewKey === 'string' && viewKey.startsWith(SESSION_TEMPLATE_VIEW_KEY_PREFIX);
}

/**
 * 生成“会话模板页”的持久化 Key。
 *
 * @param projectName 项目名；为空时返回 `null`。
 * @returns 项目级会话模板页 Key。
 */
export function getSessionTemplateViewStateKey(projectName: string | null | undefined): string | null {
  return getSessionViewStateKey(createSessionTemplateViewTarget(projectName));
}

/**
 * 生成会话视图状态的持久化 Key。
 *
 * @param target.projectName 项目名；为空时返回 `null`。
 * @param target.sessionId 会话 ID；为空时生成该项目的会话模板页 Key。
 * @param target.provider 会话所属 provider；仅在存在真实会话 ID 时参与 Key 计算。
 * @returns 可持久化的视图 Key；若项目名不可用则返回 `null`。
 * @throws 不直接抛出异常；参数无效时返回 `null`。
 */
export function getSessionViewStateKey(target: SessionViewTarget): string | null {
  const normalizedTarget = normalizeTarget(target);
  if (!normalizedTarget.projectName) {
    return null;
  }

  if (!normalizedTarget.sessionId) {
    return `${SESSION_TEMPLATE_VIEW_KEY_PREFIX}${normalizedTarget.projectName}`;
  }

  return `${SESSION_VIEW_KEY_PREFIX}${normalizedTarget.projectName}:${normalizedTarget.provider}:${normalizedTarget.sessionId}`;
}

/**
 * 管理当前项目/会话对应的页面视图状态，并提供页签切换、挂载记录和运行时快照写回能力。
 *
 * @param args.selectedProject 当前选中的项目；为空时回退到默认聊天模板。
 * @param args.selectedSession 当前选中的会话；为空时使用项目级的新建会话模板 Key。
 * @returns 当前页签、已挂载页签、聊天运行时快照及对应更新方法。
 * @throws 不直接抛出异常；本地存储异常会记录日志并回退到内存状态。
 */
export function useSessionViewState({
  selectedProject,
  selectedSession,
}: UseSessionViewStateArgs) {
  const [sessionViewStates, setSessionViewStates] = useState<SessionViewStateRecord>(
    readPersistedSessionViewStates,
  );

  const currentViewKey = useMemo(
    () =>
      getSessionViewStateKey({
        projectName: selectedProject?.name ?? null,
        sessionId: selectedSession?.id ?? null,
        provider: selectedSession?.__provider ?? null,
      }),
    [selectedProject?.name, selectedSession?.__provider, selectedSession?.id],
  );

  const currentViewState = useMemo(() => {
    if (!currentViewKey) {
      return createDefaultSessionViewState();
    }

    return sessionViewStates[currentViewKey] || createDefaultSessionViewState();
  }, [currentViewKey, sessionViewStates]);

  const getViewStateForTarget = useCallback(
    (target: SessionViewTarget): SessionViewState => {
      const viewKey = getSessionViewStateKey(target);
      if (!viewKey) {
        return createDefaultSessionViewState();
      }

      return sessionViewStates[viewKey] || createDefaultSessionViewState();
    },
    [sessionViewStates],
  );

  const updateViewStateByKey = useCallback(
    (viewKey: string, updater: SessionViewStateUpdater) => {
      setSessionViewStates((previousStates) => {
        const previousState = previousStates[viewKey] || createDefaultSessionViewState();
        const nextValue =
          typeof updater === 'function'
            ? updater(previousState)
            : updater;
        const nextState = normalizeSessionViewState(
          {
            ...previousState,
            ...nextValue,
          },
          previousState.activeTab,
        );

        if (JSON.stringify(previousState) === JSON.stringify(nextState)) {
          return previousStates;
        }

        return {
          ...previousStates,
          [viewKey]: nextState,
        };
      });
    },
    [],
  );

  const updateCurrentViewState = useCallback(
    (updater: SessionViewStateUpdater) => {
      if (!currentViewKey) {
        return;
      }

      updateViewStateByKey(currentViewKey, updater);
    },
    [currentViewKey, updateViewStateByKey],
  );

  const setActiveTab = useCallback(
    (nextTab: AppTab | ((currentTab: AppTab) => AppTab)) => {
      updateCurrentViewState((previousState) => {
        const resolvedNextTab =
          typeof nextTab === 'function' ? nextTab(previousState.activeTab) : nextTab;
        const activeTab = isValidTab(resolvedNextTab) ? resolvedNextTab : previousState.activeTab;

        return {
          ...previousState,
          activeTab,
          mountedTabs: mergeMountedTabs(previousState.mountedTabs, activeTab),
          lastVisitedAt: Date.now(),
        };
      });
    },
    [updateCurrentViewState],
  );

  const upsertViewStateForTarget = useCallback(
    (target: SessionViewTarget, updater: SessionViewStateUpdater) => {
      const viewKey = getSessionViewStateKey(target);
      if (!viewKey) {
        return;
      }

      updateViewStateByKey(viewKey, updater);
    },
    [updateViewStateByKey],
  );

  const updateChatRuntimeByViewKey = useCallback(
    (viewKey: string, updater: SessionViewChatRuntimeUpdater) => {
      updateViewStateByKey(viewKey, (previousState) => {
        const nextRuntimeValue =
          typeof updater === 'function'
            ? updater(previousState.chatRuntime)
            : updater;

        const nextRuntime = normalizeChatRuntime({
          ...previousState.chatRuntime,
          ...nextRuntimeValue,
          updatedAt: Date.now(),
        });

        if (
          createChatRuntimeFingerprint(previousState.chatRuntime) === createChatRuntimeFingerprint(nextRuntime)
        ) {
          return previousState;
        }

        return {
          ...previousState,
          chatRuntime: nextRuntime,
          lastVisitedAt: Date.now(),
        };
      });
    },
    [updateViewStateByKey],
  );

  const updateCurrentChatRuntime = useCallback(
    (updater: SessionViewChatRuntimeUpdater) => {
      if (!currentViewKey) {
        return;
      }

      updateChatRuntimeByViewKey(currentViewKey, updater);
    },
    [currentViewKey, updateChatRuntimeByViewKey],
  );

  const getChatRuntimeForTarget = useCallback(
    (target: SessionViewTarget): SessionViewChatRuntime => {
      return getViewStateForTarget(target).chatRuntime;
    },
    [getViewStateForTarget],
  );

  const updateChatRuntimeForTarget = useCallback(
    (target: SessionViewTarget, updater: SessionViewChatRuntimeUpdater) => {
      const viewKey = getSessionViewStateKey(target);
      if (!viewKey) {
        return;
      }

      updateChatRuntimeByViewKey(viewKey, updater);
    },
    [updateChatRuntimeByViewKey],
  );

  const replaceViewStateForTarget = useCallback(
    (sourceTarget: SessionViewTarget, destinationTarget: SessionViewTarget) => {
      const sourceViewKey = getSessionViewStateKey(sourceTarget);
      const destinationViewKey = getSessionViewStateKey(destinationTarget);

      if (!sourceViewKey || !destinationViewKey || sourceViewKey === destinationViewKey) {
        return;
      }

      setSessionViewStates((previousStates) => {
        const sourceState = previousStates[sourceViewKey];
        if (!sourceState) {
          return previousStates;
        }

        const destinationState = previousStates[destinationViewKey] || null;
        const preferredState =
          destinationState && destinationState.lastVisitedAt > sourceState.lastVisitedAt
            ? destinationState
            : sourceState;
        const activeTab = preferredState.activeTab;
        const nextState = normalizeSessionViewState({
          ...(destinationState || sourceState),
          activeTab,
          mountedTabs: mergeMountedTabs(
            [...sourceState.mountedTabs, ...(destinationState?.mountedTabs || [])],
            activeTab,
          ),
          lastVisitedAt: Math.max(sourceState.lastVisitedAt, destinationState?.lastVisitedAt || 0),
          chatRuntime: mergeChatRuntime(sourceState.chatRuntime, destinationState?.chatRuntime),
        }, activeTab);

        const nextStates = {
          ...previousStates,
          [destinationViewKey]: nextState,
        };

        delete nextStates[sourceViewKey];
        return nextStates;
      });
    },
    [],
  );

  const removeViewStateForTarget = useCallback((target: SessionViewTarget) => {
    const viewKey = getSessionViewStateKey(target);
    if (!viewKey) {
      return;
    }

    setSessionViewStates((previousStates) => {
      if (!previousStates[viewKey]) {
        return previousStates;
      }

      const nextStates = { ...previousStates };
      delete nextStates[viewKey];
      return nextStates;
    });
  }, []);

  const removeViewStatesForProject = useCallback((projectName: string) => {
    const templateViewKey = getSessionTemplateViewStateKey(projectName);

    setSessionViewStates((previousStates) => {
      const nextEntries = Object.entries(previousStates).filter(([viewKey]) => {
        return viewKey !== templateViewKey && !viewKey.startsWith(`${SESSION_VIEW_KEY_PREFIX}${projectName}:`);
      });

      if (nextEntries.length === Object.keys(previousStates).length) {
        return previousStates;
      }

      return Object.fromEntries(nextEntries);
    });
  }, []);

  useEffect(() => {
    try {
      if (Object.keys(sessionViewStates).length === 0) {
        localStorage.removeItem(SESSION_VIEW_STATE_STORAGE_KEY);
        return;
      }

      localStorage.setItem(SESSION_VIEW_STATE_STORAGE_KEY, JSON.stringify(sessionViewStates));
    } catch (error) {
      console.error('Failed to persist session view states:', error);
    }
  }, [sessionViewStates]);

  return {
    activeTab: currentViewState.activeTab,
    mountedTabs: currentViewState.mountedTabs,
    currentChatRuntime: currentViewState.chatRuntime,
    getViewStateForTarget,
    getChatRuntimeForTarget,
    setActiveTab,
    updateCurrentViewState,
    updateCurrentChatRuntime,
    updateChatRuntimeForTarget,
    upsertViewStateForTarget,
    replaceViewStateForTarget,
    removeViewStateForTarget,
    removeViewStatesForProject,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../constants/config';
import {
  createDefaultSessionViewState,
  createSessionTemplateViewTarget,
  useSessionViewState,
} from './useSessionViewState';
import type { SessionDeleteConfirmation } from '../components/sidebar/types/types';
import type {
  AppSocketMessage,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
  SessionProvider,
} from '../types/app';
import type { SessionViewChatRuntime } from '../types/sessionView';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

const RECENT_SESSION_STORAGE_KEY = 'recentSessionIds';
const MAX_RECENT_SESSIONS = 6;
const TEMPORARY_SESSION_PREFIX = 'new-session-';

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const readResponseErrorMessage = async (response: Response, fallbackMessage: string): Promise<string> => {
  try {
    const responseText = await response.text();
    if (!responseText.trim()) {
      return fallbackMessage;
    }

    try {
      const parsedError = JSON.parse(responseText) as { error?: string; details?: string };
      return parsedError.error || parsedError.details || fallbackMessage;
    } catch {
      return responseText;
    }
  } catch {
    return fallbackMessage;
  }
};

const resolveSessionDeleteProvider = (provider?: SessionProvider): SessionProvider =>
  provider || (IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude');

type SessionDeleteResult = {
  success: boolean;
  error: string | null;
};

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isHidden) !== Boolean(prevProject.isHidden) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions)
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  if (IS_CODEX_ONLY_HARDENED) {
    return [...(project.codexSessions ?? [])];
  }

  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
  ];
};

const findProjectSessionById = (
  project: Project,
  targetSessionId: string,
): { session: ProjectSession; provider: 'claude' | 'codex' | 'cursor' | 'gemini' } | null => {
  const codexSession = project.codexSessions?.find((session) => session.id === targetSessionId);
  if (codexSession) {
    return { session: codexSession, provider: 'codex' };
  }

  if (!IS_CODEX_ONLY_HARDENED) {
    const claudeSession = project.sessions?.find((session) => session.id === targetSessionId);
    if (claudeSession) {
      return { session: claudeSession, provider: 'claude' };
    }

    const cursorSession = project.cursorSessions?.find((session) => session.id === targetSessionId);
    if (cursorSession) {
      return { session: cursorSession, provider: 'cursor' };
    }

    const geminiSession = project.geminiSessions?.find((session) => session.id === targetSessionId);
    if (geminiSession) {
      return { session: geminiSession, provider: 'gemini' };
    }
  }

  return null;
};

const isTemporarySessionId = (sessionId?: string | null) =>
  Boolean(sessionId && sessionId.startsWith(TEMPORARY_SESSION_PREFIX));

const hasInFlightSessionSelection = (
  selectedSession: ProjectSession | null,
  activeSessions: Set<string>,
  routeSessionId?: string,
): boolean => {
  if (selectedSession?.id && activeSessions.has(selectedSession.id)) {
    return true;
  }

  if (
    routeSessionId &&
    selectedSession?.id &&
    routeSessionId !== selectedSession.id &&
    (isTemporarySessionId(routeSessionId) || isTemporarySessionId(selectedSession.id))
  ) {
    return true;
  }

  return Array.from(activeSessions).some((sessionId) => sessionId.startsWith(TEMPORARY_SESSION_PREFIX));
};

const mergeTemporaryCodexSessions = (currentProjects: Project[], updatedProjects: Project[]): Project[] => {
  return updatedProjects.map((project) => {
    const currentProject = currentProjects.find((existingProject) => existingProject.name === project.name);
    const temporaryCodexSessions =
      currentProject?.codexSessions?.filter((session) => isTemporarySessionId(session.id)) ?? [];

    if (temporaryCodexSessions.length === 0) {
      return project;
    }

    const nextCodexSessions = [...temporaryCodexSessions];
    for (const session of project.codexSessions ?? []) {
      if (!nextCodexSessions.some((temporarySession) => temporarySession.id === session.id)) {
        nextCodexSessions.push(session);
      }
    }

    return {
      ...project,
      codexSessions: nextCodexSessions,
    };
  });
};

const upsertCodexSession = (project: Project, session: ProjectSession): Project => {
  const existingSessions = project.codexSessions ?? [];
  const dedupedSessions = existingSessions.filter((existingSession) => existingSession.id !== session.id);

  return {
    ...project,
    codexSessions: [session, ...dedupedSessions],
  };
};

const replaceCodexSessionId = (
  project: Project,
  temporarySessionId: string,
  realSessionId: string,
): Project => {
  const existingSessions = project.codexSessions ?? [];
  const nextSessions = existingSessions.map((session) =>
    session.id === temporarySessionId
      ? {
          ...session,
          id: realSessionId,
          __provider: 'codex' as const,
          updated_at: new Date().toISOString(),
        }
      : session,
  );

  const dedupedSessions: ProjectSession[] = [];
  for (const session of nextSessions) {
    if (!dedupedSessions.some((existingSession) => existingSession.id === session.id)) {
      dedupedSessions.push(session);
    }
  }

  return {
    ...project,
    codexSessions: dedupedSessions,
  };
};

const readRecentSessionIds = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_SESSION_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0);
  } catch {
    return [];
  }
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [recentSessionIds, setRecentSessionIds] = useState<string[]>(readRecentSessionIds);
  const projectsRef = useRef<Project[]>([]);
  const selectedProjectRef = useRef<Project | null>(null);
  const selectedSessionRef = useRef<ProjectSession | null>(null);
  const lastTemplateRouteResetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  const {
    activeTab,
    mountedTabs,
    currentChatRuntime,
    getViewStateForTarget,
    getChatRuntimeForTarget,
    setActiveTab,
    updateCurrentChatRuntime,
    updateChatRuntimeForTarget,
    upsertViewStateForTarget,
    replaceViewStateForTarget,
    removeViewStateForTarget,
    removeViewStatesForProject,
  } = useSessionViewState({
    selectedProject,
    selectedSession,
  });

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_SESSION_STORAGE_KEY, JSON.stringify(recentSessionIds));
    } catch {
      // localStorage unavailable
    }
  }, [recentSessionIds]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  const [sessionDeleteConfirmation, setSessionDeleteConfirmation] = useState<SessionDeleteConfirmation | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recordRecentSession = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setRecentSessionIds((previous) => {
      if (previous.includes(sessionId)) {
        return previous;
      }

      return [...previous, sessionId].slice(-MAX_RECENT_SESSIONS);
    });
  }, []);

  const dismissRecentSession = useCallback((sessionIdToDismiss: string) => {
    setRecentSessionIds((previous) =>
      previous.filter((existingSessionId) => existingSessionId !== sessionIdToDismiss),
    );
  }, []);

  const requestSessionDelete = useCallback(
    (
      projectName: string,
      sessionId: string,
      sessionTitle: string,
      provider: SessionProvider,
    ) => {
      setSessionDeleteConfirmation({
        projectName,
        sessionId,
        sessionTitle,
        provider: resolveSessionDeleteProvider(provider),
      });
    },
    [],
  );

  const cancelSessionDelete = useCallback(() => {
    if (isDeletingSession) {
      return;
    }

    setSessionDeleteConfirmation(null);
  }, [isDeletingSession]);

  const resetSessionTemplateViewState = useCallback(
    (projectName: string) => {
      upsertViewStateForTarget(
        createSessionTemplateViewTarget(projectName),
        createDefaultSessionViewState('chat'),
      );
    },
    [upsertViewStateForTarget],
  );

  const clearSessionTemplatePendingMarkers = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    sessionStorage.removeItem('pendingSessionId');
    sessionStorage.removeItem('cursorSessionId');
  }, []);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      setProjects((prevProjects) => {
        const mergedProjects = mergeTemporaryCodexSessions(prevProjects, projectData);

        if (prevProjects.length === 0) {
          return mergedProjects;
        }

        return projectsHaveChanges(prevProjects, mergedProjects, !IS_CODEX_ONLY_HARDENED)
          ? mergedProjects
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  // The root route is the session template page, so it must not keep a stale real session bound.
  useEffect(() => {
    const hasConcreteSessionRoute =
      typeof window !== 'undefined' && /\/session\/[^/]+/.test(window.location.pathname);

    if (sessionId || hasConcreteSessionRoute) {
      lastTemplateRouteResetKeyRef.current = null;
      return;
    }

    if (selectedSession?.id) {
      setSelectedSession(null);
      return;
    }

    if (!selectedProject?.name) {
      return;
    }

    const templateRouteResetKey = selectedProject.name;
    if (lastTemplateRouteResetKeyRef.current === templateRouteResetKey) {
      return;
    }

    lastTemplateRouteResetKeyRef.current = templateRouteResetKey;
    clearSessionTemplatePendingMarkers();
    resetSessionTemplateViewState(selectedProject.name);
  }, [
    clearSessionTemplatePendingMarkers,
    resetSessionTemplateViewState,
    selectedProject?.name,
    selectedSession?.id,
    sessionId,
  ]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;
    const currentProjects = projectsRef.current;
    const currentSelectedProject = selectedProjectRef.current;
    const currentSelectedSession = selectedSessionRef.current;

    if (projectsMessage.changedFile && currentSelectedSession && currentSelectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const changedFileParts = normalized.split('/');

      if (changedFileParts.length >= 2) {
        const filename = changedFileParts[changedFileParts.length - 1];
        const changedSessionId = filename.replace('.jsonl', '');

        if (changedSessionId === currentSelectedSession.id) {
          const isSessionActive = activeSessions.has(currentSelectedSession.id);

          if (!isSessionActive) {
            setExternalMessageUpdate((prev) => prev + 1);
          }
        }
      }
    }

    const updatedProjects = mergeTemporaryCodexSessions(currentProjects, projectsMessage.projects);
    setProjects(updatedProjects);
    const shouldFreezeSelectedBinding = hasInFlightSessionSelection(
      currentSelectedSession,
      activeSessions,
      sessionId,
    );

    if (!currentSelectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.name === currentSelectedProject.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (
      !shouldFreezeSelectedBinding &&
      serialize(updatedSelectedProject) !== serialize(currentSelectedProject)
    ) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!currentSelectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === currentSelectedSession.id,
    );
    const shouldPreserveRouteSelection =
      Boolean(sessionId) && currentSelectedSession.id === sessionId;

    if (!updatedSelectedSession) {
      if (!shouldFreezeSelectedBinding && !shouldPreserveRouteSelection) {
        setSelectedSession(null);
      }
      return;
    }

    const normalizedUpdatedSelectedSession =
      updatedSelectedSession.__provider || !currentSelectedSession.__provider
        ? updatedSelectedSession
        : { ...updatedSelectedSession, __provider: currentSelectedSession.__provider };

    if (
      !shouldFreezeSelectedBinding &&
      serialize(normalizedUpdatedSelectedSession) !== serialize(currentSelectedSession)
    ) {
      setSelectedSession(normalizedUpdatedSelectedSession);
    }
  }, [latestMessage, activeSessions]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    for (const project of projects) {
      const codexSession = project.codexSessions?.find((session) => session.id === sessionId);
      if (codexSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'codex';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...codexSession, __provider: 'codex' });
        }
        return;
      }

      if (IS_CODEX_ONLY_HARDENED) {
        continue;
      }

      const claudeSession = project.sessions?.find((session) => session.id === sessionId);
      if (claudeSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'claude';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...claudeSession, __provider: 'claude' });
        }
        return;
      }

      const cursorSession = project.cursorSessions?.find((session) => session.id === sessionId);
      if (cursorSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'cursor';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...cursorSession, __provider: 'cursor' });
        }
        return;
      }

      const geminiSession = project.geminiSessions?.find((session) => session.id === sessionId);
      if (geminiSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'gemini';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...geminiSession, __provider: 'gemini' });
        }
        return;
      }
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  useEffect(() => {
    if (selectedSession?.id) {
      recordRecentSession(selectedSession.id);
    }
  }, [recordRecentSession, selectedSession?.id]);

  const openProjectTemplatePage = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      clearSessionTemplatePendingMarkers();
      resetSessionTemplateViewState(project.name);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [clearSessionTemplatePendingMarkers, isMobile, navigate, resetSessionTemplateViewState],
  );

  const handleProjectSelect = useCallback(
    (project: Project) => {
      openProjectTemplatePage(project);
    },
    [openProjectTemplatePage],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);
      recordRecentSession(session.id);

      if (!IS_CODEX_ONLY_HARDENED && session.__provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) {
        const sessionProjectName = session.__projectName;
        const currentProjectName = selectedProject?.name;

        if (sessionProjectName !== currentProjectName) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [isMobile, navigate, recordRecentSession, selectedProject?.name],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      openProjectTemplatePage(project);
    },
    [openProjectTemplatePage],
  );

  const createOptimisticSession = useCallback(
    (
      project: Project,
      session: ProjectSession,
      initialChatRuntime?: Partial<SessionViewChatRuntime>,
    ) => {
      const templateViewState = getViewStateForTarget(createSessionTemplateViewTarget(project.name));
      const templateChatRuntime = getChatRuntimeForTarget(createSessionTemplateViewTarget(project.name));
      const optimisticSession = {
        ...session,
        __provider: 'codex' as const,
        __projectName: project.name,
      };

      setProjects((prevProjects) =>
        prevProjects.map((existingProject) =>
          existingProject.name === project.name
            ? upsertCodexSession(existingProject, optimisticSession)
            : existingProject,
        ),
      );
      upsertViewStateForTarget(
        {
          projectName: project.name,
          sessionId: optimisticSession.id,
          provider: optimisticSession.__provider || 'codex',
        },
        {
          activeTab: templateViewState.activeTab,
          mountedTabs: templateViewState.mountedTabs,
          lastVisitedAt: Date.now(),
          chatRuntime: {
            ...templateChatRuntime,
            ...initialChatRuntime,
            updatedAt: Date.now(),
          },
        },
      );
      setSelectedProject(project);
      setSelectedSession(optimisticSession);
      navigate(`/session/${optimisticSession.id}`);

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [getChatRuntimeForTarget, getViewStateForTarget, isMobile, navigate, upsertViewStateForTarget],
  );

  const replaceOptimisticSession = useCallback(
    (temporarySessionId: string | null | undefined, realSessionId: string) => {
      if (!realSessionId) {
        return;
      }

      if (!temporarySessionId || !isTemporarySessionId(temporarySessionId)) {
        setSelectedSession((previousSession) =>
          previousSession
            ? {
                ...previousSession,
                id: realSessionId,
                __provider: 'codex',
              }
            : previousSession,
        );
        navigate(`/session/${realSessionId}`);
        return;
      }

      const projectName =
        selectedSessionRef.current?.__projectName ||
        selectedProjectRef.current?.name ||
        projectsRef.current.find((project) =>
          (project.codexSessions ?? []).some((session) => session.id === temporarySessionId),
        )?.name ||
        null;

      if (projectName) {
        replaceViewStateForTarget(
          {
            projectName,
            sessionId: temporarySessionId,
            provider: 'codex',
          },
          {
            projectName,
            sessionId: realSessionId,
            provider: 'codex',
          },
        );
      }

      setRecentSessionIds((previous) => {
        const nextSessionIds = previous.map((sessionId) =>
          sessionId === temporarySessionId ? realSessionId : sessionId,
        );
        if (!nextSessionIds.includes(realSessionId)) {
          nextSessionIds.push(realSessionId);
        }
        return Array.from(new Set(nextSessionIds)).slice(-MAX_RECENT_SESSIONS);
      });

      setProjects((prevProjects) =>
        prevProjects.map((project) => {
          if (!(project.codexSessions ?? []).some((session) => session.id === temporarySessionId)) {
            return project;
          }

          return replaceCodexSessionId(project, temporarySessionId, realSessionId);
        }),
      );

      setSelectedSession((previousSession) =>
        previousSession?.id === temporarySessionId
          ? {
              ...previousSession,
              id: realSessionId,
              __provider: 'codex',
            }
          : previousSession,
      );

      navigate(`/session/${realSessionId}`);
    },
    [navigate, replaceViewStateForTarget],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      const currentSelectedSessionId = selectedSessionRef.current?.id || null;
      const matchedProjectName =
        currentSelectedSessionId === sessionIdToDelete
          ? selectedProjectRef.current?.name || null
          : projectsRef.current.find((project) =>
              getProjectSessions(project).some((session) => session.id === sessionIdToDelete),
            )?.name || null;

      if (typeof window !== 'undefined') {
        if (sessionStorage.getItem('pendingSessionId') === sessionIdToDelete) {
          sessionStorage.removeItem('pendingSessionId');
        }

        if (sessionStorage.getItem('cursorSessionId') === sessionIdToDelete) {
          sessionStorage.removeItem('cursorSessionId');
        }
      }

      if (currentSelectedSessionId === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      if (matchedProjectName) {
        removeViewStateForTarget({
          projectName: matchedProjectName,
          sessionId: sessionIdToDelete,
          provider: 'codex',
        });
        removeViewStateForTarget({
          projectName: matchedProjectName,
          sessionId: sessionIdToDelete,
          provider: 'claude',
        });
        removeViewStateForTarget({
          projectName: matchedProjectName,
          sessionId: sessionIdToDelete,
          provider: 'cursor',
        });
        removeViewStateForTarget({
          projectName: matchedProjectName,
          sessionId: sessionIdToDelete,
          provider: 'gemini',
        });
      }

      dismissRecentSession(sessionIdToDelete);

      setProjects((prevProjects) =>
        prevProjects.map((project) => ({
          ...project,
          sessions: project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          codexSessions: project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          cursorSessions: project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          geminiSessions: project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          sessionMeta: {
            ...project.sessionMeta,
            total: Math.max(0, (project.sessionMeta?.total as number | undefined ?? 0) - 1),
          },
        })),
      );
    },
    [dismissRecentSession, navigate, removeViewStateForTarget],
  );

  const confirmSessionDelete = useCallback(async (): Promise<SessionDeleteResult> => {
    if (!sessionDeleteConfirmation || isDeletingSession) {
      return { success: false, error: null };
    }

    const { projectName, sessionId, provider } = sessionDeleteConfirmation;
    setIsDeletingSession(true);

    try {
      let response: Response;

      if (provider === 'codex') {
        response = await api.deleteCodexSession(sessionId);
      } else if (provider === 'gemini') {
        response = await api.deleteGeminiSession(sessionId);
      } else {
        response = await api.deleteSession(projectName, sessionId);
      }

      if (!response.ok) {
        const errorText = await readResponseErrorMessage(response, 'Failed to delete session. Please try again.');
        console.error('[ProjectsState] Failed to delete session:', {
          projectName,
          sessionId,
          provider,
          status: response.status,
          error: errorText,
        });
        return { success: false, error: errorText };
      }

      setSessionDeleteConfirmation(null);
      handleSessionDelete(sessionId);
      return { success: true, error: null };
    } catch (error) {
      console.error('[ProjectsState] Error deleting session:', {
        projectName,
        sessionId,
        provider,
        error,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Error deleting session. Please try again.',
      };
    } finally {
      setIsDeletingSession(false);
    }
  }, [handleSessionDelete, isDeletingSession, sessionDeleteConfirmation]);

  const confirmSessionDeleteWithFeedback = useCallback(async () => {
    const result = await confirmSessionDelete();
    if (result.error && typeof window !== 'undefined') {
      window.alert(result.error);
    }
  }, [confirmSessionDelete]);

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];
      const mergedProjects = mergeTemporaryCodexSessions(projectsRef.current, freshProjects);
      const currentSelectedProject = selectedProjectRef.current;
      const currentSelectedSession = selectedSessionRef.current;
      const shouldFreezeSelectedBinding = hasInFlightSessionSelection(
        currentSelectedSession,
        activeSessions,
        sessionId,
      );

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, mergedProjects, !IS_CODEX_ONLY_HARDENED) ? mergedProjects : prevProjects,
      );

      if (!currentSelectedProject) {
        return;
      }

      const refreshedProject = mergedProjects.find((project) => project.name === currentSelectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (
        !shouldFreezeSelectedBinding &&
        serialize(refreshedProject) !== serialize(currentSelectedProject)
      ) {
        setSelectedProject(refreshedProject);
      }

      if (!currentSelectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === currentSelectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !currentSelectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: currentSelectedSession.__provider };

        if (
          !shouldFreezeSelectedBinding &&
          serialize(normalizedRefreshedSession) !== serialize(currentSelectedSession)
        ) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [activeSessions]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      removeViewStatesForProject(projectName);
      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, removeViewStatesForProject, selectedProject?.name],
  );

  const handleProjectHide = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      removeViewStatesForProject(projectName);
      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, removeViewStatesForProject, selectedProject?.name],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: requestSessionDelete,
      onProjectDelete: handleProjectDelete,
      onProjectHide: handleProjectHide,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      sessionDeleteConfirmation,
      isDeletingSession,
      onCancelDeleteSession: cancelSessionDelete,
      onConfirmDeleteSession: confirmSessionDeleteWithFeedback,
      isMobile,
    }),
    [
      cancelSessionDelete,
      confirmSessionDeleteWithFeedback,
      handleNewSession,
      handleProjectDelete,
      handleProjectHide,
      handleProjectSelect,
      requestSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      isDeletingSession,
      settingsInitialTab,
      sessionDeleteConfirmation,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  const recentSessions = useMemo(() => {
    const sessionEntries = recentSessionIds
      .map((recentSessionId) => {
        for (const project of projects) {
          const match = findProjectSessionById(project, recentSessionId);
          if (!match) {
            continue;
          }

          return {
            sessionId: match.session.id,
            sessionTitle: match.session.title || match.session.summary || match.session.name || 'Untitled session',
            projectName: project.displayName,
            provider: match.provider,
            isProcessing: false,
            hasUnread: false,
          };
        }

        return null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    return sessionEntries;
  }, [projects, recentSessionIds]);

  return {
    projects,
    recentSessions,
    selectedProject,
    selectedSession,
    activeTab,
    mountedTabs,
    currentChatRuntime,
    getViewStateForTarget,
    getChatRuntimeForTarget,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    sessionDeleteConfirmation,
    isDeletingSession,
    setActiveTab,
    updateCurrentChatRuntime,
    updateChatRuntimeForTarget,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    createOptimisticSession,
    replaceOptimisticSession,
    dismissRecentSession,
    requestSessionDelete,
    cancelSessionDelete,
    confirmSessionDelete,
    handleSessionDelete,
    handleProjectDelete,
    handleProjectHide,
    handleSidebarRefresh,
  };
}

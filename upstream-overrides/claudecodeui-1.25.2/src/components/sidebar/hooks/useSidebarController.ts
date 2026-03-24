import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { TFunction } from 'i18next';
import { api } from '../../../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import type {
  AdditionalSessionsByProject,
  DeleteProjectConfirmation,
  HiddenProjectSummary,
  LoadingSessionsByProject,
  ProjectSortOrder,
  SessionWithProvider,
} from '../types/types';
import {
  filterProjects,
  getAllSessions,
  loadStarredProjects,
  persistStarredProjects,
  readProjectSortOrder,
  sortProjects,
} from '../utils/utils';

type SnippetHighlight = {
  start: number;
  end: number;
};

type ConversationMatch = {
  role: string;
  snippet: string;
  highlights: SnippetHighlight[];
  timestamp: string | null;
  provider?: string;
  messageUuid?: string | null;
};

type ConversationSession = {
  sessionId: string;
  sessionSummary: string;
  provider?: string;
  matches: ConversationMatch[];
};

type ConversationProjectResult = {
  projectName: string;
  projectDisplayName: string;
  sessions: ConversationSession[];
};

export type ConversationSearchResults = {
  results: ConversationProjectResult[];
  totalMatches: number;
  query: string;
};

export type SearchProgress = {
  scannedProjects: number;
  totalProjects: number;
};

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

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onProjectDelete?: (projectName: string) => void;
  onProjectHide?: (projectName: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onProjectDelete,
  onProjectHide,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [loadingSessions, setLoadingSessions] = useState<LoadingSessionsByProject>({});
  const [additionalSessions, setAdditionalSessions] = useState<AdditionalSessionsByProject>({});
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projectHasMoreOverrides, setProjectHasMoreOverrides] = useState<Record<string, boolean>>({});
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [sessionNameOverrides, setSessionNameOverrides] = useState<Record<string, string>>({});
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteProjectConfirmation | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [starredProjects, setStarredProjects] = useState<Set<string>>(() => loadStarredProjects());
  const [showHiddenProjects, setShowHiddenProjects] = useState(false);
  const [hiddenProjectNamesInFlight, setHiddenProjectNamesInFlight] = useState<Set<string>>(new Set());
  const [searchMode, setSearchMode] = useState<'projects' | 'conversations'>('projects');
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setAdditionalSessions({});
    setInitialSessionsLoaded(new Set());
    setProjectHasMoreOverrides({});
  }, [projects]);

  useEffect(() => {
    if (selectedProject) {
      setExpandedProjects((prev) => {
        if (prev.has(selectedProject.name)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(selectedProject.name);
        return next;
      });
    }
  }, [selectedSession, selectedProject]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      setInitialSessionsLoaded(new Set(projects.map((project) => project.name)));
    }
  }, [projects, isLoading]);

  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'claude-settings') {
        loadSortOrder();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    const interval = setInterval(() => {
      if (document.hasFocus()) {
        loadSortOrder();
      }
    }, 1000);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(interval);
    };
  }, []);

  // Debounced conversation search with SSE streaming
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const query = searchFilter.trim();
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const seq = ++searchSeqRef.current;

    searchTimeoutRef.current = setTimeout(() => {
      if (seq !== searchSeqRef.current) return;

      const url = api.searchConversationsUrl(query);
      const es = new EventSource(url);
      eventSourceRef.current = es;

      const accumulated: ConversationProjectResult[] = [];
      let totalMatches = 0;

      es.addEventListener('result', (evt) => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        try {
          const data = JSON.parse(evt.data) as {
            projectResult: ConversationProjectResult;
            totalMatches: number;
            scannedProjects: number;
            totalProjects: number;
          };
          accumulated.push(data.projectResult);
          totalMatches = data.totalMatches;
          setConversationResults({ results: [...accumulated], totalMatches, query });
          setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
        } catch {
          // Ignore malformed SSE data
        }
      });

      es.addEventListener('progress', (evt) => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        try {
          const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
          totalMatches = data.totalMatches;
          setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
        } catch {
          // Ignore malformed SSE data
        }
      });

      es.addEventListener('done', () => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        es.close();
        eventSourceRef.current = null;
        setIsSearching(false);
        setSearchProgress(null);
        if (accumulated.length === 0) {
          setConversationResults({ results: [], totalMatches: 0, query });
        }
      });

      es.addEventListener('error', () => {
        if (seq !== searchSeqRef.current) { es.close(); return; }
        es.close();
        eventSourceRef.current = null;
        setIsSearching(false);
        setSearchProgress(null);
        if (accumulated.length === 0) {
          setConversationResults({ results: [], totalMatches: 0, query });
        }
      });
    }, 400);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [searchFilter, searchMode]);

  const handleTouchClick = useCallback(
    (callback: () => void) =>
      (event: React.TouchEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        if (target.closest('.overflow-y-auto') || target.closest('[data-scroll-container]')) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        callback();
      },
    [],
  );

  const toggleProject = useCallback((projectName: string) => {
    setExpandedProjects((prev) => {
      const next = new Set<string>();
      if (!prev.has(projectName)) {
        next.add(projectName);
      }
      return next;
    });
  }, []);

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectName: string) => {
      onSessionSelect({ ...session, __projectName: projectName });
    },
    [onSessionSelect],
  );

  const toggleStarProject = useCallback((projectName: string) => {
    setStarredProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }

      persistStarredProjects(next);
      return next;
    });
  }, []);

  const isProjectStarred = useCallback(
    (projectName: string) => starredProjects.has(projectName),
    [starredProjects],
  );

  const getProjectSessions = useCallback(
    (project: Project) =>
      getAllSessions(project, additionalSessions).map((session) => {
        const overriddenName = sessionNameOverrides[session.id];
        if (!overriddenName) {
          return session;
        }

        return {
          ...session,
          title: overriddenName,
          summary: overriddenName,
          name: overriddenName,
        };
      }),
    [additionalSessions, sessionNameOverrides],
  );

  const effectiveHiddenProjectNames = useMemo(() => {
    return new Set(
      projects
        .filter((project) => project.isHidden)
        .map((project) => project.name),
    );
  }, [projects]);

  const projectsWithSessionMeta = useMemo(
    () =>
      projects.map((project) => {
        const hasMoreOverride = projectHasMoreOverrides[project.name];
        if (hasMoreOverride === undefined) {
          return project;
        }

        return {
          ...project,
          sessionMeta: { ...project.sessionMeta, hasMore: hasMoreOverride },
        };
      }),
    [projectHasMoreOverrides, projects],
  );

  const hiddenProjects = useMemo<HiddenProjectSummary[]>(
    () => projects.filter((project) => effectiveHiddenProjectNames.has(project.name)),
    [effectiveHiddenProjectNames, projects],
  );

  const visibleProjects = useMemo(
    () => projectsWithSessionMeta.filter((project) => !effectiveHiddenProjectNames.has(project.name)),
    [effectiveHiddenProjectNames, projectsWithSessionMeta],
  );

  const sortedProjects = useMemo(
    () => sortProjects(visibleProjects, projectSortOrder, starredProjects, additionalSessions),
    [additionalSessions, projectSortOrder, starredProjects, visibleProjects],
  );

  const filteredProjects = useMemo(
    () => filterProjects(sortedProjects, searchFilter),
    [searchFilter, sortedProjects],
  );

  const startEditing = useCallback((project: Project) => {
    setEditingProject(project.name);
    setEditingName(project.displayName);
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingProject(null);
    setEditingName('');
  }, []);

  const saveProjectName = useCallback(
    async (projectName: string) => {
      if (IS_CODEX_ONLY_HARDENED) {
        setEditingProject(null);
        setEditingName('');
        return;
      }

      try {
        const response = await api.renameProject(projectName, editingName);
        if (response.ok) {
          if (window.refreshProjects) {
            await window.refreshProjects();
          } else {
            window.location.reload();
          }
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setEditingProject(null);
        setEditingName('');
      }
    },
    [editingName],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      projectName: string,
      sessionId: string,
      sessionTitle: string,
      provider: SessionProvider = 'claude',
    ) => {
      onSessionDelete?.(projectName, sessionId, sessionTitle, provider);
    },
    [onSessionDelete],
  );

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setDeleteConfirmation({
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteConfirmation) {
      return;
    }

    if (IS_CODEX_ONLY_HARDENED) {
      setDeleteConfirmation(null);
      return;
    }

    const { project, sessionCount } = deleteConfirmation;
    const isEmpty = sessionCount === 0;

    setDeleteConfirmation(null);
    setDeletingProjects((prev) => new Set([...prev, project.name]));

    try {
      const response = await api.deleteProject(project.name, !isEmpty);

      if (response.ok) {
        onProjectDelete?.(project.name);
      } else {
        const error = (await response.json()) as { error?: string };
        alert(error.error || t('messages.deleteProjectFailed'));
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.name);
        return next;
      });
    }
  }, [deleteConfirmation, onProjectDelete, t]);

  const loadMoreSessions = useCallback(
    async (project: Project) => {
      if (IS_CODEX_ONLY_HARDENED) {
        return;
      }

      const hasMoreOverride = projectHasMoreOverrides[project.name];
      const canLoadMore =
        hasMoreOverride !== undefined ? hasMoreOverride : project.sessionMeta?.hasMore === true;
      if (!canLoadMore || loadingSessions[project.name]) {
        return;
      }

      setLoadingSessions((prev) => ({ ...prev, [project.name]: true }));

      try {
        const currentSessionCount =
          (project.sessions?.length || 0) + (additionalSessions[project.name]?.length || 0);
        const response = await api.sessions(project.name, 5, currentSessionCount);

        if (!response.ok) {
          return;
        }

        const result = (await response.json()) as {
          sessions?: ProjectSession[];
          hasMore?: boolean;
        };

        setAdditionalSessions((prev) => ({
          ...prev,
          [project.name]: [...(prev[project.name] || []), ...(result.sessions || [])],
        }));

        if (result.hasMore === false) {
          // Keep hasMore state in local hook state instead of mutating the project prop object.
          setProjectHasMoreOverrides((prev) => ({ ...prev, [project.name]: false }));
        }
      } catch (error) {
        console.error('Error loading more sessions:', error);
      } finally {
        setLoadingSessions((prev) => ({ ...prev, [project.name]: false }));
      }
    },
    [additionalSessions, loadingSessions, projectHasMoreOverrides],
  );

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh]);

  const updateSessionSummary = useCallback(
    async (_projectName: string, sessionId: string, summary: string, provider: SessionProvider) => {
      const canRenameSession = !IS_CODEX_ONLY_HARDENED || provider === 'codex';
      if (!canRenameSession) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }

      const trimmed = summary.trim();
      if (!trimmed) {
        setEditingSession(null);
        setEditingSessionName('');
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed, provider);
        if (response.ok) {
          setSessionNameOverrides((previous) => ({
            ...previous,
            [sessionId]: trimmed,
          }));
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setEditingSession(null);
        setEditingSessionName('');
      }
    },
    [onRefresh, t],
  );

  const hideProjectFromSidebar = useCallback(async (project: Project) => {
    setHiddenProjectNamesInFlight((previous) => {
      const next = new Set(previous);
      next.add(project.name);
      return next;
    });

    try {
      const response = await api.setProjectHiddenState(project.name, true);
      if (!response.ok) {
        const errorText = await readResponseErrorMessage(response, t('messages.hideProjectFailed'));
        console.error('[Sidebar] Failed to hide project:', {
          projectName: project.name,
          status: response.status,
          error: errorText,
        });
        alert(errorText);
        return;
      }

      onProjectHide?.(project.name);
      await onRefresh();
    } catch (error) {
      console.error('[Sidebar] Error hiding project:', error);
      alert(t('messages.hideProjectError'));
    } finally {
      setHiddenProjectNamesInFlight((previous) => {
        const next = new Set(previous);
        next.delete(project.name);
        return next;
      });
    }
  }, [onProjectHide, onRefresh, t]);

  const restoreHiddenProject = useCallback(async (projectName: string) => {
    setHiddenProjectNamesInFlight((previous) => {
      const next = new Set(previous);
      next.add(projectName);
      return next;
    });

    try {
      const response = await api.setProjectHiddenState(projectName, false);
      if (!response.ok) {
        const errorText = await readResponseErrorMessage(response, t('messages.restoreProjectFailed'));
        console.error('[Sidebar] Failed to restore project:', {
          projectName,
          status: response.status,
          error: errorText,
        });
        alert(errorText);
        return;
      }

      await onRefresh();
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError'));
    } finally {
      setHiddenProjectNamesInFlight((previous) => {
        const next = new Set(previous);
        next.delete(projectName);
        return next;
      });
    }
  }, [onRefresh, t]);

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    loadingSessions,
    additionalSessions,
    initialSessionsLoaded,
    currentTime,
    projectSortOrder,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    deletingProjects,
    deleteConfirmation,
    showHiddenProjects,
    hiddenProjects,
    hiddenProjectNamesInFlight,
    showVersionModal,
    starredProjects,
    filteredProjects,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    hideProjectFromSidebar,
    restoreHiddenProject,
    requestProjectDelete,
    confirmDeleteProject,
    loadMoreSessions,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults: useCallback(() => {
      searchSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults(null);
    }, []),
    setSearchFilter,
    setDeleteConfirmation,
    setShowHiddenProjects,
    setShowVersionModal,
  };
}

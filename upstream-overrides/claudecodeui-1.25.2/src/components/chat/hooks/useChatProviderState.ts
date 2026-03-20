import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { CLAUDE_MODELS, CURSOR_MODELS, GEMINI_MODELS } from '../../../../shared/modelConstants';
import {
  CODEX_CHAT_MODELS,
  CODEX_DEFAULT_PERMISSION_MODE,
  CODEX_REASONING_EFFORTS,
  IS_CODEX_ONLY_HARDENED,
} from '../../../constants/config';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';

interface UseChatProviderStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
}

const CODEX_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const OTHER_PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
const ALLOWED_CODEX_MODEL_VALUES: ReadonlySet<string> = new Set(
  CODEX_CHAT_MODELS.OPTIONS.map(({ value }) => value),
);
const ALLOWED_CODEX_REASONING_EFFORT_VALUES: ReadonlySet<string> = new Set(
  CODEX_REASONING_EFFORTS.OPTIONS.map(({ value }) => value),
);

function getDefaultPermissionMode(provider: SessionProvider): PermissionMode {
  return provider === 'codex' ? CODEX_DEFAULT_PERMISSION_MODE : 'default';
}

function isAllowedPermissionMode(value: string | null, provider: SessionProvider): value is PermissionMode {
  const allowedModes = provider === 'codex' ? CODEX_PERMISSION_MODES : OTHER_PERMISSION_MODES;
  return value !== null && allowedModes.includes(value as PermissionMode);
}

function getInitialCodexModel(): string {
  const savedCodexModel = localStorage.getItem('codex-model');
  if (savedCodexModel && ALLOWED_CODEX_MODEL_VALUES.has(savedCodexModel)) {
    return savedCodexModel;
  }
  return CODEX_CHAT_MODELS.DEFAULT;
}

function getInitialCodexReasoningEffort(): string {
  const savedReasoningEffort = localStorage.getItem('codex-reasoning-effort');
  if (savedReasoningEffort && ALLOWED_CODEX_REASONING_EFFORT_VALUES.has(savedReasoningEffort)) {
    return savedReasoningEffort;
  }
  return CODEX_REASONING_EFFORTS.DEFAULT;
}

function getSessionScopedPreferenceKey(
  key: 'permissionMode' | 'codexReasoningEffort',
  projectName: string | null | undefined,
  sessionId: string | null | undefined,
  provider: SessionProvider,
): string | null {
  if (!projectName) {
    return null;
  }

  const normalizedSessionId =
    sessionId && sessionId.trim().length > 0 ? sessionId.trim() : `new-session:${provider}`;

  return `${key}:${projectName}:${provider}:${normalizedSessionId}`;
}

const readSessionScopedValue = (
  key: 'permissionMode' | 'codexReasoningEffort',
  projectName: string | null | undefined,
  sessionId: string | null | undefined,
  provider: SessionProvider,
) => {
  const storageKey = getSessionScopedPreferenceKey(key, projectName, sessionId, provider);
  if (!storageKey) {
    return null;
  }

  return localStorage.getItem(storageKey);
};

export function useChatProviderState({ selectedProject, selectedSession }: UseChatProviderStateArgs) {
  const [provider, setProvider] = useState<SessionProvider>(() => {
    if (IS_CODEX_ONLY_HARDENED) {
      return 'codex';
    }
    return (localStorage.getItem('selected-provider') as SessionProvider) || 'claude';
  });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => getDefaultPermissionMode(provider));
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return getInitialCodexModel();
  });
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<string>(() => {
    return getInitialCodexReasoningEffort();
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });

  const lastProviderRef = useRef(provider);

  useEffect(() => {
    const sessionProvider = selectedSession?.__provider || provider;
    const defaultPermissionMode = getDefaultPermissionMode(sessionProvider);
    const savedMode =
      readSessionScopedValue(
        'permissionMode',
        selectedProject?.name,
        selectedSession?.id,
        sessionProvider,
      ) ||
      (selectedSession?.id ? localStorage.getItem(`permissionMode-${selectedSession.id}`) : null);

    setPermissionMode(isAllowedPermissionMode(savedMode, sessionProvider) ? savedMode : defaultPermissionMode);
  }, [provider, selectedProject?.name, selectedSession?.__provider, selectedSession?.id]);

  useEffect(() => {
    if (IS_CODEX_ONLY_HARDENED) {
      if (provider !== 'codex') {
        setProvider('codex');
      }
      return;
    }

    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    lastProviderRef.current = provider;
  }, [provider]);

  useEffect(() => {
    const sessionProvider = selectedSession?.__provider || provider;
    const storageKey = getSessionScopedPreferenceKey(
      'codexReasoningEffort',
      selectedProject?.name,
      selectedSession?.id,
      sessionProvider,
    );

    if (storageKey) {
      localStorage.setItem(storageKey, codexReasoningEffort);
    }
    localStorage.setItem('codex-reasoning-effort', codexReasoningEffort);
  }, [codexReasoningEffort, provider, selectedProject?.name, selectedSession?.__provider, selectedSession?.id]);

  useEffect(() => {
    const sessionProvider = selectedSession?.__provider || provider;
    const savedReasoningEffort =
      readSessionScopedValue(
        'codexReasoningEffort',
        selectedProject?.name,
        selectedSession?.id,
        sessionProvider,
      ) || localStorage.getItem('codex-reasoning-effort');

    if (savedReasoningEffort && ALLOWED_CODEX_REASONING_EFFORT_VALUES.has(savedReasoningEffort)) {
      setCodexReasoningEffort(savedReasoningEffort);
      return;
    }

    setCodexReasoningEffort(CODEX_REASONING_EFFORTS.DEFAULT);
  }, [provider, selectedProject?.name, selectedSession?.__provider, selectedSession?.id]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (IS_CODEX_ONLY_HARDENED || provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes: PermissionMode[] =
      provider === 'codex'
        ? CODEX_PERMISSION_MODES
        : OTHER_PERMISSION_MODES;

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    const storageKey = getSessionScopedPreferenceKey(
      'permissionMode',
      selectedProject?.name,
      selectedSession?.id,
      provider,
    );
    if (storageKey) {
      localStorage.setItem(storageKey, nextMode);
    }

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedProject?.name, selectedSession?.id]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    codexReasoningEffort,
    setCodexReasoningEffort,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}

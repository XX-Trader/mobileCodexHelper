import React, { useEffect } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import { IS_CODEX_ONLY_HARDENED } from '../../../constants/config';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';
import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  mountedTabs,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onCreateOptimisticSession,
  onReplaceOptimisticSession,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
  getSessionViewChatRuntimeForTarget,
  updateSessionViewChatRuntimeForTarget,
  hasUnreadSelectedSession,
  onAcknowledgeUnreadSession,
  recentSessions,
  onRecentSessionSelect,
  onRecentSessionDismiss,
  onDeleteCurrentSession,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = !IS_CODEX_ONLY_HARDENED && Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  if (isLoading) {
    return (
      <MainContentStateView
        mode="loading"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        recentSessions={recentSessions}
        onRecentSessionSelect={onRecentSessionSelect}
        onRecentSessionDismiss={onRecentSessionDismiss}
        onDeleteCurrentSession={onDeleteCurrentSession}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onCreateOptimisticSession={onCreateOptimisticSession}
                onReplaceOptimisticSession={onReplaceOptimisticSession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                getSessionViewChatRuntimeForTarget={getSessionViewChatRuntimeForTarget}
                updateSessionViewChatRuntimeForTarget={updateSessionViewChatRuntimeForTarget}
                isChatTabActive={activeTab === 'chat'}
                hasUnreadSelectedSession={hasUnreadSelectedSession}
                onAcknowledgeUnreadSession={onAcknowledgeUnreadSession}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {!IS_CODEX_ONLY_HARDENED && mountedTabs.includes('files') && (
            <div className={`h-full overflow-hidden ${activeTab === 'files' ? 'block' : 'hidden'}`}>
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
            </div>
          )}

          {!IS_CODEX_ONLY_HARDENED && mountedTabs.includes('shell') && (
            <div className={`h-full w-full overflow-hidden ${activeTab === 'shell' ? 'block' : 'hidden'}`}>
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {!IS_CODEX_ONLY_HARDENED && mountedTabs.includes('git') && (
            <div className={`h-full overflow-hidden ${activeTab === 'git' ? 'block' : 'hidden'}`}>
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
            </div>
          )}

          {!IS_CODEX_ONLY_HARDENED && shouldShowTasksTab && mountedTabs.includes('tasks') && (
            <TaskMasterPanel isVisible={activeTab === 'tasks'} />
          )}

          {!IS_CODEX_ONLY_HARDENED && mountedTabs.includes('preview') && (
            <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />
          )}

          {!IS_CODEX_ONLY_HARDENED &&
            mountedTabs
              .filter((tab): tab is `plugin:${string}` => tab.startsWith('plugin:'))
              .map((pluginTab) => (
                <div
                  key={pluginTab}
                  className={`h-full overflow-hidden ${activeTab === pluginTab ? 'block' : 'hidden'}`}
                >
                  <PluginTabContent
                    pluginName={pluginTab.replace('plugin:', '')}
                    selectedProject={selectedProject}
                    selectedSession={selectedSession}
                  />
                </div>
              ))}
        </div>

        {!IS_CODEX_ONLY_HARDENED && (
          <EditorSidebar
            editingFile={editingFile}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onCloseEditor={handleCloseEditor}
            onToggleEditorExpand={handleToggleEditorExpand}
            projectPath={selectedProject.path}
            fillSpace={activeTab === 'files'}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);

/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex } from '@openai/codex-sdk';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fsSync, { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { buildLegacyCodexThreadRecord } from './projects.js';
import {
  doesCodexSessionLikelyNeedCompaction,
  extractCodexContextTokenUsageFromTurnUsage,
  readCodexSessionContextTokenUsage,
} from './utils/codexTokenUsage.js';

// Track active sessions
const activeCodexSessions = new Map();
const CODEX_ONLY_HARDENED_MODE = process.env.CODEX_ONLY_HARDENED_MODE !== 'false';
const CODEX_SESSION_INDEX_PATH = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const CODEX_STATE_DB_PATH = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const CODEX_THREAD_NAME_MAX_LENGTH = 120;
const CODEX_INTERNAL_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';
const WINDOWS_DEVICE_PATH_PREFIX = '\\\\?\\';
const CLI_CODEX_ORIGINATOR = 'codex_cli_rs';
const SDK_CODEX_ORIGINATOR = 'codex_sdk_ts';
const SDK_CODEX_SOURCE = 'exec';
const VSCODE_CODEX_ORIGINATOR = 'codex_vscode';
const CLI_CODEX_SOURCE = 'cli';
const VSCODE_CODEX_SOURCE = 'vscode';
const CODEX_STATE_THREAD_SYNC_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const CODEX_AUTO_COMPACT_COMMAND = '/compact';

const NON_ASCII_PATH_PATTERN = /[^\u0000-\u007F]/;
let cachedPreferredCodexBinaryInfo;
let hasLoggedCodexBinarySelection = false;
const pendingCodexStateThreadSyncs = new Map();

function containsNonAscii(value) {
  return typeof value === 'string' && NON_ASCII_PATH_PATTERN.test(value);
}

async function ensureAsciiWorkingDirectory(projectPath) {
  if (process.platform !== 'win32' || !containsNonAscii(projectPath)) {
    return projectPath;
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const projectDriveRoot = path.parse(resolvedProjectPath).root || 'C:\\';
  const aliasRoot = path.join(projectDriveRoot, 'codex_project_aliases');
  const aliasName = crypto.createHash('sha1').update(resolvedProjectPath.toLowerCase()).digest('hex');
  const aliasPath = path.join(aliasRoot, aliasName);

  await fs.mkdir(aliasRoot, { recursive: true });

  try {
    const aliasStats = await fs.lstat(aliasPath);
    if (aliasStats.isDirectory() || aliasStats.isSymbolicLink()) {
      return aliasPath;
    }

    if (!aliasStats.isSymbolicLink() && !aliasStats.isDirectory()) {
      await fs.rm(aliasPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(resolvedProjectPath, aliasPath, 'junction');
  return aliasPath;
}

function summarizeCommandForThreadName(command) {
  if (typeof command !== 'string') {
    return 'Codex Session';
  }

  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Codex Session';
  }

  if (normalized.length <= CODEX_THREAD_NAME_MAX_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, CODEX_THREAD_NAME_MAX_LENGTH - 3).trimEnd()}...`;
}

function findLocatorCandidates(commandName) {
  const locatorCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  const locatorArgs = process.platform === 'win32' ? [commandName] : ['-a', commandName];
  const result = spawnSync(locatorCommand, locatorArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveWrappedCodexExecutable(wrapperPath) {
  try {
    const wrapperContent = fsSync.readFileSync(wrapperPath, 'utf8');
    const executableMatch = wrapperContent.match(/"([^"\r\n]+codex\.exe)"/i);
    return executableMatch?.[1] || null;
  } catch {
    return null;
  }
}

function resolveCodexExecutableCandidate(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return null;
  }

  let normalizedCandidate = candidatePath.trim();
  if (!normalizedCandidate) {
    return null;
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(normalizedCandidate)) {
    normalizedCandidate = resolveWrappedCodexExecutable(normalizedCandidate) || '';
  }

  if (!normalizedCandidate) {
    return null;
  }

  try {
    return fsSync.realpathSync.native(normalizedCandidate);
  } catch {
    return fsSync.existsSync(normalizedCandidate) ? normalizedCandidate : null;
  }
}

function readCodexCliVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const normalizedOutput = result.stdout.trim();
  if (!normalizedOutput) {
    return null;
  }

  const versionMatch = normalizedOutput.match(/codex-cli\s+([^\s]+)/i);
  return versionMatch?.[1] || normalizedOutput;
}

function isVsCodeExtensionCodexBinary(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') {
    return false;
  }

  const normalizedPath = binaryPath.replace(/\//g, '\\').toLowerCase();
  return normalizedPath.includes('\\.vscode\\extensions\\openai.chatgpt-');
}

function findVsCodeCodexCandidates() {
  if (process.platform !== 'win32') {
    return [];
  }

  const extensionsRoot = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const entries = fsSync
      .readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => {
        const extensionPath = path.join(extensionsRoot, entry.name);
        const executablePath = path.join(extensionPath, 'bin', 'windows-x86_64', 'codex.exe');
        const fallbackArmPath = path.join(extensionPath, 'bin', 'windows-arm64', 'codex.exe');
        const candidatePath = fsSync.existsSync(executablePath) ? executablePath : fallbackArmPath;
        let modifiedTimeMs = 0;
        try {
          modifiedTimeMs = fsSync.statSync(extensionPath).mtimeMs;
        } catch {
          modifiedTimeMs = 0;
        }

        return {
          candidatePath,
          modifiedTimeMs
        };
      })
      .filter((entry) => fsSync.existsSync(entry.candidatePath))
      .sort((left, right) => right.modifiedTimeMs - left.modifiedTimeMs);

    return entries.map((entry) => entry.candidatePath);
  } catch {
    return [];
  }
}

function detectSystemCodexBinary() {
  const envCandidates = [
    process.env.CODEX_CLI_PATH,
    process.env.CODEX_PATH
  ].filter(Boolean);
  const locatedCandidates = process.platform === 'win32'
    ? [...findLocatorCandidates('codex.exe'), ...findLocatorCandidates('codex')]
    : findLocatorCandidates('codex');
  const allCandidates = [
    ...envCandidates,
    ...locatedCandidates,
    ...findVsCodeCodexCandidates()
  ];
  const seenCandidates = new Set();

  for (const candidate of allCandidates) {
    const executablePath = resolveCodexExecutableCandidate(candidate);
    if (!executablePath || seenCandidates.has(executablePath)) {
      continue;
    }

    seenCandidates.add(executablePath);

    const cliVersion = readCodexCliVersion(executablePath);
    if (!cliVersion) {
      continue;
    }

    return {
      path: executablePath,
      cliVersion,
      useVsCodeSessionMetadata: isVsCodeExtensionCodexBinary(executablePath)
    };
  }

  return null;
}

function getPreferredCodexBinaryInfo() {
  if (cachedPreferredCodexBinaryInfo !== undefined) {
    return cachedPreferredCodexBinaryInfo;
  }

  cachedPreferredCodexBinaryInfo = detectSystemCodexBinary();
  return cachedPreferredCodexBinaryInfo;
}

function logCodexBinarySelectionOnce(binaryInfo) {
  if (hasLoggedCodexBinarySelection) {
    return;
  }

  if (binaryInfo?.path) {
    console.log(
      '[Codex] Using system Codex CLI binary:',
      binaryInfo.path,
      `(version ${binaryInfo.cliVersion || 'unknown'})`
    );
  } else {
    console.log('[Codex] System Codex CLI not found in PATH, falling back to bundled SDK CLI.');
  }

  hasLoggedCodexBinarySelection = true;
}

function normalizeCodexSessionIndexField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeCodexStateThreadCwd(value) {
  const normalizedCwd = normalizeCodexSessionIndexField(value);
  if (!normalizedCwd || process.platform !== 'win32') {
    return normalizedCwd;
  }

  const resolvedCwd = path.resolve(normalizedCwd);
  if (resolvedCwd.startsWith(WINDOWS_DEVICE_PATH_PREFIX)) {
    return resolvedCwd;
  }

  return `${WINDOWS_DEVICE_PATH_PREFIX}${resolvedCwd}`;
}

function hasCodexSessionArtifactMetadata(sessionMetadata = {}) {
  return Boolean(
    normalizeCodexSessionIndexField(sessionMetadata.cwd) ||
    normalizeCodexSessionIndexField(sessionMetadata.stateThreadCwd) ||
    normalizeCodexSessionIndexField(sessionMetadata.originator) ||
    normalizeCodexSessionIndexField(sessionMetadata.source) ||
    normalizeCodexSessionIndexField(sessionMetadata.cliVersion)
  );
}

function getCodexInteractiveSessionMetadata(preferredCodexBinaryInfo) {
  if (!preferredCodexBinaryInfo?.path) {
    return {
      originator: SDK_CODEX_ORIGINATOR,
      source: SDK_CODEX_SOURCE
    };
  }

  if (preferredCodexBinaryInfo.useVsCodeSessionMetadata) {
    return {
      originator: VSCODE_CODEX_ORIGINATOR,
      source: VSCODE_CODEX_SOURCE
    };
  }

  return {
    originator: CLI_CODEX_ORIGINATOR,
    source: CLI_CODEX_SOURCE
  };
}

function withCodexStateDatabase(callback) {
  if (!fsSync.existsSync(CODEX_STATE_DB_PATH)) {
    return null;
  }

  const database = new DatabaseSync(CODEX_STATE_DB_PATH);
  try {
    database.exec('PRAGMA busy_timeout = 2000');
    return callback(database);
  } finally {
    database.close();
  }
}

function buildCodexEnvironment(preferredCodexBinaryInfo, isNewSession) {
  if (!preferredCodexBinaryInfo?.useVsCodeSessionMetadata || !isNewSession) {
    return undefined;
  }

  const nextEnvironment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      nextEnvironment[key] = value;
    }
  }

  nextEnvironment[CODEX_INTERNAL_ORIGINATOR_ENV] = VSCODE_CODEX_ORIGINATOR;
  return nextEnvironment;
}

function buildCodexSessionIndexMetadata(preferredCodexBinaryInfo, requestedWorkingDirectory, sessionId) {
  const isNewSession = !sessionId;
  const interactiveSessionMetadata = getCodexInteractiveSessionMetadata(preferredCodexBinaryInfo);

  return {
    cwd: requestedWorkingDirectory,
    stateThreadCwd: isNewSession ? normalizeCodexStateThreadCwd(requestedWorkingDirectory) : undefined,
    originator: isNewSession ? interactiveSessionMetadata.originator : undefined,
    source: isNewSession ? interactiveSessionMetadata.source : undefined,
    cliVersion: isNewSession ? preferredCodexBinaryInfo?.cliVersion : undefined
  };
}

function mergeCodexSessionArtifactMetadata(previousMetadata = {}, nextMetadata = {}) {
  return {
    cwd:
      normalizeCodexSessionIndexField(nextMetadata.cwd) ||
      normalizeCodexSessionIndexField(previousMetadata.cwd) ||
      undefined,
    stateThreadCwd:
      normalizeCodexSessionIndexField(nextMetadata.stateThreadCwd) ||
      normalizeCodexSessionIndexField(previousMetadata.stateThreadCwd) ||
      undefined,
    originator:
      normalizeCodexSessionIndexField(nextMetadata.originator) ||
      normalizeCodexSessionIndexField(previousMetadata.originator) ||
      undefined,
    source:
      normalizeCodexSessionIndexField(nextMetadata.source) ||
      normalizeCodexSessionIndexField(previousMetadata.source) ||
      undefined,
    cliVersion:
      normalizeCodexSessionIndexField(nextMetadata.cliVersion) ||
      normalizeCodexSessionIndexField(previousMetadata.cliVersion) ||
      undefined
  };
}

function clearPendingCodexStateThreadSync(sessionId) {
  const pendingSync = pendingCodexStateThreadSyncs.get(sessionId);
  if (pendingSync?.timeoutId) {
    clearTimeout(pendingSync.timeoutId);
  }

  pendingCodexStateThreadSyncs.delete(sessionId);
}

function buildCodexNativeTitleMetadata(sessionId) {
  return withCodexStateDatabase((database) => {
    const existingThread = database
      .prepare('SELECT cwd, source, cli_version FROM threads WHERE id = ?')
      .get(sessionId);

    if (!existingThread) {
      return null;
    }

    return {
      cwd: normalizeCodexSessionIndexField(existingThread.cwd) || undefined,
      stateThreadCwd: normalizeCodexStateThreadCwd(existingThread.cwd),
      source: normalizeCodexSessionIndexField(existingThread.source) || undefined,
      cliVersion: normalizeCodexSessionIndexField(existingThread.cli_version) || undefined
    };
  });
}

async function ensureCodexStateThreadExistsForRename(sessionId, threadName) {
  const normalizedThreadName =
    typeof threadName === 'string' && threadName.trim() ? threadName.trim() : 'Codex Session';
  const existingMetadata = buildCodexNativeTitleMetadata(sessionId);
  if (existingMetadata) {
    return existingMetadata;
  }

  const legacyThreadRecord = await buildLegacyCodexThreadRecord(sessionId);
  if (!legacyThreadRecord) {
    throw new Error(`Codex thread metadata not found for session ${sessionId}`);
  }

  const inserted = withCodexStateDatabase((database) => {
    const existingThread = database
      .prepare('SELECT id FROM threads WHERE id = ?')
      .get(sessionId);
    if (existingThread) {
      return true;
    }

    database.prepare(`
      INSERT INTO threads (
        id,
        rollout_path,
        created_at,
        updated_at,
        source,
        model_provider,
        cwd,
        title,
        sandbox_policy,
        approval_mode,
        cli_version,
        first_user_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyThreadRecord.id,
      legacyThreadRecord.rolloutPath,
      legacyThreadRecord.createdAt,
      legacyThreadRecord.updatedAt,
      legacyThreadRecord.source,
      legacyThreadRecord.modelProvider,
      legacyThreadRecord.cwd,
      normalizedThreadName,
      legacyThreadRecord.sandboxPolicy,
      legacyThreadRecord.approvalMode,
      legacyThreadRecord.cliVersion,
      legacyThreadRecord.firstUserMessage
    );

    return true;
  });

  if (!inserted) {
    throw new Error(`Codex state database unavailable for session ${sessionId}`);
  }

  const nextMetadata = buildCodexNativeTitleMetadata(sessionId);
  if (!nextMetadata) {
    throw new Error(`Codex thread metadata sync failed for session ${sessionId}`);
  }

  return nextMetadata;
}

async function syncCodexSessionIndex(sessionId, threadName, preserveExistingTitle = false, sessionMetadata = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return;
  }

  const normalizedThreadName =
    typeof threadName === 'string' && threadName.trim() ? threadName.trim() : 'Codex Session';
  const updatedAt = new Date().toISOString();
  const preservedRawLines = [];
  const entriesById = new Map();

  try {
    const existing = await fs.readFile(CODEX_SESSION_INDEX_PATH, 'utf8');
    for (const line of existing.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id === 'string' && parsed.id.trim()) {
          entriesById.set(parsed.id, parsed);
        } else {
          preservedRawLines.push(line);
        }
      } catch {
        preservedRawLines.push(line);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const existingEntry = entriesById.get(sessionId);
  const nextThreadName =
    preserveExistingTitle && existingEntry?.thread_name
      ? existingEntry.thread_name
      : normalizedThreadName;
  const normalizedSessionCwd = normalizeCodexSessionIndexField(sessionMetadata.cwd);
  const normalizedOriginator = normalizeCodexSessionIndexField(sessionMetadata.originator);
  const normalizedSource = normalizeCodexSessionIndexField(sessionMetadata.source);
  const normalizedCliVersion = normalizeCodexSessionIndexField(sessionMetadata.cliVersion);

  entriesById.set(sessionId, {
    ...existingEntry,
    id: sessionId,
    thread_name: nextThreadName,
    updated_at: updatedAt,
    cwd: normalizedSessionCwd || existingEntry?.cwd || undefined,
    originator: normalizedOriginator || existingEntry?.originator || undefined,
    source: normalizedSource || existingEntry?.source || undefined,
    cli_version: normalizedCliVersion || existingEntry?.cli_version || undefined
  });

  const nextContent = [
    ...preservedRawLines,
    ...Array.from(entriesById.values()).map((entry) => JSON.stringify(entry))
  ].join('\n');

  await fs.mkdir(path.dirname(CODEX_SESSION_INDEX_PATH), { recursive: true });

  const tempPath = `${CODEX_SESSION_INDEX_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${nextContent}\n`, 'utf8');
  await fs.rename(tempPath, CODEX_SESSION_INDEX_PATH);
}

function syncCodexStateThread(sessionId, threadName, preserveExistingTitle = false, sessionMetadata = {}) {
  if (!sessionId || typeof sessionId !== 'string' || !hasCodexSessionArtifactMetadata(sessionMetadata)) {
    return false;
  }

  const normalizedThreadName =
    typeof threadName === 'string' && threadName.trim() ? threadName.trim() : 'Codex Session';
  const normalizedThreadCwd =
    normalizeCodexSessionIndexField(sessionMetadata.stateThreadCwd) ||
    normalizeCodexStateThreadCwd(sessionMetadata.cwd);
  const normalizedSource = normalizeCodexSessionIndexField(sessionMetadata.source);
  const normalizedCliVersion = normalizeCodexSessionIndexField(sessionMetadata.cliVersion);

  try {
    return Boolean(withCodexStateDatabase((database) => {
      const existingThread = database
        .prepare('SELECT title, rollout_path, cwd, source, cli_version FROM threads WHERE id = ?')
        .get(sessionId);

      if (!existingThread) {
        return false;
      }

      const nextTitle =
        preserveExistingTitle && normalizeCodexSessionIndexField(existingThread.title)
          ? existingThread.title
          : normalizedThreadName;
      const nextThreadCwd = normalizedThreadCwd || existingThread.cwd || null;
      const nextSource = normalizedSource || existingThread.source || null;
      const nextCliVersion = normalizedCliVersion || existingThread.cli_version || null;

      database
        .prepare(
          'UPDATE threads SET title = ?, cwd = ?, source = ?, cli_version = ? WHERE id = ?'
        )
        .run(nextTitle, nextThreadCwd, nextSource, nextCliVersion, sessionId);

      return true;
    }));
  } catch (error) {
    console.warn('[Codex] Failed to sync state_5.sqlite thread metadata:', error);
    return false;
  }
}

/**
 * Retry `state_5.sqlite.threads` metadata sync because the Codex CLI may
 * create the row several seconds after `thread.started`.
 */
function scheduleCodexStateThreadSyncRetry(
  sessionId,
  threadName,
  preserveExistingTitle = false,
  sessionMetadata = {}
) {
  if (!sessionId || typeof sessionId !== 'string' || !hasCodexSessionArtifactMetadata(sessionMetadata)) {
    return;
  }

  const pendingSync = pendingCodexStateThreadSyncs.get(sessionId) || {
    attemptIndex: 0,
    timeoutId: null,
    threadName,
    preserveExistingTitle,
    sessionMetadata: {}
  };

  pendingSync.threadName = threadName;
  pendingSync.preserveExistingTitle = pendingSync.preserveExistingTitle || preserveExistingTitle;
  pendingSync.sessionMetadata = mergeCodexSessionArtifactMetadata(
    pendingSync.sessionMetadata,
    sessionMetadata
  );
  pendingCodexStateThreadSyncs.set(sessionId, pendingSync);

  if (pendingSync.timeoutId) {
    return;
  }

  const retryDelayMs = CODEX_STATE_THREAD_SYNC_RETRY_DELAYS_MS[pendingSync.attemptIndex];
  if (retryDelayMs === undefined) {
    console.warn(
      `[Codex] state_5.sqlite thread row still unavailable after retries for session ${sessionId}`
    );
    clearPendingCodexStateThreadSync(sessionId);
    return;
  }

  pendingSync.timeoutId = setTimeout(() => {
    pendingSync.timeoutId = null;

    const synced = syncCodexStateThread(
      sessionId,
      pendingSync.threadName,
      pendingSync.preserveExistingTitle,
      pendingSync.sessionMetadata
    );
    if (synced) {
      clearPendingCodexStateThreadSync(sessionId);
      return;
    }

    pendingSync.attemptIndex += 1;
    scheduleCodexStateThreadSyncRetry(
      sessionId,
      pendingSync.threadName,
      pendingSync.preserveExistingTitle,
      pendingSync.sessionMetadata
    );
  }, retryDelayMs);
  pendingSync.timeoutId.unref?.();
}

async function syncCodexSessionArtifacts(
  sessionId,
  threadName,
  preserveExistingTitle = false,
  sessionMetadata = {}
) {
  await syncCodexSessionIndex(sessionId, threadName, preserveExistingTitle, sessionMetadata);
  // Trust the Codex CLI to own rollout file contents. We only sync secondary indexes here.
  const synced = syncCodexStateThread(sessionId, threadName, preserveExistingTitle, sessionMetadata);
  if (synced) {
    clearPendingCodexStateThreadSync(sessionId);
    return;
  }

  scheduleCodexStateThreadSyncRetry(sessionId, threadName, preserveExistingTitle, sessionMetadata);
}

/**
 * Rename a Codex session using the native CLI metadata store.
 * Updates `state_5.sqlite.threads.title` as the source of truth and
 * keeps `session_index.jsonl.thread_name` in sync for compatibility.
 *
 * @param {string} sessionId Codex session id; must be a valid existing session.
 * @param {string} threadName User-provided title; trimmed and required.
 * @returns {Promise<void>} Resolves when native metadata has been updated.
 * @throws {Error} When the session metadata cannot be located or the native stores cannot be updated.
 */
export async function renameCodexSessionTitle(sessionId, threadName) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Codex sessionId is required');
  }

  const normalizedThreadName =
    typeof threadName === 'string' && threadName.trim() ? threadName.trim() : '';
  if (!normalizedThreadName) {
    throw new Error('Codex thread title is required');
  }

  const sessionMetadata = await ensureCodexStateThreadExistsForRename(sessionId, normalizedThreadName);
  const syncedStateThread = syncCodexStateThread(
    sessionId,
    normalizedThreadName,
    false,
    sessionMetadata
  );
  if (!syncedStateThread) {
    throw new Error(`Failed to update Codex native title for session ${sessionId}`);
  }

  await syncCodexSessionIndex(sessionId, normalizedThreadName, false, sessionMetadata);
  clearPendingCodexStateThreadSync(sessionId);
}

function rekeyActiveCodexSession(previousSessionId, nextSessionId) {
  if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return nextSessionId;
  }

  const session = activeCodexSessions.get(previousSessionId);
  if (!session) {
    return nextSessionId;
  }

  activeCodexSessions.set(nextSessionId, session);
  activeCodexSessions.delete(previousSessionId);
  return nextSessionId;
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            itemType: 'web_search',
            query: item.query
          };

        case 'todo_list':
          return {
            type: 'item',
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'plan':
      return {
        sandboxMode: 'read-only',
        approvalPolicy: 'never'
      };
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: CODEX_ONLY_HARDENED_MODE ? 'never' : 'untrusted'
      };
  }
}

function buildPlanModePrompt(command) {
  return [
    'Plan mode is enabled.',
    'Do not execute commands, modify files, or use tools.',
    'Respond with analysis and an implementation plan only.',
    'If inspection would normally require a command, describe what you would inspect instead of running it.',
    '',
    'User request:',
    command
  ].join('\n');
}

function normalizeCodexAttachmentEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path.trim()) {
    return null;
  }

  const normalizedPath = path.resolve(entry.path.trim());
  const mimeType = typeof entry.mimeType === 'string' ? entry.mimeType : '';
  const kind =
    entry.kind === 'image' || mimeType.startsWith('image/')
      ? 'image'
      : 'file';

  return {
    path: normalizedPath,
    kind
  };
}

function collectCodexAdditionalDirectories(workingDirectory, attachments = []) {
  const directories = new Set();

  attachments.forEach((attachment) => {
    if (attachment?.path) {
      directories.add(path.dirname(attachment.path));
    }
  });

  return Array.from(directories).filter((directory) => path.resolve(directory) !== path.resolve(workingDirectory));
}

function buildCodexInput(command, attachments = []) {
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  if (imageAttachments.length === 0) {
    return command;
  }

  const inputItems = [];
  if (typeof command === 'string' && command.trim()) {
    inputItems.push({
      type: 'text',
      text: command
    });
  } else {
    inputItems.push({
      type: 'text',
      text: 'Use the attached image(s) as additional context.'
    });
  }

  imageAttachments.forEach((attachment) => {
    inputItems.push({
      type: 'local_image',
      path: attachment.path
    });
  });

  return inputItems;
}

function extractCodexErrorMessage(errorLike) {
  if (!errorLike) {
    return '';
  }

  if (typeof errorLike === 'string') {
    return errorLike;
  }

  if (typeof errorLike.message === 'string') {
    return errorLike.message;
  }

  if (typeof errorLike.error === 'string') {
    return errorLike.error;
  }

  if (typeof errorLike.error?.message === 'string') {
    return errorLike.error.message;
  }

  try {
    return JSON.stringify(errorLike);
  } catch {
    return String(errorLike);
  }
}

function isCodexCompactCommand(command) {
  return typeof command === 'string' && command.trim().toLowerCase().startsWith(CODEX_AUTO_COMPACT_COMMAND);
}

function isCodexContextLimitError(errorLike) {
  const message = extractCodexErrorMessage(errorLike).toLowerCase();
  if (!message) {
    return false;
  }

  return [
    'context window',
    'context limit',
    'maximum context length',
    'max context length',
    'too many tokens',
    'prompt is too long',
    'input is too long',
    'reduce the length',
    'context_length_exceeded',
    'input_tokens',
  ].some((pattern) => message.includes(pattern));
}

async function executeCodexAttempt({
  codex,
  resumeSessionId,
  effectiveInput,
  threadOptions,
  ws,
  abortController,
  fallbackThreadName,
  preferredCodexBinaryInfo,
  requestedWorkingDirectory,
}) {
  const sessionIndexMetadata = buildCodexSessionIndexMetadata(
    preferredCodexBinaryInfo,
    requestedWorkingDirectory,
    resumeSessionId
  );
  let thread;
  let currentSessionId = resumeSessionId || `codex-web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let hasSentSessionCreated = false;

  try {
    thread = resumeSessionId
      ? codex.resumeThread(resumeSessionId, threadOptions)
      : codex.startThread(threadOptions);

    activeCodexSessions.set(currentSessionId, {
      thread,
      codex,
      status: 'running',
      abortController,
      startedAt: new Date().toISOString()
    });

    if (resumeSessionId) {
      await syncCodexSessionArtifacts(
        resumeSessionId,
        fallbackThreadName,
        true,
        sessionIndexMetadata
      );
      sendMessage(ws, {
        type: 'session-created',
        sessionId: resumeSessionId,
        provider: 'codex'
      });
      hasSentSessionCreated = true;
    }

    const streamedTurn = await thread.runStreamed(effectiveInput, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started' && event.thread_id) {
        currentSessionId = rekeyActiveCodexSession(currentSessionId, event.thread_id);
        await syncCodexSessionArtifacts(
          currentSessionId,
          fallbackThreadName,
          Boolean(resumeSessionId),
          sessionIndexMetadata
        );

        if (!hasSentSessionCreated) {
          sendMessage(ws, {
            type: 'session-created',
            sessionId: currentSessionId,
            provider: 'codex'
          });
          hasSentSessionCreated = true;
        }
      }

      const activeSession = activeCodexSessions.get(currentSessionId);
      if (!activeSession || activeSession.status === 'aborted') {
        break;
      }

      if (event.type === 'item.started' || event.type === 'item.updated') {
        continue;
      }

      const transformed = transformCodexEvent(event);
      sendMessage(ws, {
        type: 'codex-response',
        data: transformed,
        sessionId: currentSessionId
      });

      if (event.type === 'turn.completed' && event.usage) {
        await syncCodexSessionArtifacts(
          currentSessionId,
          fallbackThreadName,
          Boolean(resumeSessionId),
          sessionIndexMetadata
        );
        const tokenUsage = extractCodexContextTokenUsageFromTurnUsage(event.usage);
        sendMessage(ws, {
          type: 'token-budget',
          data: tokenUsage || {
            used: 0,
            total: 200000
          },
          sessionId: currentSessionId
        });
      }
    }

    const finalSessionId = thread.id || currentSessionId;
    currentSessionId = rekeyActiveCodexSession(currentSessionId, finalSessionId);
    await syncCodexSessionArtifacts(
      currentSessionId,
      fallbackThreadName,
      Boolean(resumeSessionId),
      sessionIndexMetadata
    );

    if (!hasSentSessionCreated && currentSessionId) {
      sendMessage(ws, {
        type: 'session-created',
        sessionId: currentSessionId,
        provider: 'codex'
      });
    }

    return {
      sessionId: currentSessionId,
      wasAborted: false,
    };
  } catch (error) {
    const activeSession = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      activeSession?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (wasAborted) {
      return {
        sessionId: currentSessionId,
        wasAborted: true,
      };
    }

    if (error && typeof error === 'object') {
      error.codexSessionId = currentSessionId;
    }
    throw error;
  } finally {
    if (currentSessionId) {
      const activeSession = activeCodexSessions.get(currentSessionId);
      if (activeSession) {
        activeSession.status = activeSession.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode, modelReasoningEffort
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
export async function queryCodex(command, options = {}, ws) {
  const {
    sessionId,
    cwd,
    projectPath,
    model,
    modelReasoningEffort,
    permissionMode = 'default',
    attachments = []
  } = options;

  const requestedWorkingDirectory = cwd || projectPath || process.cwd();
  const workingDirectory = await ensureAsciiWorkingDirectory(requestedWorkingDirectory);
  if (workingDirectory !== requestedWorkingDirectory) {
    console.log('[Codex] Using ASCII working directory alias:', workingDirectory, 'for', requestedWorkingDirectory);
  }
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.map(normalizeCodexAttachmentEntry).filter(Boolean)
    : [];
  const additionalDirectories = collectCodexAdditionalDirectories(requestedWorkingDirectory, normalizedAttachments);
  const baseCommand = permissionMode === 'plan' ? buildPlanModePrompt(command) : command;
  const fallbackThreadName = summarizeCommandForThreadName(command);
  const preferredCodexBinaryInfo = getPreferredCodexBinaryInfo();
  const preferredCodexPath = preferredCodexBinaryInfo?.path || null;
  const codexEnvironment = buildCodexEnvironment(
    preferredCodexBinaryInfo,
    !sessionId
  );

  let codex;
  let currentSessionId = sessionId || `codex-web-${Date.now()}`;
  const abortController = new AbortController();
  let hasAttemptedAutomaticCompaction = false;

  try {
    // Initialize Codex SDK
    logCodexBinarySelectionOnce(preferredCodexBinaryInfo);
    codex = preferredCodexPath
      ? new Codex({ codexPathOverride: preferredCodexPath, env: codexEnvironment })
      : new Codex();

    // Thread options with sandbox and approval settings
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model,
      modelReasoningEffort,
      additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined
    };
    const effectiveInput = buildCodexInput(baseCommand, normalizedAttachments);

    if (sessionId && !isCodexCompactCommand(command)) {
      try {
        const currentTokenUsage = await readCodexSessionContextTokenUsage(sessionId);
        if (doesCodexSessionLikelyNeedCompaction(currentTokenUsage)) {
          hasAttemptedAutomaticCompaction = true;
          const compactAttempt = await executeCodexAttempt({
            codex,
            resumeSessionId: sessionId,
            effectiveInput: CODEX_AUTO_COMPACT_COMMAND,
            threadOptions,
            ws,
            abortController,
            fallbackThreadName,
            preferredCodexBinaryInfo,
            requestedWorkingDirectory,
          });
          currentSessionId = compactAttempt.sessionId || currentSessionId;

          if (compactAttempt.wasAborted) {
            return;
          }
        }
      } catch (compactPreparationError) {
        console.warn('[Codex] Automatic preflight compaction skipped:', compactPreparationError);
      }
    }

    const attemptResult = await executeCodexAttempt({
      codex,
      resumeSessionId: currentSessionId || sessionId,
      effectiveInput,
      threadOptions,
      ws,
      abortController,
      fallbackThreadName,
      preferredCodexBinaryInfo,
      requestedWorkingDirectory,
    });
    currentSessionId = attemptResult.sessionId || currentSessionId;

    if (attemptResult.wasAborted) {
      return;
    }

    // Send completion event
    sendMessage(ws, {
      type: 'codex-complete',
      sessionId: currentSessionId,
      actualSessionId: currentSessionId
    });

  } catch (error) {
    const session = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (
      !wasAborted &&
      currentSessionId &&
      !hasAttemptedAutomaticCompaction &&
      !isCodexCompactCommand(command) &&
      isCodexContextLimitError(error)
    ) {
      try {
        hasAttemptedAutomaticCompaction = true;

        const compactAttempt = await executeCodexAttempt({
          codex,
          resumeSessionId: currentSessionId,
          effectiveInput: CODEX_AUTO_COMPACT_COMMAND,
          threadOptions: {
            workingDirectory,
            skipGitRepoCheck: true,
            sandboxMode,
            approvalPolicy,
            model,
            modelReasoningEffort,
            additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined
          },
          ws,
          abortController,
          fallbackThreadName,
          preferredCodexBinaryInfo,
          requestedWorkingDirectory,
        });
        currentSessionId = compactAttempt.sessionId || currentSessionId;

        if (compactAttempt.wasAborted) {
          return;
        }

        const retryAttempt = await executeCodexAttempt({
          codex,
          resumeSessionId: currentSessionId,
          effectiveInput,
          threadOptions: {
            workingDirectory,
            skipGitRepoCheck: true,
            sandboxMode,
            approvalPolicy,
            model,
            modelReasoningEffort,
            additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined
          },
          ws,
          abortController,
          fallbackThreadName,
          preferredCodexBinaryInfo,
          requestedWorkingDirectory,
        });
        currentSessionId = retryAttempt.sessionId || currentSessionId;

        if (retryAttempt.wasAborted) {
          return;
        }

        sendMessage(ws, {
          type: 'codex-complete',
          sessionId: currentSessionId,
          actualSessionId: currentSessionId
        });
        return;
      } catch (compactionError) {
        error = compactionError;
      }
    }

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: extractCodexErrorMessage(error),
        sessionId: error?.codexSessionId || currentSessionId
      });
    }
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = activeCodexSessions.get(sessionId);

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = activeCodexSessions.get(sessionId);
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status === 'running') {
      sessions.push({
        id,
        status: session.status,
        startedAt: session.startedAt
      });
    }
  }

  return sessions;
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

// Clean up old completed sessions periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

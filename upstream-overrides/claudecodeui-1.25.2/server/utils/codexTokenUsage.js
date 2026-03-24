import fsSync, { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_CODEX_CONTEXT_WINDOW = 200000;
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

function normalizeNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizePositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Extract the current-context token usage from a Codex `token_count` info payload.
 * Codex exposes both cumulative totals and last-turn usage; context occupancy should
 * follow the latest turn input size so compacting the session resets the percentage.
 *
 * @param {object | null | undefined} tokenInfo Codex `event_msg.payload.info` payload.
 * @returns {{used: number, total: number, breakdown: {input: number, cachedInput: number, output: number, reasoningOutput: number, cumulativeTotal: number | null}} | null}
 * Returns `null` when the payload does not contain usable token usage data.
 */
export function extractCodexContextTokenUsageFromInfo(tokenInfo) {
  if (!tokenInfo || typeof tokenInfo !== 'object') {
    return null;
  }

  const lastTokenUsage =
    tokenInfo.last_token_usage && typeof tokenInfo.last_token_usage === 'object'
      ? tokenInfo.last_token_usage
      : null;
  const totalTokenUsage =
    tokenInfo.total_token_usage && typeof tokenInfo.total_token_usage === 'object'
      ? tokenInfo.total_token_usage
      : null;

  const inputTokens =
    normalizeNonNegativeNumber(lastTokenUsage?.input_tokens) ??
    normalizeNonNegativeNumber(lastTokenUsage?.total_tokens) ??
    normalizeNonNegativeNumber(totalTokenUsage?.input_tokens) ??
    normalizeNonNegativeNumber(totalTokenUsage?.total_tokens);
  const cachedInputTokens =
    normalizeNonNegativeNumber(lastTokenUsage?.cached_input_tokens) ??
    normalizeNonNegativeNumber(totalTokenUsage?.cached_input_tokens) ??
    0;
  const outputTokens =
    normalizeNonNegativeNumber(lastTokenUsage?.output_tokens) ??
    normalizeNonNegativeNumber(totalTokenUsage?.output_tokens) ??
    0;
  const reasoningOutputTokens =
    normalizeNonNegativeNumber(lastTokenUsage?.reasoning_output_tokens) ??
    normalizeNonNegativeNumber(totalTokenUsage?.reasoning_output_tokens) ??
    0;
  const contextWindow =
    normalizePositiveNumber(tokenInfo.model_context_window) ?? DEFAULT_CODEX_CONTEXT_WINDOW;

  if (inputTokens === null) {
    return null;
  }

  return {
    used: inputTokens,
    total: contextWindow,
    breakdown: {
      input: inputTokens,
      cachedInput: cachedInputTokens,
      output: outputTokens,
      reasoningOutput: reasoningOutputTokens,
      cumulativeTotal: normalizeNonNegativeNumber(totalTokenUsage?.total_tokens),
    },
  };
}

/**
 * Extract current-context usage from a Codex streamed `turn.completed` usage payload.
 *
 * @param {object | null | undefined} usage Codex streamed usage payload.
 * @param {number} [contextWindow=DEFAULT_CODEX_CONTEXT_WINDOW] Fallback context window.
 * @returns {{used: number, total: number, breakdown: {input: number, cachedInput: number, output: number, reasoningOutput: number}} | null}
 * Returns `null` when the payload does not contain usable input token data.
 */
export function extractCodexContextTokenUsageFromTurnUsage(
  usage,
  contextWindow = DEFAULT_CODEX_CONTEXT_WINDOW,
) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens =
    normalizeNonNegativeNumber(usage.input_tokens) ??
    normalizeNonNegativeNumber(usage.total_tokens);
  if (inputTokens === null) {
    return null;
  }

  return {
    used: inputTokens,
    total: normalizePositiveNumber(contextWindow) ?? DEFAULT_CODEX_CONTEXT_WINDOW,
    breakdown: {
      input: inputTokens,
      cachedInput: normalizeNonNegativeNumber(usage.cached_input_tokens) ?? 0,
      output: normalizeNonNegativeNumber(usage.output_tokens) ?? 0,
      reasoningOutput: normalizeNonNegativeNumber(usage.reasoning_output_tokens) ?? 0,
    },
  };
}

/**
 * Find the Codex session JSONL file for a given session id.
 *
 * @param {string} sessionId Codex session id; must be non-empty.
 * @param {string} [sessionsRoot=CODEX_SESSIONS_ROOT] Root directory containing Codex session files.
 * @returns {Promise<string | null>} Absolute file path when found; otherwise `null`.
 * @throws Re-throws unexpected filesystem errors while traversing the sessions tree.
 */
export async function findCodexSessionFile(sessionId, sessionsRoot = CODEX_SESSIONS_ROOT) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return null;
  }

  const visitDirectory = async (directoryPath) => {
    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (
        error?.code === 'ENOENT' ||
        error?.code === 'EACCES' ||
        error?.code === 'EPERM'
      ) {
        return null;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        const nestedMatch = await visitDirectory(fullPath);
        if (nestedMatch) {
          return nestedMatch;
        }
        continue;
      }

      if (entry.isFile() && entry.name.includes(normalizedSessionId) && entry.name.endsWith('.jsonl')) {
        return fullPath;
      }
    }

    return null;
  };

  return visitDirectory(sessionsRoot);
}

/**
 * Read the latest current-context token usage snapshot from a Codex session JSONL file.
 *
 * @param {string} sessionId Codex session id.
 * @param {string} [sessionsRoot=CODEX_SESSIONS_ROOT] Root directory containing Codex session files.
 * @returns {Promise<{used: number, total: number, breakdown: {input: number, cachedInput: number, output: number, reasoningOutput: number, cumulativeTotal: number | null}} | null>}
 * Returns `null` when the session file cannot be found or does not contain a `token_count` event yet.
 * @throws Re-throws unexpected filesystem errors while reading the session file.
 */
export async function readCodexSessionContextTokenUsage(
  sessionId,
  sessionsRoot = CODEX_SESSIONS_ROOT,
) {
  const sessionFilePath = await findCodexSessionFile(sessionId, sessionsRoot);
  if (!sessionFilePath) {
    return null;
  }

  const fileContent = await fs.readFile(sessionFilePath, 'utf8');
  const lines = fileContent.trim().split('\n');

  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const currentLine = lines[lineIndex];
    if (!currentLine) {
      continue;
    }

    try {
      const entry = JSON.parse(currentLine);
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count' || !entry.payload?.info) {
        continue;
      }

      const usage = extractCodexContextTokenUsageFromInfo(entry.payload.info);
      if (usage) {
        return usage;
      }
    } catch {
      // Skip malformed lines so one bad record does not break the whole session.
    }
  }

  return null;
}

export function doesCodexSessionLikelyNeedCompaction(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') {
    return false;
  }

  const used = normalizeNonNegativeNumber(tokenUsage.used);
  const total = normalizePositiveNumber(tokenUsage.total);
  if (used === null || total === null) {
    return false;
  }

  return used >= total;
}

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Codex-only hardened mode
 * Keeps the UI aligned with the reduced backend surface for a single-user remote Codex panel.
 */
export const IS_CODEX_ONLY_HARDENED = import.meta.env.VITE_CODEX_ONLY_HARDENED_MODE !== 'false';

/**
 * Codex chat model options.
 * Keeps the UI focused on the current preferred OpenAI Codex models.
 */
export const CODEX_CHAT_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  ],
  DEFAULT: 'gpt-5.4',
} as const;

/**
 * Codex reasoning effort presets.
 * These map directly to the Codex SDK `modelReasoningEffort` option.
 */
export const CODEX_REASONING_EFFORTS = {
  OPTIONS: [
    { value: 'xhigh', label: 'XHigh' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
    { value: 'minimal', label: 'Minimal' },
  ],
  DEFAULT: 'xhigh',
} as const;

/**
 * Default Codex permission mode for chat sessions.
 * `bypassPermissions` maps to `danger-full-access` on the backend.
 */
export const CODEX_DEFAULT_PERMISSION_MODE = 'bypassPermissions';

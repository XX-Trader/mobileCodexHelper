import { IS_CODEX_ONLY_HARDENED, IS_PLATFORM } from "../constants/config";
import { getDeviceIdentity, getStoredDeviceSession } from "../components/auth/deviceTrust.js";

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const defaultHeaders = {};
  const deviceSession = getStoredDeviceSession();

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  return fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...defaultHeaders,
      ...(deviceSession?.token ? { Authorization: `Bearer ${deviceSession.token}` } : {}),
      ...options.headers,
    },
  });
};

const buildAuthPayload = (username, password) => ({
  username,
  password,
  ...getDeviceIdentity(),
});

const CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

const appendQueryParams = (url, params = {}) => {
  const [pathPart, hashPart = ''] = String(url || '').split('#');
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    searchParams.set(key, String(value));
  });

  if ([...searchParams.keys()].length === 0) {
    return url;
  }

  const queryJoiner = pathPart.includes('?') ? '&' : '?';
  const suffix = hashPart ? `#${hashPart}` : '';
  return `${pathPart}${queryJoiner}${searchParams.toString()}${suffix}`;
};

const resolveAttachmentFileName = (attachment, response) => {
  const headerValue = response?.headers?.get('X-Chat-Attachment-File-Name');
  if (headerValue) {
    try {
      return decodeURIComponent(headerValue);
    } catch {
      return headerValue;
    }
  }

  return attachment?.name || 'attachment';
};

const readErrorMessage = async (response, fallbackMessage) => {
  try {
    const errorData = await response.json();
    return errorData?.error || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status', { credentials: 'same-origin' }),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAuthPayload(username, password)),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAuthPayload(username, password)),
    }),
    deviceApprovalStatus: (requestToken) =>
      fetch(`/api/auth/device-approval/${encodeURIComponent(requestToken)}`, { credentials: 'same-origin' }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: () => authenticatedFetch('/api/projects'),
  sessions: (projectName, limit = 5, offset = 0) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  sessionMessages: (projectName, sessionId, limit = null, offset = 0, provider = IS_CODEX_ONLY_HARDENED ? 'codex' : 'claude') => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', limit);
      params.append('offset', offset);
    }
    const queryString = params.toString();

    let url;
    if (provider === 'codex') {
      url = `/api/codex/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'cursor') {
      url = `/api/cursor/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else if (provider === 'gemini') {
      url = `/api/gemini/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    } else {
      url = `/api/projects/${projectName}/sessions/${sessionId}/messages${queryString ? `?${queryString}` : ''}`;
    }
    return authenticatedFetch(url);
  },
  renameProject: (projectName, displayName) =>
    authenticatedFetch(`/api/projects/${projectName}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  setProjectHiddenState: (projectName, hidden) =>
    authenticatedFetch(`/api/projects/${projectName}/hidden`, {
      method: 'PUT',
      body: JSON.stringify({ hidden }),
    }),
  deleteSession: (projectName, sessionId) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  renameSession: (sessionId, summary, provider) =>
    authenticatedFetch(`/api/sessions/${sessionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  deleteCodexSession: (sessionId) =>
    authenticatedFetch(`/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteGeminiSession: (sessionId) =>
    authenticatedFetch(`/api/gemini/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false) =>
    authenticatedFetch(`/api/projects/${projectName}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  searchConversationsUrl: (query, limit = 50) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return `/api/search/conversations?${params.toString()}`;
  },
  createProject: (path) =>
    authenticatedFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    authenticatedFetch('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, options),

  // File operations
  createFile: (projectName, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectName, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectName, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  uploadChatAttachments: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/chat-attachments`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  transcribe: (formData) =>
    authenticatedFetch('/api/transcribe', {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) =>
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    language: () => authenticatedFetch('/api/user/language'),
    updateLanguage: (language) =>
      authenticatedFetch('/api/user/language', {
        method: 'PUT',
        body: JSON.stringify({ language }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};

/**
 * Builds a protected chat attachment content URL for a project-scoped temporary attachment.
 *
 * @param {string} projectName Project name; cannot be empty.
 * @param {string} filePath Absolute server-side attachment path returned by the upload endpoint.
 * @param {{ download?: boolean, maxBytes?: number | null }} [options] Optional response modifiers.
 * @returns {string} Relative API URL that can be used with authenticated fetch helpers.
 * @throws {Error} Throws when projectName or filePath is missing.
 */
export const buildChatAttachmentUrl = (projectName, filePath, options = {}) => {
  if (!projectName || !filePath) {
    throw new Error('Missing projectName or filePath when building chat attachment URL');
  }

  const baseUrl = `/api/projects/${encodeURIComponent(projectName)}/chat-attachments/content`;
  return appendQueryParams(baseUrl, {
    filePath,
    ...(options.download ? { download: 1 } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
};

/**
 * Resolves the best available chat attachment content URL.
 *
 * @param {string} projectName Project name; required when attachment metadata does not already include a URL.
 * @param {{ path?: string, contentUrl?: string, previewUrl?: string, downloadUrl?: string }} attachment Attachment metadata from chat messages.
 * @param {{ download?: boolean, maxBytes?: number | null }} [options] Optional response modifiers.
 * @returns {string} Relative API URL for authenticated attachment access.
 * @throws {Error} Throws when the attachment cannot be resolved to a URL.
 */
export const resolveChatAttachmentUrl = (projectName, attachment, options = {}) => {
  const baseUrl = options.download
    ? attachment?.downloadUrl || attachment?.contentUrl || attachment?.previewUrl
    : attachment?.contentUrl || attachment?.previewUrl || attachment?.downloadUrl;

  if (baseUrl) {
    return appendQueryParams(baseUrl, {
      ...(options.download ? { download: 1 } : {}),
      ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
    });
  }

  if (!attachment?.path) {
    throw new Error('Attachment path is missing');
  }

  return buildChatAttachmentUrl(projectName, attachment.path, options);
};

/**
 * Fetches a chat attachment as a Blob using the same bearer/cookie auth as the rest of the app.
 *
 * @param {string} projectName Project name used to derive fallback URLs.
 * @param {{ name?: string, path?: string, contentUrl?: string, previewUrl?: string, downloadUrl?: string, previewKind?: string }} attachment Attachment metadata.
 * @param {{ download?: boolean }} [options] Whether the server should return an attachment disposition.
 * @returns {Promise<{ blob: Blob, contentType: string, fileName: string, previewKind: string, size: number | null }>} Attachment payload and metadata.
 * @throws {Error} Throws when the request fails or returns a non-2xx status.
 */
export const fetchChatAttachmentBlob = async (projectName, attachment, options = {}) => {
  const requestUrl = resolveChatAttachmentUrl(projectName, attachment, options);
  const response = await authenticatedFetch(requestUrl);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load attachment'));
  }

  const blob = await response.blob();
  const sizeHeader = response.headers.get('X-Chat-Attachment-Original-Size');
  const parsedSize = sizeHeader ? Number.parseInt(sizeHeader, 10) : Number.NaN;

  return {
    blob,
    contentType: response.headers.get('Content-Type') || blob.type || 'application/octet-stream',
    fileName: resolveAttachmentFileName(attachment, response),
    previewKind: response.headers.get('X-Chat-Attachment-Preview-Kind') || attachment?.previewKind || 'unsupported',
    size: Number.isFinite(parsedSize) ? parsedSize : (typeof attachment?.size === 'number' ? attachment.size : null),
  };
};

/**
 * Fetches a chat attachment preview as text with optional server-side truncation.
 *
 * @param {string} projectName Project name used to derive fallback URLs.
 * @param {{ path?: string, contentUrl?: string, previewUrl?: string, name?: string, previewKind?: string, size?: number }} attachment Attachment metadata.
 * @param {{ maxBytes?: number }} [options] Maximum preview bytes. Values above 4MB are clamped.
 * @returns {Promise<{ text: string, truncated: boolean, mimeType: string, fileName: string, previewKind: string, size: number | null, maxBytes: number }>} Text preview payload and headers.
 * @throws {Error} Throws when the request fails or the server rejects the preview request.
 */
export const fetchChatAttachmentTextPreview = async (projectName, attachment, options = {}) => {
  const requestedMaxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.min(Number(options.maxBytes), CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES))
    : CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES;
  const requestUrl = resolveChatAttachmentUrl(projectName, attachment, { maxBytes: requestedMaxBytes });
  const response = await authenticatedFetch(requestUrl);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load attachment preview'));
  }

  const sizeHeader = response.headers.get('X-Chat-Attachment-Original-Size');
  const parsedSize = sizeHeader ? Number.parseInt(sizeHeader, 10) : Number.NaN;

  return {
    text: await response.text(),
    truncated: response.headers.get('X-Chat-Attachment-Truncated') === '1',
    mimeType: response.headers.get('Content-Type') || attachment?.mimeType || 'text/plain',
    fileName: resolveAttachmentFileName(attachment, response),
    previewKind: response.headers.get('X-Chat-Attachment-Preview-Kind') || attachment?.previewKind || 'unsupported',
    size: Number.isFinite(parsedSize) ? parsedSize : (typeof attachment?.size === 'number' ? attachment.size : null),
    maxBytes: requestedMaxBytes,
  };
};

/**
 * Downloads a protected chat attachment through the browser download flow.
 *
 * @param {string} projectName Project name used to derive fallback URLs.
 * @param {{ name?: string, path?: string, contentUrl?: string, previewUrl?: string, downloadUrl?: string }} attachment Attachment metadata.
 * @returns {Promise<void>} Resolves when the browser download has been triggered.
 * @throws {Error} Throws when the attachment request fails.
 */
export const downloadChatAttachment = async (projectName, attachment) => {
  const { blob, fileName } = await fetchChatAttachmentBlob(projectName, attachment, { download: true });
  const objectUrl = window.URL.createObjectURL(blob);

  try {
    const downloadLink = document.createElement('a');
    downloadLink.href = objectUrl;
    downloadLink.download = attachment?.name || fileName;
    downloadLink.rel = 'noopener noreferrer';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  } finally {
    window.setTimeout(() => {
      window.URL.revokeObjectURL(objectUrl);
    }, 0);
  }
};

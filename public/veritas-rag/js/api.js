/**
 * VeritasRAG API client — talks to Express /veritas-rag/*
 */
import { state } from './state.js';

const DEFAULT_BASE = (() => {
  const { protocol, hostname, port } = window.location;
  // When served from Express static (/veritas-rag-ui) or same host:3001
  if (port === '3001' || hostname === 'localhost' || hostname === '127.0.0.1') {
    const apiPort = port === '3001' ? '3001' : '3001';
    return `${protocol}//${hostname}:${apiPort}/veritas-rag`;
  }
  // Netlify static: proxy via env override
  return localStorage.getItem('veritasrag_api') || 'http://localhost:3001/veritas-rag';
})();

export function getApiBase() {
  return localStorage.getItem('veritasrag_api') || DEFAULT_BASE;
}

function headers(extra = {}) {
  const h = {
    ...extra,
    'X-Veritas-Mode': state.mode,
    'X-Veritas-Demo': 'true',
  };
  if (state.role) h['X-Veritas-Role'] = state.role;
  if (state.userId) h['X-Veritas-User-Id'] = state.userId;
  if (state.workspaceId) h['X-Veritas-Workspace'] = state.workspaceId;
  return h;
}

async function request(path, options = {}) {
  const url = `${getApiBase()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: headers(options.headers || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  meta: () => request('/meta'),
  ensureWorkspace: () => request('/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  currentWorkspace: () => request('/workspaces/current'),
  listDocuments: (q = '') => request(`/documents${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getDocument: (id) => request(`/documents/${id}`),
  deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  reindexDocument: (id) => request(`/documents/${id}/reindex`, { method: 'POST' }),
  async uploadDocuments(files, onProgress = null) {
    if (!files?.length) return { workspaceId: null, documents: [] };

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `${getApiBase()}/documents/upload`;
      xhr.open('POST', url, true);
      xhr.setRequestHeader('X-Veritas-Mode', state.mode);
      xhr.setRequestHeader('X-Veritas-Demo', 'true');
      if (state.role) xhr.setRequestHeader('X-Veritas-Role', state.role);
      if (state.userId) xhr.setRequestHeader('X-Veritas-User-Id', state.userId);
      if (state.workspaceId) xhr.setRequestHeader('X-Veritas-Workspace', state.workspaceId);

      xhr.upload.onprogress = (event) => {
        if (!onProgress || !event.lengthComputable) return;
        const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        onProgress({ percent, loaded: event.loaded, total: event.total, type: 'upload' });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const payload = JSON.parse(xhr.responseText);
            if (payload?.workspaceId) {
              state.workspaceId = payload.workspaceId;
            }
            resolve(payload);
          } catch {
            resolve({ workspaceId: state.workspaceId, documents: [] });
          }
          return;
        }

        let message = 'Upload failed';
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed?.error) message = parsed.error;
        } catch {
          // ignore malformed payloads
        }
        reject(new Error(message));
      };

      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));

      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      xhr.send(fd);
    });
  },
  ask: (question, conversationId = null, documentIds = null) =>
    request('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, conversationId, documentIds }),
    }),
  conversations: () => request('/conversations'),
  conversation: (id) => request(`/conversations/${id}`),
  dashboard: () => request('/jkuat/dashboard'),
  timetable: () => request('/jkuat/timetable'),
  announcements: () => request('/jkuat/announcements'),
  notifications: () => request('/jkuat/notifications'),
  markRead: (id) => request(`/jkuat/notifications/${id}/read`, { method: 'POST' }),
  listChanges: () => request('/jkuat/schedule-changes'),
  proposeChange: (body) =>
    request('/jkuat/schedule-changes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  submitChange: (id) => request(`/jkuat/schedule-changes/${id}/submit`, { method: 'POST' }),
  publishChange: (id) =>
    request(`/jkuat/schedule-changes/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Veritas-Demo-Publish': 'true' },
      body: JSON.stringify({ demoPublish: true }),
    }),
  cancelChange: (id) => request(`/jkuat/schedule-changes/${id}/cancel`, { method: 'POST' }),
  freshness: () => request('/admin/freshness'),

  /**
   * Send raw Float32 PCM audio (16 kHz mono) to the voice endpoint.
   * The server transcribes, runs the full RAG pipeline, and returns TTS audio.
   *
   * @param {Float32Array} samples  16 kHz mono Float32 PCM
   * @returns {Promise<{question: string, answer: string, audioBase64: string|null}>}
   */
  voiceAsk(samples) {
    const url = `${getApiBase()}/voice/ask`;
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...headers({ 'Content-Type': 'application/octet-stream' }),
      },
      body: buffer,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || res.statusText || 'Voice request failed');
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  },
};

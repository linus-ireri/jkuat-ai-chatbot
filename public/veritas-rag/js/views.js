import { api, getApiBase } from './api.js';
import { state, setRole, getAvailableRoles } from './state.js';
import { toast } from './toast.js';
// Imported lazily to avoid a circular dependency — app.js imports views.js
// via renderAssistant, so we use a dynamic import inside the function.
async function refreshSidebarHistory() {
  try {
    const { renderSidebarHistory } = await import('./app.js');
    await renderSidebarHistory();
  } catch {
    // non-fatal — sidebar just won't update until next navigation
  }
}

function roleDisplayName(role) {
  const normalized = String(role || '').toLowerCase();
  return normalized
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'User';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function supportBadge(level) {
  const map = {
    strong: ['ok', 'Strongly supported'],
    partial: ['warn', 'Partially supported'],
    conflicting: ['warn', 'Conflicting evidence'],
    insufficient: ['', 'Insufficient evidence'],
  };
  const [cls, label] = map[level] || map.insufficient;
  return `<span class="badge ${cls}">${label}</span>`;
}

const DOCUMENT_PROGRESS_STEPS = {
  uploaded: { percent: 12, label: 'Preparing upload' },
  extracting: { percent: 35, label: 'Extracting text' },
  chunking: { percent: 55, label: 'Chunking content' },
  embedding: { percent: 75, label: 'Embedding vectors' },
  indexing: { percent: 90, label: 'Building index' },
  ready: { percent: 100, label: 'Finalizing index' },
  failed: { percent: 100, label: 'Processing failed' },
};

function progressMarkup(percent, label, detail) {
  const safeLabel = esc(label || 'Processing');
  const safeDetail = esc(detail || `${Math.max(0, Math.min(100, Number(percent) || 0))}% complete`);
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return `
    <div class="progress-loader" aria-live="polite" aria-atomic="true">
      <div class="progress-spinner" aria-hidden="true"></div>
      <div class="progress-details">
        <div class="progress-header">${safeLabel}</div>
        <div class="progress"><span style="width:${safePercent}%"></span></div>
        <small>${safeDetail}</small>
      </div>
    </div>
  `;
}

async function pollDocumentProgress({ documentId = null, filenames = [], statusEl, maxWaitMs = 180000 }) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const data = await api.listDocuments();
      const doc = documentId
        ? data.documents.find((entry) => entry.id === documentId)
        : (data.documents || []).find((entry) => filenames.some((name) => entry.filename === name));

      if (doc) {
        const step = DOCUMENT_PROGRESS_STEPS[doc.status] || DOCUMENT_PROGRESS_STEPS.uploaded;
        const detail = doc.status === 'ready'
          ? 'Ready for answers'
          : doc.status === 'failed'
            ? (doc.error_message || 'Could not complete ingestion')
            : `${step.percent}% complete`;
        if (statusEl) statusEl.innerHTML = progressMarkup(step.percent, step.label, detail);
        if (doc.status === 'ready' || doc.status === 'failed') return doc;
      }
    } catch {
      // retry until the workspace becomes available again
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  if (statusEl) {
    statusEl.innerHTML = progressMarkup(95, 'Finishing up', 'Wrapping up ingestion…');
  }
  return null;
}

export async function renderOverview(root) {
  if (state.mode === 'generic') {
    root.innerHTML = `<div class="panel"><div class="skeleton" style="height:6rem"></div></div>`;
    try {
      const data = await api.currentWorkspace();
      state.workspaceId = data.workspace.id;
      const ready = data.documents.filter((d) => d.status === 'ready').length;
      const failed = data.documents.filter((d) => d.status === 'failed').length;
      root.innerHTML = `
        <div class="panel">
          <h2>Generic workspace</h2>
          <p class="sub">Private document RAG. Retrieval is scoped to your workspace on the server.</p>
          <div class="grid-3">
            <div class="stat"><div class="n">${data.documents.length}</div><div class="l">Documents</div></div>
            <div class="stat"><div class="n">${ready}</div><div class="l">Ready</div></div>
            <div class="stat"><div class="n">${failed}</div><div class="l">Failed</div></div>
          </div>
          <div class="mode-actions" style="margin-top:1rem">
            <a class="btn btn-primary" href="#/generic/documents">Upload documents</a>
            <a class="btn btn-secondary" href="#/generic/assistant">Ask my documents</a>
          </div>
        </div>
        <div class="panel">
          <h2>How it works</h2>
          <p class="sub">Uploaded → Extracting → Chunking → Embedding → Indexing → Ready. Answers cite retrieved excerpts only.</p>
        </div>`;
    } catch (err) {
      root.innerHTML = `<div class="panel"><p class="empty">Could not load workspace: ${esc(err.message)}. Is the RAG server running on port 3001?</p></div>`;
    }
    return;
  }

  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:8rem"></div></div>`;
  try {
    const dash = await api.dashboard();
    const roleTitle = roleDisplayName(dash.role);
    let body = `
      <div class="panel">
        <h2>${esc(roleTitle)} dashboard</h2>
        <p class="sub"><span class="badge">${esc(dash.demoLabel)}</span> Identity is <strong>not verified</strong>.</p>
        <div class="grid-3">
          <div class="stat"><div class="n">${(dash.timetable || dash.timetableSample || []).length}</div><div class="l">Timetable rows</div></div>
          <div class="stat"><div class="n">${(dash.announcements || []).length}</div><div class="l">Announcements</div></div>
          <div class="stat"><div class="n">${(dash.notifications || []).length}</div><div class="l">Notifications</div></div>
        </div>
      </div>`;

    if (dash.faqs?.length) {
      body += `<div class="panel"><h2>Suggested questions</h2><div class="followups">${dash.faqs.map((q) =>
        `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`
      ).join('')}</div></div>`;
    }
    if (dash.publicTopics) {
      body += `<div class="panel"><h2>Public topics</h2><p class="sub">${dash.publicTopics.map(esc).join(' · ')}</p>
        <p class="sub">Private timetables and internal records are not available in public mode.</p></div>`;
    }
    if (dash.allocations) {
      body += `<div class="panel"><h2>Assigned units (demo)</h2><div class="table-wrap"><table class="data"><thead><tr><th>Code</th><th>Name</th><th>Group</th></tr></thead><tbody>
        ${dash.allocations.map((a) => `<tr><td>${esc(a.unit_code)}</td><td>${esc(a.unit_name)}</td><td>${esc(a.student_group)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    }
    root.innerHTML = body;
    root.querySelectorAll('[data-ask]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.hash = `#/jkuat/assistant?q=${encodeURIComponent(btn.dataset.ask)}`;
      });
    });
  } catch (err) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

export async function renderDocuments(root) {
  root.innerHTML = `
    <div class="panel">
      <h2>Documents</h2>
      <p class="sub">PDF, DOCX, TXT, CSV · max 8&nbsp;MB · private workspace isolation</p>
      <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Upload documents">
        <p><strong>Drop files here</strong> or click to browse</p>
        <input type="file" id="file-input" class="sr-only" multiple accept=".pdf,.txt,.csv,.docx,application/pdf,text/plain,text/csv" />
      </div>
      <div id="upload-status"></div>
    </div>
    <div class="panel">
      <div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
        <input type="search" id="doc-search" placeholder="Filter by filename…" style="flex:1;border:1px solid var(--line);border-radius:10px;padding:0.5rem 0.7rem;background:var(--bg-elevated)" />
        <button type="button" class="btn btn-secondary btn-sm" id="refresh-docs">Refresh</button>
      </div>
      <div id="doc-list"><div class="skeleton" style="height:4rem"></div></div>
    </div>`;

  const drop = root.querySelector('#dropzone');
  const input = root.querySelector('#file-input');
  const status = root.querySelector('#upload-status');

  async function refresh(q = '') {
    const list = root.querySelector('#doc-list');
    try {
      const data = await api.listDocuments(q);
      state.workspaceId = data.workspaceId;
      if (!data.documents.length) {
        list.innerHTML = `<div class="empty">No documents yet. Upload a PDF or text file to begin.</div>`;
        return;
      }
      list.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
        <th>File</th><th>Status</th><th>Chunks</th><th>Indexed</th><th></th>
      </tr></thead><tbody>
        ${data.documents.map((d) => `
          <tr>
            <td>${esc(d.filename)}<br><small style="color:var(--ink-muted)">${esc(d.format)} · ${(d.size_bytes / 1024).toFixed(1)} KB</small></td>
            <td><span class="status-pill ${esc(d.status)}">${esc(d.status)}</span>${d.error_message ? `<br><small>${esc(d.error_message)}</small>` : ''}</td>
            <td>${d.chunk_count || 0}</td>
            <td>${d.indexed_at ? esc(new Date(d.indexed_at).toLocaleString()) : '—'}</td>
            <td style="white-space:nowrap">
              <button type="button" class="btn btn-ghost btn-sm" data-reindex="${d.id}">Reindex</button>
              <button type="button" class="btn btn-danger btn-sm" data-del="${d.id}">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody></table></div>`;

      list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this document from the workspace index?')) return;
        await api.deleteDocument(b.dataset.del);
        toast('Document deleted');
        refresh(root.querySelector('#doc-search').value);
      }));
      list.querySelectorAll('[data-reindex]').forEach((b) => b.addEventListener('click', async () => {
        status.innerHTML = progressMarkup(8, 'Reindexing document', 'Starting ingestion…');
        try {
          const doc = await api.reindexDocument(b.dataset.reindex);
          await pollDocumentProgress({ documentId: b.dataset.reindex, statusEl: status });
          status.innerHTML = progressMarkup(100, 'Reindex complete', 'Document is ready for search.');
          toast(doc?.document?.status === 'ready' ? 'Reindex complete' : 'Reindex finished');
          refresh();
        } catch (err) {
          status.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
          toast(err.message, true);
        }
      }));
    } catch (err) {
      list.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  async function uploadFiles(files) {
    if (!files?.length) return;
    const fileList = [...files];
    status.innerHTML = progressMarkup(0, 'Preparing upload', '0% complete');
    try {
      const res = await api.uploadDocuments(fileList, ({ percent }) => {
        status.innerHTML = progressMarkup(percent, 'Uploading file(s)', `${percent}% complete`);
      });
      if (res?.workspaceId) state.workspaceId = res.workspaceId;
      await pollDocumentProgress({
        filenames: fileList.map((file) => file.name),
        statusEl: status,
      });
      status.innerHTML = progressMarkup(100, 'Upload complete', 'Ready for questions');
      toast('Ingestion complete');
      refresh();
    } catch (err) {
      status.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
      toast(err.message, true);
    }
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => uploadFiles(input.files));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
  }));
  drop.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));
  root.querySelector('#refresh-docs').addEventListener('click', () => refresh(root.querySelector('#doc-search').value));
  root.querySelector('#doc-search').addEventListener('input', (e) => refresh(e.target.value));
  await refresh();
}

export async function renderAssistant(root, presetQ = '') {
  root.innerHTML = `
    <div class="chat-layout">
      <div class="panel" style="display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;margin-bottom:0.5rem">
          <h2 style="margin:0;font-family:var(--display);font-size:1.2rem">AI Assistant</h2>
          <span id="support-slot"></span>
        </div>
        <p class="sub" style="margin-top:0">${state.mode === 'generic' ? 'Grounded in your workspace documents.' : `JKUAT mode · demo role: ${esc(state.role)}`}</p>
        <div class="chat-thread" id="thread" aria-live="polite" aria-label="Conversation"></div>
        <div class="followups" id="followups"></div>
        <div class="chat-composer">
          <textarea id="q" rows="2" placeholder="Ask a grounded question…" aria-label="Type your question"></textarea>
          <button type="button" class="btn btn-primary" id="send" aria-label="Send typed question">Ask</button>
          <button
            type="button"
            class="btn btn-voice"
            id="mic-btn"
            aria-label="Hold to record voice question (or hold Space)"
            aria-pressed="false"
            title="Hold to record — release to send"
          ><i class="fas fa-microphone" aria-hidden="true"></i></button>
        </div>
        <div id="voice-status" class="voice-status" aria-live="polite" aria-atomic="true"></div>
        <div id="voice-playback" class="voice-playback" hidden>
          <button type="button" class="btn btn-ghost btn-sm" id="replay-btn" aria-label="Replay last voice answer">
            <i class="fas fa-rotate-left" aria-hidden="true"></i> Repeat
          </button>
          <button type="button" class="btn btn-ghost btn-sm" id="stop-btn" aria-label="Stop audio playback">
            <i class="fas fa-stop" aria-hidden="true"></i> Stop
          </button>
        </div>
      </div>
      <aside class="panel evidence-panel" id="citation-drawer" aria-live="polite">
        <h2 style="font-family:var(--display);font-size:1.1rem;margin:0 0 0.5rem">Evidence inspector</h2>
        <p class="sub">Retrieved passages supporting the latest answer. Never fabricated.</p>
        <div id="evidence"><div class="empty">Ask a question to inspect evidence.</div></div>
      </aside>
    </div>`;

  const thread = root.querySelector('#thread');
  const evidenceEl = root.querySelector('#evidence');
  const supportSlot = root.querySelector('#support-slot');
  const followups = root.querySelector('#followups');
  const qInput = root.querySelector('#q');
  if (presetQ) qInput.value = presetQ;

  function formatInlineMarkdown(text) {
    return esc(String(text ?? ''))
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function markdownToHtml(markdown) {
    const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
    const html = [];
    let tableRows = [];
    let listItems = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${formatInlineMarkdown(paragraph.join(' '))}</p>`);
      paragraph = [];
    };

    const flushList = () => {
      if (!listItems.length) return;
      html.push(`<ul>${listItems.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
      listItems = [];
    };

    const flushTable = () => {
      if (tableRows.length < 2) return;
      const rows = tableRows.map((row) => row.map((cell) => cell.trim()));
      const header = rows[0];
      const body = rows.slice(1);
      html.push(`<table class="chat-table"><thead><tr>${header.map((cell) => `<th>${formatInlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${formatInlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      tableRows = [];
    };

    const isTableSeparator = (line) => /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line) || /^\s*(?:\|?\s*:?-{3,}:?\s*\|\s*)+:?\s*$/.test(line);

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.trim();

      if (!line) {
        flushParagraph();
        flushList();
        continue;
      }

      if (/^#{1,6}\s+/.test(line)) {
        flushParagraph();
        flushList();
        flushTable();
        const level = line.match(/^#+/)?.[0].length || 1;
        const text = line.replace(/^#+\s+/, '');
        html.push(`<h${level}>${formatInlineMarkdown(text)}</h${level}>`);
        continue;
      }

      if (/^[-*+]\s+/.test(line)) {
        flushParagraph();
        flushTable();
        listItems.push(line.replace(/^[-*+]\s+/, ''));
        continue;
      }

      if (line.includes('|')) {
        const nextLine = lines[i + 1]?.trim() || '';
        if (isTableSeparator(nextLine) || isTableSeparator(line)) {
          flushParagraph();
          flushList();
          if (line.includes('|')) {
            tableRows.push(line.split('|').map((cell) => cell.trim()).filter((_, index, arr) => index !== 0 || arr.length > 1));
          }
          if (isTableSeparator(nextLine)) {
            i += 1;
          }
          continue;
        }
      }

      if (tableRows.length) {
        if (line.includes('|')) {
          tableRows.push(line.split('|').map((cell) => cell.trim()).filter((_, index, arr) => index !== 0 || arr.length > 1));
          continue;
        }
        flushTable();
      }

      if (/^\d+\.\s+/.test(line)) {
        flushParagraph();
        flushList();
        html.push(`<ol><li>${formatInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li></ol>`);
        continue;
      }

      if (line.startsWith('>')) {
        flushParagraph();
        flushList();
        html.push(`<blockquote>${formatInlineMarkdown(line.replace(/^>\s*/, ''))}</blockquote>`);
        continue;
      }

      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    flushTable();

    return html.join('');
  }

  async function loadConversationThread() {
    if (!state.conversationId) return;
    try {
      const data = await api.conversation(state.conversationId);
      const existing = data.messages || [];
      existing.forEach((message) => {
        addBubble(message.role === 'assistant' ? 'assistant' : 'user', message.content);
      });
      if (existing.length) {
        const last = existing[existing.length - 1];
        if (last && last.support_level) {
          const items = last.evidence_json ? JSON.parse(last.evidence_json) : [];
          showEvidence(items, last.support_level);
        }
      }
    } catch {
      // ignore: a stale conversation id should not break the new chat view
    }
  }

  function addBubble(role, text) {
    const div = document.createElement('div');
    div.className = `bubble ${role}`;
    if (role === 'assistant') {
      div.innerHTML = markdownToHtml(text);
    } else {
      div.textContent = text;
    }
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    return div;
  }

  function renderCitationBadges(items = []) {
    if (!items.length) return '';
    return `<div class="citation-badges">${items.map((item, index) => `
      <button type="button" class="citation-badge" data-cite-index="${index}">${esc(item.title || `Doc ${index + 1}`)}${item.page != null ? `, p.${esc(item.page)}` : ''}</button>
    `).join('')}</div>`;
  }

  function showEvidence(items, support) {
    supportSlot.innerHTML = supportBadge(support);
    state.lastEvidence = items || [];
    state.lastSupport = support;
    if (!items?.length) {
      evidenceEl.innerHTML = `<div class="empty">No passages retrieved.</div>`;
      return;
    }
    evidenceEl.innerHTML = items.map((e) => `
      <div class="evidence-item">
        <strong>${esc(e.title)}</strong>
        <div style="font-size:0.75rem;color:var(--ink-muted);margin-bottom:0.35rem">
          ${e.page != null ? `Page ${esc(e.page)} · ` : ''}${e.section ? esc(e.section) : ''}
        </div>
        <div class="excerpt">${esc(e.excerpt)}</div>
      </div>`).join('');
    evidenceEl.querySelectorAll('.evidence-item').forEach((item, index) => {
      item.addEventListener('click', () => {
        const current = items[index];
        if (!current) return;
        const drawer = document.getElementById('citation-drawer');
        if (drawer) drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  async function ask(question) {
    if (!question.trim()) return;
    addBubble('user', question);
    qInput.value = '';
    const loading = document.createElement('div');
    loading.className = 'bubble assistant';
    loading.innerHTML = '<div class="skeleton" style="width:12rem"></div>';
    thread.appendChild(loading);
    try {
      const res = await api.ask(question, state.conversationId);
      const isNewConversation = !state.conversationId || state.conversationId !== res.conversationId;
      state.conversationId = res.conversationId;
      loading.remove();
      const bubble = addBubble('assistant', res.answer);
      if (res.evidence?.length) {
        const badgeWrap = document.createElement('div');
        badgeWrap.className = 'citation-row';
        badgeWrap.innerHTML = renderCitationBadges(res.evidence);
        bubble.appendChild(badgeWrap);
        badgeWrap.querySelectorAll('.citation-badge').forEach((button) => {
          button.addEventListener('click', () => {
            const idx = Number(button.dataset.citeIndex);
            const item = res.evidence[idx];
            if (!item) return;
            showEvidence([item], res.supportLevel);
            const drawer = document.getElementById('citation-drawer');
            if (drawer) drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        });
      }
      showEvidence(res.evidence, res.supportLevel);
      followups.innerHTML = (res.followUps || []).map((f) =>
        `<button type="button" data-f="${esc(f)}">${esc(f)}</button>`
      ).join('');
      followups.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => ask(b.dataset.f));
      });
      // Refresh sidebar so the new (or active) conversation appears immediately
      refreshSidebarHistory();
    } catch (err) {
      loading.remove();
      addBubble('assistant', `Error: ${err.message}`);
      toast(err.message, true);
    }
  }

  root.querySelector('#send').addEventListener('click', () => ask(qInput.value));
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(qInput.value);
    }
  });
  if (state.conversationId) {
    loadConversationThread();
  }
  if (presetQ) ask(presetQ);

  // ── Voice push-to-talk ────────────────────────────────────────────────────
  const micBtn = root.querySelector('#mic-btn');
  const voiceStatus = root.querySelector('#voice-status');
  const voicePlayback = root.querySelector('#voice-playback');
  const replayBtn = root.querySelector('#replay-btn');
  const stopBtn = root.querySelector('#stop-btn');

  /** @type {MediaRecorder|null} */
  let mediaRecorder = null;
  /** @type {AudioBuffer|null} */
  let lastAudio = null;
  /** @type {AudioBufferSourceNode|null} */
  let currentSource = null;
  /** @type {AudioContext|null} */
  let audioCtx = null;

  function setVoiceStatus(msg, isError = false) {
    voiceStatus.textContent = msg;
    voiceStatus.className = `voice-status${isError ? ' voice-status--error' : ''}`;
  }

  /** Stop any currently-playing audio */
  function stopPlayback() {
    if (currentSource) {
      try { currentSource.stop(); } catch { /* already stopped */ }
      currentSource = null;
    }
  }

  /**
   * Play a WAV audio buffer (Base64-encoded) from the server, or fall back
   * to the Web Speech API for the given text.
   */
  async function playAnswer(audioBase64, fallbackText) {
    stopPlayback();
    voicePlayback.hidden = false;

    if (audioBase64) {
      try {
        if (!audioCtx) audioCtx = new AudioContext();
        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const decoded = await audioCtx.decodeAudioData(bytes.buffer);
        lastAudio = decoded;
        currentSource = audioCtx.createBufferSource();
        currentSource.buffer = decoded;
        currentSource.connect(audioCtx.destination);
        currentSource.start();
        currentSource.onended = () => { currentSource = null; };
        return;
      } catch (err) {
        console.warn('[voice] Web Audio playback failed, using speechSynthesis:', err.message);
      }
    }

    // Browser TTS fallback
    if ('speechSynthesis' in window && fallbackText) {
      const utt = new SpeechSynthesisUtterance(fallbackText);
      utt.lang = 'en';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utt);
    }
  }

  replayBtn.addEventListener('click', () => {
    if (lastAudio && audioCtx) {
      stopPlayback();
      currentSource = audioCtx.createBufferSource();
      currentSource.buffer = lastAudio;
      currentSource.connect(audioCtx.destination);
      currentSource.start();
      currentSource.onended = () => { currentSource = null; };
    } else if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      // Re-speak the last assistant bubble
      const bubbles = thread.querySelectorAll('.bubble.assistant');
      const last = bubbles[bubbles.length - 1];
      if (last) {
        const utt = new SpeechSynthesisUtterance(last.textContent || '');
        utt.lang = 'en';
        window.speechSynthesis.speak(utt);
      }
    }
  });

  stopBtn.addEventListener('click', () => {
    stopPlayback();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setVoiceStatus('');
  });

  /**
   * Resample a Float32Array from `fromRate` to `toRate` (16 000 Hz) using
   * the OfflineAudioContext so we always send the right sample rate to Whisper.
   */
  async function resampleTo16k(inputSamples, fromRate) {
    if (fromRate === 16000) return inputSamples;
    const duration = inputSamples.length / fromRate;
    const outLength = Math.ceil(duration * 16000);
    const ctx = new OfflineAudioContext(1, outLength, 16000);
    const buf = ctx.createBuffer(1, inputSamples.length, fromRate);
    buf.copyToChannel(inputSamples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0);
  }

  async function startRecording() {
    if (mediaRecorder) return; // already recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      setVoiceStatus('● Recording… release to send', false);
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.classList.add('recording');

      /** @type {BlobPart[]} */
      const chunks = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.start(100); // collect in 100 ms slices
      mediaRecorder = mr;

      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        micBtn.setAttribute('aria-pressed', 'false');
        micBtn.classList.remove('recording');
        mediaRecorder = null;

        if (!chunks.length) {
          setVoiceStatus('No audio captured.', true);
          return;
        }

        setVoiceStatus('Processing…');
        try {
          // Decode the recorded blob via Web Audio
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          const arrayBuf = await blob.arrayBuffer();
          const tmpCtx = new AudioContext();
          const audioBuf = await tmpCtx.decodeAudioData(arrayBuf);
          tmpCtx.close();

          // Mix down to mono
          const monoSamples = (() => {
            const ch = audioBuf.numberOfChannels;
            const len = audioBuf.length;
            if (ch === 1) return audioBuf.getChannelData(0);
            const out = new Float32Array(len);
            for (let c = 0; c < ch; c++) {
              const data = audioBuf.getChannelData(c);
              for (let i = 0; i < len; i++) out[i] += data[i];
            }
            for (let i = 0; i < len; i++) out[i] /= ch;
            return out;
          })();

          // Resample to 16 kHz
          const samples16k = await resampleTo16k(monoSamples, audioBuf.sampleRate);

          setVoiceStatus('Sending to server…');
          const result = await api.voiceAsk(samples16k);

          // Show question and answer in the thread
          addBubble('user', `🎙️ ${result.question}`);
          const bubble = addBubble('assistant', result.answer);

          // Persist the conversation id so follow-up typed questions
          // can continue from the same conversation thread
          if (result.conversationId) {
            state.conversationId = result.conversationId;
          }

          setVoiceStatus(`Transcribed: "${result.question}"`);

          // Refresh sidebar so the voice conversation appears immediately
          refreshSidebarHistory();

          // Play back the answer
          await playAnswer(result.audioBase64, stripMarkdownForSpeech(result.answer));
        } catch (err) {
          setVoiceStatus(err.message || 'Voice request failed', true);
          toast(err.message || 'Voice request failed', true);
        }
      };
    } catch (err) {
      setVoiceStatus(
        err.name === 'NotAllowedError'
          ? 'Microphone access denied. Allow it in browser settings.'
          : `Microphone error: ${err.message}`,
        true
      );
      micBtn.setAttribute('aria-pressed', 'false');
      micBtn.classList.remove('recording');
      mediaRecorder = null;
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }

  // Simple helper for speech stripping in the fallback TTS path
  function stripMarkdownForSpeech(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/^\d+\.\s+/gm, '')
      .replace(/\|/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Mouse / touch: hold to record ──────────────────────────────────────────
  micBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener('mouseup', stopRecording);
  micBtn.addEventListener('mouseleave', stopRecording);
  micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); }, { passive: false });
  micBtn.addEventListener('touchend', stopRecording);
  micBtn.addEventListener('touchcancel', stopRecording);

  // ── Keyboard: hold Space to record (only when mic button has focus) ─────────
  // Also global Space when mic button has focus via tab
  micBtn.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      startRecording();
    }
  });
  micBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ') stopRecording();
  });
}

export async function renderTimetable(root) {
  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:6rem"></div></div>`;
  try {
    if (!state.role) {
      root.innerHTML = `<div class="panel"><h2>Timetable</h2><p class="empty">Select a role in Settings before opening private timetable data.</p></div>`;
      return;
    }
    const data = await api.timetable();

    // Status badge colours for change requests
    const statusColour = {
      draft:            'style="background:var(--ink-muted);color:#fff"',
      pending_approval: 'style="background:#f59e0b;color:#fff"',
      approved:         'style="background:#3b82f6;color:#fff"',
      published:        'style="background:#22c55e;color:#fff"',
      rejected:         'style="background:var(--danger);color:#fff"',
      cancelled:        'style="background:#6b7280;color:#fff"',
    };

    const statusLabel = {
      draft:            'Draft',
      pending_approval: 'Pending approval',
      approved:         'Approved',
      published:        'Published',
      rejected:         'Rejected',
      cancelled:        'Cancelled',
    };

    let html = `
      <div class="panel">
        <h2>Timetable</h2>
        <p class="sub"><span class="badge">DEMO DATA</span> Not official JKUAT registry records.</p>
        <div class="table-wrap"><table class="data"><thead><tr>
          <th>Unit</th><th>Day</th><th>Time</th><th>Venue</th><th>Group</th><th></th>
        </tr></thead><tbody>
        ${(data.entries || []).map((e) => `
          <tr>
            <td><strong>${esc(e.unit_code)}</strong><br><small>${esc(e.unit_name || e.unit_code)}</small></td>
            <td>${esc(e.day_of_week)}</td>
            <td>${esc(e.start_time)}–${esc(e.end_time)}</td>
            <td>${esc(e.venue_name)}</td>
            <td>${esc(e.student_group)}</td>
            <td>${state.role === 'lecturer' && e.lecturer_id === state.userId
              ? `<button type="button" class="btn btn-secondary btn-sm" data-change='${esc(JSON.stringify(e))}'>Propose change</button>`
              : ''}
            </td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;

    if (state.role === 'lecturer') {
      html += `
        <!-- ── Propose change form ── -->
        <div class="panel" id="change-panel" hidden>
          <h2>Propose schedule change</h2>
          <p class="sub">Changes are saved as a <strong>Draft</strong> first. Review them below, then <strong>Publish</strong> to update the timetable and notify students.</p>
          <form id="change-form">
            <input type="hidden" name="entryId" />
            <p id="change-unit-label" style="font-weight:600;margin-bottom:0.5rem"></p>
            <div class="grid-2">
              <div class="form-row">
                <label for="cf-day">New day</label>
                <select id="cf-day" name="proposedDay">
                  ${['Monday','Tuesday','Wednesday','Thursday','Friday'].map((d) => `<option>${d}</option>`).join('')}
                </select>
              </div>
              <div class="form-row">
                <label for="cf-venue">New venue</label>
                <select id="cf-venue" name="proposedVenueId">
                  <option value="v-lab1">SCC Lab 1</option>
                  <option value="v-lt2">Lecture Theatre 2</option>
                  <option value="v-hallA">Hall A</option>
                </select>
              </div>
              <div class="form-row">
                <label for="cf-start">Start time</label>
                <input id="cf-start" name="proposedStart" type="time" required />
              </div>
              <div class="form-row">
                <label for="cf-end">End time</label>
                <input id="cf-end" name="proposedEnd" type="time" required />
              </div>
            </div>
            <div class="form-row">
              <label for="cf-reason">Reason <small style="color:var(--ink-muted)">(optional)</small></label>
              <textarea id="cf-reason" name="reason" rows="2" placeholder="e.g. Venue maintenance, lecturer conflict…"></textarea>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem">
              <button type="submit" class="btn btn-primary">Save as draft</button>
              <button type="button" class="btn btn-ghost" id="cancel-change-form">Cancel</button>
            </div>
          </form>
          <div id="change-result" style="margin-top:0.75rem"></div>
        </div>

        <!-- ── Change requests list ── -->
        <div class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
            <h2 style="margin:0">Change requests</h2>
            <button type="button" class="btn btn-ghost btn-sm" id="refresh-changes">↻ Refresh</button>
          </div>
          <p class="sub">Drafts are visible only to you. Published changes update the live timetable and send student notifications.</p>
          <div id="changes-list"><div class="skeleton" style="height:3rem"></div></div>
        </div>`;
    }
    root.innerHTML = html;

    if (state.role === 'lecturer') {
      const panel      = root.querySelector('#change-panel');
      const form       = root.querySelector('#change-form');
      const resultBox  = root.querySelector('#change-result');
      const unitLabel  = root.querySelector('#change-unit-label');

      // Open form when "Propose change" is clicked on a timetable row
      root.querySelectorAll('[data-change]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const e = JSON.parse(btn.dataset.change);
          panel.hidden = false;
          form.entryId.value          = e.id;
          form.proposedDay.value       = e.day_of_week;
          form.proposedStart.value     = e.start_time;
          form.proposedEnd.value       = e.end_time;
          form.proposedVenueId.value   = e.venue_id;
          form.reason.value            = '';
          resultBox.innerHTML          = '';
          unitLabel.textContent        = `${e.unit_code} — ${e.unit_name || e.unit_code} (currently: ${e.day_of_week} ${e.start_time}–${e.end_time} @ ${e.venue_name})`;
          panel.scrollIntoView({ behavior: 'smooth' });
        });
      });

      root.querySelector('#cancel-change-form').addEventListener('click', () => {
        panel.hidden = true;
        resultBox.innerHTML = '';
      });

      // Save draft
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const submitBtn = form.querySelector('[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        try {
          const res = await api.proposeChange({
            entryId:         fd.get('entryId'),
            proposedDay:     fd.get('proposedDay'),
            proposedStart:   fd.get('proposedStart'),
            proposedEnd:     fd.get('proposedEnd'),
            proposedVenueId: fd.get('proposedVenueId'),
            reason:          fd.get('reason'),
          });
          const conflicts = JSON.parse(res.change?.conflict_json || '[]');
          const venueLabel = { 'v-lab1': 'SCC Lab 1', 'v-lt2': 'Lecture Theatre 2', 'v-hallA': 'Hall A' };
          resultBox.innerHTML = `
            <div style="padding:0.75rem;border:1px solid var(--line);border-radius:10px;background:var(--bg-elevated)">
              <p style="margin:0 0 0.4rem"><strong>Draft saved</strong> — status: <span class="status-pill" ${statusColour.draft}>Draft</span></p>
              <p style="margin:0 0 0.4rem;font-size:0.85rem">
                ${esc(res.change.proposed_day)} ${esc(res.change.proposed_start)}–${esc(res.change.proposed_end)}
                @ ${esc(venueLabel[res.change.proposed_venue_id] || res.change.proposed_venue_id)}
                ${res.change.reason ? `· <em>${esc(res.change.reason)}</em>` : ''}
              </p>
              ${conflicts.length
                ? `<p style="color:var(--danger);font-size:0.85rem;margin:0 0 0.5rem">⚠ Conflicts detected — resolve before publishing.</p>`
                : `<p style="color:#22c55e;font-size:0.85rem;margin:0 0 0.5rem">✓ No conflicts detected.</p>`}
              ${!conflicts.length
                ? `<button type="button" class="btn btn-primary btn-sm" data-pub="${res.change.id}">Publish now — notify students</button>`
                : ''}
            </div>`;
          resultBox.querySelector('[data-pub]')?.addEventListener('click', async (e2) => {
            if (!confirm('Publish this change? The timetable will be updated and students will receive a notification.')) return;
            try {
              await api.publishChange(e2.target.dataset.pub);
              toast('Published — students notified ✓');
              panel.hidden = true;
              renderTimetable(root);
            } catch (err) {
              toast(err.message, true);
            }
          });
          loadChanges();
        } catch (err) {
          resultBox.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
          toast(err.message, true);
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Save as draft';
        }
      });

      root.querySelector('#refresh-changes').addEventListener('click', loadChanges);

      async function loadChanges() {
        const box = root.querySelector('#changes-list');
        try {
          const { changes } = await api.listChanges();
          if (!changes.length) {
            box.innerHTML = `<div class="empty">No change requests yet. Use <em>Propose change</em> on a timetable row to create one.</div>`;
            return;
          }

          const venueLabel = { 'v-lab1': 'SCC Lab 1', 'v-lt2': 'Lecture Theatre 2', 'v-hallA': 'Hall A' };

          box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Unit</th>
            <th>Status</th>
            <th>From</th>
            <th>To</th>
            <th>Reason</th>
            <th>Actions</th>
          </tr></thead><tbody>
            ${changes.map((c) => {
              const colour = statusColour[c.status] || '';
              const label  = statusLabel[c.status]  || c.status;
              const canAct = !['published','cancelled'].includes(c.status);
              return `<tr>
                <td><strong>${esc(c.entry_id.replace('tt-','').replace(/-\w+$/,'').toUpperCase())}</strong></td>
                <td><span class="status-pill" ${colour}>${esc(label)}</span></td>
                <td style="white-space:nowrap;font-size:0.85rem">
                  ${c.entry_id ? `<em>original slot</em>` : '—'}
                </td>
                <td style="white-space:nowrap;font-size:0.85rem">
                  ${esc(c.proposed_day)}<br>
                  ${esc(c.proposed_start)}–${esc(c.proposed_end)}<br>
                  <small>@ ${esc(venueLabel[c.proposed_venue_id] || c.proposed_venue_id)}</small>
                </td>
                <td style="font-size:0.85rem;max-width:12rem">${c.reason ? esc(c.reason) : '<em style="color:var(--ink-muted)">—</em>'}</td>
                <td>
                  ${canAct
                    ? `<div class="inline-actions">
                         <button class="btn btn-primary btn-sm" data-publish="${c.id}">Publish</button>
                         <button class="btn btn-ghost btn-sm" data-cancel="${c.id}">Cancel</button>
                       </div>`
                    : `<span style="color:var(--ink-muted);font-size:0.8rem">${c.status === 'published' ? 'Live' : 'Closed'}</span>`}
                </td>
              </tr>`;
            }).join('')}
          </tbody></table></div>`;

          box.querySelectorAll('[data-publish]').forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('Publish this change? The timetable will update and students will be notified.')) return;
            try {
              await api.publishChange(b.dataset.publish);
              toast('Published — students notified ✓');
              renderTimetable(root);
            } catch (err) {
              toast(err.message, true);
            }
          }));
          box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
            try {
              await api.cancelChange(b.dataset.cancel);
              toast('Change cancelled');
              loadChanges();
            } catch (err) {
              toast(err.message, true);
            }
          }));
        } catch (err) {
          box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
        }
      }

      loadChanges();
    }
  } catch (err) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

export async function renderAnnouncements(root) {
  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:4rem"></div></div>`;
  try {
    const { announcements } = await api.announcements();
    if (!announcements.length) {
      root.innerHTML = `<div class="panel"><h2>Announcements</h2><div class="empty">No announcements.</div></div>`;
      return;
    }
    root.innerHTML = `<div class="panel"><h2>Announcements</h2><p class="sub">Includes published schedule changes.</p>
      ${announcements.map((a) => `
        <div class="evidence-item">
          <strong>${esc(a.title)}</strong>
          <div style="font-size:0.75rem;color:var(--ink-muted);margin:0.25rem 0">${esc(a.created_at)} · audience ${esc(a.audience)}</div>
          <div class="excerpt">${esc(a.body)}</div>
        </div>`).join('')}
    </div>`;
  } catch (err) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

export async function renderNotifications(root) {
  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:4rem"></div></div>`;
  try {
    const { notifications } = await api.notifications();
    if (!notifications.length) {
      root.innerHTML = `<div class="panel"><h2>Notifications</h2><div class="empty">No notifications yet.</div></div>`;
      return;
    }
    root.innerHTML = `<div class="panel"><h2>Notifications</h2>
      ${notifications.map((n) => {
        let meta = null;
        try { meta = JSON.parse(n.meta_json || 'null'); } catch { /* ignore */ }
        const scheduleDetail = meta?.next
          ? `<div style="margin:0.4rem 0;padding:0.5rem 0.75rem;background:var(--bg-elevated);border-radius:8px;font-size:0.85rem;border-left:3px solid #3b82f6">
               <div><strong>New schedule:</strong> ${esc(meta.next.day)} ${esc(meta.next.start)}–${esc(meta.next.end)} @ <strong>${esc(meta.next.venue || meta.next.venue_id)}</strong></div>
               ${meta.previous ? `<div style="color:var(--ink-muted)">Was: ${esc(meta.previous.day)} ${esc(meta.previous.start)}–${esc(meta.previous.end)} @ ${esc(meta.previous.venue || meta.previous.venue_id)}</div>` : ''}
             </div>`
          : '';
        return `
        <div class="evidence-item" style="opacity:${n.read ? 0.65 : 1};margin-bottom:0.75rem">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem">
            <strong>${esc(n.title)}</strong>
            ${!n.read ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3b82f6;flex-shrink:0;margin-top:4px" title="Unread"></span>` : ''}
          </div>
          ${scheduleDetail}
          <div class="excerpt" style="white-space:pre-line">${esc(n.body)}</div>
          <div style="margin-top:0.4rem;display:flex;gap:0.5rem;align-items:center">
            <small style="color:var(--ink-muted)">${esc(n.created_at)}</small>
            <button type="button" class="btn btn-ghost btn-sm" data-read="${n.id}" ${n.read ? 'disabled' : ''}>Mark read</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
    root.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', async () => {
      await api.markRead(b.dataset.read);
      renderNotifications(root);
    }));
  } catch (err) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

export async function renderHistory(root) {
  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:4rem"></div></div>`;
  try {
    const { conversations } = await api.conversations();
    if (!conversations.length) {
      root.innerHTML = `<div class="panel"><h2>Conversation history</h2><div class="empty">No conversations yet.</div></div>`;
      return;
    }
    root.innerHTML = `<div class="panel"><h2>Conversation history</h2>
      <div class="table-wrap"><table class="data"><thead><tr><th>Title</th><th>Mode</th><th>Updated</th><th></th></tr></thead><tbody>
      ${conversations.map((c) => `<tr>
        <td>${esc(c.title)}</td><td>${esc(c.mode)}</td><td>${esc(new Date(c.updated_at).toLocaleString())}</td>
        <td><button class="btn btn-ghost btn-sm" data-open="${c.id}">Open</button></td>
      </tr>`).join('')}
      </tbody></table></div></div>
      <div class="panel" id="hist-detail" hidden></div>`;
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      const detail = root.querySelector('#hist-detail');
      const data = await api.conversation(b.dataset.open);
      detail.hidden = false;
      detail.innerHTML = `<h2>${esc(data.conversation.title)}</h2>
        ${data.messages.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'assistant'}" style="margin:0.5rem 0">${esc(m.content)}</div>`).join('')}`;
    }));
  } catch (err) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(err.message)}</p></div>`;
  }
}

export async function renderSettings(root) {
  const roles = getAvailableRoles();
  const roleOptions = roles
    .map((role) => `<option value="${esc(role)}">${esc(roleDisplayName(role))}</option>`)
    .join('');

  root.innerHTML = `
    <div class="panel">
      <h2>Settings</h2>
      <p class="sub">Custom roles are created in the admin dashboard. Role selection is never verified identity.</p>
      <div class="form-row">
        <label>API base URL</label>
        <input id="api-base" value="${esc(getApiBase())}" />
      </div>
      <div class="form-row">
        <label>JKUAT role</label>
        <select id="role-select">
          ${roleOptions || '<option value="">No custom roles yet</option>'}
        </select>
      </div>
      <button type="button" class="btn btn-primary" id="save-settings">Save</button>
    </div>
    <div class="panel">
      <h2>Knowledge freshness</h2>
      <div id="fresh"><div class="skeleton"></div></div>
    </div>`;
  if (roles.length) {
    root.querySelector('#role-select').value = state.role || roles[0];
  }
  root.querySelector('#save-settings').addEventListener('click', () => {
    localStorage.setItem('veritasrag_api', root.querySelector('#api-base').value.trim());
    setRole(root.querySelector('#role-select').value);
    toast('Settings saved');
    location.hash = `#/${state.mode}/overview`;
    location.reload();
  });
  try {
    const f = await api.freshness();
    root.querySelector('#fresh').innerHTML = `<pre style="white-space:pre-wrap;font-size:0.8rem;margin:0">${esc(JSON.stringify(f, null, 2))}</pre>`;
  } catch (err) {
    root.querySelector('#fresh').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

import { api, getApiBase } from './api.js';
import { state, setRole } from './state.js';
import { toast } from './toast.js';

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
    const roleTitle = { student: 'Student', lecturer: 'Lecturer', staff: 'Other Staff', public: 'Public User' }[dash.role] || dash.role;
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
        <div class="chat-thread" id="thread" aria-live="polite"></div>
        <div class="followups" id="followups"></div>
        <div class="chat-composer">
          <textarea id="q" rows="2" placeholder="Ask a grounded question…"></textarea>
          <button type="button" class="btn btn-primary" id="send">Ask</button>
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
}

export async function renderTimetable(root) {
  root.innerHTML = `<div class="panel"><div class="skeleton" style="height:6rem"></div></div>`;
  try {
    if (state.role === 'public') {
      root.innerHTML = `<div class="panel"><h2>Timetable</h2><p class="empty">Public users cannot access private class schedules.</p></div>`;
      return;
    }
    const data = await api.timetable();
    let html = `
      <div class="panel">
        <h2>Timetable</h2>
        <p class="sub"><span class="badge">DEMO DATA</span> Not official JKUAT registry records.</p>
        <div class="table-wrap"><table class="data"><thead><tr>
          <th>Unit</th><th>Day</th><th>Time</th><th>Venue</th><th>Group</th><th></th>
        </tr></thead><tbody>
        ${data.entries.map((e) => `
          <tr>
            <td>${esc(e.unit_code)}<br><small>${esc(e.unit_name)}</small></td>
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
        <div class="panel" id="change-panel" hidden>
          <h2>Propose schedule change</h2>
          <p class="sub">Draft → Pending Approval → Approved → Published. LLM cannot write timetable records.</p>
          <form id="change-form">
            <input type="hidden" name="entryId" />
            <div class="grid-2">
              <div class="form-row"><label>Day</label>
                <select name="proposedDay">
                  ${['Monday','Tuesday','Wednesday','Thursday','Friday'].map((d) => `<option>${d}</option>`).join('')}
                </select>
              </div>
              <div class="form-row"><label>Venue</label>
                <select name="proposedVenueId">
                  <option value="v-lab1">SCC Lab 1</option>
                  <option value="v-lt2">Lecture Theatre 2</option>
                  <option value="v-hallA">Hall A</option>
                </select>
              </div>
              <div class="form-row"><label>Start</label><input name="proposedStart" type="time" required /></div>
              <div class="form-row"><label>End</label><input name="proposedEnd" type="time" required /></div>
            </div>
            <div class="form-row"><label>Reason</label><textarea name="reason" rows="2"></textarea></div>
            <button type="submit" class="btn btn-primary">Save draft</button>
          </form>
          <div id="change-result"></div>
        </div>
        <div class="panel">
          <h2>Change requests</h2>
          <div id="changes-list"><div class="skeleton"></div></div>
        </div>`;
    }
    root.innerHTML = html;

    if (state.role === 'lecturer') {
      const panel = root.querySelector('#change-panel');
      const form = root.querySelector('#change-form');
      root.querySelectorAll('[data-change]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const e = JSON.parse(btn.dataset.change);
          panel.hidden = false;
          form.entryId.value = e.id;
          form.proposedDay.value = e.day_of_week;
          form.proposedStart.value = e.start_time;
          form.proposedEnd.value = e.end_time;
          form.proposedVenueId.value = e.venue_id;
          panel.scrollIntoView({ behavior: 'smooth' });
        });
      });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        try {
          const res = await api.proposeChange({
            entryId: fd.get('entryId'),
            proposedDay: fd.get('proposedDay'),
            proposedStart: fd.get('proposedStart'),
            proposedEnd: fd.get('proposedEnd'),
            proposedVenueId: fd.get('proposedVenueId'),
            reason: fd.get('reason'),
          });
          const conflicts = JSON.parse(res.change.conflict_json || '[]');
          root.querySelector('#change-result').innerHTML = `
            <p>Draft <code>${esc(res.change.id)}</code> created · status <strong>${esc(res.change.status)}</strong></p>
            ${conflicts.length ? `<p style="color:var(--danger)">Conflicts: ${esc(JSON.stringify(conflicts))}</p>` : '<p>No conflicts detected.</p>'}
            <button type="button" class="btn btn-secondary btn-sm" data-pub="${res.change.id}">Publish now (demo)</button>`;
          root.querySelector('[data-pub]')?.addEventListener('click', async (e2) => {
            const id = e2.target.dataset.pub;
            if (!confirm('Publish this change and notify affected student groups?')) return;
            await api.publishChange(id);
            toast('Published — students notified');
            renderTimetable(root);
          });
          loadChanges();
        } catch (err) {
          toast(err.message, true);
        }
      });

      async function loadChanges() {
        const box = root.querySelector('#changes-list');
        try {
          const { changes } = await api.listChanges();
          if (!changes.length) {
            box.innerHTML = `<div class="empty">No change requests yet.</div>`;
            return;
          }
          box.innerHTML = `<div class="table-wrap"><table class="data"><thead><tr><th>ID</th><th>Status</th><th>Proposed</th><th></th></tr></thead><tbody>
            ${changes.map((c) => `<tr>
              <td><small>${esc(c.id.slice(0, 8))}…</small></td>
              <td><span class="status-pill">${esc(c.status)}</span></td>
              <td>${esc(c.proposed_day)} ${esc(c.proposed_start)}–${esc(c.proposed_end)}</td>
              <td>
                ${c.status !== 'published' && c.status !== 'cancelled'
                  ? `<button class="btn btn-primary btn-sm" data-publish="${c.id}">Publish</button>
                     <button class="btn btn-ghost btn-sm" data-cancel="${c.id}">Cancel</button>`
                  : '—'}
              </td>
            </tr>`).join('')}
          </tbody></table></div>`;
          box.querySelectorAll('[data-publish]').forEach((b) => b.addEventListener('click', async () => {
            if (!confirm('Confirm publish? This updates the timetable and notifies students.')) return;
            await api.publishChange(b.dataset.publish);
            toast('Published');
            renderTimetable(root);
          }));
          box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
            await api.cancelChange(b.dataset.cancel);
            loadChanges();
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
      ${notifications.map((n) => `
        <div class="evidence-item" style="opacity:${n.read ? 0.65 : 1}">
          <strong>${esc(n.title)}</strong>
          <div class="excerpt">${esc(n.body)}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-read="${n.id}" ${n.read ? 'disabled' : ''}>Mark read</button>
        </div>`).join('')}
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
  root.innerHTML = `
    <div class="panel">
      <h2>Settings</h2>
      <p class="sub">Demo session controls. Role selection is never verified identity.</p>
      <div class="form-row">
        <label>API base URL</label>
        <input id="api-base" value="${esc(getApiBase())}" />
      </div>
      <div class="form-row">
        <label>JKUAT demo role</label>
        <select id="role-select">
          <option value="student">Student</option>
          <option value="lecturer">Lecturer</option>
          <option value="staff">Other Staff</option>
          <option value="public">Public User</option>
        </select>
      </div>
      <button type="button" class="btn btn-primary" id="save-settings">Save</button>
    </div>
    <div class="panel">
      <h2>Knowledge freshness</h2>
      <div id="fresh"><div class="skeleton"></div></div>
    </div>`;
  root.querySelector('#role-select').value = state.role || 'public';
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

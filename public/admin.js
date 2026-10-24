const apiBase = '/veritas-rag';
const form = document.getElementById('upload-form');
const statusEl = document.getElementById('upload-status');
const auditBody = document.getElementById('audit-body');
const documentsBody = document.getElementById('documents-body');

function parseRoles(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) {
    return ['public', 'student', 'lecturer', 'staff'];
  }
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Ignore malformed JSON and fall through to a simple split fallback.
  }
  return text.split(',').map((role) => role.trim()).filter(Boolean);
}

function renderRoleBadges(value) {
  const roles = parseRoles(value);
  if (!roles.length) return '<span class="role-badge">none</span>';
  return roles.map((role) => `<span class="role-badge">${role}</span>`).join('');
}

function renderDocuments(rows) {
  if (!rows.length) {
    documentsBody.innerHTML = '<tr><td colspan="5">No documents uploaded yet.</td></tr>';
    return;
  }

  documentsBody.innerHTML = rows.map((doc) => `
    <tr>
      <td><div class="doc-name">${doc.filename || 'Untitled document'}</div></td>
      <td>${renderRoleBadges(doc.allowed_roles)}</td>
      <td><span class="status-pill ${doc.status || 'unknown'}">${doc.status || 'unknown'}</span></td>
      <td>${doc.indexed_at ? new Date(doc.indexed_at).toLocaleString() : 'Not indexed'}</td>
      <td><button class="inline-action delete" type="button" data-doc-id="${doc.id}">Delete</button></td>
    </tr>
  `).join('');

  documentsBody.querySelectorAll('[data-doc-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const docId = button.getAttribute('data-doc-id');
      if (!docId) return;
      button.disabled = true;
      button.textContent = 'Deleting…';
      try {
        const res = await fetch(`${apiBase}/documents/${docId}`, {
          method: 'DELETE',
          headers: { 'X-Veritas-Mode': 'generic', 'X-Veritas-User-Id': 'demo-generic', 'X-Veritas-Demo': 'true' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        statusEl.textContent = `Deleted ${button.closest('tr')?.querySelector('.doc-name')?.textContent || 'document'}.`;
        await loadDocuments();
        await loadAudit();
      } catch (err) {
        statusEl.textContent = err.message;
      }
    });
  });
}

async function loadDocuments() {
  try {
    const res = await fetch(`${apiBase}/documents`, {
      headers: { 'X-Veritas-Mode': 'generic', 'X-Veritas-User-Id': 'demo-generic', 'X-Veritas-Demo': 'true' },
    });
    if (!res.ok) throw new Error('Documents endpoint unavailable');
    const data = await res.json();
    renderDocuments(data.documents || []);
  } catch (err) {
    documentsBody.innerHTML = `<tr><td colspan="5">${err.message}</td></tr>`;
  }
}

function renderAudit(rows) {
  if (!rows.length) {
    auditBody.innerHTML = '<tr><td colspan="5">No activity recorded yet.</td></tr>';
    return;
  }

  auditBody.innerHTML = rows.map((row) => {
    const detail = row.detail || {};
    const status = detail.status || row.action;
    const role = detail.user_role || row.actor_id || 'unknown';
    const query = detail.query || '—';
    const chunks = detail.chunks_retrieved ?? detail.chunksRetrieved ?? 0;
    return `
      <tr>
        <td>${new Date(row.created_at).toLocaleString()}</td>
        <td>${role}</td>
        <td>${query}</td>
        <td>${chunks}</td>
        <td><span class="status-pill ${status}">${status}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadAudit() {
  try {
    const res = await fetch(`${apiBase}/admin/audit`, {
      headers: { 'X-Veritas-Mode': 'generic', 'X-Veritas-User-Id': 'demo-generic', 'X-Veritas-Demo': 'true' },
    });
    if (!res.ok) throw new Error('Audit endpoint unavailable');
    const data = await res.json();
    renderAudit((data.events || []).slice(0, 25));
  } catch (err) {
    auditBody.innerHTML = `<tr><td colspan="5">${err.message}</td></tr>`;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fileInput = document.getElementById('file-input');
  const files = Array.from(fileInput.files || []);
  if (!files.length) {
    statusEl.textContent = 'Please choose at least one file.';
    return;
  }

  const selected = Array.from(document.querySelectorAll('#roles input[type="checkbox"]:checked')).map((option) => option.value);
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  formData.append('allowedRoles', JSON.stringify(selected));

  if (!selected.length) {
    statusEl.textContent = 'No roles selected — this document will be hidden from all users until a role is enabled.';
    return;
  }

  statusEl.textContent = 'Uploading and indexing…';
  try {
    const res = await fetch(`${apiBase}/documents/upload`, {
      method: 'POST',
      headers: { 'X-Veritas-Mode': 'generic', 'X-Veritas-User-Id': 'demo-generic', 'X-Veritas-Demo': 'true' },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    statusEl.textContent = `Indexed ${data.documents?.length || 0} document(s) with roles: ${selected.join(', ')}`;
    form.reset();
    await loadDocuments();
    await loadAudit();
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

document.querySelectorAll('.nav-item').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === link));
  });
});

loadDocuments();
loadAudit();
setInterval(loadAudit, 3000);

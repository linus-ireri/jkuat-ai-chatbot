const apiBase = '/veritas-rag';
const form = document.getElementById('upload-form');
const statusEl = document.getElementById('upload-status');
const auditBody = document.getElementById('audit-body');

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
    await loadAudit();
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

loadAudit();
setInterval(loadAudit, 3000);

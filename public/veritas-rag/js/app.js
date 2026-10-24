import { state, setMode, setRole, setTheme, applyTheme, persist } from './state.js';
import { api } from './api.js';
import {
  renderOverview,
  renderDocuments,
  renderAssistant,
  renderTimetable,
  renderAnnouncements,
  renderNotifications,
  renderHistory,
  renderSettings,
} from './views.js';

applyTheme();

const NAV = {
  generic: [
    { id: 'overview', label: 'Overview', icon: 'fa-house' },
    { id: 'assistant', label: 'AI Assistant', icon: 'fa-comments' },
    { id: 'documents', label: 'Documents', icon: 'fa-folder-open' },
    { id: 'settings', label: 'Settings', icon: 'fa-gear' },
  ],
  jkuat: {
    student: [
      { id: 'overview', label: 'Overview', icon: 'fa-house' },
      { id: 'assistant', label: 'AI Assistant', icon: 'fa-comments' },
      { id: 'timetable', label: 'Timetable', icon: 'fa-calendar' },
      { id: 'announcements', label: 'Announcements', icon: 'fa-bullhorn' },
      { id: 'notifications', label: 'Notifications', icon: 'fa-bell' },
      { id: 'settings', label: 'Settings', icon: 'fa-gear' },
    ],
    lecturer: [
      { id: 'overview', label: 'Overview', icon: 'fa-house' },
      { id: 'assistant', label: 'AI Assistant', icon: 'fa-comments' },
      { id: 'timetable', label: 'Timetable', icon: 'fa-calendar' },
      { id: 'announcements', label: 'Announcements', icon: 'fa-bullhorn' },
      { id: 'notifications', label: 'Notifications', icon: 'fa-bell' },
      { id: 'settings', label: 'Settings', icon: 'fa-gear' },
    ],
    staff: [
      { id: 'overview', label: 'Overview', icon: 'fa-house' },
      { id: 'assistant', label: 'AI Assistant', icon: 'fa-comments' },
      { id: 'announcements', label: 'Announcements', icon: 'fa-bullhorn' },
      { id: 'timetable', label: 'Timetable', icon: 'fa-calendar' },
      { id: 'settings', label: 'Settings', icon: 'fa-gear' },
    ],
    public: [
      { id: 'overview', label: 'Overview', icon: 'fa-house' },
      { id: 'assistant', label: 'AI Assistant', icon: 'fa-comments' },
      { id: 'announcements', label: 'Announcements', icon: 'fa-bullhorn' },
      { id: 'settings', label: 'Settings', icon: 'fa-gear' },
    ],
  },
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || `${state.mode}/overview`;
  const [pathPart, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const parts = pathPart.split('/').filter(Boolean);
  let mode = parts[0] || state.mode;
  let page = parts[1] || 'overview';
  if (mode !== 'generic' && mode !== 'jkuat') mode = state.mode;
  if (params.role) setRole(params.role);
  return { mode, page, params };
}

function navItems() {
  if (state.mode === 'generic') return NAV.generic;
  return NAV.jkuat[state.role || 'public'] || NAV.jkuat.public;
}

function renderNav(activePage) {
  const host = document.getElementById('nav-links');
  host.innerHTML = `<div class="nav-section-label">Navigate</div>` + navItems().map((item) => `
    <a class="nav-link ${item.id === activePage ? 'active' : ''}" href="#/${state.mode}/${item.id}">
      <i class="fas ${item.icon} icon" aria-hidden="true"></i>
      <span class="label">${item.label}</span>
    </a>`).join('');
}

async function renderSidebarHistory() {
  const host = document.getElementById('history-panel');
  if (!host) return;

  try {
    const { conversations } = await api.conversations();
    if (!conversations.length) {
      host.innerHTML = `
        <div class="nav-section-label">Recent chats</div>
        <div class="history-empty">No chat history yet.</div>
      `;
      return;
    }

    host.innerHTML = `
      <div class="nav-section-label">Recent chats</div>
      ${conversations.slice(0, 6).map((conversation) => `
        <button
          type="button"
          class="history-item ${state.conversationId === conversation.id ? 'active' : ''}"
          data-history-id="${conversation.id}"
          title="${esc(conversation.title || 'Conversation')}"
        >
          <span class="title">${esc(conversation.title || 'Conversation')}</span>
          <span class="meta">${esc(new Date(conversation.updated_at).toLocaleDateString())}</span>
        </button>
      `).join('')}
    `;

    host.querySelectorAll('[data-history-id]').forEach((button) => {
      button.addEventListener('click', () => {
        state.conversationId = button.dataset.historyId;
        location.hash = `#/${state.mode}/assistant`;
        route();
      });
    });
  } catch {
    host.innerHTML = `
      <div class="nav-section-label">Recent chats</div>
      <div class="history-empty">History unavailable.</div>
    `;
  }
}

function updateChrome(page) {
  document.body.dataset.mode = state.mode;
  document.body.classList.toggle('mode-jkuat', state.mode === 'jkuat');
  document.body.classList.toggle('mode-generic', state.mode === 'generic');

  const logo = document.querySelector('.brand-logo');
  if (logo) {
    logo.style.display = state.mode === 'jkuat' ? 'block' : 'none';
  }

  document.getElementById('page-title').textContent =
    navItems().find((i) => i.id === page)?.label || 'VeritasRAG';
  document.getElementById('mode-badge').textContent =
    state.mode === 'generic' ? 'Generic RAG' : 'JKUAT RAG';
  document.getElementById('role-label').textContent =
    state.mode === 'jkuat'
      ? `Demo role: ${state.role} · ${state.userId} (unverified)`
      : `Workspace user: ${state.userId}`;
  document.getElementById('mode-generic').classList.toggle('active', state.mode === 'generic');
  document.getElementById('mode-jkuat').classList.toggle('active', state.mode === 'jkuat');
  document.getElementById('theme-toggle').innerHTML =
    state.theme === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
}

async function route() {
  const { mode, page, params } = parseHash();
  if (mode !== state.mode) setMode(mode);
  if (mode === 'jkuat' && !state.role) setRole(params.role || 'public');
  persist();
  renderNav(page);
  await renderSidebarHistory();
  updateChrome(page);

  const root = document.getElementById('view-root');
  root.focus();

  switch (page) {
    case 'documents':
      if (state.mode !== 'generic') {
        location.hash = `#/jkuat/overview`;
        return;
      }
      return renderDocuments(root);
    case 'assistant':
      return renderAssistant(root, params.q || '');
    case 'timetable':
      return renderTimetable(root);
    case 'announcements':
      return renderAnnouncements(root);
    case 'notifications':
      return renderNotifications(root);
    case 'history':
      return renderHistory(root);
    case 'settings':
      return renderSettings(root);
    case 'overview':
    default:
      return renderOverview(root);
  }
}

document.getElementById('mode-generic').addEventListener('click', () => {
  setMode('generic');
  location.hash = '#/generic/overview';
});
document.getElementById('mode-jkuat').addEventListener('click', () => {
  setMode('jkuat');
  if (!state.role) setRole('student');
  location.hash = `#/jkuat/overview`;
});
document.getElementById('theme-toggle').addEventListener('click', () => {
  setTheme(state.theme === 'dark' ? 'light' : 'dark');
  updateChrome(parseHash().page);
});
document.getElementById('menu-toggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  bd.hidden = !open;
  bd.classList.toggle('show', open);
});
document.getElementById('sidebar-backdrop').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  const bd = document.getElementById('sidebar-backdrop');
  bd.hidden = true;
  bd.classList.remove('show');
});

window.addEventListener('hashchange', route);
if (!location.hash) {
  location.hash = `#/${state.mode}/overview`;
} else {
  route();
}

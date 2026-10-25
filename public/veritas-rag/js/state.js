const STORAGE_KEY = 'veritasrag_session_v1';
const CUSTOM_ROLES_KEY = 'veritasrag_custom_roles_v1';
const DEFAULT_ROLES = ['public', 'student', 'lecturer', 'staff'];

const ROLE_USERS = {
  student: 'demo-student',
  lecturer: 'demo-lecturer',
  staff: 'demo-staff',
  public: 'demo-public',
};

function normalizeRoleName(role) {
  return String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getCustomRoles() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_ROLES_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((role) => normalizeRoleName(role)).filter(Boolean))];
  } catch {
    return [];
  }
}

export function getAvailableRoles() {
  return [...new Set([...DEFAULT_ROLES, ...getCustomRoles()])];
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

const saved = load();

export const state = {
  mode: saved.mode || 'generic',
  role: saved.role || null,
  userId: saved.userId || 'demo-generic',
  workspaceId: saved.workspaceId || null,
  theme: saved.theme || 'light',
  conversationId: null,
  lastEvidence: [],
  lastSupport: null,
};

export function persist() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      mode: state.mode,
      role: state.role,
      userId: state.userId,
      workspaceId: state.workspaceId,
      theme: state.theme,
    })
  );
}

export function setMode(mode) {
  state.mode = mode;
  if (mode === 'generic') {
    state.role = null;
    state.userId = 'demo-generic';
    state.theme = 'light';
  } else if (!state.role) {
    setRole('public');
  }
  persist();
}

export function setRole(role) {
  const nextRole = normalizeRoleName(role) || 'public';
  state.role = nextRole;
  state.userId = ROLE_USERS[nextRole] || `demo-${nextRole || 'public'}`;
  persist();
}

export function setTheme(theme) {
  const nextTheme = state.mode === 'generic' ? 'light' : theme;
  state.theme = nextTheme;
  document.documentElement.setAttribute('data-theme', nextTheme);
  persist();
}

export function applyTheme() {
  const theme = state.mode === 'generic' ? 'light' : state.theme;
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
}

export { ROLE_USERS };

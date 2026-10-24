const STORAGE_KEY = 'veritasrag_session_v1';

const ROLE_USERS = {
  student: 'demo-student',
  lecturer: 'demo-lecturer',
  staff: 'demo-staff',
  public: 'demo-public',
};

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
  state.role = role;
  state.userId = ROLE_USERS[role] || 'demo-public';
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

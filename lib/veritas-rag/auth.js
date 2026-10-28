/**
 * Demo-role access context for VeritasRAG.
 * Frontend role selection is labelled as demo; privileged actions still require
 * matching server-side context headers. This is not institutional SSO.
 */

const dynamicRoleProxy = new Proxy(Object.freeze({}), {
  get(_target, prop) {
    if (typeof prop === 'string') return prop.toLowerCase();
    return undefined;
  },
  ownKeys() {
    return [];
  },
  has(_target, prop) {
    return typeof prop === 'string';
  },
});

export const ROLES = dynamicRoleProxy;

export const MODES = Object.freeze({
  GENERIC: 'generic',
  JKUAT: 'jkuat',
});

const DEMO_USERS = {
  'demo-student': { id: 'demo-student', role: ROLES.STUDENT, name: 'Demo Student', groups: ['MCS-Y2'] },
  'demo-lecturer': { id: 'demo-lecturer', role: ROLES.LECTURER, name: 'Demo Lecturer', units: ['ICS2405', 'ICS2400'] },
  'demo-staff': { id: 'demo-staff', role: ROLES.STAFF, name: 'Demo Staff', department: 'Academic Registry' },
  'demo-public': { id: 'demo-public', role: ROLES.PUBLIC, name: 'Public Visitor' },
  'demo-generic': { id: 'demo-generic', role: null, name: 'Workspace Owner' },
};

export function parseAccessContext(req) {
  const mode = String(req.headers['x-veritas-mode'] || req.body?.mode || '').toLowerCase();
  const role = String(req.headers['x-veritas-role'] || req.body?.role || '').toLowerCase() || null;
  const userId = String(req.headers['x-veritas-user-id'] || req.body?.userId || 'anonymous');
  const isDemo = String(req.headers['x-veritas-demo'] || 'true') === 'true';
  const workspaceId = req.headers['x-veritas-workspace'] || req.body?.workspaceId || null;

  const profile = DEMO_USERS[userId] || {
    id: userId,
    role,
    name: userId,
    groups: [],
    units: [],
    department: null,
  };

  return {
    mode: mode === MODES.GENERIC || mode === MODES.JKUAT ? mode : null,
    role: role || profile.role,
    userId: profile.id,
    name: profile.name,
    isDemo,
    workspaceId,
    groups: profile.groups || [],
    units: profile.units || [],
    department: profile.department || null,
    verified: false, // demo selection is never verified identity
  };
}

export function requireMode(...allowed) {
  return (req, res, next) => {
    const ctx = parseAccessContext(req);
    req.veritas = ctx;
    if (!ctx.mode || !allowed.includes(ctx.mode)) {
      return res.status(403).json({
        error: 'Invalid or missing mode',
        allowed,
        hint: 'Send X-Veritas-Mode: generic|jkuat',
      });
    }
    next();
  };
}

export function requireRole(...allowed) {
  return (req, res, next) => {
    const ctx = req.veritas || parseAccessContext(req);
    req.veritas = ctx;
    if (!allowed.includes(ctx.role)) {
      return res.status(403).json({
        error: 'Unauthorized role for this action',
        role: ctx.role,
        allowed,
        verified: false,
      });
    }
    next();
  };
}

export function attachContext(req, _res, next) {
  req.veritas = parseAccessContext(req);
  next();
}

export { DEMO_USERS };

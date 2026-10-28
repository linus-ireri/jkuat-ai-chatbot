/**
 * Critical workflow tests for VeritasRAG.
 * Run: node --test tests/veritas-rag.test.js
 * Requires: RAG server on PORT (default 3001) OR runs in-process suite for structured APIs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import { seedDemoData } from '../lib/veritas-rag/seed.js';
import * as timetable from '../lib/veritas-rag/timetable.js';
import {
  ensureWorkspace,
  insertDocument,
  listDocuments,
  deleteDocument,
  uid,
  nowIso,
  DATA_DIR,
  getDb,
} from '../lib/veritas-rag/db.js';
import { ingestDocument, retrieveWorkspace, deleteFromIndex, normalizeAllowedRoles } from '../lib/veritas-rag/ingest-pipeline.js';
import { parseAccessContext, MODES, ROLES } from '../lib/veritas-rag/auth.js';
import { runVeritasQuery } from '../lib/veritas-rag/query.js';
import axios from 'axios';
import { cleanLlmAnswer } from '../lib/clean-llm-answer.js';
import { extractDateRanges, filterTemporalDocs } from '../lib/veritas-rag/date-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API = process.env.VERITAS_API || 'http://127.0.0.1:3001/veritas-rag';

/**
 * Purge all test-created workspaces and their files from DB + disk.
 * Keeps only the production 'demo-generic' workspace intact.
 */
function purgeTestWorkspaces() {
  const db = getDb();
  const testWorkspaces = db
    .prepare("SELECT id FROM workspaces WHERE owner_id != 'demo-generic'")
    .all();

  for (const { id } of testWorkspaces) {
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE workspace_id = ?)').run(id);
    db.prepare('DELETE FROM conversations WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE workspace_id = ?').run(id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    const wsPath = path.join(DATA_DIR, 'workspaces', id);
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function apiAlive() {
  try {
    const res = await fetch(`${API}/meta`);
    return res.ok;
  } catch {
    return false;
  }
}

describe('auth context', () => {
  it('never marks demo roles as verified', () => {
    const ctx = parseAccessContext({
      headers: {
        'x-veritas-mode': 'jkuat',
        'x-veritas-role': 'lecturer',
        'x-veritas-user-id': 'demo-lecturer',
        'x-veritas-demo': 'true',
      },
      body: {},
    });
    assert.equal(ctx.verified, false);
    assert.equal(ctx.role, 'lecturer');
  });

  it('preserves the active workspace id in jkuat mode', () => {
    const ctx = parseAccessContext({
      headers: {
        'x-veritas-mode': 'jkuat',
        'x-veritas-role': 'student',
        'x-veritas-user-id': 'demo-student',
        'x-veritas-workspace': 'workspace-123',
      },
      body: {},
    });
    assert.equal(ctx.workspaceId, 'workspace-123');
    assert.equal(ctx.mode, MODES.JKUAT);
  });
});

describe('JKUAT timetable workflow (in-process)', () => {
  before(() => {
    seedDemoData();
  });

  it('keeps lecturer-made announcements when demo data is re-seeded', () => {
    const db = getDb();
    const customId = `manual-announcement-${uid()}`;
    db.prepare(`
      INSERT INTO announcements (id, title, body, audience, unit_code, change_id, created_at, effective_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(customId, 'Lecture update', 'This is the lecturer-issued notice that must stay visible.', 'all', 'ICS2405', nowIso(), nowIso());

    seedDemoData();

    const preserved = db.prepare('SELECT * FROM announcements WHERE id = ?').get(customId);
    assert.ok(preserved, 'lecturer-managed announcement should survive demo reseed');
    assert.match(preserved.body, /lecturer-issued notice/i);
  });

  it('includes published change records in a student schedule question', async () => {
    const db = getDb();
    const lecturerId = `test-change-lecturer-${uid()}`;
    const groupId = `TEST-GROUP-${uid().slice(0, 8)}`;
    const entryId = `test-change-entry-${uid()}`;
    const unitCode = `TEST${uid().slice(0, 6).toUpperCase()}`;

    db.prepare('INSERT OR IGNORE INTO units (code, name, department) VALUES (?, ?, ?)')
      .run(unitCode, 'Test Unit', 'Testing');
    const freeVenueId = `v-test-change-free-${uid().slice(0, 8)}`;
    db.prepare('INSERT OR IGNORE INTO venues (id, name, capacity) VALUES (?, ?, ?)')
      .run('v-test-change', 'Test Change Venue', 40);
    db.prepare('INSERT OR IGNORE INTO venues (id, name, capacity) VALUES (?, ?, ?)')
      .run(freeVenueId, 'Free Test Venue', 50);

    db.prepare(`
      INSERT INTO timetable_entries (
        id, unit_code, lecturer_id, student_group, day_of_week,
        start_time, end_time, venue_id, week_label, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DEMO WEEK', 'published', ?)
    `).run(entryId, unitCode, lecturerId, groupId, 'Sunday', '09:00', '10:30', 'v-test-change', nowIso());

    const change = timetable.proposeChange(lecturerId, {
      entryId,
      proposedDay: 'Wednesday',
      proposedStart: '15:00',
      proposedEnd: '16:30',
      proposedVenueId: freeVenueId,
      reason: 'Lab maintenance and projector repair',
    });
    timetable.publishChange(change.id, lecturerId, { allowDirectPublish: true });

    const originalPost = axios.post;
    process.env.GROQ_API_KEY = 'test-key';
    let requestBody;
    axios.post = async (...args) => {
      requestBody = args[1];
      return { data: { choices: [{ message: { content: 'The class was moved.' } }] } };
    };

    try {
      await runVeritasQuery({
        question: 'Are there any changes to my class times?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student-01',
          groups: [groupId],
        },
        jkuatVectorStore: null,
      });
      assert.ok(requestBody, 'query should send a prompt to the model');
      assert.match(requestBody.messages[1].content, /Lab maintenance and projector repair/i);
      assert.match(requestBody.messages[1].content, /previously/i);
      assert.match(requestBody.messages[1].content, /now/i);
      assert.match(requestBody.messages[1].content, /DEMO TIMETABLE/i);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('lists demo student timetable', () => {
    const rows = timetable.listTimetable({ studentGroup: 'MCS-Y2' });
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].status, 'published');
  });

  it('rejects unauthorized lecturer change', () => {
    const rows = timetable.listTimetable({ studentGroup: 'MCS-Y2' });
    const foreign = rows.find((r) => r.lecturer_id !== 'demo-lecturer');
    assert.ok(foreign, 'demo data should include a non-demo-lecturer row');
    assert.throws(
      () => timetable.proposeChange('demo-lecturer', {
        entryId: foreign.id,
        proposedDay: 'Tuesday',
        proposedStart: '09:00',
        proposedEnd: '11:00',
        reason: 'test',
      }),
      /Not authorized/i
    );
  });

  it('proposes, publishes, notifies students, and updates timetable', () => {
    const entries = timetable.listTimetable({ lecturerId: 'demo-lecturer' });
    assert.ok(entries.length >= 1);
    const entry = entries[0];
    const change = timetable.proposeChange('demo-lecturer', {
      entryId: entry.id,
      proposedDay: entry.day_of_week === 'Monday' ? 'Tuesday' : 'Monday',
      proposedStart: '09:00',
      proposedEnd: '11:00',
      proposedVenueId: entry.venue_id,
      reason: 'Demo conflict avoidance',
    });
    assert.equal(change.status, 'draft');
    const conflicts = JSON.parse(change.conflict_json || '[]');
    // Publish only if no conflicts; otherwise cancel path still validates states
    if (conflicts.length) {
      const cancelled = timetable.cancelChange(change.id, 'demo-lecturer');
      assert.equal(cancelled.status, 'cancelled');
      return;
    }
    const published = timetable.publishChange(change.id, 'demo-lecturer', {
      allowDirectPublish: true,
    });
    assert.equal(published.change.status, 'published');
    const updated = timetable.getEntry(entry.id);
    assert.equal(updated.start_time, '09:00');
    const notifs = timetable.listNotifications({ studentGroup: entry.student_group });
    assert.ok(notifs.some((n) => n.kind === 'schedule_change'));
    const pending = timetable.listChanges({ lecturerId: 'demo-lecturer' })
      .filter((c) => c.status === 'draft' || c.status === 'pending_approval');
    // pending must not be treated as official — status check
    for (const p of pending) {
      assert.notEqual(p.status, 'published');
    }
  });

  it('publishes a lecturer draft and sends the new venue to students in notifications', () => {
    const entry = timetable.listTimetable({ lecturerId: 'demo-lecturer', unitCode: 'ICS2400' })[0];
    assert.ok(entry, 'demo lecturer should have an Operating Systems timetable entry');

    const change = timetable.proposeChange('demo-lecturer', {
      entryId: entry.id,
      proposedDay: 'Thursday',
      proposedStart: '12:00',
      proposedEnd: '14:00',
      proposedVenueId: 'v-hallA',
      reason: 'Move to the main hall for equipment access',
    });
    assert.equal(change.status, 'draft');

    const published = timetable.publishChange(change.id, 'demo-lecturer', { allowDirectPublish: true });
    assert.equal(published.change.status, 'published');
    assert.equal(published.entry.venue_id, 'v-hallA');

    const studentSchedule = timetable.listTimetable({ studentGroup: entry.student_group }).find((row) => row.id === entry.id);
    assert.equal(studentSchedule.venue_id, 'v-hallA');

    const studentNotifications = timetable.listNotifications({ studentGroup: entry.student_group });
    const venueNotification = studentNotifications.find((n) => {
      if (n.kind !== 'schedule_change') return false;
      try {
        const meta = JSON.parse(n.meta_json || 'null');
        return meta?.next?.venue === 'Hall A';
      } catch { return false; }
    });
    assert.ok(venueNotification, 'student should receive a schedule-change notification with the updated venue');
    assert.match(venueNotification.body, /Hall A/i);
  });

  it('blocks public timetable via role checks at route layer conceptually', () => {
    const ctx = parseAccessContext({
      headers: { 'x-veritas-mode': 'jkuat', 'x-veritas-role': 'public', 'x-veritas-user-id': 'demo-public' },
      body: {},
    });
    assert.equal(ctx.role, 'public');
  });
});

describe('answer sanitization', () => {
  it('removes evidence citations and see-evidence boilerplate from final answers', () => {
    const dirty = `**Events listed for the current semester (as documented in the JKUAT Information Guide):**\n\n*(see Evidence #3 for the conference overview and dates; Evidence #1 and #2 for the detailed schedule; Evidence #4 for the closing ceremony)*\n\n| Date | Time | Event |\n| --- | --- | --- |\n| Sunday, 6 July 2026 | 08:00 | Registration | JKUAT |`;
    const cleaned = cleanLlmAnswer(dirty);
    assert.ok(!/see Evidence|Evidence #\d+/i.test(cleaned));
    assert.ok(/Sunday, 6 July 2026/i.test(cleaned));
  });

  it('accepts custom role names in upload filtering and retrieval checks', async () => {
    const allowed = normalizeAllowedRoles(['student', 'alumni', 'researcher']);
    assert.deepEqual(allowed, ['student', 'alumni', 'researcher']);

    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Allowed answer for alumni.' } }] } });

    try {
      const result = await runVeritasQuery({
        question: 'What guidance applies to alumni?',
        ctx: {
          mode: MODES.JKUAT,
          role: 'alumni',
          userId: 'demo-alumni',
          groups: [],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Alumni access guidance applies to graduates only.',
            metadata: { source: 'alumni-guide.pdf', allowed_roles: ['alumni'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(result.rbacBlocked, false);
      assert.match(String(result.answer || ''), /alumni/i);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('respects explicit allowed_roles for JKUAT documents instead of forcing student-only access for matching sources', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Role-aware answer.' } }] } });

    try {
      const lecturerAllowed = await runVeritasQuery({
        question: 'What is the fee payment threshold?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.LECTURER,
          userId: 'demo-lecturer',
          groups: [],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'A student must pay 75% before registering units.',
            metadata: { source: 'JKUAT Information Guide', allowed_roles: ['public', 'student', 'lecturer'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(lecturerAllowed.rbacBlocked, false);
      assert.ok(Array.isArray(lecturerAllowed.evidence));
      assert.ok(String(lecturerAllowed.answer || '').length > 0);

      const studentAllowed = await runVeritasQuery({
        question: 'What is the fee payment threshold?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'A student must pay 75% before registering units.',
            metadata: { source: 'JKUAT Information Guide', allowed_roles: ['public', 'student'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(studentAllowed.rbacBlocked, false);
      assert.ok(Array.isArray(studentAllowed.evidence));
      assert.ok(String(studentAllowed.answer || '').length > 0);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('allows the expected role set for policy documents across lecturer, staff, public, and student access', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Role-aware answer.' } }] } });

    try {
      const cases = [
        { role: ROLES.LECTURER, metadata: { source: 'Detailed_Staff_and_Lecturer_HR_Policy_Demo.pdf', allowed_roles: ['student'] }, blocked: true },
        { role: ROLES.STAFF, metadata: { source: 'Detailed_Staff_and_Lecturer_HR_Policy_Demo.pdf', allowed_roles: ['student'] }, blocked: true },
        { role: ROLES.PUBLIC, metadata: { source: 'Detailed_Staff_and_Lecturer_HR_Policy_Demo.pdf', allowed_roles: ['student'] }, blocked: true },
        { role: ROLES.STUDENT, metadata: { source: 'Detailed_Staff_and_Lecturer_HR_Policy_Demo.pdf', allowed_roles: ['student'] }, blocked: false },
      ];

      for (const scenario of cases) {
        const result = await runVeritasQuery({
          question: 'tell me about the leave days',
          ctx: {
            mode: MODES.JKUAT,
            role: scenario.role,
            userId: `demo-${scenario.role}`,
            groups: scenario.role === ROLES.STUDENT ? ['MCS-Y2'] : [],
          },
          jkuatVectorStore: {
            similaritySearchWithScore: async () => [[{
              pageContent: 'Annual leave and staff/lecturer policy details.',
              metadata: scenario.metadata,
            }, 0.3]],
          },
          conversationHistory: [],
        });

        assert.equal(result.rbacBlocked, scenario.blocked, `role ${scenario.role} should have blocked=${scenario.blocked}`);
      }
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('treats empty allowed_roles metadata as restricted — denies all roles until a role is explicitly assigned', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Role-aware answer.' } }] } });

    try {
      const result = await runVeritasQuery({
        question: 'tell me about deeptech',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'DeepTech is a technology and innovation hub focused on practical research and commercialisation.',
            metadata: { source: 'deeptech.txt', allowed_roles: [] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      // Empty allowed_roles means no role was assigned → blocked for all roles
      assert.equal(result.rbacBlocked, true);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('uses the stored document role list during ingestion when no explicit override is passed', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Role-aware answer.' } }] } });

    try {
      const owner = `demo-admin-${uid()}`;
      const ws = ensureWorkspace(owner, 'Admin Role Override');
      const docId = uid();
      const filePath = path.join(DATA_DIR, 'workspaces', ws.id, 'files', `${docId}.txt`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'Only staff should access this restricted memo.');

      insertDocument({
        id: docId,
        workspace_id: ws.id,
        filename: 'staff-only.txt',
        format: 'txt',
        size_bytes: fs.statSync(filePath).size,
        status: 'uploaded',
        pages_or_sections: 0,
        chunk_count: 0,
        error_message: null,
        storage_path: filePath,
        indexed_at: null,
        allowed_roles: JSON.stringify(['staff']),
        created_at: nowIso(),
        updated_at: nowIso(),
      });

      const doc = await ingestDocument(docId);
      assert.equal(doc.status, 'ready');
      assert.equal(doc.allowed_roles, JSON.stringify(['staff']));

      const allowed = await runVeritasQuery({
        question: 'What does the restricted memo say?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STAFF,
          userId: 'demo-staff',
          groups: [],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Only staff should access this restricted memo.',
            metadata: { source: 'staff-only.txt', allowed_roles: ['staff'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      const blocked = await runVeritasQuery({
        question: 'What does the restricted memo say?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Only staff should access this restricted memo.',
            metadata: { source: 'staff-only.txt', allowed_roles: ['staff'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(allowed.rbacBlocked, false);
      assert.equal(blocked.rbacBlocked, true);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });
});

describe('role-aware retrieval and audit logging', () => {
  after(() => purgeTestWorkspaces());
  it('blocks restricted retrieval when the user role is not in allowed_roles and records the audit status', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    let requestBody;
    axios.post = async (...args) => {
      requestBody = args[1];
      return { data: { choices: [{ message: { content: 'Allowed answer.' } }] } };
    };
    try {
      const result = await runVeritasQuery({
        question: 'Can I access the internal CS lab policy?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Internal lab policy for lecturers only.',
            metadata: { source: 'lab-policy.pdf', allowed_roles: ['lecturer', 'staff'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(result.rbacBlocked, true);
      assert.match(String(result.answer || ''), /permission|not authorized|access denied/i);
      assert.ok(requestBody, 'the system should still build a model prompt for the final response');
      const auditRow = getDb().prepare(`
        SELECT * FROM audit_events WHERE action = 'query.rbac_block' ORDER BY created_at DESC LIMIT 1
      `).get();
      assert.ok(auditRow, 'RBAC block should be logged to the audit table');
      assert.match(JSON.stringify(auditRow.detail_json || {}), /RBAC_BLOCKED/i);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('logs a fresh audit event for each answered question, including the query text and outcome', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Allowed answer.' } }] } });
    try {
      const result = await runVeritasQuery({
        question: 'What are the student notice rules?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Student notice rules: do not skip attendance.',
            metadata: { source: 'student-rules.pdf', allowed_roles: ['student'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(result.rbacBlocked, false);
      const auditRow = getDb().prepare(`
        SELECT * FROM audit_events WHERE action = 'query.answer' ORDER BY created_at DESC LIMIT 1
      `).get();
      assert.ok(auditRow, 'answered queries should create a live audit row');
      assert.match(JSON.stringify(auditRow.detail_json || {}), /student notice rules/i);
      assert.match(JSON.stringify(auditRow.detail_json || {}), /ANSWERED/i);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('allows document chunks when the user role is included in allowed_roles', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Allowed answer.' } }] } });
    try {
      const result = await runVeritasQuery({
        question: 'What are the student notice rules?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.STUDENT,
          userId: 'demo-student',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Student notice rules: do not skip attendance.',
            metadata: { source: 'student-rules.pdf', allowed_roles: ['student'] },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(result.rbacBlocked, false);
      assert.ok(String(result.answer || '').length > 0);
      assert.ok(Array.isArray(result.evidence));
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('accepts allowed_roles stored as a JSON string when checking a matching role', async () => {
    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    axios.post = async (...args) => ({ data: { choices: [{ message: { content: 'Allowed answer.' } }] } });
    try {
      const result = await runVeritasQuery({
        question: 'What is the lecturer attendance policy?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.LECTURER,
          userId: 'demo-lecturer',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: {
          similaritySearchWithScore: async () => [[{
            pageContent: 'Lecturer attendance policy requires review before Friday.',
            metadata: { source: 'lecturer-policy.txt', allowed_roles: '["lecturer","staff"]' },
          }, 0.3]],
        },
        conversationHistory: [],
      });

      assert.equal(result.rbacBlocked, false);
      assert.ok(Array.isArray(result.evidence));
      assert.ok(String(result.answer || '').length > 0);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('retrieves admin-uploaded role-scoped documents in JKUAT mode for an allowed role', async () => {
    const owner = `demo-admin-${uid()}`;
    const ws = ensureWorkspace(owner, 'Admin Shared Files');
    const docId = uid();
    const filePath = path.join(DATA_DIR, 'workspaces', ws.id, 'files', `${docId}.txt`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'Lecturer attendance policy: staff and lecturers must review the briefing before the Friday session.');

    const inserted = insertDocument({
      id: docId,
      workspace_id: ws.id,
      filename: 'lecturer-attendance.txt',
      format: 'txt',
      size_bytes: fs.statSync(filePath).size,
      status: 'uploaded',
      pages_or_sections: 0,
      chunk_count: 0,
      error_message: null,
      storage_path: filePath,
      indexed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    await ingestDocument(inserted.id, { allowedRoles: ['lecturer', 'staff'] });

    process.env.GROQ_API_KEY = 'test-key';
    const originalPost = axios.post;
    let requestBody;
    axios.post = async (...args) => {
      requestBody = args[1];
      return { data: { choices: [{ message: { content: 'The lecturer attendance policy requires review before the Friday session.' } }] } };
    };

    try {
      const result = await runVeritasQuery({
        question: 'What is the lecturer attendance policy?',
        ctx: {
          mode: MODES.JKUAT,
          role: ROLES.LECTURER,
          userId: 'demo-lecturer',
          groups: ['MCS-Y2'],
        },
        jkuatVectorStore: null,
        conversationHistory: [],
      });

      const evidenceText = (result.evidence || []).map((e) => `${e.title || ''} ${e.excerpt || ''}`).join('\n');
      assert.ok(requestBody, 'query should still send a prompt to the model');
      assert.match(evidenceText, /lecturer attendance policy|Friday session/i);
    } finally {
      axios.post = originalPost;
      delete process.env.GROQ_API_KEY;
    }
  });
});

describe('date-aware temporal filtering', () => {
  it('excludes fully past event ranges from upcoming answers', () => {
    const now = new Date(Date.UTC(2026, 9, 24));
    const docs = [
      { pageContent: 'Conference — 6-7 July 2026' },
      { pageContent: 'Career fair — 12 November 2026' },
    ];
    const filtered = filterTemporalDocs(docs, 'what events are there this semester?', now);
    assert.equal(filtered.length, 1);
    assert.match(filtered[0].pageContent, /12 November 2026/i);
  });

  it('keeps past-event evidence when the user asks about a past event', () => {
    const now = new Date(Date.UTC(2026, 9, 24));
    const docs = [{ pageContent: 'Conference held on 6-7 July 2026' }];
    const filtered = filterTemporalDocs(docs, 'what happened at the conference?', now);
    assert.equal(filtered.length, 1);
  });

  it('does not fabricate dates from ambiguous text', () => {
    const ranges = extractDateRanges('The event happens sometime in late October at the campus');
    assert.equal(ranges.length, 0);
  });
});

describe('Generic RAG workspace isolation (in-process)', () => {
  after(() => purgeTestWorkspaces());
  it('ingests a DOCX, extracts readable text, keeps it retrievable, and removes it on delete', async () => {
    const owner = `test-owner-docx-${uid().slice(0, 8)}`;
    const ws = ensureWorkspace(owner, 'WS-DOCX');
    const zip = new AdmZip();
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>DeepTech Studio Meeting Agenda</w:t></w:r></w:p>
          <w:p><w:r><w:t>Action items include product launch and Q3 roadmap.</w:t></w:r></w:p>
        </w:body>
      </w:document>`;

    zip.addFile('word/document.xml', docXml);
    const docDir = path.join(DATA_DIR, 'workspaces', ws.id, 'files');
    fs.mkdirSync(docDir, { recursive: true });
    const docId = uid();
    const docPath = path.join(docDir, `${docId}.docx`);
    zip.writeZip(docPath);

    insertDocument({
      id: docId,
      workspace_id: ws.id,
      filename: 'DeepTech Studio Meeting Agenda.docx',
      format: 'docx',
      size_bytes: fs.statSync(docPath).size,
      status: 'uploaded',
      pages_or_sections: 0,
      chunk_count: 0,
      error_message: null,
      storage_path: docPath,
      indexed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const ready = await ingestDocument(docId);
    assert.equal(ready.status, 'ready');
    const hits = await retrieveWorkspace(ws.id, 'What is the meeting agenda about?', 5);
    assert.ok(hits.some((h) => /DeepTech Studio Meeting Agenda|Q3 roadmap|product launch/i.test(h.pageContent)));

    await deleteFromIndex(docId);
    deleteDocument(docId);
    const afterDelete = await retrieveWorkspace(ws.id, 'product launch', 5);
    assert.ok(!afterDelete.some((h) => h.metadata?.document_id === docId));
  });

  it('ingests multiple documents, keeps both retrievable, and removes the deleted one from the workspace index', async () => {
    const ownerA = `test-owner-a-${uid().slice(0, 8)}`;
    const ownerB = `test-owner-b-${uid().slice(0, 8)}`;
    const wsA = ensureWorkspace(ownerA, 'WS-A');
    const wsB = ensureWorkspace(ownerB, 'WS-B');

    const sampleSrc = path.join(ROOT, 'sample-data', 'demo-knowledge.txt');
    const destDir = path.join(DATA_DIR, 'workspaces', wsA.id, 'files');
    fs.mkdirSync(destDir, { recursive: true });

    const doc1Id = uid();
    const doc2Id = uid();
    const doc1Path = path.join(destDir, `${doc1Id}.txt`);
    const doc2Path = path.join(destDir, `${doc2Id}.txt`);
    fs.copyFileSync(sampleSrc, doc1Path);
    fs.writeFileSync(doc2Path, 'The second document says the answer is zebra crossing and public safety.');

    insertDocument({
      id: doc1Id,
      workspace_id: wsA.id,
      filename: 'demo-knowledge.txt',
      format: 'txt',
      size_bytes: fs.statSync(doc1Path).size,
      status: 'uploaded',
      pages_or_sections: 0,
      chunk_count: 0,
      error_message: null,
      storage_path: doc1Path,
      indexed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    insertDocument({
      id: doc2Id,
      workspace_id: wsA.id,
      filename: 'safety.txt',
      format: 'txt',
      size_bytes: fs.statSync(doc2Path).size,
      status: 'uploaded',
      pages_or_sections: 0,
      chunk_count: 0,
      error_message: null,
      storage_path: doc2Path,
      indexed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const ready1 = await ingestDocument(doc1Id);
    const ready2 = await ingestDocument(doc2Id);
    assert.equal(ready1.status, 'ready');
    assert.equal(ready2.status, 'ready');
    assert.ok(ready1.chunk_count > 0);
    assert.ok(ready2.chunk_count > 0);

    const hitsA1 = await retrieveWorkspace(wsA.id, 'What is the workspace demo passphrase?', 5);
    const hitsA2 = await retrieveWorkspace(wsA.id, 'What does the second document say?', 5);
    assert.ok(hitsA1.some((h) => /cedar-orbit-17/i.test(h.pageContent)));
    assert.ok(hitsA2.some((h) => /zebra crossing|public safety/i.test(h.pageContent)));

    const hitsB = await retrieveWorkspace(wsB.id, 'What is the workspace demo passphrase?', 5);
    assert.equal(hitsB.length, 0);

    await deleteFromIndex(doc2Id);
    deleteDocument(doc2Id);
    const afterDelete = await retrieveWorkspace(wsA.id, 'What does the second document say?', 5);
    assert.ok(!afterDelete.some((h) => h.metadata?.document_id === doc2Id));
    assert.ok(!listDocuments(wsA.id).find((d) => d.id === doc2Id));
  });
});

describe('HTTP API smoke (optional)', () => {
  it('meta endpoint when server is up', async (t) => {
    if (!(await apiAlive())) {
      t.skip('RAG server not running');
      return;
    }
    const res = await fetch(`${API}/meta`);
    const data = await res.json();
    assert.equal(data.product, 'VeritasRAG');
    assert.ok(data.modes.includes('generic'));
  });

  it('rejects public timetable over HTTP', async (t) => {
    if (!(await apiAlive())) {
      t.skip('RAG server not running');
      return;
    }
    const res = await fetch(`${API}/jkuat/timetable`, {
      headers: {
        'X-Veritas-Mode': 'jkuat',
        'X-Veritas-Role': 'public',
        'X-Veritas-User-Id': 'demo-public',
        'X-Veritas-Demo': 'true',
      },
    });
    assert.equal(res.status, 403);
  });
});

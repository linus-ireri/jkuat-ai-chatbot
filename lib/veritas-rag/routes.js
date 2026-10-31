/**
 * VeritasRAG API routes — mounted on the existing Express RAG server.
 * Does not alter legacy /ask or /rag behaviour.
 */
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import express from 'express';
import { transcribeFloat32, synthesisePiper, stripMarkdownForSpeech } from './voice.js';
import { cleanLlmAnswer } from '../clean-llm-answer.js';
import {
  DATA_DIR,
  ensureWorkspace,
  getWorkspace,
  listDocuments,
  getDocument,
  insertDocument,
  updateDocument,
  deleteDocument,
  uid,
  nowIso,
  audit,
  getDb,
} from './db.js';
import { attachContext, requireMode, requireRole, ROLES, MODES, DEMO_USERS } from './auth.js';
import {
  validateUpload,
  ingestDocument,
  deleteFromIndex,
  MAX_BYTES,
  normalizeAllowedRoles,
} from './ingest-pipeline.js';
import { runVeritasQuery } from './query.js';
import { seedDemoData, resetDemoData } from './seed.js';
import * as timetable from './timetable.js';

const upload = multer({
  dest: path.join(DATA_DIR, 'uploads'),
  limits: { fileSize: MAX_BYTES, files: 5 },
});

function httpError(res, err) {
  const status = err.status || 500;
  const payload = { error: err.message || 'Server error' };
  if (err.conflicts) payload.conflicts = err.conflicts;
  if (status >= 500) console.error(err);
  return res.status(status).json(payload);
}

export function createVeritasRouter({ getJkuatStore }) {
  const router = express.Router();
  seedDemoData();

  router.use(attachContext);

  router.post('/demo/reset', requireMode(MODES.JKUAT), requireRole(ROLES.STAFF, ROLES.LECTURER), (_req, res) => {
    resetDemoData();
    seedDemoData();
    res.json({ ok: true, message: 'Demo notifications, announcements, and schedule changes reset to a clean state.' });
  });

  router.get('/meta', (_req, res) => {
    res.json({
      product: 'VeritasRAG',
      modes: Object.values(MODES),
      roles: Object.values(ROLES),
      demoUsers: Object.values(DEMO_USERS).map((u) => ({
        id: u.id,
        role: u.role,
        name: u.name,
        verified: false,
      })),
      note: 'Demo roles are not verified institutional identities.',
      persistence: {
        vectors: 'local disk under data/workspaces (ephemeral on serverless hosts)',
        structured: 'SQLite at data/veritas.db',
        warning: 'Uploads do not persist across ephemeral deployments unless durable storage is configured.',
      },
    });
  });

  // ——— Generic workspace ———
  router.post('/workspaces', requireMode(MODES.GENERIC), (req, res) => {
    const ws = ensureWorkspace(req.veritas.userId, req.body?.name || 'My Workspace');
    audit(req.veritas.userId, 'workspace.ensure', ws.id, {});
    res.json({ workspace: ws });
  });

  router.get('/workspaces/current', requireMode(MODES.GENERIC), (req, res) => {
    const ws = ensureWorkspace(req.veritas.userId);
    res.json({ workspace: ws, documents: listDocuments(ws.id) });
  });

  router.get('/documents', requireMode(MODES.GENERIC), (req, res) => {
    const ws = ensureWorkspace(req.veritas.userId);
    let docs = listDocuments(ws.id).map((doc) => ({
      ...doc,
      allowed_roles: doc.allowed_roles ?? JSON.stringify([]),
    }));
    const q = String(req.query.q || '').toLowerCase();
    if (q) docs = docs.filter((d) => d.filename.toLowerCase().includes(q));
    res.json({ workspaceId: ws.id, documents: docs });
  });

  router.post(
    '/documents/upload',
    requireMode(MODES.GENERIC),
    upload.array('files', 5),
    async (req, res) => {
      try {
        const ws = ensureWorkspace(req.veritas.userId);
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

        const allowedRoles = normalizeAllowedRoles(req.body?.allowedRoles || []);
        const created = [];
        for (const file of files) {
          const check = validateUpload(file);
          if (!check.ok) {
            fs.unlinkSync(file.path);
            created.push({ filename: file.originalname, error: check.error });
            continue;
          }
          const id = uid();
          const destDir = path.join(DATA_DIR, 'workspaces', ws.id, 'files');
          fs.mkdirSync(destDir, { recursive: true });
          const dest = path.join(destDir, `${id}${path.extname(file.originalname)}`);
          fs.renameSync(file.path, dest);
          const ts = nowIso();
          const row = insertDocument({
            id,
            workspace_id: ws.id,
            filename: file.originalname,
            format: check.ext,
            size_bytes: file.size,
            status: 'uploaded',
            pages_or_sections: 0,
            chunk_count: 0,
            error_message: null,
            storage_path: dest,
            indexed_at: null,
            allowed_roles: JSON.stringify(allowedRoles),
            created_at: ts,
            updated_at: ts,
          });
          // Async ingest — await for demo reliability
          const ready = await ingestDocument(id, { allowedRoles });
          created.push(ready || { ...row, allowed_roles: allowedRoles });
        }
        audit(req.veritas.userId, 'documents.upload', ws.id, { count: created.length });
        res.status(201).json({ workspaceId: ws.id, documents: created });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.post('/documents/:id/reindex', requireMode(MODES.GENERIC), async (req, res) => {
    try {
      const doc = getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });
      const ws = ensureWorkspace(req.veritas.userId);
      if (doc.workspace_id !== ws.id) return res.status(403).json({ error: 'Cross-workspace access denied' });
      const nextRoles = normalizeAllowedRoles(req.body?.allowedRoles || []);
      updateDocument(doc.id, { status: 'uploaded', error_message: null, allowed_roles: JSON.stringify(nextRoles) });
      const result = await ingestDocument(doc.id, { allowedRoles: nextRoles });
      res.json({ document: result });
    } catch (err) {
      httpError(res, err);
    }
  });

  router.get('/documents/:id', requireMode(MODES.GENERIC), (req, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const ws = ensureWorkspace(req.veritas.userId);
    if (doc.workspace_id !== ws.id) return res.status(403).json({ error: 'Cross-workspace access denied' });
    let preview = null;
    try {
      if (doc.format === 'txt' || doc.format === 'csv') {
        preview = fs.readFileSync(doc.storage_path, 'utf8').slice(0, 4000);
      }
    } catch { /* ignore */ }
    res.json({ document: doc, preview });
  });

  router.delete('/documents/:id', requireMode(MODES.GENERIC), async (req, res) => {
    try {
      const doc = getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found' });
      const ws = ensureWorkspace(req.veritas.userId);
      if (doc.workspace_id !== ws.id) return res.status(403).json({ error: 'Cross-workspace access denied' });
      await deleteFromIndex(doc.id);
      if (doc.storage_path && fs.existsSync(doc.storage_path)) fs.unlinkSync(doc.storage_path);
      deleteDocument(doc.id);
      audit(req.veritas.userId, 'documents.delete', doc.id, {});
      res.json({ ok: true });
    } catch (err) {
      httpError(res, err);
    }
  });

  // ——— Unified ask ———
  router.post('/ask', async (req, res) => {
    try {
      const ctx = req.veritas;
      if (!ctx.mode) {
        return res.status(400).json({ error: 'X-Veritas-Mode required (generic|jkuat)' });
      }
      const question = req.body?.question;
      if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'Missing question' });
      }
      if (ctx.mode === MODES.GENERIC) {
        const ws = ensureWorkspace(ctx.userId);
        ctx.workspaceId = ws.id;
      }
      const db = getDb();
      let conversationId = req.body?.conversationId;
      let previousMessages = [];
      if (conversationId) {
        previousMessages = db.prepare(`
          SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 15
        `).all(conversationId).map((m) => ({ role: m.role, content: m.content }));
      }

      const result = await runVeritasQuery({
        question,
        ctx,
        jkuatVectorStore: getJkuatStore(),
        documentIds: req.body?.documentIds || null,
        conversationHistory: previousMessages,
      });

      // Persist conversation lightly
      if (!conversationId) {
        conversationId = uid();
        const ts = nowIso();
        db.prepare(`
          INSERT INTO conversations (id, mode, role, user_id, workspace_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          conversationId,
          ctx.mode,
          ctx.role,
          ctx.userId,
          ctx.workspaceId || null,
          question.slice(0, 80),
          ts,
          ts
        );
      }
      const midQ = uid();
      const midA = uid();
      const ts = nowIso();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, evidence_json, support_level, created_at)
        VALUES (?, ?, 'user', ?, NULL, NULL, ?)
      `).run(midQ, conversationId, question, ts);
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, evidence_json, support_level, created_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?)
      `).run(midA, conversationId, result.answer, JSON.stringify(result.evidence || []), result.supportLevel, ts);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);

      res.json({ ...result, conversationId });
    } catch (err) {
      httpError(res, err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /veritas-rag/voice/ask
  //
  // Accepts raw 16 kHz mono Float32 PCM as application/octet-stream.
  // Role and userId come ONLY from the server session (or the X-Veritas-*
  // headers that were already attached to req.veritas by attachContext),
  // never from the request body — guaranteeing the same RBAC path as typed asks.
  //
  // Request body: raw binary (Float32LE, 16 000 Hz, mono, max 30 s / 2 MB)
  // Response:     { question, answer, audioBase64 } — audioBase64 may be null
  //               when Piper is not configured or fails (browser falls back to
  //               speechSynthesis).
  // ──────────────────────────────────────────────────────────────────────────
  router.post('/voice/ask', express.raw({ type: 'application/octet-stream', limit: '2mb' }), async (req, res) => {
    try {
      // ── 1. Validate incoming audio ──────────────────────────────────────
      const rawBuf = req.body; // Buffer from express.raw()
      if (!Buffer.isBuffer(rawBuf) || rawBuf.length === 0) {
        audit(req.veritas.userId || 'anonymous', 'voice.ask.rejected', 'voice_endpoint', {
          reason: 'Empty audio body',
        });
        return res.status(400).json({ error: 'Empty audio body. Send raw Float32 PCM at 16 kHz.' });
      }
      // 2 MB hard cap (express.raw limit handles it but be explicit)
      if (rawBuf.length > 2 * 1024 * 1024) {
        audit(req.veritas.userId || 'anonymous', 'voice.ask.rejected', 'voice_endpoint', {
          reason: 'Audio body too large',
          bytes: rawBuf.length,
        });
        return res.status(413).json({ error: 'Audio too large. Maximum is 2 MB (≈30 s at 16 kHz mono Float32).' });
      }
      // Float32 LE → 4 bytes per sample; 16 000 samples/s × 30 s = 1 920 000 samples
      const MAX_SAMPLES = 16000 * 30; // 30 s at 16 kHz
      if (rawBuf.length % 4 !== 0) {
        return res.status(400).json({ error: 'Audio body length must be a multiple of 4 (Float32LE).' });
      }
      const numSamples = rawBuf.length / 4;
      if (numSamples > MAX_SAMPLES) {
        return res.status(413).json({ error: 'Audio exceeds 30 seconds. Please send shorter clips.' });
      }
      const samples = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, numSamples);

      // ── 2. Auth context — role/userId from existing session headers ──────
      //    attachContext has already populated req.veritas from X-Veritas-*
      //    headers.  We read ONLY from req.veritas; the request body is never
      //    consulted for identity values.
      const ctx = req.veritas;
      if (!ctx.mode) {
        audit(ctx.userId || 'anonymous', 'voice.ask.rejected', 'voice_endpoint', {
          reason: 'Missing mode header',
        });
        return res.status(400).json({ error: 'X-Veritas-Mode header required (generic|jkuat).' });
      }
      if (ctx.mode === MODES.GENERIC) {
        const ws = ensureWorkspace(ctx.userId);
        ctx.workspaceId = ws.id;
      }

      // ── 3. Transcribe ────────────────────────────────────────────────────
      let question;
      try {
        question = await transcribeFloat32(samples);
      } catch (whisperErr) {
        console.error('[voice] Whisper transcription error:', whisperErr);
        audit(ctx.userId, 'voice.ask.error', 'voice_endpoint', {
          stage: 'transcription',
          error: whisperErr.message,
        });
        return res.status(500).json({ error: 'Transcription failed. Please try again.' });
      }

      if (!question) {
        audit(ctx.userId, 'voice.ask.rejected', 'voice_endpoint', {
          reason: 'Silent or unintelligible audio',
        });
        return res.status(422).json({ error: 'Could not detect speech in the audio. Please speak clearly and try again.' });
      }

      // ── 4. Run the same query pipeline as typed asks ─────────────────────
      let previousMessages = [];
      // Voice queries are always one-shot (no conversationId in the body);
      // conversation context could be added later if desired.
      let result;
      try {
        result = await runVeritasQuery({
          question,
          ctx,
          jkuatVectorStore: getJkuatStore(),
          documentIds: null,
          conversationHistory: previousMessages,
        });
      } catch (queryErr) {
        console.error('[voice] runVeritasQuery error:', queryErr);
        audit(ctx.userId, 'voice.ask.error', 'voice_endpoint', {
          stage: 'query',
          question,
          error: queryErr.message,
        });
        return res.status(500).json({ error: 'Query failed. Please try again.' });
      }

      // ── 5. Audit-log the voice query (mirrors typed-ask logging) ─────────
      audit(ctx.userId, 'voice.ask', 'voice_endpoint', {
        mode: ctx.mode,
        role: ctx.role,
        question,
        rbacBlocked: result.rbacBlocked || false,
        supportLevel: result.supportLevel,
      });

      // ── 5b. Persist to conversations + messages (same as typed /ask) ─────
      const db = getDb();
      const voiceConvId = uid();
      const tsVoice = nowIso();
      db.prepare(`
        INSERT INTO conversations (id, mode, role, user_id, workspace_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        voiceConvId,
        ctx.mode,
        ctx.role || null,
        ctx.userId,
        ctx.workspaceId || null,
        `🎙️ ${question.slice(0, 77)}`,
        tsVoice,
        tsVoice,
      );
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, evidence_json, support_level, created_at)
        VALUES (?, ?, 'user', ?, NULL, NULL, ?)
      `).run(uid(), voiceConvId, question, tsVoice);
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, evidence_json, support_level, created_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?)
      `).run(uid(), voiceConvId, result.answer, JSON.stringify(result.evidence || []), result.supportLevel, tsVoice);

      // ── 6. Prepare TTS: clean answer → strip markdown → synthesise ───────
      const spokenText = stripMarkdownForSpeech(cleanLlmAnswer(result.answer));
      let audioBase64 = null;
      try {
        const wavBuf = await synthesisePiper(spokenText);
        if (wavBuf) {
          audioBase64 = wavBuf.toString('base64');
        }
      } catch (ttsErr) {
        // TTS failure is non-fatal — browser will use speechSynthesis
        console.warn('[voice] Piper TTS error (falling back to client speechSynthesis):', ttsErr.message);
      }

      res.json({
        question,
        answer: result.answer,
        audioBase64, // null → client should use speechSynthesis
        conversationId: voiceConvId,
      });
    } catch (err) {
      httpError(res, err);
    }
  });

  router.get('/conversations', (req, res) => {
    const ctx = req.veritas;
    const rows = getDb().prepare(`
      SELECT * FROM conversations
      WHERE user_id = ? AND (mode = ? OR mode IS NULL)
      ORDER BY updated_at DESC LIMIT 40
    `).all(ctx.userId, ctx.mode || '');
    res.json({ conversations: rows });
  });

  router.get('/conversations/:id', (req, res) => {
    const ctx = req.veritas;
    const conv = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
    if (!conv || conv.user_id !== ctx.userId) return res.status(404).json({ error: 'Not found' });
    const messages = getDb().prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC
    `).all(conv.id);
    res.json({
      conversation: conv,
      messages: messages.map((m) => ({
        ...m,
        evidence: m.evidence_json ? JSON.parse(m.evidence_json) : null,
      })),
    });
  });

  // ——— JKUAT dashboards ———
  router.get('/jkuat/dashboard', requireMode(MODES.JKUAT), (req, res) => {
    const ctx = req.veritas;
    const role = ctx.role || ROLES.PUBLIC;
    const base = {
      role,
      verifiedIdentity: false,
      demoLabel: 'Demonstration data — not official JKUAT records',
      user: { id: ctx.userId, name: ctx.name },
    };

    if (role === ROLES.STUDENT) {
      const group = ctx.groups?.[0] || 'MCS-Y2';
      return res.json({
        ...base,
        timetable: timetable.listTimetable({ studentGroup: group }),
        announcements: timetable.listAnnouncements({ studentGroup: group }),
        notifications: timetable.listNotifications({ studentGroup: group, userId: ctx.userId }),
        faqs: [
          'When is the next class for ICS2405?',
          'Has any venue changed this week?',
          'What does the information guide say about library hours?',
        ],
      });
    }

    if (role === ROLES.LECTURER) {
      return res.json({
        ...base,
        allocations: timetable.lecturerAllocations(ctx.userId),
        timetable: timetable.listTimetable({ lecturerId: ctx.userId }),
        changes: timetable.listChanges({ lecturerId: ctx.userId }),
        notifications: timetable.listNotifications({ userId: ctx.userId }),
      });
    }

    if (role === ROLES.STAFF) {
      return res.json({
        ...base,
        department: ctx.department,
        announcements: timetable.listAnnouncements({}),
        timetableSample: timetable.listTimetable({}).slice(0, 8),
        note: 'Staff demo access excludes confidential student records.',
      });
    }

    return res.json({
      ...base,
      publicTopics: ['Programmes', 'Admissions', 'Campus information', 'Public contacts'],
      announcements: timetable.listAnnouncements({ audience: 'public' }).filter(
        (a) => a.audience === 'all' || a.audience === 'public'
      ),
    });
  });

  router.get('/jkuat/timetable', requireMode(MODES.JKUAT), (req, res) => {
    const ctx = req.veritas;
    if (ctx.role === ROLES.PUBLIC) {
      return res.status(403).json({ error: 'Public users cannot access private timetables' });
    }
    if (ctx.role === ROLES.STUDENT) {
      return res.json({
        demo: true,
        entries: timetable.listTimetable({ studentGroup: ctx.groups?.[0] || 'MCS-Y2' }),
      });
    }
    if (ctx.role === ROLES.LECTURER) {
      return res.json({
        demo: true,
        entries: timetable.listTimetable({ lecturerId: ctx.userId }),
        allocations: timetable.lecturerAllocations(ctx.userId),
      });
    }
    res.json({ demo: true, entries: timetable.listTimetable({}) });
  });

  router.post(
    '/jkuat/schedule-changes',
    requireMode(MODES.JKUAT),
    requireRole(ROLES.LECTURER),
    (req, res) => {
      try {
        const change = timetable.proposeChange(req.veritas.userId, req.body || {});
        res.status(201).json({
          change,
          demo: true,
          message: 'Draft created. Conflicts listed if any. Not official until published.',
        });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.post(
    '/jkuat/schedule-changes/:id/submit',
    requireMode(MODES.JKUAT),
    requireRole(ROLES.LECTURER),
    (req, res) => {
      try {
        res.json({ change: timetable.submitForApproval(req.params.id, req.veritas.userId) });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.post(
    '/jkuat/schedule-changes/:id/publish',
    requireMode(MODES.JKUAT),
    requireRole(ROLES.LECTURER, ROLES.STAFF),
    (req, res) => {
      try {
        const allowDirectPublish =
          String(req.headers['x-veritas-demo-publish'] || '') === 'true' ||
          req.body?.demoPublish === true;
        const result = timetable.publishChange(req.params.id, req.veritas.userId, {
          allowDirectPublish,
        });
        res.json({
          ...result,
          demo: true,
          message: 'Published. Student notifications and announcements created.',
        });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.post(
    '/jkuat/schedule-changes/:id/reject',
    requireMode(MODES.JKUAT),
    requireRole(ROLES.STAFF, ROLES.LECTURER),
    (req, res) => {
      try {
        res.json({
          change: timetable.rejectChange(req.params.id, req.veritas.userId, req.body?.reason),
        });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.post(
    '/jkuat/schedule-changes/:id/cancel',
    requireMode(MODES.JKUAT),
    requireRole(ROLES.LECTURER),
    (req, res) => {
      try {
        res.json({ change: timetable.cancelChange(req.params.id, req.veritas.userId) });
      } catch (err) {
        httpError(res, err);
      }
    }
  );

  router.get('/jkuat/schedule-changes', requireMode(MODES.JKUAT), (req, res) => {
    const ctx = req.veritas;
    if (ctx.role === ROLES.LECTURER) {
      return res.json({ changes: timetable.listChanges({ lecturerId: ctx.userId }) });
    }
    if (ctx.role === ROLES.STAFF) {
      return res.json({ changes: timetable.listChanges({}) });
    }
    return res.status(403).json({ error: 'Not authorized to list change requests' });
  });

  router.get('/jkuat/announcements', requireMode(MODES.JKUAT), (req, res) => {
    const ctx = req.veritas;
    const group = ctx.role === ROLES.STUDENT ? (ctx.groups?.[0] || 'MCS-Y2') : undefined;
    res.json({ announcements: timetable.listAnnouncements({ studentGroup: group }) });
  });

  router.get('/jkuat/notifications', requireMode(MODES.JKUAT), (req, res) => {
    const ctx = req.veritas;
    const group = ctx.role === ROLES.STUDENT ? (ctx.groups?.[0] || 'MCS-Y2') : undefined;
    res.json({
      notifications: timetable.listNotifications({ userId: ctx.userId, studentGroup: group }),
    });
  });

  router.post('/jkuat/notifications/:id/read', requireMode(MODES.JKUAT), (req, res) => {
    timetable.markNotificationRead(req.params.id);
    res.json({ ok: true });
  });

  router.get('/admin/audit', requireMode(MODES.GENERIC, MODES.JKUAT), (_req, res) => {
    const rows = getDb().prepare(`
      SELECT id, actor_id, action, resource, detail_json, created_at
      FROM audit_events
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    res.json({ events: rows.map((row) => ({ ...row, detail: row.detail_json ? JSON.parse(row.detail_json) : {} })) });
  });

  // Freshness monitor (staff / lecturer demo)
  router.get(
    '/admin/freshness',
    requireMode(MODES.GENERIC, MODES.JKUAT),
    (req, res) => {
      const ctx = req.veritas;
      if (ctx.mode === MODES.GENERIC) {
        const ws = ensureWorkspace(ctx.userId);
        const docs = listDocuments(ws.id);
        return res.json({
          workspaceId: ws.id,
          documents: docs.map((d) => ({
            id: d.id,
            filename: d.filename,
            status: d.status,
            indexed_at: d.indexed_at,
            error: d.error_message,
          })),
          failed: docs.filter((d) => d.status === 'failed'),
          pendingChanges: [],
        });
      }
      if (![ROLES.STAFF, ROLES.LECTURER].includes(ctx.role)) {
        return res.status(403).json({ error: 'Freshness monitor restricted' });
      }
      res.json({
        pendingChanges: timetable.listChanges({}).filter((c) =>
          ['draft', 'pending_approval'].includes(c.status)
        ),
        note: 'JKUAT institutional vector store is managed via offline ingest.js',
      });
    }
  );

  return router;
}

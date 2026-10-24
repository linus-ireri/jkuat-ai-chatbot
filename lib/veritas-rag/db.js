/**
 * VeritasRAG structured store (SQLite).
 * Source of truth for workspaces, documents, timetables, notifications, audit.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'veritas.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'workspaces'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL,
    pages_or_sections INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    error_message TEXT,
    storage_path TEXT,
    indexed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    role TEXT,
    user_id TEXT,
    workspace_id TEXT,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_json TEXT,
    support_level TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS units (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT
  );

  CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    capacity INTEGER
  );

  CREATE TABLE IF NOT EXISTS lecturer_allocations (
    id TEXT PRIMARY KEY,
    lecturer_id TEXT NOT NULL,
    unit_code TEXT NOT NULL,
    student_group TEXT NOT NULL,
    FOREIGN KEY (unit_code) REFERENCES units(code)
  );

  CREATE TABLE IF NOT EXISTS timetable_entries (
    id TEXT PRIMARY KEY,
    unit_code TEXT NOT NULL,
    lecturer_id TEXT NOT NULL,
    student_group TEXT NOT NULL,
    day_of_week TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    week_label TEXT DEFAULT 'DEMO WEEK',
    status TEXT NOT NULL DEFAULT 'published',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (unit_code) REFERENCES units(code),
    FOREIGN KEY (venue_id) REFERENCES venues(id)
  );

  CREATE TABLE IF NOT EXISTS schedule_changes (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    lecturer_id TEXT NOT NULL,
    proposed_day TEXT,
    proposed_start TEXT,
    proposed_end TEXT,
    proposed_venue_id TEXT,
    reason TEXT,
    status TEXT NOT NULL,
    affected_groups_json TEXT,
    conflict_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    FOREIGN KEY (entry_id) REFERENCES timetable_entries(id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    audience TEXT NOT NULL,
    unit_code TEXT,
    change_id TEXT,
    created_at TEXT NOT NULL,
    effective_at TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    student_group TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    action TEXT NOT NULL,
    resource TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
  );
`);

export function nowIso() {
  return new Date().toISOString();
}

export function uid() {
  return randomUUID();
}

export function getDb() {
  return db;
}

export function ensureWorkspace(ownerId, name = 'My Workspace') {
  let ws = db.prepare('SELECT * FROM workspaces WHERE owner_id = ? LIMIT 1').get(ownerId);
  if (ws) return ws;
  const id = uid();
  const created = nowIso();
  db.prepare('INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    ownerId,
    created
  );
  fs.mkdirSync(path.join(DATA_DIR, 'workspaces', id), { recursive: true });
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

export function getWorkspace(id) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

export function listDocuments(workspaceId) {
  return db
    .prepare('SELECT * FROM documents WHERE workspace_id = ? ORDER BY created_at DESC')
    .all(workspaceId);
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

export function insertDocument(row) {
  db.prepare(`
    INSERT INTO documents (
      id, workspace_id, filename, format, size_bytes, status,
      pages_or_sections, chunk_count, error_message, storage_path,
      indexed_at, created_at, updated_at
    ) VALUES (
      @id, @workspace_id, @filename, @format, @size_bytes, @status,
      @pages_or_sections, @chunk_count, @error_message, @storage_path,
      @indexed_at, @created_at, @updated_at
    )
  `).run(row);
  return getDocument(row.id);
}

export function updateDocument(id, patch) {
  const current = getDocument(id);
  if (!current) return null;
  const next = { ...current, ...patch, updated_at: nowIso() };
  db.prepare(`
    UPDATE documents SET
      status = @status,
      pages_or_sections = @pages_or_sections,
      chunk_count = @chunk_count,
      error_message = @error_message,
      indexed_at = @indexed_at,
      updated_at = @updated_at
    WHERE id = @id
  `).run(next);
  return getDocument(id);
}

export function deleteDocument(id) {
  return db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

export function audit(actorId, action, resource, detail = {}) {
  db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, resource, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uid(), actorId || null, action, resource || null, JSON.stringify(detail), nowIso());
}

export { DATA_DIR, ROOT, DB_PATH };

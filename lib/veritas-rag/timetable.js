/**
 * Structured timetable operations — source of truth for schedules.
 * LLM never writes timetable records directly.
 */
import { getDb, nowIso, uid, audit } from './db.js';

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

export function listTimetable({ lecturerId, studentGroup, unitCode } = {}) {
  const db = getDb();
  let sql = `
    SELECT t.*, u.name AS unit_name, v.name AS venue_name
    FROM timetable_entries t
    JOIN units u ON u.code = t.unit_code
    JOIN venues v ON v.id = t.venue_id
    WHERE t.status = 'published'
  `;
  const params = [];
  if (lecturerId) {
    sql += ' AND t.lecturer_id = ?';
    params.push(lecturerId);
  }
  if (studentGroup) {
    sql += ' AND t.student_group = ?';
    params.push(studentGroup);
  }
  if (unitCode) {
    sql += ' AND t.unit_code = ?';
    params.push(unitCode);
  }
  sql += ' ORDER BY t.day_of_week, t.start_time';
  const rows = db.prepare(sql).all(...params);
  return rows.sort((a, b) => {
    const d = DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week);
    if (d !== 0) return d;
    return timeToMinutes(a.start_time) - timeToMinutes(b.start_time);
  });
}

export function getEntry(id) {
  return getDb().prepare(`
    SELECT t.*, u.name AS unit_name, v.name AS venue_name
    FROM timetable_entries t
    JOIN units u ON u.code = t.unit_code
    JOIN venues v ON v.id = t.venue_id
    WHERE t.id = ?
  `).get(id);
}

export function lecturerAllocations(lecturerId) {
  return getDb().prepare(`
    SELECT a.*, u.name AS unit_name
    FROM lecturer_allocations a
    JOIN units u ON u.code = a.unit_code
    WHERE a.lecturer_id = ?
  `).all(lecturerId);
}

export function detectConflicts({ lecturerId, venueId, day, start, end, excludeEntryId }) {
  const db = getDb();
  const conflicts = [];
  const rows = db.prepare(`
    SELECT * FROM timetable_entries
    WHERE status = 'published' AND day_of_week = ? AND id != ?
  `).all(day, excludeEntryId || '');

  for (const row of rows) {
    if (!overlaps(start, end, row.start_time, row.end_time)) continue;
    if (row.lecturer_id === lecturerId) {
      conflicts.push({ type: 'lecturer_overlap', entry: row });
    }
    if (row.venue_id === venueId) {
      conflicts.push({ type: 'venue_conflict', entry: row });
    }
  }
  return conflicts;
}

export function proposeChange(lecturerId, {
  entryId,
  proposedDay,
  proposedStart,
  proposedEnd,
  proposedVenueId,
  reason,
}) {
  const entry = getEntry(entryId);
  if (!entry) throw Object.assign(new Error('Timetable entry not found'), { status: 404 });
  if (entry.lecturer_id !== lecturerId) {
    throw Object.assign(new Error('Not authorized for this allocation'), { status: 403 });
  }

  const day = proposedDay || entry.day_of_week;
  const start = proposedStart || entry.start_time;
  const end = proposedEnd || entry.end_time;
  const venueId = proposedVenueId || entry.venue_id;

  if (timeToMinutes(end) <= timeToMinutes(start)) {
    throw Object.assign(new Error('End time must be after start time'), { status: 400 });
  }

  const conflicts = detectConflicts({
    lecturerId,
    venueId,
    day,
    start,
    end,
    excludeEntryId: entryId,
  });

  const id = uid();
  const ts = nowIso();
  getDb().prepare(`
    INSERT INTO schedule_changes (
      id, entry_id, lecturer_id, proposed_day, proposed_start, proposed_end,
      proposed_venue_id, reason, status, affected_groups_json, conflict_json,
      created_at, updated_at, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    entryId,
    lecturerId,
    day,
    start,
    end,
    venueId,
    reason || null,
    conflicts.length ? 'draft' : 'draft',
    JSON.stringify([entry.student_group]),
    JSON.stringify(conflicts),
    ts,
    ts
  );

  audit(lecturerId, 'schedule.propose', id, { entryId, conflicts: conflicts.length });
  return getChange(id);
}

export function getChange(id) {
  return getDb().prepare('SELECT * FROM schedule_changes WHERE id = ?').get(id);
}

export function listChanges({ lecturerId, status } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM schedule_changes WHERE 1=1';
  const params = [];
  if (lecturerId) {
    sql += ' AND lecturer_id = ?';
    params.push(lecturerId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

export function submitForApproval(changeId, lecturerId) {
  const change = getChange(changeId);
  if (!change) throw Object.assign(new Error('Change not found'), { status: 404 });
  if (change.lecturer_id !== lecturerId) {
    throw Object.assign(new Error('Not authorized'), { status: 403 });
  }
  if (!['draft', 'rejected'].includes(change.status)) {
    throw Object.assign(new Error(`Cannot submit from status ${change.status}`), { status: 400 });
  }
  const conflicts = JSON.parse(change.conflict_json || '[]');
  if (conflicts.length) {
    throw Object.assign(new Error('Resolve conflicts before submitting'), {
      status: 400,
      conflicts,
    });
  }
  getDb().prepare(`
    UPDATE schedule_changes SET status = 'pending_approval', updated_at = ? WHERE id = ?
  `).run(nowIso(), changeId);
  audit(lecturerId, 'schedule.submit', changeId, {});
  return getChange(changeId);
}

/**
 * Demo mode: lecturers with explicit demo flag may publish directly
 * when permissions allow (X-Veritas-Demo-Publish: true).
 */
export function publishChange(changeId, actorId, { allowDirectPublish = false } = {}) {
  const change = getChange(changeId);
  if (!change) throw Object.assign(new Error('Change not found'), { status: 404 });

  const canPublish =
    change.status === 'approved' ||
    (allowDirectPublish && ['draft', 'pending_approval', 'approved'].includes(change.status));

  if (!canPublish) {
    throw Object.assign(new Error(`Cannot publish from status ${change.status}`), { status: 400 });
  }

  const conflicts = detectConflicts({
    lecturerId: change.lecturer_id,
    venueId: change.proposed_venue_id,
    day: change.proposed_day,
    start: change.proposed_start,
    end: change.proposed_end,
    excludeEntryId: change.entry_id,
  });
  if (conflicts.length) {
    throw Object.assign(new Error('Conflicts detected at publish time'), {
      status: 409,
      conflicts,
    });
  }

  const entry = getEntry(change.entry_id);
  const ts = nowIso();
  const db = getDb();

  const tx = db.transaction(() => {
    const oldSnapshot = { ...entry };

    db.prepare(`
      UPDATE timetable_entries SET
        day_of_week = ?, start_time = ?, end_time = ?, venue_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      change.proposed_day,
      change.proposed_start,
      change.proposed_end,
      change.proposed_venue_id,
      ts,
      change.entry_id
    );

    db.prepare(`
      UPDATE schedule_changes SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?
    `).run(ts, ts, changeId);

    const announcementId = uid();
    const title = `[DEMO] Class change: ${entry.unit_code}`;
    const body = [
      `Unit ${entry.unit_code} (${entry.unit_name}) schedule updated.`,
      `Previous: ${oldSnapshot.day_of_week} ${oldSnapshot.start_time}–${oldSnapshot.end_time} @ ${oldSnapshot.venue_name}`,
      `New: ${change.proposed_day} ${change.proposed_start}–${change.proposed_end}`,
      change.reason ? `Reason: ${change.reason}` : '',
      `Published at ${ts}`,
      'This is a demonstration notification — not an official registry notice.',
    ].filter(Boolean).join('\n');

    db.prepare(`
      INSERT INTO announcements (id, title, body, audience, unit_code, change_id, created_at, effective_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(announcementId, title, body, entry.student_group, entry.unit_code, changeId, ts, ts);

    const notifId = uid();
    db.prepare(`
      INSERT INTO notifications (id, user_id, student_group, title, body, kind, read, meta_json, created_at)
      VALUES (?, NULL, ?, ?, ?, 'schedule_change', 0, ?, ?)
    `).run(
      notifId,
      entry.student_group,
      title,
      body,
      JSON.stringify({
        changeId,
        unit_code: entry.unit_code,
        previous: {
          day: oldSnapshot.day_of_week,
          start: oldSnapshot.start_time,
          end: oldSnapshot.end_time,
          venue: oldSnapshot.venue_name,
        },
        next: {
          day: change.proposed_day,
          start: change.proposed_start,
          end: change.proposed_end,
          venue_id: change.proposed_venue_id,
        },
        published_at: ts,
      }),
      ts
    );

    audit(actorId, 'schedule.publish', changeId, { entryId: change.entry_id });
  });

  tx();
  return { change: getChange(changeId), entry: getEntry(change.entry_id) };
}

export function rejectChange(changeId, actorId, reason) {
  const change = getChange(changeId);
  if (!change) throw Object.assign(new Error('Change not found'), { status: 404 });
  if (!['pending_approval', 'draft'].includes(change.status)) {
    throw Object.assign(new Error(`Cannot reject from ${change.status}`), { status: 400 });
  }
  getDb().prepare(`
    UPDATE schedule_changes SET status = 'rejected', reason = COALESCE(?, reason), updated_at = ? WHERE id = ?
  `).run(reason || null, nowIso(), changeId);
  audit(actorId, 'schedule.reject', changeId, { reason });
  return getChange(changeId);
}

export function cancelChange(changeId, lecturerId) {
  const change = getChange(changeId);
  if (!change) throw Object.assign(new Error('Change not found'), { status: 404 });
  if (change.lecturer_id !== lecturerId) {
    throw Object.assign(new Error('Not authorized'), { status: 403 });
  }
  if (change.status === 'published') {
    throw Object.assign(new Error('Cannot cancel a published change'), { status: 400 });
  }
  getDb().prepare(`
    UPDATE schedule_changes SET status = 'cancelled', updated_at = ? WHERE id = ?
  `).run(nowIso(), changeId);
  return getChange(changeId);
}

export function listAnnouncements({ audience, studentGroup } = {}) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50').all();
  return rows.filter((a) => {
    if (a.audience === 'all' || a.audience === 'public') return true;
    if (studentGroup && a.audience === studentGroup) return true;
    if (audience && a.audience === audience) return true;
    return !studentGroup; // staff see all in demo
  });
}

export function listNotifications({ userId, studentGroup } = {}) {
  const db = getDb();
  if (studentGroup) {
    return db.prepare(`
      SELECT * FROM notifications
      WHERE student_group = ? OR user_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(studentGroup, userId || '');
  }
  if (userId) {
    return db.prepare(`
      SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).all(userId);
  }
  return db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
}

export function markNotificationRead(id) {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
}

export function timetableAsContext(entries) {
  if (!entries?.length) return 'No published timetable rows for this scope. (DEMO data may be empty.)';
  return entries.map((e) =>
    `${e.unit_code} ${e.unit_name} | ${e.day_of_week} ${e.start_time}-${e.end_time} | Venue: ${e.venue_name} | Group: ${e.student_group} | Lecturer: ${e.lecturer_id} | Status: ${e.status} | Updated: ${e.updated_at}`
  ).join('\n');
}

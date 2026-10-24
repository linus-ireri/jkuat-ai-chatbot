/**
 * Seed labelled demonstration timetable and institutional sample records.
 * All data is explicitly DEMO — not official JKUAT records.
 */
import {
  getDb,
  nowIso,
  uid,
} from './db.js';

export function resetDemoData() {
  const db = getDb();
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM announcements').run();
  db.prepare('DELETE FROM schedule_changes').run();
  db.prepare('DELETE FROM timetable_entries').run();
  db.prepare('DELETE FROM lecturer_allocations').run();
  db.prepare('DELETE FROM venues').run();
  db.prepare('DELETE FROM units').run();
  return { cleared: true };
}

export function seedDemoData() {
  const db = getDb();

  const hasUnits = db.prepare('SELECT 1 FROM units LIMIT 1').get();
  if (hasUnits) return { seeded: false, reason: 'demo data already present' };

  const units = [
    { code: 'ICS2405', name: 'Knowledge Based Systems', department: 'Computing' },
    { code: 'ICS2400', name: 'Operating Systems', department: 'Computing' },
    { code: 'SMA2170', name: 'Discrete Mathematics', department: 'Mathematics' },
  ];
  const venues = [
    { id: 'v-lab1', name: 'SCC Lab 1', capacity: 40 },
    { id: 'v-lt2', name: 'Lecture Theatre 2', capacity: 120 },
    { id: 'v-hallA', name: 'Hall A', capacity: 80 },
  ];

  const insertUnit = db.prepare('INSERT INTO units (code, name, department) VALUES (@code, @name, @department)');
  const insertVenue = db.prepare('INSERT INTO venues (id, name, capacity) VALUES (@id, @name, @capacity)');
  for (const u of units) insertUnit.run(u);
  for (const v of venues) insertVenue.run(v);

  db.prepare(`
    INSERT INTO lecturer_allocations (id, lecturer_id, unit_code, student_group)
    VALUES (?, ?, ?, ?)
  `).run(uid(), 'demo-lecturer', 'ICS2405', 'MCS-Y2');
  db.prepare(`
    INSERT INTO lecturer_allocations (id, lecturer_id, unit_code, student_group)
    VALUES (?, ?, ?, ?)
  `).run(uid(), 'demo-lecturer', 'ICS2400', 'MCS-Y2');

  const ts = nowIso();
  const entries = [
    {
      id: 'tt-ics2405-mon',
      unit_code: 'ICS2405',
      lecturer_id: 'demo-lecturer',
      student_group: 'MCS-Y2',
      day_of_week: 'Monday',
      start_time: '08:00',
      end_time: '10:00',
      venue_id: 'v-lab1',
    },
    {
      id: 'tt-ics2400-wed',
      unit_code: 'ICS2400',
      lecturer_id: 'demo-lecturer',
      student_group: 'MCS-Y2',
      day_of_week: 'Wednesday',
      start_time: '10:00',
      end_time: '12:00',
      venue_id: 'v-lt2',
    },
    {
      id: 'tt-sma2170-fri',
      unit_code: 'SMA2170',
      lecturer_id: 'other-lecturer',
      student_group: 'MCS-Y2',
      day_of_week: 'Friday',
      start_time: '14:00',
      end_time: '16:00',
      venue_id: 'v-hallA',
    },
  ];

  const insertEntry = db.prepare(`
    INSERT INTO timetable_entries (
      id, unit_code, lecturer_id, student_group, day_of_week,
      start_time, end_time, venue_id, week_label, status, updated_at
    ) VALUES (
      @id, @unit_code, @lecturer_id, @student_group, @day_of_week,
      @start_time, @end_time, @venue_id, 'DEMO WEEK', 'published', @updated_at
    )
  `);

  for (const e of entries) insertEntry.run({ ...e, updated_at: ts });

  db.prepare(`
    INSERT INTO announcements (id, title, body, audience, unit_code, change_id, created_at, effective_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    uid(),
    '[DEMO] Semester orientation reminder',
    'This is a labelled demonstration announcement. Check the Academic Registry for official notices.',
    'all',
    null,
    ts,
    ts
  );

  return { seeded: true, entries: entries.length };
}

// Data layer: SQLite storage plus every task operation.
// All business rules live here (not in the HTTP layer) so that the web API today
// and the Telegram bot later call exactly the same functions and log the same events.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { randomBytes } = require('node:crypto');

const RECUR = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const uid = () => Date.now().toString(36) + randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      due TEXT,
      importance INTEGER NOT NULL DEFAULT 2,
      recur_type TEXT NOT NULL DEFAULT 'none',
      recur_every INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      snooze_count INTEGER NOT NULL DEFAULT 0,
      reminded_for TEXT,
      reminded_at TEXT,
      ignored_logged INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      task_id TEXT,
      title TEXT,
      importance INTEGER,
      due TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
    CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks(status, due);
  `);

  const COLS = ['id', 'title', 'notes', 'due', 'importance', 'recur_type', 'recur_every', 'status', 'created_at',
    'completed_at', 'snooze_count', 'reminded_for', 'reminded_at', 'ignored_logged'];
  const q = {
    get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    all: db.prepare('SELECT * FROM tasks'),
    put: db.prepare(`INSERT OR REPLACE INTO tasks (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`),
    del: db.prepare('DELETE FROM tasks WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM tasks'),
    addEvent: db.prepare('INSERT INTO events (at, type, source, task_id, title, importance, due, data) VALUES (?,?,?,?,?,?,?,?)'),
    recentEvents: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
    allEvents: db.prepare('SELECT * FROM events ORDER BY id'),
    eventCount: db.prepare('SELECT COUNT(*) AS n FROM events'),
    clearEvents: db.prepare('DELETE FROM events'),
    openDue: db.prepare("SELECT * FROM tasks WHERE status = 'open' AND due IS NOT NULL AND due <= ?")
  };

  const put = (r) => q.put.run(...COLS.map(c => r[c]));
  const row = (id) => {
    const r = q.get.get(id);
    if (!r) throw new HttpError(404, 'Task not found');
    return r;
  };
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---- shapes sent to clients ----
  const taskOut = (r) => ({
    id: r.id, title: r.title, notes: r.notes, due: r.due, importance: r.importance,
    recur: { type: r.recur_type, every: r.recur_every }, status: r.status,
    createdAt: r.created_at, completedAt: r.completed_at, snoozeCount: r.snooze_count, remindedAt: r.reminded_at
  });
  const eventOut = (e) => ({
    id: e.id, at: e.at, type: e.type, source: e.source, taskId: e.task_id, title: e.title,
    importance: e.importance, due: e.due, ...JSON.parse(e.data)
  });

  // ---- event log: every interaction, from every channel ----
  function log(type, source, r, data = {}) {
    q.addEvent.run(nowIso(), type, source, r?.id ?? null, r?.title ?? null, r?.importance ?? null, r?.due ?? null, JSON.stringify(data));
  }

  // ---- undo: remember the rows an action touched, so it can be put back ----
  const undos = new Map();
  function remember(label, before, created = []) {
    const token = randomBytes(9).toString('base64url');
    undos.set(token, { label, before, created });
    if (undos.size > 30) undos.delete(undos.keys().next().value);
    return token;
  }
  function undo(token, source) {
    const u = undos.get(token);
    if (!u) throw new HttpError(410, 'Nothing to undo');
    undos.delete(token);
    tx(() => {
      u.created.forEach(id => q.del.run(id));
      u.before.forEach(put);
      log('action_undone', source, u.before[0] ?? null, { action: u.label });
    });
  }

  // ---- validation ----
  function clean(input, base) {
    const f = { ...base };
    if (input.title !== undefined) {
      if (typeof input.title !== 'string' || !input.title.trim()) throw new HttpError(400, 'Title is required');
      f.title = input.title.trim().slice(0, 500);
    }
    if (input.notes !== undefined) f.notes = String(input.notes ?? '').trim().slice(0, 10000);
    if (input.due !== undefined) f.due = cleanDue(input.due);
    if (input.importance !== undefined) {
      if (![1, 2, 3, 4].includes(input.importance)) throw new HttpError(400, 'Importance must be 1-4');
      f.importance = input.importance;
    }
    if (input.recur !== undefined) {
      const type = input.recur?.type, every = Number(input.recur?.every ?? 1);
      if (!RECUR.includes(type)) throw new HttpError(400, 'Unknown repeat type');
      if (!Number.isInteger(every) || every < 1 || every > 365) throw new HttpError(400, 'Repeat interval must be 1-365');
      f.recur_type = type; f.recur_every = every;
    }
    if (f.title === undefined) throw new HttpError(400, 'Title is required');
    if (f.recur_type !== 'none' && !f.due) f.due = nowIso(); // a repeating task needs an anchor date
    return f;
  }
  function cleanDue(v) {
    if (v === null || v === '') return null;
    const d = new Date(v);
    if (typeof v !== 'string' || isNaN(d)) throw new HttpError(400, 'Invalid due date');
    return d.toISOString();
  }

  // ---- dates (local-time maths uses the server's TZ setting) ----
  function tomorrowAt(iso) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const o = iso ? new Date(iso) : null;
    d.setHours(o ? o.getHours() : 9, o ? o.getMinutes() : 0, 0, 0);
    return d.toISOString();
  }
  function nextOccurrence(r) {
    const d = new Date(r.due || Date.now()), n = Math.max(1, r.recur_every);
    const step = () => {
      if (r.recur_type === 'daily') d.setDate(d.getDate() + n);
      else if (r.recur_type === 'weekly') d.setDate(d.getDate() + 7 * n);
      else if (r.recur_type === 'monthly') d.setMonth(d.getMonth() + n);
      else do { d.setDate(d.getDate() + 1); } while ([0, 6].includes(d.getDay()));
    };
    step();
    while (d < new Date()) step(); // skip occurrences that are already in the past
    return d.toISOString();
  }

  // ---- task operations ----
  function insert(f) {
    const r = {
      id: uid(), title: f.title, notes: f.notes ?? '', due: f.due ?? null, importance: f.importance ?? 2,
      recur_type: f.recur_type ?? 'none', recur_every: f.recur_every ?? 1, status: 'open', created_at: nowIso(),
      completed_at: null, snooze_count: 0, reminded_for: null, reminded_at: null, ignored_logged: 0
    };
    put(r);
    return r;
  }
  const clearReminder = (r) => { r.reminded_for = null; r.reminded_at = null; r.ignored_logged = 0; };

  const DEFAULTS = { notes: '', due: null, importance: 2, recur_type: 'none', recur_every: 1 };
  function create(input, source) {
    return tx(() => {
      const r = insert(clean(input, DEFAULTS));
      log('task_created', source, r, { recur: r.recur_type });
      return remember('create', [], [r.id]);
    });
  }
  function update(id, input, source) {
    return tx(() => {
      const before = row(id), r = clean(input, before);
      if (r.importance !== before.importance) log('importance_changed', source, r, { from: before.importance, to: r.importance });
      if (r.due !== before.due) clearReminder(r);
      put(r);
      log('task_edited', source, r, {
        before: { title: before.title, notes: before.notes, due: before.due, importance: before.importance, recur: before.recur_type + before.recur_every }
      });
      return remember('edit', [before]);
    });
  }
  function complete(id, source) {
    return tx(() => {
      const before = row(id), r = { ...before }, now = new Date();
      if (r.status !== 'open') throw new HttpError(409, 'Task is already done');
      log('task_completed', source, r, {
        minutesVsDue: r.due ? Math.round((now - new Date(r.due)) / 60000) : null, // negative = early, positive = late
        snoozeCount: r.snooze_count, afterReminder: !!r.reminded_at
      });
      const created = [];
      if (r.recur_type !== 'none') {
        const next = insert({ ...r, due: nextOccurrence(r) });
        log('task_created', source, next, { recur: next.recur_type, recurringFrom: r.id });
        created.push(next.id);
      }
      r.status = 'done'; r.completed_at = now.toISOString();
      put(r);
      return remember('complete', [before], created);
    });
  }
  function reopen(id, source) {
    return tx(() => {
      const before = row(id), r = { ...before, status: 'open', completed_at: null };
      put(r);
      log('task_reopened', source, r);
      return remember('reopen', [before]);
    });
  }
  function snooze(id, kind, source) {
    if (!['1h', 'tomorrow'].includes(kind)) throw new HttpError(400, 'Unknown snooze kind');
    return tx(() => {
      const before = row(id), r = { ...before };
      r.due = kind === '1h' ? new Date(Date.now() + 3600e3).toISOString() : tomorrowAt(before.due);
      r.snooze_count++; clearReminder(r);
      put(r);
      log('task_snoozed', source, r, { kind, from: before.due, to: r.due, afterReminder: !!before.reminded_at });
      return remember('snooze', [before]);
    });
  }
  function reschedule(id, due, source) {
    return tx(() => {
      const before = row(id), r = { ...before, due: cleanDue(due) };
      if (!r.due) throw new HttpError(400, 'A new due date is required');
      clearReminder(r);
      put(r);
      log('task_rescheduled', source, r, { from: before.due, to: r.due, afterReminder: !!before.reminded_at });
      return remember('reschedule', [before]);
    });
  }
  function remove(id, source) {
    return tx(() => {
      const before = row(id);
      q.del.run(id);
      log('task_deleted', source, before);
      return remember('delete', [before]);
    });
  }

  // ---- reminders: called on a timer by reminders.js ----
  // Returns the tasks that just became due so the caller can notify (Telegram/push later).
  function collectDue() {
    return tx(() => {
      const now = Date.now(), fresh = [];
      for (const r of q.openDue.all(new Date(now).toISOString())) {
        if (r.reminded_for !== r.due) {
          r.reminded_for = r.due; r.reminded_at = nowIso(); r.ignored_logged = 0;
          put(r); fresh.push(taskOut(r));
        } else if (r.reminded_at && !r.ignored_logged && now - new Date(r.reminded_at) > 3600e3) {
          r.ignored_logged = 1; put(r);
          log('reminder_ignored', 'system', r, { remindedAt: r.reminded_at });
        }
      }
      return fresh;
    });
  }
  const logReminder = (task, channels) =>
    log('reminder_due', 'system', task, { channels: channels.join(',') || 'none' });

  // ---- reads & bulk ----
  const state = () => ({
    tasks: q.all.all().map(taskOut),
    events: q.recentEvents.all(500).map(eventOut),
    eventCount: q.eventCount.get().n
  });
  const allEvents = () => q.allEvents.all().map(eventOut);
  function clearEvents(source) {
    tx(() => { q.clearEvents.run(); log('log_cleared', source, null); });
  }
  // One-time migration of tasks created while the app was browser-only.
  function importLocal(data, source) {
    return tx(() => {
      if (q.count.get().n > 0) throw new HttpError(409, 'Server already has tasks');
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const t of tasks) {
        const r = insert(clean({ title: t.title, notes: t.notes ?? '', due: t.due ?? null, importance: t.importance ?? 2, recur: t.recur ?? { type: 'none', every: 1 } }, DEFAULTS));
        if (t.status === 'done') { r.status = 'done'; r.completed_at = cleanDue(t.completedAt) || nowIso(); }
        r.snooze_count = Number.isInteger(t.snoozeCount) ? t.snoozeCount : 0;
        put(r);
      }
      for (const e of Array.isArray(data?.events) ? data.events : []) {
        const { id, at, type, taskId, title, importance, due, ...rest } = e;
        if (typeof type !== 'string' || isNaN(new Date(at))) continue;
        q.addEvent.run(new Date(at).toISOString(), type.slice(0, 60), 'import', null, title ?? null,
          Number.isInteger(importance) ? importance : null, typeof due === 'string' ? due : null, JSON.stringify(rest));
      }
      log('data_imported', source, null, { tasks: tasks.length });
      return tasks.length;
    });
  }

  return {
    create, update, complete, reopen, snooze, reschedule, remove, undo,
    collectDue, logReminder, state, allEvents, clearEvents, importLocal,
    close: () => db.close()
  };
}

module.exports = { openStore, HttpError };

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
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      sub TEXT UNIQUE,            -- Google's stable account id ('password' for the optional password login)
      email TEXT UNIQUE COLLATE NOCASE,
      name TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      due TEXT,                   -- deadline: when it must be done (drives reminders)
      planned TEXT,               -- when it happens / is planned to be done; independent of due
      planned_time INTEGER NOT NULL DEFAULT 0, -- 1 if planned includes a clock time, 0 if date only
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
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      task_id TEXT,
      title TEXT,
      importance INTEGER,
      due TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    );
  `);
  // Databases created before accounts existed have no user_id; add it. Their rows stay unowned
  // until the first user signs in, who then adopts them (see upsertUser).
  for (const t of ['tasks', 'events']) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'user_id'))
      db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  }
  for (const [col, ddl] of [['planned', 'planned TEXT'], ['planned_time', 'planned_time INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  }
  db.exec(`
    DROP INDEX IF EXISTS tasks_open_due;
    CREATE INDEX IF NOT EXISTS tasks_user_status_due ON tasks(user_id, status, due);
    CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks(status, due);
    CREATE INDEX IF NOT EXISTS events_user ON events(user_id, id);
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
  `);

  const COLS = ['id', 'user_id', 'title', 'notes', 'due', 'planned', 'planned_time', 'importance', 'recur_type', 'recur_every', 'status', 'created_at',
    'completed_at', 'snooze_count', 'reminded_for', 'reminded_at', 'ignored_logged'];
  const q = {
    get: db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?'),
    all: db.prepare('SELECT * FROM tasks WHERE user_id = ?'),
    put: db.prepare(`INSERT OR REPLACE INTO tasks (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`),
    del: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?'),
    addEvent: db.prepare('INSERT INTO events (user_id, at, type, source, task_id, title, importance, due, data) VALUES (?,?,?,?,?,?,?,?,?)'),
    recentEvents: db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    allEvents: db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id'),
    eventCount: db.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?'),
    clearEvents: db.prepare('DELETE FROM events WHERE user_id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userBySub: db.prepare('SELECT * FROM users WHERE sub = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    addUser: db.prepare('INSERT INTO users (id, sub, email, name, created_at, last_login_at) VALUES (?,?,?,?,?,?)'),
    touchUser: db.prepare('UPDATE users SET sub = ?, email = ?, name = ?, last_login_at = ? WHERE id = ?'),
    adoptTasks: db.prepare('UPDATE tasks SET user_id = ? WHERE user_id IS NULL'),
    adoptEvents: db.prepare('UPDATE events SET user_id = ? WHERE user_id IS NULL'),
    openDue: db.prepare("SELECT * FROM tasks WHERE status = 'open' AND due IS NOT NULL AND due <= ?")
  };

  const put = (r) => q.put.run(...COLS.map(c => r[c]));
  // Every read and write of a task goes through the owner's id, so one account can never reach another's rows.
  const row = (userId, id) => {
    const r = q.get.get(id, userId);
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
    id: r.id, title: r.title, notes: r.notes, due: r.due, planned: r.planned, plannedTime: !!r.planned_time, importance: r.importance,
    recur: { type: r.recur_type, every: r.recur_every }, status: r.status,
    createdAt: r.created_at, completedAt: r.completed_at, snoozeCount: r.snooze_count, remindedAt: r.reminded_at
  });
  const eventOut = (e) => ({
    id: e.id, at: e.at, type: e.type, source: e.source, taskId: e.task_id, title: e.title,
    importance: e.importance, due: e.due, ...JSON.parse(e.data)
  });

  // ---- event log: every interaction, from every channel ----
  function log(userId, type, source, r, data = {}) {
    q.addEvent.run(userId, nowIso(), type, source, r?.id ?? null, r?.title ?? null, r?.importance ?? null, r?.due ?? null, JSON.stringify(data));
  }

  // ---- undo: remember the rows an action touched, so it can be put back ----
  const undos = new Map();
  function remember(userId, label, before, created = []) {
    const token = randomBytes(9).toString('base64url');
    undos.set(token, { userId, label, before, created });
    if (undos.size > 30) undos.delete(undos.keys().next().value);
    return token;
  }
  function undo(userId, token, source) {
    const u = undos.get(token);
    if (!u || u.userId !== userId) throw new HttpError(410, 'Nothing to undo');
    undos.delete(token);
    tx(() => {
      u.created.forEach(id => q.del.run(id, userId));
      u.before.forEach(put);
      log(userId, 'action_undone', source, u.before[0] ?? null, { action: u.label });
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
    if (input.planned !== undefined) {
      f.planned = cleanDue(input.planned, 'planned');
      if (!f.planned) f.planned_time = 0;
    }
    if (input.plannedTime !== undefined) f.planned_time = input.plannedTime && f.planned ? 1 : 0;
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
    if (f.recur_type !== 'none' && !f.due && !f.planned) f.due = nowIso(); // a repeating task needs an anchor date
    return f;
  }
  function cleanDue(v, what = 'due') {
    if (v === null || v === '') return null;
    const d = new Date(v);
    if (typeof v !== 'string' || isNaN(d)) throw new HttpError(400, `Invalid ${what} date`);
    return d.toISOString();
  }

  // ---- dates (local-time maths uses the server's TZ setting) ----
  function tomorrowAt(iso) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const o = iso ? new Date(iso) : null;
    d.setHours(o ? o.getHours() : 9, o ? o.getMinutes() : 0, 0, 0);
    return d.toISOString();
  }
  // Next occurrence of a repeating task. due and planned (whichever exist) move together by the same
  // number of repeats; the first of them to be set decides how many are needed to land in the future.
  function nextOccurrence(r) {
    const n = Math.max(1, r.recur_every);
    const step = (d) => {
      if (r.recur_type === 'daily') d.setDate(d.getDate() + n);
      else if (r.recur_type === 'weekly') d.setDate(d.getDate() + 7 * n);
      else if (r.recur_type === 'monthly') d.setMonth(d.getMonth() + n);
      else do { d.setDate(d.getDate() + 1); } while ([0, 6].includes(d.getDay()));
    };
    const advance = (iso, k) => { const d = new Date(iso); for (let i = 0; i < k; i++) step(d); return d.toISOString(); };
    const base = new Date(r.due || r.planned || Date.now());
    let k = 1; step(base);
    while (base < new Date()) { step(base); k++; } // skip occurrences that are already in the past
    return {
      due: r.due ? advance(r.due, k) : null,
      planned: r.planned ? advance(r.planned, k) : null
    };
  }

  // ---- task operations ----
  function insert(userId, f) {
    const r = {
      id: uid(), user_id: userId, title: f.title, notes: f.notes ?? '', due: f.due ?? null,
      planned: f.planned ?? null, planned_time: f.planned ? (f.planned_time ? 1 : 0) : 0, importance: f.importance ?? 2,
      recur_type: f.recur_type ?? 'none', recur_every: f.recur_every ?? 1, status: 'open', created_at: nowIso(),
      completed_at: null, snooze_count: 0, reminded_for: null, reminded_at: null, ignored_logged: 0
    };
    put(r);
    return r;
  }
  const clearReminder = (r) => { r.reminded_for = null; r.reminded_at = null; r.ignored_logged = 0; };

  const DEFAULTS = { notes: '', due: null, planned: null, planned_time: 0, importance: 2, recur_type: 'none', recur_every: 1 };
  function create(userId, input, source) {
    return tx(() => {
      const r = insert(userId, clean(input, DEFAULTS));
      log(userId, 'task_created', source, r, { recur: r.recur_type });
      return remember(userId, 'create', [], [r.id]);
    });
  }
  function update(userId, id, input, source) {
    return tx(() => {
      const before = row(userId, id), r = clean(input, before);
      if (r.importance !== before.importance) log(userId, 'importance_changed', source, r, { from: before.importance, to: r.importance });
      if (r.due !== before.due) clearReminder(r);
      put(r);
      log(userId, 'task_edited', source, r, {
        before: { title: before.title, notes: before.notes, due: before.due, planned: before.planned, importance: before.importance, recur: before.recur_type + before.recur_every }
      });
      return remember(userId, 'edit', [before]);
    });
  }
  function complete(userId, id, source) {
    return tx(() => {
      const before = row(userId, id), r = { ...before }, now = new Date();
      if (r.status !== 'open') throw new HttpError(409, 'Task is already done');
      log(userId, 'task_completed', source, r, {
        minutesVsDue: r.due ? Math.round((now - new Date(r.due)) / 60000) : null, // negative = early, positive = late
        snoozeCount: r.snooze_count, afterReminder: !!r.reminded_at
      });
      const created = [];
      if (r.recur_type !== 'none') {
        const next = insert(userId, { ...r, ...nextOccurrence(r) });
        log(userId, 'task_created', source, next, { recur: next.recur_type, recurringFrom: r.id });
        created.push(next.id);
      }
      r.status = 'done'; r.completed_at = now.toISOString();
      put(r);
      return remember(userId, 'complete', [before], created);
    });
  }
  function reopen(userId, id, source) {
    return tx(() => {
      const before = row(userId, id), r = { ...before, status: 'open', completed_at: null };
      put(r);
      log(userId, 'task_reopened', source, r);
      return remember(userId, 'reopen', [before]);
    });
  }
  function snooze(userId, id, kind, source) {
    if (!['1h', 'tomorrow'].includes(kind)) throw new HttpError(400, 'Unknown snooze kind');
    return tx(() => {
      const before = row(userId, id), r = { ...before };
      r.due = kind === '1h' ? new Date(Date.now() + 3600e3).toISOString() : tomorrowAt(before.due);
      r.snooze_count++; clearReminder(r);
      put(r);
      log(userId, 'task_snoozed', source, r, { kind, from: before.due, to: r.due, afterReminder: !!before.reminded_at });
      return remember(userId, 'snooze', [before]);
    });
  }
  // Moves the deadline (default) or the planned date. A planned move keeps whether it has a clock time
  // unless `plannedTime` is given.
  function reschedule(userId, id, date, source, which = 'due', plannedTime) {
    if (!['due', 'planned'].includes(which)) throw new HttpError(400, 'Unknown date to change');
    return tx(() => {
      const before = row(userId, id), r = { ...before }, iso = cleanDue(date, which);
      if (!iso) throw new HttpError(400, `A new ${which} date is required`);
      if (which === 'due') { r.due = iso; clearReminder(r); }
      else { r.planned = iso; if (plannedTime !== undefined) r.planned_time = plannedTime ? 1 : 0; }
      put(r);
      log(userId, 'task_rescheduled', source, r, { which, from: before[which], to: iso, afterReminder: !!before.reminded_at });
      return remember(userId, 'reschedule', [before]);
    });
  }
  function remove(userId, id, source) {
    return tx(() => {
      const before = row(userId, id);
      q.del.run(id, userId);
      log(userId, 'task_deleted', source, before);
      return remember(userId, 'delete', [before]);
    });
  }

  // ---- reminders: called on a timer by reminders.js ----
  // Covers every user's tasks. Returns the tasks that just became due (each carries its userId)
  // so the caller can notify the right person (Telegram/push later).
  function collectDue() {
    return tx(() => {
      const now = Date.now(), fresh = [];
      for (const r of q.openDue.all(new Date(now).toISOString())) {
        if (r.reminded_for !== r.due) {
          r.reminded_for = r.due; r.reminded_at = nowIso(); r.ignored_logged = 0;
          put(r); fresh.push({ ...taskOut(r), userId: r.user_id });
        } else if (r.reminded_at && !r.ignored_logged && now - new Date(r.reminded_at) > 3600e3) {
          r.ignored_logged = 1; put(r);
          log(r.user_id, 'reminder_ignored', 'system', r, { remindedAt: r.reminded_at });
        }
      }
      return fresh;
    });
  }
  const logReminder = (task, channels) =>
    log(task.userId, 'reminder_due', 'system', task, { channels: channels.join(',') || 'none' });

  // ---- reads & bulk ----
  const state = (userId) => ({
    tasks: q.all.all(userId).map(taskOut),
    events: q.recentEvents.all(userId, 500).map(eventOut),
    eventCount: q.eventCount.get(userId).n
  });
  const allEvents = (userId) => q.allEvents.all(userId).map(eventOut);
  function clearEvents(userId, source) {
    tx(() => { q.clearEvents.run(userId); log(userId, 'log_cleared', source, null); });
  }
  // One-time migration of tasks created while the app was browser-only.
  function importLocal(userId, data, source) {
    return tx(() => {
      if (q.count.get(userId).n > 0) throw new HttpError(409, 'Server already has tasks');
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const t of tasks) {
        const r = insert(userId, clean({ title: t.title, notes: t.notes ?? '', due: t.due ?? null, planned: t.planned ?? null, plannedTime: !!t.plannedTime, importance: t.importance ?? 2, recur: t.recur ?? { type: 'none', every: 1 } }, DEFAULTS));
        if (t.status === 'done') { r.status = 'done'; r.completed_at = cleanDue(t.completedAt) || nowIso(); }
        r.snooze_count = Number.isInteger(t.snoozeCount) ? t.snoozeCount : 0;
        put(r);
      }
      for (const e of Array.isArray(data?.events) ? data.events : []) {
        const { id, at, type, taskId, title, importance, due, ...rest } = e;
        if (typeof type !== 'string' || isNaN(new Date(at))) continue;
        q.addEvent.run(userId, new Date(at).toISOString(), type.slice(0, 60), 'import', null, title ?? null,
          Number.isInteger(importance) ? importance : null, typeof due === 'string' ? due : null, JSON.stringify(rest));
      }
      log(userId, 'data_imported', source, null, { tasks: tasks.length });
      return tasks.length;
    });
  }

  // ---- accounts ----
  // Find or create the user for a verified sign-in. Matches by the provider's stable id first,
  // then by email (so an account created from an email can be linked to its Google id later).
  // The first user ever created adopts any rows from before accounts existed.
  function upsertUser({ sub, email, name }) {
    return tx(() => {
      const now = nowIso();
      email = email ? String(email).toLowerCase() : null;
      let u = (sub && q.userBySub.get(sub)) || (email && q.userByEmail.get(email)) || null;
      if (u) {
        q.touchUser.run(sub ?? u.sub, email ?? u.email, name ?? u.name, now, u.id);
      } else {
        u = { id: uid() };
        const first = q.userCount.get().n === 0;
        q.addUser.run(u.id, sub ?? null, email, name ?? null, now, now);
        if (first) { q.adoptTasks.run(u.id); q.adoptEvents.run(u.id); }
      }
      return userOut(q.userById.get(u.id));
    });
  }
  const userOut = (u) => u ? { id: u.id, sub: u.sub, email: u.email, name: u.name } : null;
  const getUser = (id) => userOut(q.userById.get(id));

  return {
    upsertUser, getUser,
    create, update, complete, reopen, snooze, reschedule, remove, undo,
    collectDue, logReminder, state, allEvents, clearEvents, importLocal,
    close: () => db.close()
  };
}

module.exports = { openStore, HttpError };

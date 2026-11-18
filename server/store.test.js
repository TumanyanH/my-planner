'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openStore } = require('./store');

const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
// Most tests act as a single signed-in user, so bind the store to one user.
function bind(store, userId) {
  const bound = { ...store };
  for (const k of ['create', 'update', 'complete', 'reopen', 'snooze', 'reschedule', 'remove', 'undo', 'state', 'allEvents', 'clearEvents', 'importLocal'])
    bound[k] = (...args) => store[k](userId, ...args);
  return bound;
}
const user = (store, n) => store.upsertUser({ sub: `sub-${n}`, email: `${n}@example.com`, name: n });
const fresh = () => { const raw = openStore(':memory:'); return bind(raw, user(raw, 'alice').id); };
const only = (s) => s.state().tasks[0];
const types = (s) => s.state().events.map(e => e.type).reverse();

test('create validates input and logs', () => {
  const s = fresh();
  assert.throws(() => s.create({ title: '  ' }, 'web'), /Title/);
  assert.throws(() => s.create({ title: 'x', importance: 9 }, 'web'), /Importance/);
  assert.throws(() => s.create({ title: 'x', due: 'nonsense' }, 'web'), /due/);
  s.create({ title: ' Pay rent ', importance: 4, due: hours(2) }, 'web');
  assert.equal(only(s).title, 'Pay rent');
  assert.deepEqual(types(s), ['task_created']);
});

test('completing a repeating task schedules the next one in the future', () => {
  const s = fresh();
  s.create({ title: 'Gym', due: hours(-50), recur: { type: 'daily', every: 1 } }, 'web');
  const first = only(s);
  s.complete(first.id, 'web');
  const tasks = s.state().tasks;
  assert.equal(tasks.length, 2);
  const next = tasks.find(t => t.id !== first.id);
  assert.equal(next.status, 'open');
  assert.ok(new Date(next.due) > new Date(), 'next occurrence is not in the past');
  const done = s.state().events.find(e => e.type === 'task_completed');
  assert.ok(done.minutesVsDue > 2900, 'lateness is recorded');
  assert.throws(() => s.complete(first.id, 'web'), /already done/);
});

test('undo puts everything back, including the spawned occurrence', () => {
  const s = fresh();
  s.create({ title: 'Gym', due: hours(1), recur: { type: 'weekly', every: 2 } }, 'web');
  const before = only(s);
  const token = s.complete(before.id, 'web');
  s.undo(token, 'web');
  assert.deepEqual(s.state().tasks, [before]);
  assert.equal(types(s).at(-1), 'action_undone');
  assert.throws(() => s.undo(token, 'web'), /Nothing to undo/);

  const del = s.remove(before.id, 'web');
  assert.equal(s.state().tasks.length, 0);
  s.undo(del, 'web');
  assert.deepEqual(s.state().tasks, [before]);
});

test('snooze, reschedule and edit', () => {
  const s = fresh();
  s.create({ title: 'Call', due: hours(-1), importance: 2 }, 'web');
  const id = only(s).id;
  s.snooze(id, '1h', 'web');
  assert.ok(Math.abs(new Date(only(s).due) - Date.now() - 3600e3) < 5000);
  assert.equal(only(s).snoozeCount, 1);
  s.snooze(id, 'tomorrow', 'web');
  assert.ok(new Date(only(s).due) - Date.now() > 3600e3);
  const when = hours(72);
  s.reschedule(id, when, 'web');
  assert.equal(only(s).due, when);
  s.update(id, { importance: 4, title: 'Call bank' }, 'web');
  assert.equal(only(s).importance, 4);
  assert.equal(only(s).due, when, 'fields not sent are left alone');
  assert.ok(types(s).includes('importance_changed'));
  assert.throws(() => s.update('missing', { title: 'x' }, 'web'), /not found/);
});

test('reminders fire once per due date', () => {
  const s = fresh();
  s.create({ title: 'Late', due: hours(-1) }, 'web');
  s.create({ title: 'Later', due: hours(5) }, 'web');
  const due = s.collectDue();
  assert.deepEqual(due.map(t => t.title), ['Late']);
  s.logReminder(due[0], []);
  assert.equal(s.collectDue().length, 0, 'not reminded twice');
  s.snooze(due[0].id, '1h', 'web');
  assert.equal(s.collectDue().length, 0, 'snoozed task is no longer due');
  assert.ok(types(s).includes('reminder_due'));
});

test('import only into an empty server', () => {
  const s = fresh();
  const n = s.importLocal({
    tasks: [{ title: 'Old', importance: 3, due: null, recur: { type: 'none', every: 1 }, status: 'done', completedAt: hours(-3) }, { title: 'Bare' }],
    events: [{ at: hours(-4), type: 'task_created', title: 'Old' }, { type: 'broken' }]
  }, 'web');
  assert.equal(n, 2);
  assert.equal(s.state().tasks.find(t => t.title === 'Old').status, 'done');
  assert.equal(s.state().tasks.find(t => t.title === 'Bare').importance, 2);
  assert.throws(() => s.importLocal({ tasks: [{ title: 'Again' }] }, 'web'), /already has tasks/);
});

test('accounts never see or touch each other\'s data', () => {
  const raw = openStore(':memory:');
  const a = user(raw, 'alice'), b = user(raw, 'bob');
  raw.create(a.id, { title: 'Alice secret', due: hours(-1) }, 'web');
  const aliceTask = raw.state(a.id).tasks[0];

  assert.deepEqual(raw.state(b.id).tasks, []);
  assert.deepEqual(raw.state(b.id).events, []);
  assert.equal(raw.state(b.id).eventCount, 0);
  assert.deepEqual(raw.allEvents(b.id), []);

  for (const fn of [
    () => raw.update(b.id, aliceTask.id, { title: 'hacked' }, 'web'),
    () => raw.complete(b.id, aliceTask.id, 'web'),
    () => raw.reopen(b.id, aliceTask.id, 'web'),
    () => raw.snooze(b.id, aliceTask.id, '1h', 'web'),
    () => raw.reschedule(b.id, aliceTask.id, hours(5), 'web'),
    () => raw.remove(b.id, aliceTask.id, 'web')
  ]) assert.throws(fn, /not found/);
  assert.equal(raw.state(a.id).tasks[0].title, 'Alice secret');

  // Bob's undo token is useless to Alice and vice versa.
  const token = raw.create(b.id, { title: 'Bob task' }, 'web');
  assert.throws(() => raw.undo(a.id, token, 'web'), /Nothing to undo/);
  raw.undo(b.id, token, 'web');
  assert.deepEqual(raw.state(b.id).tasks, []);

  // Clearing one user's log leaves the other's alone.
  raw.create(b.id, { title: 'Bob task' }, 'web');
  raw.clearEvents(b.id, 'web');
  assert.ok(raw.state(a.id).eventCount > 0);

  // Each user can import into their own empty account.
  assert.equal(raw.importLocal(user(raw, 'carol').id, { tasks: [{ title: 'c' }] }, 'web'), 1);
});

test('reminders go to the owner of each task', () => {
  const raw = openStore(':memory:');
  const a = user(raw, 'alice'), b = user(raw, 'bob');
  raw.create(a.id, { title: 'A late', due: hours(-1) }, 'web');
  raw.create(b.id, { title: 'B late', due: hours(-1) }, 'web');
  const due = raw.collectDue();
  assert.equal(due.length, 2);
  assert.equal(due.find(t => t.title === 'A late').userId, a.id);
  due.forEach(t => raw.logReminder(t, []));
  assert.deepEqual(raw.state(a.id).events.filter(e => e.type === 'reminder_due').map(e => e.title), ['A late']);
  assert.deepEqual(raw.state(b.id).events.filter(e => e.type === 'reminder_due').map(e => e.title), ['B late']);
});

test('users: stable by Google id, email matched case-insensitively, first user adopts old data', () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'planner-')), 'old.db');
  // A database from before accounts existed: no users table, no user_id columns.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due TEXT,
    importance INTEGER NOT NULL DEFAULT 2, recur_type TEXT NOT NULL DEFAULT 'none', recur_every INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, completed_at TEXT, snooze_count INTEGER NOT NULL DEFAULT 0,
    reminded_for TEXT, reminded_at TEXT, ignored_logged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL,
    task_id TEXT, title TEXT, importance INTEGER, due TEXT, data TEXT NOT NULL DEFAULT '{}');
    INSERT INTO tasks (id, title, created_at) VALUES ('t1', 'Legacy task', '2026-01-01T00:00:00Z');
    INSERT INTO events (at, type, source, title) VALUES ('2026-01-01T00:00:00Z', 'task_created', 'web', 'Legacy task');`);
  old.close();

  const s = openStore(file);
  const alice = s.upsertUser({ sub: 'g-1', email: 'Alice@Example.com', name: 'Alice' });
  assert.equal(s.state(alice.id).tasks[0].title, 'Legacy task');
  assert.equal(s.state(alice.id).eventCount, 1);
  const bob = s.upsertUser({ sub: 'g-2', email: 'bob@example.com', name: 'Bob' });
  assert.deepEqual(s.state(bob.id).tasks, [], 'later users do not inherit old data');
  assert.equal(s.upsertUser({ sub: 'g-1', email: 'alice@example.com', name: 'Alice B' }).id, alice.id);
  assert.equal(s.upsertUser({ sub: 'g-1b', email: 'ALICE@example.com' }).id, alice.id, 'same email, same account');
  assert.equal(s.getUser(alice.id).email, 'alice@example.com');
  assert.equal(s.getUser('nobody'), null);
});

test('planned and due are independent and both optional', () => {
  const s = fresh();
  s.create({ title: 'Only planned', planned: hours(30), plannedTime: true }, 'web');
  s.create({ title: 'Only due', due: hours(30) }, 'web');
  s.create({ title: 'Both', planned: hours(30), due: hours(60) }, 'web');
  s.create({ title: 'Neither' }, 'web');
  const t = Object.fromEntries(s.state().tasks.map(x => [x.title, x]));
  assert.ok(t['Only planned'].planned && !t['Only planned'].due && t['Only planned'].plannedTime);
  assert.ok(!t['Only due'].planned && t['Only due'].due && !t['Only due'].plannedTime);
  assert.ok(t.Both.planned && t.Both.due);
  assert.ok(!t.Neither.planned && !t.Neither.due);
  assert.throws(() => s.create({ title: 'x', planned: 'nonsense' }, 'web'), /planned/);
  s.update(t.Both.id, { planned: null }, 'web');
  assert.equal(s.state().tasks.find(x => x.id === t.Both.id).planned, null);
  assert.ok(s.state().tasks.find(x => x.id === t.Both.id).due, 'due is untouched');
});

test('a planned-only task gets no reminder, and reschedule can move the planned date', () => {
  const raw = openStore(':memory:'), s = bind(raw, user(raw, 'bob').id);
  s.create({ title: 'Dentist', planned: hours(-1), plannedTime: true }, 'web');
  assert.equal(raw.collectDue().length, 0);
  const id = only(s).id, when = hours(5);
  s.reschedule(id, when, 'web', 'planned', false);
  assert.equal(only(s).planned, when);
  assert.equal(only(s).due, null);
  assert.equal(only(s).plannedTime, false);
});

test('repeating a planned-only task moves its planned date', () => {
  const s = fresh();
  s.create({ title: 'Class', planned: hours(-50), plannedTime: true, recur: { type: 'daily', every: 1 } }, 'web');
  const first = only(s);
  s.complete(first.id, 'web');
  const next = s.state().tasks.find(t => t.id !== first.id);
  assert.ok(new Date(next.planned) > new Date());
  assert.equal(next.due, null);
});

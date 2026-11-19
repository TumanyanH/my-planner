'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('./parse');

const now = new Date(2026, 10, 18, 10, 0); // Wed 18 Nov 2026, 10:00 local
const p = (s) => parse(s, { now });
const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

test('a date and time in the title is the planned date; due stays empty', () => {
  assert.deepEqual(p('Dentist friday 3pm'), { title: 'Dentist', planned: at(2026, 11, 20, 15), plannedTime: true, due: null });
  assert.deepEqual(p('Call mom at 17:30'), { title: 'Call mom', planned: at(2026, 11, 18, 17, 30), plannedTime: true, due: null });
});
test('date only is planned without a time', () => {
  const r = p('Pay rent nov 25');
  assert.equal(r.planned, at(2026, 11, 25)); assert.equal(r.plannedTime, false); assert.equal(r.due, null);
});
test('by / due marks a deadline, planned stays empty', () => {
  assert.deepEqual(p('Send report by friday 5pm'), { title: 'Send report', planned: null, plannedTime: false, due: at(2026, 11, 20, 17) });
  assert.equal(p('Tax return due 2026-12-01').due, at(2026, 12, 1));
});
test('both at once', () => {
  const r = p('Dinner with Sam tomorrow 7pm due monday');
  assert.equal(r.title, 'Dinner with Sam');
  assert.equal(r.planned, at(2026, 11, 19, 19)); assert.equal(r.due, at(2026, 11, 23));
});
test('relative, past times and next-week weekdays', () => {
  assert.equal(p('Gym in 2 hours').planned, new Date(now.getTime() + 2 * 3600e3).toISOString());
  assert.equal(p('Stretch 8am').planned, at(2026, 11, 19, 8), 'a time already past today means tomorrow');
  assert.equal(p('Review next friday').planned, at(2026, 11, 27));
  assert.equal(p('Plan jan 5').planned, at(2027, 1, 5), 'a past month/day rolls to next year');
});
test('ordinary titles are left alone', () => {
  for (const s of ['Buy 2 pizzas', 'Buy sun cream', 'Read chapter 12', 'tomorrow'])
    assert.deepEqual(p(s), { title: s, planned: null, plannedTime: false, due: null });
});

test('a time range is removed from the title and starts at the first time', () => {
  const r = parse('Meeting 3pm-4pm', { now: new Date(2026, 10, 19, 10, 0) });
  assert.equal(r.title, 'Meeting');
  assert.equal(new Date(r.planned).getHours(), 15);
  assert.equal(r.plannedTime, true);
});

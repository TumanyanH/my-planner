// Title analysis: finds a date/time phrase inside a task title and turns it into a
// planned date (when the thing happens) or a due date (the deadline), removing it from the title.
//   "Dentist friday 3pm"          -> planned Fri 15:00, due empty
//   "Send report by friday 5pm"   -> due Fri 17:00,     planned empty
//   "Dinner with Sam tomorrow 7pm due monday" -> both
// Runs in the browser (global PlannerParse) and in Node (module.exports) so it can be tested.
// All maths is in the local timezone of whoever runs it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlannerParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const SHORT_DAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthIndex = (s) => MONTHS.findIndex(m => m.startsWith(s.slice(0, 3).toLowerCase()));

  // Words that mark the phrase after them as a deadline.
  const DUE_WORD = '(due|by|before|until|till|deadline)';
  const LEAD = `(?:${DUE_WORD}:?\\s+(?:(?:on|at)\\s+)?|(?:on|at|@)\\s+)?`;
  const END = '(?![\\w:])';
  const B = '(?<![\\w:/.-])';

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  // Each rule: regex (with LEAD first) + a resolver returning { kind, ... } given the match and "today".
  const RULES = [
    // --- times ---
    { re: new RegExp(`${B}${LEAD}(noon|midday|midnight)${END}`, 'i'),
      fn: (m) => ({ kind: 'time', h: /midnight/i.test(m[2]) ? 0 : 12, min: 0 }) },
    { re: new RegExp(`${B}${LEAD}(\\d{1,2})(?::(\\d{2}))?\\s?(am|pm|a\\.m\\.|p\\.m\\.)(?:\\s?[-\u2013]\\s?\\d{1,2}(?::\\d{2})?\\s?(?:am|pm|a\\.m\\.|p\\.m\\.))?${END}`, 'i'),
      fn: (m) => {
        let h = +m[2]; const min = +(m[3] || 0), pm = /^p/i.test(m[4]);
        if (h < 1 || h > 12 || min > 59) return null;
        if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0;
        return { kind: 'time', h, min };
      } },
    { re: new RegExp(`${B}${LEAD}([01]?\\d|2[0-3]):([0-5]\\d)${END}`, 'i'),
      fn: (m) => ({ kind: 'time', h: +m[2], min: +m[3] }) },
    // --- relative: "in 2 hours", "in 3 days" ---
    { re: new RegExp(`${B}()in\\s+(\\d{1,3})\\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)${END}`, 'i'),
      fn: (m, now) => {
        const n = +m[2], u = m[3].toLowerCase();
        if (u.startsWith('m')) return { kind: 'moment', date: new Date(now.getTime() + n * 60e3) };
        if (u.startsWith('h')) return { kind: 'moment', date: new Date(now.getTime() + n * 3600e3) };
        return { kind: 'date', date: addDays(startOfDay(now), u.startsWith('w') ? 7 * n : n) };
      } },
    // --- dates ---
    { re: new RegExp(`${B}${LEAD}(today|tomorrow|tmrw|tonight|yesterday)${END}`, 'i'),
      fn: (m, now) => {
        const w = m[2].toLowerCase(), d = startOfDay(now);
        if (w === 'tomorrow' || w === 'tmrw') d.setDate(d.getDate() + 1);
        if (w === 'yesterday') d.setDate(d.getDate() - 1);
        return { kind: 'date', date: d, defaultTime: w === 'tonight' ? [20, 0] : null };
      } },
    { re: new RegExp(`${B}${LEAD}(?:(next|this)\\s+)?(${DAYS.join('|')})${END}`, 'i'),
      fn: (m, now) => ({ kind: 'date', date: weekday(now, DAYS.indexOf(m[3].toLowerCase()), m[2]) }) },
    { re: new RegExp(`${B}${LEAD}(?:(next|this|on)\\s+)(${Object.keys(SHORT_DAYS).join('|')})\\.?${END}`, 'i'),
      fn: (m, now) => ({ kind: 'date', date: weekday(now, SHORT_DAYS[m[3].toLowerCase()], m[2]) }) },
    { re: new RegExp(`${B}${LEAD}(\\d{4})-(\\d{2})-(\\d{2})${END}`),
      fn: (m) => { const d = new Date(+m[2], +m[3] - 1, +m[4]); return d.getMonth() === +m[3] - 1 ? { kind: 'date', date: d } : null; } },
    { re: new RegExp(`${B}${LEAD}${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${END}`, 'i'),
      fn: (m, now) => monthDay(now, monthIndex(m[2]), +m[3], m[4]) },
    { re: new RegExp(`${B}${LEAD}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?(?:,?\\s+(\\d{4}))?${END}`, 'i'),
      fn: (m, now) => monthDay(now, monthIndex(m[3]), +m[2], m[4]) },
    { re: new RegExp(`${B}${LEAD}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})?${END}`),
      fn: (m, now) => monthDay(now, +m[3] - 1, +m[2], m[4]) }
  ];

  // "friday" = the next Friday from today (today counts); "next friday" = Friday of the following week.
  function weekday(now, target, qual) {
    const today = startOfDay(now);
    if ((qual || '').toLowerCase() === 'next') {
      const monday = addDays(today, ((8 - today.getDay()) % 7) || 7); // the coming Monday
      return addDays(monday, (target + 6) % 7);
    }
    return addDays(today, (target - today.getDay() + 7) % 7);
  }
  function monthDay(now, month, day, year) {
    if (month < 0 || day < 1 || day > 31) return null;
    const today = startOfDay(now);
    let y = year ? +year : today.getFullYear(), d = new Date(y, month, day);
    if (d.getMonth() !== month) return null; // e.g. 31 Feb
    if (!year && d < today) d = new Date(y + 1, month, day);
    return { kind: 'date', date: d };
  }

  // Find every phrase, drop overlaps (earliest, then longest, wins).
  function scan(text, now) {
    const found = [];
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags + 'g');
      let m;
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        const r = rule.fn(m, now);
        if (r) found.push({ ...r, start: m.index, end: m.index + m[0].length, due: !!(m[1] && new RegExp(`^${DUE_WORD}$`, 'i').test(m[1])) });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const f of found) if (!kept.length || f.start >= kept[kept.length - 1].end) kept.push(f);
    return kept;
  }

  const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s+([,;.!?])/g, '$1').replace(/^[\s,;:.\-–—]+|[\s,;:\-–—]+$/g, '')
    .replace(/(?:\s+(?:on|at|by|due|before|until|till|for|from))+$/i, '').trim();

  // parse(text, { now }) -> { title, planned, plannedTime, due }
  //   planned: ISO string or null; plannedTime: true when the phrase included a clock time
  //   due: ISO string or null
  function parse(text, opts = {}) {
    const now = opts.now ? new Date(opts.now) : new Date();
    const src = String(text ?? '');
    const found = scan(src, now);
    const out = { title: tidy(src), planned: null, plannedTime: false, due: null };
    if (!found.length) { out.title = src.trim(); return out; }

    // A bare time next to a date belongs to that date, so "by friday 5pm" is all deadline.
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      if (f.kind !== 'time' || f.due) continue;
      const near = (a, b) => /^[\s,@]*(?:at\s*)?$/i.test(src.slice(a.end, b.start));
      const prev = found[i - 1], next = found[i + 1];
      if (prev && prev.kind === 'date' && near(prev, f)) f.due = prev.due;
      else if (next && next.kind === 'date' && near(f, next)) f.due = next.due;
    }

    const groups = { planned: [], due: [] };
    for (const f of found) groups[f.due ? 'due' : 'planned'].push(f);

    const build = (list, dateOnlyHour) => {
      if (!list.length) return null;
      const moment = list.find(f => f.kind === 'moment'), date = list.find(f => f.kind === 'date'), time = list.find(f => f.kind === 'time');
      if (moment) return { d: moment.date, hasTime: true };
      let d, hasTime = false;
      if (date) {
        d = new Date(date.date);
        const t = time ? [time.h, time.min] : date.defaultTime;
        if (t) { d.setHours(t[0], t[1], 0, 0); hasTime = true; } else d.setHours(dateOnlyHour, 0, 0, 0);
      } else {
        d = new Date(now); d.setHours(time.h, time.min, 0, 0); hasTime = true;
        if (d <= now) d.setDate(d.getDate() + 1); // a time that already passed means tomorrow
      }
      return { d, hasTime };
    };
    const p = build(groups.planned, 9), du = build(groups.due, 9);
    if (p) { out.planned = p.d.toISOString(); out.plannedTime = p.hasTime; }
    if (du) out.due = du.d.toISOString();

    let title = '', pos = 0;
    for (const f of found) { title += src.slice(pos, f.start) + ' '; pos = f.end; }
    title += src.slice(pos);
    out.title = tidy(title);
    // Never leave a task with an empty title: if the whole text was a date, keep it as typed.
    if (!out.title) return { title: src.trim(), planned: null, plannedTime: false, due: null };
    return out;
  }

  return { parse };
});

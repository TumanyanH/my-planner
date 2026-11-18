// Planner web client. The server owns the data and the rules; this file renders
// the state it returns and sends actions back.
(() => {
'use strict';

let state = { tasks: [], events: [], eventCount: 0 };
// Device-local preferences (General settings).
const SETTINGS_KEY = 'planner.settings';
function loadSettings() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) {}
  return {
    startView: ['dashboard', 'today', 'upcoming', 'all'].includes(v.startView) ? v.startView : 'today',
    importance: [1, 2, 3, 4].includes(+v.importance) ? +v.importance : 2
  };
}
let settings = loadSettings();
let view = settings.startView;
let query = '';
let editingId = null;
let reschedId = null, reschedWhich = 'due';
let offline = false;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byId = (id) => state.tasks.find(t => t.id === id);

// ---------- server ----------
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(method, path, body) {
  if (body === undefined && (method === 'POST' || method === 'PATCH')) body = {};
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) { throw new ApiError(0, 'Can’t reach the server'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login')) { showLogin(); throw new ApiError(401, 'Sign in required'); }
  if (!res.ok) throw new ApiError(res.status, data.error || 'Something went wrong');
  return data;
}
const fail = (e) => { if (e.status !== 401) toast(e.message); };

// Sends one action; the server answers with the new state and an undo token.
async function act(msg, method, path, body) {
  try {
    const r = await api(method, path, body);
    state = r.state; render();
    toast(msg, r.undo && (async () => {
      try { state = (await api('POST', '/undo/' + r.undo)).state; render(); toast('Undone'); } catch (e) { fail(e); }
    }));
    return true;
  } catch (e) { fail(e); return false; }
}

async function refresh() {
  try {
    state = await api('GET', '/state');
    offline = false; render();
    return true;
  } catch (e) {
    if (e.status === 0 && !offline) { offline = true; toast('Offline — can’t reach the server'); }
    else if (e.status !== 0) fail(e);
    return false;
  }
}

// ---------- sign in ----------
let loginCfg;
async function showLogin() {
  const d = $('#loginDlg');
  if (d.open) return;
  $('#loginErr').hidden = true;
  d.showModal();
  try {
    loginCfg = loginCfg || await api('GET', '/config');
  } catch (e) { return loginError(e.message); }
  setupGoogle(loginCfg.google);
}
function loginError(msg) { $('#loginErr').textContent = msg; $('#loginErr').hidden = false; }

let gsiLoading;
function setupGoogle(clientId) {
  gsiLoading = gsiLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = resolve; s.onerror = () => { gsiLoading = null; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(s);
  });
  gsiLoading.then(() => {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: async (r) => {
        try { await api('POST', '/login/google', { credential: r.credential }); $('#loginDlg').close(); boot(); }
        catch (err) { loginError(err.message); }
      }
    });
    const box = $('#googleBtn');
    box.replaceChildren();
    google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 260 });
  }).catch((e) => loginError(e.message));
}

$('#loginDlg').addEventListener('cancel', (e) => e.preventDefault());

// Tasks made before there was a server live in this browser's storage; move them over once.
async function importLocal() {
  let local;
  try { local = JSON.parse(localStorage.getItem('planner.v1')); } catch (e) { return; }
  if (!local?.tasks?.length || state.tasks.length) return;
  try {
    const r = await api('POST', '/import', { tasks: local.tasks, events: local.events || [] });
    state = r.state; render();
    try { localStorage.setItem('planner.v1.imported', localStorage.getItem('planner.v1')); localStorage.removeItem('planner.v1'); } catch (e) {}
    toast(`Moved ${r.imported} task${r.imported === 1 ? '' : 's'} from this device to the server`);
  } catch (e) { fail(e); }
}
async function boot() {
  if (await refresh()) { importLocal(); loadProfile(); }
}

// ---------- profile ----------
let me = null;
async function loadProfile() {
  try { me = await api('GET', '/me'); } catch (e) { return; }
  const b = $('#profileBtn');
  b.textContent = (me.email || 'P')[0].toUpperCase();
  b.title = me.email || 'Profile';
}
async function signOut() {
  try { await api('POST', '/logout'); } catch (err) { return fail(err); }
  $('#profileDlg').close(); me = null;
  state = { tasks: [], events: [], eventCount: 0 }; render(); showLogin();
}
$('#profileBtn').onclick = () => {
  $('#profileEmail').value = me?.email || '';
  $('#profileDlg').showModal();
};
$('#profileClose').onclick = () => $('#profileDlg').close();
$('#signOutBtn').onclick = signOut;
$('#settingsBtn').onclick = () => {
  const f = $('#settingsForm');
  f.startView.value = settings.startView; f.importance.value = settings.importance;
  $('#profileDlg').close(); $('#settingsDlg').showModal();
};
$('#settingsCancel').onclick = () => $('#settingsDlg').close();
$('#settingsForm').addEventListener('submit', () => {
  const f = $('#settingsForm');
  settings = { startView: f.startView.value, importance: +f.importance.value };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  toast('Settings saved');
});

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, '0');
const toInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromInput = (v) => v ? new Date(v).toISOString() : null;
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function fmt(iso) {
  const d = new Date(iso), now = new Date(), tom = new Date(); tom.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `Today ${time(d)}`;
  if (d.toDateString() === tom.toDateString()) return `Tomorrow ${time(d)}`;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return `${d.toLocaleDateString([], opts)} ${time(d)}`;
}
const fmtDay = (iso) => {
  const d = new Date(iso), now = new Date(), tom = new Date(); tom.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === tom.toDateString()) return 'Tomorrow';
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
};
const fmtPlanned = (t) => t.plannedTime ? fmt(t.planned) : fmtDay(t.planned);
const toDateInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const toTimeInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Date (+ optional time) inputs -> { planned, plannedTime }. A date alone is stored at 09:00 and marked "no time".
function fromPlannedInputs(date, tm) {
  if (!date) return { planned: null, plannedTime: false };
  return { planned: new Date(`${date}T${tm || '09:00'}`).toISOString(), plannedTime: !!tm };
}
function rel(iso) {
  const diff = new Date(iso) - Date.now(), m = Math.round(Math.abs(diff) / 60000);
  if (m < 1) return 'now';
  const s = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return diff < 0 ? `${s} overdue` : `in ${s}`;
}
const UNIT = { daily: 'day', weekly: 'week', monthly: 'month' };
const recurLabel = (r) => r.type === 'none' ? '' : r.type === 'weekdays' ? 'weekdays' :
  +r.every > 1 ? `every ${r.every} ${UNIT[r.type]}s` : r.type;
const IMP = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Critical' };

// ---------- quick add parsing ----------
// Importance via a trailing "!1".."!4"; dates and times anywhere in the title (see parse.js):
// a plain date/time becomes the planned date, one after by/due/before/until becomes the due date.
function parseQuick(text) {
  const words = text.trim().split(/\s+/);
  let importance = settings.importance, m;
  while (words.length > 1 && (m = /^!([1-4])$/.exec(words[words.length - 1]))) { importance = +m[1]; words.pop(); }
  const p = PlannerParse.parse(words.join(' '));
  return { title: p.title, notes: '', planned: p.planned, plannedTime: p.plannedTime, due: p.due, importance, recur: { type: 'none', every: 1 } };
}

// ---------- toast ----------
let toastTimer = null, undoFn = null;
function toast(msg, undo = null) {
  $('#toastMsg').textContent = msg;
  undoFn = undo || null; $('#toastUndo').hidden = !undoFn;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; undoFn = null; }, 6000);
}
$('#toastUndo').onclick = () => { const fn = undoFn; undoFn = null; $('#toast').hidden = true; if (fn) fn(); };

// ---------- rendering ----------
const TABS = [
  ['dashboard', 'Dashboard', '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/>'],
  ['today', 'Today', '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4M12 15.5h.01"/>'],
  ['upcoming', 'Upcoming', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ['all', 'All', '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'],
  ['done', 'Done', '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>'],
  ['log', 'Activity', '<path d="M3 12h4l3-8 4 16 3-8h4"/>']
];
// A task has up to two dates. due = deadline (drives reminders); planned = when it happens.
// A planned date without a time counts until the end of that day.
const plannedEnd = (t) => { if (!t.planned) return null; const d = new Date(t.planned); if (!t.plannedTime) d.setHours(23, 59, 59, 999); return d; };
const hasDate = (t) => !!(t.due || t.planned);
// Overdue once the deadline passes; with no deadline, once the planned moment has passed.
const isOverdue = (t, now = new Date()) => t.due ? new Date(t.due) <= now : !!t.planned && plannedEnd(t) <= now;
// Where the task sits in time: the earliest of its dates that is still ahead (else the last one it had).
function place(t, now = new Date()) {
  const ds = [t.due && new Date(t.due), plannedEnd(t) && { ref: new Date(t.planned), end: plannedEnd(t) }].filter(Boolean)
    .map(x => x.ref ? { ts: +x.ref, end: +x.end } : { ts: +x, end: +x });
  if (!ds.length) return null;
  const ahead = ds.filter(x => x.end > now).sort((a, b) => a.ts - b.ts)[0];
  return new Date((ahead || ds.sort((a, b) => b.ts - a.ts)[0]).ts);
}
const dueTs = (t) => hasDate(t) ? +place(t) : Infinity;
const byImportance = (a, b) => (b.importance - a.importance) || (dueTs(a) - dueTs(b));
const byDue = (a, b) => (dueTs(a) - dueTs(b)) || (b.importance - a.importance);
const empty = (head, sub = '') => `<p class="empty"><b>${head}</b>${sub}</p>`;
const cards = (ts) => ts.map(cardHTML).join('');

function cardHTML(t) {
  const open = t.status === 'open';
  const late = open && isOverdue(t);
  const rec = recurLabel(t.recur);
  return `<article class="card i${t.importance} ${open ? '' : 'done'}" data-id="${t.id}">
    <button class="check" data-a="${open ? 'done' : 'reopen'}" aria-label="${open ? 'Mark done' : 'Reopen'}" title="${open ? 'Mark done' : 'Reopen'}">✓</button>
    <div class="body">
      <div class="tap" data-a="edit" role="button" tabindex="0" aria-label="Edit ${esc(t.title)}">
        <div class="title">${esc(t.title)}</div>
        <div class="meta">
          <span class="pill">${IMP[t.importance]}</span>
          ${t.planned ? `<span class="${late && !t.due ? 'late' : ''}">📅 ${fmtPlanned(t)}</span>` : ''}
          ${t.due ? `<span class="${late ? 'late' : ''}">Due ${fmt(t.due)}${open ? ` · ${rel(t.due)}` : ''}</span>` : ''}
          ${hasDate(t) ? '' : '<span>No date</span>'}
          ${rec ? `<span>↻ ${esc(rec)}</span>` : ''}
          ${t.snoozeCount ? `<span>snoozed ${t.snoozeCount}×</span>` : ''}
          ${!open && t.completedAt ? `<span>completed ${fmt(t.completedAt)}</span>` : ''}
        </div>
        ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
      </div>
      ${open ? `<div class="btns">
        ${t.due ? `<button data-a="snooze1h">Snooze 1h</button>
        <button data-a="tomorrow">Tomorrow</button>` : ''}
        <button data-a="resched">Reschedule</button>
      </div>` : ''}
    </div>
  </article>`;
}

function logHTML() {
  const rows = state.events.map(e => {
    const { id, at, type, source, taskId, title, importance, due, ...rest } = e;
    const det = Object.entries(rest).filter(([, v]) => v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${/^\d{4}-\d\d-\d\dT/.test(v) ? fmt(v) : v}`).join(' · ');
    return `<div class="event"><span class="t when">${new Date(at).toLocaleString()}${source && source !== 'web' ? ` · ${esc(source)}` : ''}</span><span class="k">${esc(type.replace(/_/g, ' '))}</span><span>${esc(title || '')} ${det ? `<span class="t">${title ? '— ' : ''}${esc(det)}</span>` : ''}</span></div>`;
  }).join('');
  const n = state.eventCount;
  return `<div class="logbar"><span>${n} event${n === 1 ? '' : 's'}${n > state.events.length ? ` (latest ${state.events.length} shown)` : ''}</span>
    <span><button class="small" data-a="export">Export</button><button class="small" data-a="clearlog">Clear</button></span></div>` +
    (rows ? `<div class="log">${rows}</div>` : empty('No activity yet', 'Everything you do with a task is recorded here.'));
}

function render() {
  const now = new Date(), eod = endOfToday();
  const allOpen = state.tasks.filter(t => t.status === 'open');
  const overdueN = allOpen.filter(t => isOverdue(t, now)).length;
  const counts = {
    today: allOpen.filter(t => hasDate(t) && (isOverdue(t, now) || place(t, now) <= eod)).length,
    upcoming: allOpen.filter(t => hasDate(t) && !isOverdue(t, now) && place(t, now) > eod).length,
    all: allOpen.length
  };
  $('#tabs').innerHTML = TABS.map(([v, label, icon]) =>
    `<button data-view="${v}" class="${v === view ? 'active' : ''}"${v === view ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${label}${counts[v] ? `<span class="count ${v === 'today' && overdueN ? 'alert' : ''}">${counts[v] > 99 ? '99+' : counts[v]}</span>` : ''}</button>`).join('');
  document.title = overdueN ? `(${overdueN}) Planner` : 'Planner';

  const taskView = !['dashboard', 'log'].includes(view);
  $('#quick').hidden = $('#quickHint').hidden = !taskView || view === 'done';
  $('#search').hidden = !taskView;

  const q = query.toLowerCase();
  const match = (t) => !q || `${t.title} ${t.notes}`.toLowerCase().includes(q);
  const open = allOpen.filter(match);
  const none = q ? empty('No matches', `Nothing here matches “${esc(query)}”.`) : null;
  let html = '';

  if (view === 'dashboard') {
    html = empty('Dashboard', 'Coming soon.');
  } else if (view === 'today') {
    const overdue = open.filter(t => isOverdue(t, now)).sort(byImportance);
    const today = open.filter(t => hasDate(t) && !isOverdue(t, now) && place(t, now) <= eod).sort(byDue);
    if (overdue.length) html += `<h3 class="overdue">Overdue · ${overdue.length}</h3>${cards(overdue)}`;
    if (today.length) html += `<h3>Later today</h3>${cards(today)}`;
    html ||= none || empty('All clear', 'Nothing due today.');
  } else if (view === 'upcoming') {
    const groups = new Map();
    open.filter(t => hasDate(t) && !isOverdue(t, now) && place(t, now) > eod).sort(byDue).forEach(t => {
      const k = place(t, now).toDateString();
      groups.set(k, [...(groups.get(k) || []), t]);
    });
    for (const [k, ts] of groups)
      html += `<h3>${new Date(k).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h3>${cards(ts)}`;
    html ||= none || empty('Nothing upcoming', 'Tasks due after today show up here.');
  } else if (view === 'all') {
    const dated = open.filter(hasDate).sort(byImportance), undated = open.filter(t => !hasDate(t)).sort(byImportance);
    if (dated.length) html += `<h3>Scheduled</h3>${cards(dated)}`;
    if (undated.length) html += `<h3>No date</h3>${cards(undated)}`;
    html ||= none || empty('No open tasks', 'Add one above to get started.');
  } else if (view === 'done') {
    const d = state.tasks.filter(t => t.status === 'done' && match(t)).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    html = d.length ? `<h3>Completed · ${d.length}</h3>${cards(d)}` : none || empty('Nothing completed yet');
  } else if (view === 'log') {
    html = logHTML();
  }
  $('#list').innerHTML = html;
}

// ---------- interactions ----------
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) { view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }

  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const a = btn.dataset.a;
  if (a === 'export') { location.href = '/api/events.json'; return; }
  if (a === 'clearlog') {
    if (state.eventCount && confirm('Clear the whole activity log? This is what the agent learns from, and it cannot be undone.'))
      act('Activity log cleared', 'DELETE', '/events');
    return;
  }

  const t = byId(btn.closest('.card')?.dataset.id);
  if (!t) return;
  const path = `/tasks/${t.id}`;
  if (a === 'done') act(t.recur.type !== 'none' ? 'Done — next occurrence scheduled' : 'Marked done', 'POST', path + '/complete');
  else if (a === 'snooze1h') act('Snoozed for 1 hour', 'POST', path + '/snooze', { kind: '1h' });
  else if (a === 'tomorrow') act('Moved to tomorrow', 'POST', path + '/snooze', { kind: 'tomorrow' });
  else if (a === 'reopen') act('Reopened', 'POST', path + '/reopen');
  else if (a === 'edit') openEditor(t);
  else if (a === 'resched') {
    // A task with only a planned date reschedules that date; otherwise the deadline moves.
    reschedId = t.id; reschedWhich = !t.due && t.planned ? 'planned' : 'due';
    $('#reLabel').firstChild.textContent = reschedWhich === 'planned' ? 'New planned time ' : 'New due ';
    $('#reForm').due.value = toInput(t[reschedWhich] || new Date().toISOString()); $('#reDlg').showModal();
  }
});

$('#quick').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#quickInput'), text = inp.value;
  if (!text.trim()) return;
  const data = parseQuick(text);
  inp.value = '';
  const ok = await act(`Added “${data.title}”${data.planned ? ` · 📅 ${data.plannedTime ? fmt(data.planned) : fmtDay(data.planned)}` : ''}${data.due ? ` · due ${fmt(data.due)}` : ''}${data.importance !== 2 ? ` · ${IMP[data.importance]}` : ''}`, 'POST', '/tasks', data);
  if (!ok && !inp.value) inp.value = text;
});

$('#search').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });

function syncEvery() {
  const f = $('#taskForm');
  $('#everyLabel').hidden = ['none', 'weekdays'].includes(f.recur.value);
}
function openEditor(t) {
  editingId = t?.id ?? null;
  const f = $('#taskForm');
  $('#dlgTitle').textContent = t ? 'Edit task' : 'New task';
  f.title.value = t?.title ?? ''; f.notes.value = t?.notes ?? '';
  f.plannedDate.value = toDateInput(t?.planned); f.plannedTime.value = t?.plannedTime ? toTimeInput(t.planned) : '';
  f.due.value = toInput(t?.due); f.importance.value = t?.importance ?? 2;
  f.recur.value = t?.recur.type ?? 'none'; f.every.value = t?.recur.every ?? 1;
  syncEvery();
  $('#delBtn').hidden = !t;
  $('#taskDlg').showModal();
  // Only a new task focuses the title; editing shouldn't pop the phone keyboard.
  if (t) document.activeElement?.blur(); else f.title.focus();
}
$('#delBtn').onclick = () => {
  const id = editingId;
  $('#taskDlg').close();
  if (id) act('Task deleted', 'DELETE', `/tasks/${id}`);
};
$('#taskForm').recur.addEventListener('change', syncEvery);
$('#newBtn').onclick = () => openEditor(null);
$('#cancelBtn').onclick = () => $('#taskDlg').close();
$('#reCancel').onclick = () => $('#reDlg').close();

$('#taskForm').addEventListener('submit', () => {
  const f = $('#taskForm');
  const data = {
    title: f.title.value.trim(), notes: f.notes.value.trim(), due: fromInput(f.due.value),
    ...fromPlannedInputs(f.plannedDate.value, f.plannedTime.value),
    importance: +f.importance.value, recur: { type: f.recur.value, every: Math.max(1, +f.every.value || 1) }
  };
  if (!data.title) return;
  // Analyse the title: a date/time in it fills whichever date is still empty (new tasks, or when the title was edited).
  if (!editingId || data.title !== byId(editingId)?.title) {
    const p = PlannerParse.parse(data.title);
    if (p.planned || p.due) {
      let used = false;
      if (p.planned && !data.planned) { data.planned = p.planned; data.plannedTime = p.plannedTime; used = true; }
      if (p.due && !data.due) { data.due = p.due; used = true; }
      if (used) data.title = p.title;
    }
  }
  if (editingId) act('Changes saved', 'PATCH', `/tasks/${editingId}`, data);
  else act('Task added', 'POST', '/tasks', data);
});
$('#reForm').addEventListener('submit', () => {
  const v = $('#reForm').due.value;
  if (reschedId && v) act(`Rescheduled to ${fmt(fromInput(v))}`, 'POST', `/tasks/${reschedId}/reschedule`,
    reschedWhich === 'planned' ? { planned: fromInput(v), plannedTime: true } : { due: fromInput(v) });
});

// Keyboard: "n" quick add, "/" search (when not typing or in a dialog)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList?.contains('tap')) { e.target.click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (e.key === 'n') {
    e.preventDefault();
    if ($('#quick').hidden) { view = 'today'; render(); }
    $('#quickInput').focus();
  } else if (e.key === '/' && !$('#search').hidden) { e.preventDefault(); $('#search').focus(); }
});

// Stay in sync with changes made elsewhere (another device, later the Telegram bot).
setInterval(() => { if (!document.hidden && !$('#loginDlg').open) refresh(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#loginDlg').open) refresh(); });
render();
boot();
})();

// Planner server: serves the web app and a small JSON API. No dependencies beyond Node itself.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac, createHash, timingSafeEqual } = require('node:crypto');
const { openStore, HttpError } = require('./store');
const { startReminders } = require('./reminders');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.PLANNER_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const WEB_DIR = path.join(__dirname, '..', 'web');
const COOKIE = 'planner_session';
const SESSION_DAYS = 365;

if (PASSWORD.length < 8) {
  console.error('PLANNER_PASSWORD must be set (at least 8 characters). See README.md.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(path.join(DATA_DIR, 'planner.db'));
startReminders(store);

// ---------- auth: one user, one password, signed session cookie ----------
// The signing key is derived from the password, so changing the password signs everyone out.
const KEY = createHmac('sha256', PASSWORD).update('planner-session-v1').digest();
const sign = (v) => createHmac('sha256', KEY).update(v).digest('base64url');
const sha = (v) => createHash('sha256').update(String(v)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

function newSession() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}
function authed(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && !!sig && same(sig, sign(exp)) && Number(exp) > Date.now();
}
function cookie(req, value, maxAge) {
  const https = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}
// Brute-force guard: after 10 wrong passwords, logins are refused for 15 minutes.
const fails = { n: 0, until: 0 };
function login(req, res, body) {
  if (Date.now() < fails.until) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (typeof body.password !== 'string' || !same(body.password, PASSWORD)) {
    if (++fails.n >= 10) { fails.n = 0; fails.until = Date.now() + 15 * 60e3; }
    throw new HttpError(401, 'Wrong password');
  }
  fails.n = 0;
  res.setHeader('Set-Cookie', cookie(req, newSession(), SESSION_DAYS * 86400));
  return { ok: true };
}

// ---------- helpers ----------
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Send JSON'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(WEB_DIR + path.sep) || !TYPES[path.extname(file)]) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

// ---------- API ----------
// Every change answers with the fresh state plus an undo token, so the client needs one round trip.
const changed = (undo) => ({ state: store.state(), undo: undo || null });
const SRC = 'web';

async function api(req, res, route) {
  const m = req.method;
  if (route === '/health' && m === 'GET') return { ok: true };

  const body = ['POST', 'PATCH'].includes(m) ? await readJson(req, route === '/import' ? 8e6 : 1e5) : {};
  if (route === '/login' && m === 'POST') return login(req, res, body);
  if (!authed(req)) throw new HttpError(401, 'Sign in required');

  if (route === '/logout' && m === 'POST') { res.setHeader('Set-Cookie', cookie(req, '', 0)); return { ok: true }; }
  if (route === '/state' && m === 'GET') return store.state();
  if (route === '/events.json' && m === 'GET') {
    res.setHeader('Content-Disposition', 'attachment; filename="planner-events.json"');
    return store.allEvents();
  }
  if (route === '/events' && m === 'DELETE') { store.clearEvents(SRC); return changed(); }
  if (route === '/import' && m === 'POST') { const n = store.importLocal(body, SRC); return { ...changed(), imported: n }; }
  if (route === '/tasks' && m === 'POST') return changed(store.create(body, SRC));

  let p;
  if ((p = /^\/undo\/([\w-]+)$/.exec(route)) && m === 'POST') { store.undo(p[1], SRC); return changed(); }
  if ((p = /^\/tasks\/(\w+)$/.exec(route))) {
    if (m === 'PATCH') return changed(store.update(p[1], body, SRC));
    if (m === 'DELETE') return changed(store.remove(p[1], SRC));
  }
  if ((p = /^\/tasks\/(\w+)\/(complete|reopen|snooze|reschedule)$/.exec(route)) && m === 'POST') {
    const [, id, action] = p;
    if (action === 'complete') return changed(store.complete(id, SRC));
    if (action === 'reopen') return changed(store.reopen(id, SRC));
    if (action === 'snooze') return changed(store.snooze(id, body.kind, SRC));
    return changed(store.reschedule(id, body.due, SRC));
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    return serveStatic(req, res, pathname);
  }
  try {
    send(res, 200, await api(req, res, pathname.slice(4)));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Planner listening on http://${HOST}:${PORT}  (data: ${DATA_DIR}, timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { store.close(); process.exit(0); }); server.closeAllConnections?.(); });
}

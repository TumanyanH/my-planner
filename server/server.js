// Planner server: serves the web app and a small JSON API. No dependencies beyond Node itself.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac, createHash, createPublicKey, verify, randomBytes, timingSafeEqual } = require('node:crypto');
const { openStore, HttpError } = require('./store');
const { startReminders } = require('./reminders');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
// Accounts allowed to sign in with Google: ALLOWED_EMAILS, comma separated (ALLOWED_EMAIL still works).
const ALLOWED = new Set(`${process.env.ALLOWED_EMAILS || ''},${process.env.ALLOWED_EMAIL || ''}`
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const WEB_DIR = path.join(__dirname, '..', 'web');
const COOKIE = 'planner_session';
const SESSION_DAYS = 365;

const GOOGLE = !!GOOGLE_CLIENT_ID;
if (GOOGLE && !ALLOWED.size) {
  console.error('GOOGLE_CLIENT_ID is set but ALLOWED_EMAILS is not. List the Google accounts that may sign in, comma separated.');
  process.exit(1);
}
if (!GOOGLE) {
  console.error('Set GOOGLE_CLIENT_ID and ALLOWED_EMAILS in .env to enable Google sign-in. See README.md.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(path.join(DATA_DIR, 'planner.db'));
startReminders(store);

// ---------- auth: Google sign-in, signed session cookie ----------
// The signing key is a random secret kept in the data directory. Deleting data/session.key signs everyone out.
function loadSecret() {
  const file = path.join(DATA_DIR, 'session.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const KEY = createHmac('sha256', loadSecret()).update('planner-session-v1').digest();
const sign = (v) => createHmac('sha256', KEY).update(v).digest('base64url');
const sha = (v) => createHash('sha256').update(String(v)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

// Session value: base64url("<expiry ms>:<user id>") + "." + signature.
function newSession(userId) {
  const payload = Buffer.from(`${Date.now() + SESSION_DAYS * 864e5}:${userId}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
// The signed-in user, or null. Checked against the database and the allowlist on every request,
// so removing an email from ALLOWED_EMAILS locks that account out immediately.
function currentUser(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !same(sig, sign(payload))) return null;
  const [exp, userId] = Buffer.from(payload, 'base64url').toString().split(':');
  if (!(Number(exp) > Date.now())) return null;
  const user = store.getUser(userId);
  if (!user) return null;
  return ALLOWED.has(String(user.email).toLowerCase()) ? user : null;
}
function cookie(req, value, maxAge) {
  const https = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}
// Google sign-in: the browser gets an ID token from Google; we check its signature against
// Google's published keys, that it was issued for this app, and that it is the allowed account.
let jwks = { at: 0, keys: [] };
async function googleKey(kid) {
  if (Date.now() - jwks.at > 36e5 || !jwks.keys.some((k) => k.kid === kid)) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('Could not fetch Google keys');
    jwks = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid);
  return jwk && createPublicKey({ key: jwk, format: 'jwk' });
}
async function loginGoogle(req, res, body) {
  const bad = () => new HttpError(401, 'Google sign-in failed');
  const parts = typeof body.credential === 'string' ? body.credential.split('.') : [];
  if (parts.length !== 3) throw bad();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw bad(); }
  if (header.alg !== 'RS256') throw bad();
  let key;
  try { key = await googleKey(header.kid); } catch (e) { console.error(e.message); throw new HttpError(502, 'Could not reach Google. Try again.'); }
  if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw bad();
  const okIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!okIss || claims.aud !== GOOGLE_CLIENT_ID || !(Number(claims.exp) * 1000 > Date.now())) throw bad();
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw bad();
  if (!claims.sub || !ALLOWED.has(String(claims.email || '').toLowerCase())) throw new HttpError(403, 'This Google account is not allowed');
  const user = store.upsertUser({ sub: String(claims.sub), email: claims.email, name: claims.name || null });
  res.setHeader('Set-Cookie', cookie(req, newSession(user.id), SESSION_DAYS * 86400));
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
const changed = (u, undo) => ({ state: store.state(u.id), undo: undo || null });
const SRC = 'web';

async function api(req, res, route) {
  const m = req.method;
  if (route === '/health' && m === 'GET') return { ok: true };

  const body = ['POST', 'PATCH'].includes(m) ? await readJson(req, route === '/import' ? 8e6 : 1e5) : {};
  if (route === '/config' && m === 'GET') return { google: GOOGLE_CLIENT_ID };
  if (route === '/login/google' && m === 'POST') return loginGoogle(req, res, body);
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Sign in required');

  if (route === '/logout' && m === 'POST') { res.setHeader('Set-Cookie', cookie(req, '', 0)); return { ok: true }; }
  if (route === '/me' && m === 'GET') return { email: user.email, name: user.name };
  if (route === '/state' && m === 'GET') return store.state(user.id);
  if (route === '/events.json' && m === 'GET') {
    res.setHeader('Content-Disposition', 'attachment; filename="planner-events.json"');
    return store.allEvents(user.id);
  }
  if (route === '/events' && m === 'DELETE') { store.clearEvents(user.id, SRC); return changed(user); }
  if (route === '/import' && m === 'POST') { const n = store.importLocal(user.id, body, SRC); return { ...changed(user), imported: n }; }
  if (route === '/tasks' && m === 'POST') return changed(user, store.create(user.id, body, SRC));

  let p;
  if ((p = /^\/undo\/([\w-]+)$/.exec(route)) && m === 'POST') { store.undo(user.id, p[1], SRC); return changed(user); }
  if ((p = /^\/tasks\/(\w+)$/.exec(route))) {
    if (m === 'PATCH') return changed(user, store.update(user.id, p[1], body, SRC));
    if (m === 'DELETE') return changed(user, store.remove(user.id, p[1], SRC));
  }
  if ((p = /^\/tasks\/(\w+)\/(complete|reopen|snooze|reschedule)$/.exec(route)) && m === 'POST') {
    const [, id, action] = p;
    if (action === 'complete') return changed(user, store.complete(user.id, id, SRC));
    if (action === 'reopen') return changed(user, store.reopen(user.id, id, SRC));
    if (action === 'snooze') return changed(user, store.snooze(user.id, id, body.kind, SRC));
    if (body.planned !== undefined) return changed(user, store.reschedule(user.id, id, body.planned, SRC, 'planned', body.plannedTime));
    return changed(user, store.reschedule(user.id, id, body.due, SRC));
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

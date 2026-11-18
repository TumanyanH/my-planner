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
const PASSWORD = process.env.PLANNER_PASSWORD || '';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL || '').trim().toLowerCase();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const WEB_DIR = path.join(__dirname, '..', 'web');
const COOKIE = 'planner_session';
const SESSION_DAYS = 365;

const GOOGLE = !!GOOGLE_CLIENT_ID;
if (GOOGLE && !ALLOWED_EMAIL) {
  console.error('GOOGLE_CLIENT_ID is set but ALLOWED_EMAIL is not. Set ALLOWED_EMAIL to the Google account that may sign in.');
  process.exit(1);
}
if (PASSWORD && PASSWORD.length < 8) {
  console.error('PLANNER_PASSWORD must be at least 8 characters.');
  process.exit(1);
}
if (!GOOGLE && !PASSWORD) {
  console.error('Set GOOGLE_CLIENT_ID and ALLOWED_EMAIL (Google sign-in) or PLANNER_PASSWORD. See README.md.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = openStore(path.join(DATA_DIR, 'planner.db'));
startReminders(store);

// ---------- auth: one user, Google sign-in (and optionally a password), signed session cookie ----------
// The signing key is a random secret kept in the data directory, mixed with the password if one
// is set, so changing the password signs everyone out. Deleting data/session.key does the same.
function loadSecret() {
  const file = path.join(DATA_DIR, 'session.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const KEY = createHmac('sha256', loadSecret()).update('planner-session-v1:' + PASSWORD).digest();
const sign = (v) => createHmac('sha256', KEY).update(v).digest('base64url');
const sha = (v) => createHash('sha256').update(String(v)).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

// Session value: base64url("<expiry ms>:<method>") + "." + signature. method is "google" or "password".
function newSession(method) {
  const payload = Buffer.from(`${Date.now() + SESSION_DAYS * 864e5}:${method}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function session(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || !same(sig, sign(payload))) return null;
  const [exp, method] = Buffer.from(payload, 'base64url').toString().split(':');
  return Number(exp) > Date.now() ? { method } : null;
}
const authed = (req) => !!session(req);
function cookie(req, value, maxAge) {
  const https = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${https ? '; Secure' : ''}`;
}
// Brute-force guard: after 10 wrong passwords, logins are refused for 15 minutes.
const fails = { n: 0, until: 0 };
function login(req, res, body) {
  if (!PASSWORD) throw new HttpError(404, 'Password sign-in is turned off');
  if (Date.now() < fails.until) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  if (typeof body.password !== 'string' || !same(body.password, PASSWORD)) {
    if (++fails.n >= 10) { fails.n = 0; fails.until = Date.now() + 15 * 60e3; }
    throw new HttpError(401, 'Wrong password');
  }
  fails.n = 0;
  res.setHeader('Set-Cookie', cookie(req, newSession('password'), SESSION_DAYS * 86400));
  return { ok: true };
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
  if (!GOOGLE) throw new HttpError(404, 'Google sign-in is not configured');
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
  if (String(claims.email || '').toLowerCase() !== ALLOWED_EMAIL) throw new HttpError(403, 'This Google account is not allowed');
  res.setHeader('Set-Cookie', cookie(req, newSession('google'), SESSION_DAYS * 86400));
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
  if (route === '/config' && m === 'GET') return { google: GOOGLE ? GOOGLE_CLIENT_ID : null, password: !!PASSWORD };
  if (route === '/login' && m === 'POST') return login(req, res, body);
  if (route === '/login/google' && m === 'POST') return loginGoogle(req, res, body);
  if (!authed(req)) throw new HttpError(401, 'Sign in required');

  if (route === '/logout' && m === 'POST') { res.setHeader('Set-Cookie', cookie(req, '', 0)); return { ok: true }; }
  if (route === '/me' && m === 'GET') { const method = session(req).method; return { method, email: method === 'google' ? ALLOWED_EMAIL : null }; }
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

// Authentication, sessions, roles and permissions.
//
// Roles and permissions are defined ONLY here. `can(user, permission)` is the
// single permission check used by every route (always two arguments).

import { b64, fromB64, randomToken, sha256Hex, timingSafeEqual, nowIso, json, error, redirect, clean, isEmail, readBody, parseJson, newId } from './util.js';
import { audit } from './audit.js';
import { resolveGoogle, integrationStatus } from './settings-crypto.js';
import { sendEmail, resetEmail } from './email.js';

export const COOKIE = 'crm_session';
export const CSRF_HEADER = 'x-requested-with';
const PBKDF2_ITERATIONS = 100000; // Workers maximum
const SESSION_HOURS = 12, REMEMBER_DAYS = 30, IDLE_MINUTES = 30;
const SET_TOKEN_MINUTES = 15;
const LOGIN_MAX = 5, LOGIN_WINDOW_MIN = 15;

// ---------- roles & permissions (one place) ----------
export const PERMISSIONS = [
  'dashboard.view', 'leads.view', 'leads.edit', 'leads.delete', 'leads.export', 'notes.add',
  'analytics.view', 'automations.manage', 'media.manage', 'team.manage', 'settings.manage', 'audit.view'
];
export const ROLES = {
  admin: { label: 'Admin', perms: PERMISSIONS },
  staff: { label: 'Staff', perms: ['dashboard.view', 'leads.view', 'leads.edit', 'notes.add', 'analytics.view'] }
};
export const SECTIONS = ['dashboard', 'leads', 'analytics', 'automations', 'media', 'team', 'settings', 'audit'];
// Which section each permission belongs to, so hidden sections are enforced by the API.
const PERM_SECTION = {
  'dashboard.view': 'dashboard', 'leads.view': 'leads', 'leads.edit': 'leads', 'leads.delete': 'leads', 'leads.export': 'leads', 'notes.add': 'leads',
  'analytics.view': 'analytics', 'automations.manage': 'automations', 'media.manage': 'media', 'team.manage': 'team',
  'settings.manage': 'settings', 'audit.view': 'audit'
};

export function permissionsFor(user) {
  const role = ROLES[user.role] || ROLES.staff;
  const extra = user.role === 'admin' ? [] : (Array.isArray(user.perms) ? user.perms : parseJson(user.perms, []));
  const set = new Set([...role.perms, ...extra.filter((p) => PERMISSIONS.includes(p))]);
  return [...set];
}
export function sectionsFor(user) {
  const off = new Set(Array.isArray(user.off) ? user.off : parseJson(user.off, []));
  const perms = new Set(permissionsFor(user));
  return SECTIONS.filter((s) => !off.has(s) && [...perms].some((p) => PERM_SECTION[p] === s));
}

// ---------- agency accounts ----------
// Admin accounts whose email is listed in SUPER_ADMINS are agency accounts. They have every
// admin permission, and the rest of the team never sees them: they are left out of the Team
// list, their actions are attributed to AGENCY_LABEL in notes/history/audit, and any request
// aimed at one of them by a non-agency user answers as if the account did not exist.
export function superEmails(env) {
  return String((env && env.SUPER_ADMINS) || '').split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function isSuper(env, user) {
  return !!(user && user.role === 'admin' && user.email && superEmails(env).includes(String(user.email).toLowerCase()));
}
export const agencyLabel = (env) => (env && env.AGENCY_NAME) || 'Smart Marketing';
/** Build the in-memory user from a users row (adds the `super` flag). */
export function userFromRow(env, row) {
  const u = { id: row.id, email: row.email, name: row.name, role: row.role, perms: parseJson(row.perms, []), off: parseJson(row.off, []), active: !!row.active };
  u.super = isSuper(env, u);
  return u;
}
/** ids of agency accounts (for masking joins). */
export async function superIds(env) {
  const emails = superEmails(env);
  if (!emails.length) return new Set();
  const rows = (await env.DB.prepare(`SELECT id FROM users WHERE lower(email) IN (${emails.map(() => '?').join(',')})`).bind(...emails).all()).results;
  return new Set(rows.map((r) => r.id));
}
/**
 * Returns mask(userId, displayName): for non-agency viewers, anything done by an agency
 * account is shown under the agency label. Agency viewers see real names.
 */
export async function actorMask(ctx) {
  if (!ctx.user || ctx.user.super) return (id, name) => name;
  const ids = await superIds(ctx.env);
  const label = agencyLabel(ctx.env);
  return (id, name) => (id && ids.has(id) ? label : name);
}

/** THE permission check. Fixed two-argument signature. */
export function can(user, permission) {
  if (!user || !user.active) return false;
  if (!PERMISSIONS.includes(permission)) return false;
  const off = new Set(Array.isArray(user.off) ? user.off : parseJson(user.off, []));
  if (off.has(PERM_SECTION[permission])) return false;
  return permissionsFor(user).includes(permission);
}

// ---------- passwords ----------
export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
export async function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const { hash: h } = await hashPassword(password, salt);
  return timingSafeEqual(h, hash);
}
export function passwordOk(p) { return typeof p === 'string' && p.length >= 10 && p.length <= 200; }

// ---------- cookies ----------
function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function cookieHeader(value, maxAgeSec) {
  const base = `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  return maxAgeSec === 0 ? `${base}; Max-Age=0` : maxAgeSec ? `${base}; Max-Age=${maxAgeSec}` : base;
}

// ---------- sessions ----------
export async function createSession(ctx, user, remember) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const ttlMs = remember ? REMEMBER_DAYS * 86400000 : SESSION_HOURS * 3600000;
  const exp = new Date(Date.now() + ttlMs).toISOString();
  await ctx.env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen,remember,ip_hash,ua) VALUES (?,?,?,?,?,?,?,?)')
    .bind(tokenHash, user.id, nowIso(), exp, nowIso(), remember ? 1 : 0, ctx.ip, clean(ctx.request.headers.get('User-Agent'), 200)).run();
  await ctx.env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(nowIso(), user.id).run();
  // Session cookie (no Max-Age) unless remembered, so a closed browser ends a plain session.
  return cookieHeader(token, remember ? REMEMBER_DAYS * 86400 : undefined);
}

export async function loadSession(ctx) {
  const token = parseCookies(ctx.request)[COOKIE];
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await ctx.env.DB.prepare(
    'SELECT s.token_hash, s.expires_at, s.last_seen, s.remember, u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'
  ).bind(tokenHash).first();
  if (!row) return null;
  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() < now;
  const idle = !row.remember && now - new Date(row.last_seen).getTime() > IDLE_MINUTES * 60000;
  if (expired || idle || !row.active) {
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(tokenHash).run();
    return null;
  }
  // Touch at most once a minute to limit writes.
  if (now - new Date(row.last_seen).getTime() > 60000) {
    await ctx.env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').bind(nowIso(), tokenHash).run();
  }
  const user = userFromRow(ctx.env, row);
  return { user, tokenHash };
}

// ---------- middleware ----------
export function requireAuth() {
  return async (ctx) => {
    if (!ctx.user) return error(401, 'unauthorized', 'Please sign in.');
  };
}
export function requirePerm(permission) {
  return async (ctx) => {
    if (!ctx.user) return error(401, 'unauthorized', 'Please sign in.');
    if (!can(ctx.user, permission)) {
      const off = new Set(ctx.user.off || []);
      if (off.has(PERM_SECTION[permission])) return error(403, 'section_off', 'This section is turned off for your account.');
      return error(403, 'forbidden', "You don't have access to this.", { need: permission });
    }
  };
}

/** CSRF: non-GET API calls need the custom header and a matching Origin. */
export function csrfCheck(ctx) {
  const { request, url, env } = ctx;
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const hdr = (request.headers.get(CSRF_HEADER) || '').toLowerCase();
  const origin = request.headers.get('Origin') || '';
  if (hdr !== 'crm' || !originAllowed(origin, url, env)) return error(403, 'csrf', 'Request blocked.');
  return null;
}
/**
 * Same-origin check. Allowed: the request's own host, SITE_URL, and this
 * Worker's own workers.dev hosts (`<WORKER_NAME>[-suffix].<account>.workers.dev`,
 * which covers the preview environment). Other workers.dev sites are rejected.
 */
export function originAllowed(origin, url, env) {
  if (!origin) return false;
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.host === url.host) return true;
  try { if (o.host === new URL(env.SITE_URL).host) return true; } catch { /* ignore */ }
  const name = String(env.WORKER_NAME || '').toLowerCase();
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc}(-[a-z0-9-]+)?\\.[a-z0-9-]+\\.workers\\.dev$`).test(o.hostname);
}

// ---------- login rate limit ----------
async function tooManyAttempts(env, scope, keyHash) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MIN * 60000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE scope=? AND key_hash=? AND ok=0 AND at>?').bind(scope, keyHash, since).first();
  return row.n >= LOGIN_MAX;
}
async function recordAttempt(env, scope, keyHash, ok) {
  await env.DB.prepare('INSERT INTO auth_attempts (scope,key_hash,at,ok) VALUES (?,?,?,?)').bind(scope, keyHash, nowIso(), ok ? 1 : 0).run();
}
export async function pruneAttempts(env) {
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  await env.DB.prepare('DELETE FROM auth_attempts WHERE at<?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(nowIso()).run();
  await env.DB.prepare('DELETE FROM set_tokens WHERE expires_at<? OR used_at IS NOT NULL').bind(new Date(Date.now() - 24 * 3600000).toISOString()).run();
}

// ---------- routes ----------
export async function login(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const email = clean(body.email, 254).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const remember = body.remember === true || body.remember === 'true' || body.remember === 'on' || body.remember === 1;
  if (!isEmail(email) || !password) return error(401, 'bad_credentials', 'Email or password is incorrect.');

  const emailKey = await sha256Hex('e:' + email);
  if (await tooManyAttempts(env, 'login_email', emailKey) || await tooManyAttempts(env, 'login_ip', ctx.ip)) {
    await audit(ctx, 'login_fail', email, 'rate limited');
    return error(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.', { retry_after: LOGIN_WINDOW_MIN * 60 });
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  const ok = !!row && !!row.active && (await verifyPassword(password, row.pass_hash, row.salt));
  await recordAttempt(env, 'login_email', emailKey, ok);
  await recordAttempt(env, 'login_ip', ctx.ip, ok);
  if (!ok) {
    // Burn the same time for unknown emails so timing doesn't reveal them.
    if (!row) await hashPassword(password, b64(crypto.getRandomValues(new Uint8Array(16))));
    await audit(ctx, 'login_fail', email, '');
    return error(401, 'bad_credentials', 'Email or password is incorrect.');
  }
  const user = userFromRow(env, row);
  ctx.user = user;
  const cookie = await createSession(ctx, user, remember);
  await audit(ctx, 'login_ok', email, remember ? 'remembered' : '');
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
}

export async function logout(ctx) {
  if (ctx.session) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(ctx.session.tokenHash).run();
  if (ctx.user) await audit(ctx, 'logout', ctx.user.email, '');
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
}
export async function logoutAll(ctx) {
  await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(ctx.user.id).run();
  await audit(ctx, 'logout_all', ctx.user.email, '');
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
}
export async function ping(ctx) { return json({ ok: true }); }

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, perms: u.perms || [], off: u.off || [] };
}

export async function me(ctx) {
  const { env, user } = ctx;
  const integ = await integrationStatus(env);
  const integrations = Object.fromEntries(Object.entries(integ).map(([k, v]) => [k, !!v.set]));
  return json({
    user: { ...publicUser(user), ...(user.super ? { super: true } : {}) },
    permissions: permissionsFor(user),
    sections: sectionsFor(user),
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, perms: v.perms }])),
    all_permissions: PERMISSIONS,
    all_sections: SECTIONS,
    integrations,
    business: {
      name: env.BUSINESS_NAME, site_url: env.SITE_URL, timezone: env.TIMEZONE || 'UTC',
      phone: env.BUSINESS_PHONE || '', address: env.BUSINESS_ADDRESS || ''
    }
  });
}

// ---------- one-time set / invite / reset tokens ----------
export async function issueSetToken(env, userId, kind = 'set', minutes = SET_TOKEN_MINUTES) {
  const token = randomToken(32);
  const exp = new Date(Date.now() + minutes * 60000).toISOString();
  await env.DB.prepare('INSERT INTO set_tokens (token_hash,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)')
    .bind(await sha256Hex(token), userId, kind, exp, nowIso()).run();
  return token;
}
async function findSetToken(env, token) {
  if (!token || token.length < 20) return null;
  const row = await env.DB.prepare('SELECT t.*, u.email FROM set_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?').bind(await sha256Hex(token)).first();
  if (!row || row.used_at || row.expires_at < nowIso()) return null;
  return row;
}
/** POST /api/auth/set/check {token}: validates without consuming. POST keeps the token out of URLs and logs. */
export async function checkSetToken(ctx) {
  const body = await readBody(ctx.request);
  const row = await findSetToken(ctx.env, clean(body.token, 200));
  if (!row) return error(410, 'expired', 'This link has expired or was already used.');
  return json({ ok: true, email: row.email, kind: row.kind });
}
export async function setPassword(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const row = await findSetToken(env, clean(body.token, 200));
  if (!row) return error(410, 'expired', 'This link has expired or was already used.');
  if (!passwordOk(body.password)) return error(400, 'invalid', 'Use at least 10 characters.', { fields: { password: 'Use at least 10 characters.' } });
  const { hash, salt } = await hashPassword(body.password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash=?, salt=?, active=1 WHERE id=?').bind(hash, salt, row.user_id),
    env.DB.prepare('UPDATE set_tokens SET used_at=? WHERE token_hash=?').bind(nowIso(), row.token_hash),
    env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(row.user_id) // a reset signs out everywhere
  ]);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(row.user_id).first();
  const user = userFromRow(env, u);
  ctx.user = user;
  const cookie = await createSession(ctx, user, false);
  await audit(ctx, 'password_set', user.email, row.kind);
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
}
export async function forgot(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const email = clean(body.email, 254).toLowerCase();
  // Always the same answer, and rate limited per IP.
  if (await tooManyAttempts(env, 'forgot_ip', ctx.ip)) return json({ ok: true });
  await recordAttempt(env, 'forgot_ip', ctx.ip, false);
  if (isEmail(email)) {
    const u = await env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(email).first();
    if (u) {
      const token = await issueSetToken(env, u.id, 'reset');
      const link = `${env.SITE_URL}/admin/#set=${token}`;
      ctx.waitUntil(sendEmail(env, resetEmail(env, { name: u.name, link, minutes: SET_TOKEN_MINUTES, to: u.email }), { kind: 'reset' }));
      await audit(ctx, 'reset_link', email, 'self-service');
    }
  }
  return json({ ok: true });
}

// ---------- Sign in with Google (existing active users only) ----------
export async function googleStart(ctx) {
  const g = await resolveGoogle(ctx.env);
  if (!g) return error(404, 'not_configured', 'Google sign-in is not configured.');
  const state = randomToken(16);
  const nonceCookie = `crm_oauth=${state}; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
  const p = new URLSearchParams({
    client_id: g.id, redirect_uri: `${ctx.env.SITE_URL}/api/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account'
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302, { 'Set-Cookie': nonceCookie });
}
export async function googleCallback(ctx) {
  const { env, url } = ctx;
  const g = await resolveGoogle(env);
  const fail = () => redirect('/admin/#error=google');
  if (!g) return fail();
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  const cookies = parseCookies(ctx.request);
  if (!code || !state || cookies.crm_oauth !== state) return fail();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: g.id, client_secret: g.secret, redirect_uri: `${env.SITE_URL}/api/auth/google/callback`, grant_type: 'authorization_code' })
  });
  if (!tokenRes.ok) return fail();
  const tok = await tokenRes.json();
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!infoRes.ok) return fail();
  const info = await infoRes.json();
  if (!info.email || !info.email_verified) return fail();
  const u = await env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(String(info.email).toLowerCase()).first();
  if (!u) { await audit(ctx, 'login_fail', info.email, 'google: no account'); return fail(); } // never auto-creates
  const user = userFromRow(env, u);
  ctx.user = user;
  const cookie = await createSession(ctx, user, false);
  await audit(ctx, 'login_ok', u.email, 'google');
  return redirect('/admin/', 302, { 'Set-Cookie': cookie });
}

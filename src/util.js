// Shared helpers: ids, hashing, responses, time, validation.

const enc = new TextEncoder();

export function nowIso() { return new Date().toISOString(); }

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export function newId(prefix) { return `${prefix}_${randomToken(12)}`; }

export async function sha256Hex(str) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(str))); }

/** IPs are only ever stored as a salted hash. */
export async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '0.0.0.0';
  const salt = env.SETTINGS_KEY ? env.SETTINGS_KEY.slice(0, 16) : 'crm';
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 32);
}

/** Constant-time string comparison. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let r = 0;
  for (let i = 0; i < ab.length; i++) r |= ab[i] ^ bb[i];
  return r === 0;
}

// ---------- responses ----------
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders }
  });
}
export function error(status, code, message, extra = {}) {
  return json({ error: code, message: message || code, ...extra }, status);
}
export function redirect(location, status = 302, extraHeaders = {}) {
  return new Response(null, { status, headers: { Location: location, 'Cache-Control': 'no-store', ...extraHeaders } });
}

// ---------- input cleaning ----------
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function clean(v, max = 500) {
  if (v == null) return '';
  return String(v).replace(CONTROL, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}
export function isEmail(v) { return /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254; }
export function isPhone(v) { const d = v.replace(/\D/g, ''); return d.length >= 7 && d.length <= 15; }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function firstName(name) { return (name || '').trim().split(/\s+/)[0] || 'there'; }

export function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Guard against spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ---------- time / date ranges in the business time zone ----------
function tzParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
  });
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(date, timeZone) {
  const p = tzParts(date, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
/** Start of local day (y,m,d in timeZone) as a UTC Date. */
export function localDayStart(y, m, d, timeZone) {
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const off = tzOffsetMs(guess, timeZone);
  const corrected = new Date(guess.getTime() - off);
  // second pass handles DST boundaries
  return new Date(guess.getTime() - tzOffsetMs(corrected, timeZone));
}
export function localNow(timeZone) { return tzParts(new Date(), timeZone); }

const RANGE_LABELS = {
  any: 'Any time', '24h': 'Last 24 hours', today: 'Today', '7d': 'Last 7 days', week: 'This week', '30d': 'Last 30 days',
  month: 'This month', lastmonth: 'Last month', '90d': 'Last 90 days', year: 'This year', custom: 'Custom range'
};
export const RANGE_KEYS = Object.keys(RANGE_LABELS);

/** Resolve a range key (+ optional from/to YYYY-MM-DD) to ISO bounds. Returns {from, to, label} with nulls for open ends. */
export function resolveRange(range, from, to, timeZone) {
  const now = new Date();
  const L = localNow(timeZone);
  const day = (y, m, d) => localDayStart(y, m, d, timeZone);
  const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
  const todayStart = day(L.y, L.m, L.d);
  let f = null, t = null;
  switch (range) {
    case '24h': f = new Date(now.getTime() - 86400000); break;
    case 'today': f = todayStart; break;
    case '7d': f = addDays(todayStart, -6); break;
    case 'week': f = addDays(todayStart, -((L.wd + 6) % 7)); break; // Monday start
    case '30d': f = addDays(todayStart, -29); break;
    case 'month': f = day(L.y, L.m, 1); break;
    case 'lastmonth': {
      const pm = L.m === 1 ? 12 : L.m - 1, py = L.m === 1 ? L.y - 1 : L.y;
      f = day(py, pm, 1); t = day(L.y, L.m, 1); break;
    }
    case '90d': f = addDays(todayStart, -89); break;
    case 'year': f = day(L.y, 1, 1); break;
    case 'custom': {
      const mf = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from || ''), mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to || '');
      if (mf) f = day(+mf[1], +mf[2], +mf[3]);
      if (mt) t = addDays(day(+mt[1], +mt[2], +mt[3]), 1);
      break;
    }
    default: break;
  }
  return { from: f ? f.toISOString() : null, to: t ? t.toISOString() : null, label: RANGE_LABELS[range] || 'Any time', key: RANGE_LABELS[range] ? range : 'any' };
}

export function fmtDate(iso, timeZone, opts) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short', ...(opts || {}) }).format(new Date(iso));
  } catch { return iso; }
}

/** Parse a request body (JSON, urlencoded, multipart) into a plain object; files kept as File. */
export async function readBody(request) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return (await request.json()) || {}; } catch { return {}; }
  }
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const out = {};
    try {
      const fd = await request.formData();
      for (const [k, v] of fd.entries()) out[k] = v;
    } catch { /* malformed body */ }
    return out;
  }
  return {};
}

export function parseJson(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }

export function emailList(s) {
  return String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter((x) => x && isEmail(x));
}

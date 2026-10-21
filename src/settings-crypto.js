// Encrypted settings in D1. Keys typed into the portal are AES-GCM encrypted
// with SETTINGS_KEY before storage. A Cloudflare secret with the same purpose
// always overrides the portal value. Values are never returned in full.

import { b64, fromB64, parseJson, nowIso } from './util.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(env) {
  if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set');
  // Derive a 256-bit key from whatever string the owner set (base64 32 bytes recommended).
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(env.SETTINGS_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(env, plaintext) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decrypt(env, stored) {
  const [ivB, ctB] = String(stored).split('.');
  const key = await aesKey(env);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(ivB) }, key, fromB64(ctB));
  return dec.decode(pt);
}

// ---------- settings table ----------
// Secret-ish keys are encrypted; other settings (templates, flags) stored as "plain:<json>".
const SECRET_KEYS = new Set(['resend_api_key', 'turnstile_secret', 'anthropic_api_key', 'ga_service_account', 'google_client_id', 'google_client_secret']);

export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT enc_value FROM settings WHERE key=?').bind(key).first();
  if (!row) return null;
  const v = row.enc_value;
  if (v.startsWith('plain:')) return parseJson(v.slice(6), null);
  try { return await decrypt(env, v); } catch { return null; }
}

export async function setSetting(env, key, value, userId) {
  if (value === null || value === undefined || value === '') {
    await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
    return;
  }
  const stored = SECRET_KEYS.has(key) ? await encrypt(env, String(value)) : 'plain:' + JSON.stringify(value);
  await env.DB.prepare(
    'INSERT INTO settings (key, enc_value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET enc_value=excluded.enc_value, updated_by=excluded.updated_by, updated_at=excluded.updated_at'
  ).bind(key, stored, userId || null, nowIso()).run();
}

/** Map of integration -> { secretVar, settingKey }. */
export const INTEGRATIONS = {
  resend: { secret: 'RESEND_API_KEY', setting: 'resend_api_key' },
  turnstile: { secret: 'TURNSTILE_SECRET', setting: 'turnstile_secret' },
  anthropic: { secret: 'ANTHROPIC_API_KEY', setting: 'anthropic_api_key' },
  ga4: { secret: 'GA_SERVICE_ACCOUNT', setting: 'ga_service_account' },
  google: { secret: 'GOOGLE_CLIENT_ID', setting: 'google_client_id' }
};

/** Resolve a secret: Cloudflare secret wins, then the encrypted portal value. */
export async function resolveSecret(env, integration) {
  const def = INTEGRATIONS[integration];
  if (!def) return { value: null, source: 'none' };
  if (env[def.secret]) return { value: env[def.secret], source: 'secret' };
  const v = await getSetting(env, def.setting);
  if (v) return { value: v, source: 'portal' };
  return { value: null, source: 'none' };
}

export async function resolveGoogle(env) {
  const id = env.GOOGLE_CLIENT_ID || (await getSetting(env, 'google_client_id'));
  const secret = env.GOOGLE_CLIENT_SECRET || (await getSetting(env, 'google_client_secret'));
  return id && secret ? { id, secret } : null;
}

export async function ga4PropertyId(env) {
  const v = (await getSetting(env, 'ga4_property_id')) || env.GA4_PROPERTY_ID || 'none';
  return /^\d+$/.test(String(v)) ? String(v) : null;
}

/** Status for the Settings page and /api/health (never the key itself). */
export async function integrationStatus(env) {
  const out = {};
  for (const name of Object.keys(INTEGRATIONS)) {
    const r = await resolveSecret(env, name);
    out[name] = { set: !!r.value, source: r.source, last4: r.value ? String(r.value).slice(-4) : null };
  }
  const google = await resolveGoogle(env);
  out.google = { set: !!google, source: env.GOOGLE_CLIENT_ID ? 'secret' : google ? 'portal' : 'none', last4: google ? String(google.id).slice(-4) : null };
  const pid = await ga4PropertyId(env);
  out.ga4.property_id = pid;
  out.ga4.set = out.ga4.set && !!pid;
  return out;
}

// ---------- small cache table (used by analytics) ----------
export async function cacheGet(env, key) {
  const row = await env.DB.prepare('SELECT value, expires_at FROM cache WHERE key=?').bind(key).first();
  if (!row || row.expires_at < nowIso()) return null;
  return parseJson(row.value, null);
}
export async function cacheSet(env, key, value, ttlSeconds) {
  const exp = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare('INSERT INTO cache (key,value,expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at')
    .bind(key, JSON.stringify(value), exp).run();
}

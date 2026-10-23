// System controls (agency accounts only): the CRM pause switch, sign-out-everyone,
// and importing submissions that were held while paused.
//
// Pausing: ends every non-agency session, refuses non-agency sign-ins with a neutral message,
// stops writing website leads (they are still emailed and held encrypted in lead_queue),
// and pauses auto-replies and the weekly summary. The list of agency accounts is frozen into
// the state record at that moment, so edits to config or the database during the pause grant
// nothing. Only the same account that paused can resume, with its password, 5 tries per 15 min.
import { json, error, readBody, clean, nowIso, newId, sha256Hex, parseJson } from './util.js';
import { verifyPassword, superEmails, superIds } from './auth.js';
import { encrypt, decrypt } from './settings-crypto.js';
import { audit } from './audit.js';

export const PAUSE_PHRASE = 'SHUT DOWN';
export const RESUME_PHRASE = 'RESTORE';
const TRY_MAX = 5, TRY_WINDOW_MIN = 15;
const KEY = 'crm_state';

export async function getState(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM system_state WHERE key=?').bind(KEY).first();
    const v = row ? parseJson(row.value, null) : null;
    if (!v || !v.off) return { off: false };
    return { off: true, by: v.by || null, by_email: v.by_email || null, at: v.at || null, supers: Array.isArray(v.supers) ? v.supers : [] };
  } catch { return { off: false }; } // missing table = never paused
}
export const isPaused = async (env) => (await getState(env)).off;

async function setState(env, value, userId) {
  await env.DB.prepare('INSERT INTO system_state (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
    .bind(KEY, JSON.stringify(value), userId || null, nowIso()).run();
}

/** Routes under /api/system answer 404 to everyone but agency accounts, so they don't appear to exist. */
export function requireSuper() {
  return async (ctx) => {
    if (!ctx.user) return error(401, 'unauthorized', 'Please sign in.');
    if (!ctx.user.super) return error(404, 'not_found', 'No such API route.');
  };
}

async function tooManyTries(env, keyHash) {
  const since = new Date(Date.now() - TRY_WINDOW_MIN * 60000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE scope=? AND key_hash=? AND ok=0 AND at>?').bind('system', keyHash, since).first();
  return row.n >= TRY_MAX;
}
const recordTry = (env, keyHash, ok) => env.DB.prepare('INSERT INTO auth_attempts (scope,key_hash,at,ok) VALUES (?,?,?,?)').bind('system', keyHash, nowIso(), ok ? 1 : 0).run();

/** Password + phrase check shared by pause and resume. Returns an error Response or null. */
async function confirmAction(ctx, phrase, action) {
  const { env, user } = ctx;
  const body = await readBody(ctx.request);
  const keyHash = await sha256Hex('u:' + user.id);
  if (await tooManyTries(env, keyHash)) {
    await audit(ctx, action + '_fail', user.email, 'rate limited');
    return error(429, 'rate_limited', 'Too many attempts. Try again in 15 minutes.', { retry_after: TRY_WINDOW_MIN * 60 });
  }
  if (clean(body.phrase, 40) !== phrase) {
    await recordTry(env, keyHash, false); await audit(ctx, action + '_fail', user.email, 'wrong phrase');
    return error(400, 'phrase', `Type ${phrase} exactly to confirm.`, { fields: { phrase: `Type ${phrase} exactly.` } });
  }
  const row = await env.DB.prepare('SELECT pass_hash, salt FROM users WHERE id=? AND active=1').bind(user.id).first();
  const ok = !!row && (await verifyPassword(typeof body.password === 'string' ? body.password : '', row.pass_hash, row.salt));
  await recordTry(env, keyHash, ok);
  if (!ok) { await audit(ctx, action + '_fail', user.email, 'wrong password'); return error(401, 'bad_credentials', 'Password is incorrect.'); }
  return null;
}

export async function status(ctx) {
  const { env } = ctx;
  const state = await getState(env);
  const queued = (await env.DB.prepare('SELECT COUNT(*) AS n FROM lead_queue').first().catch(() => ({ n: 0 }))).n;
  const sessions = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at>?').bind(nowIso()).first()).n;
  return json({ state, queued, sessions, can_resume: state.off && state.by === ctx.user.id, phrases: { pause: PAUSE_PHRASE, resume: RESUME_PHRASE } });
}

export async function pause(ctx) {
  const { env, user } = ctx;
  if ((await getState(env)).off) return error(409, 'already', 'The CRM is already paused.');
  const bad = await confirmAction(ctx, PAUSE_PHRASE, 'crm_pause');
  if (bad) return bad;
  const ids = await superIds(env);
  const state = { off: true, by: user.id, by_email: user.email, at: nowIso(), supers: superEmails(env) };
  await setState(env, state, user.id);
  // Sign out everyone who is not an agency account.
  const keep = [...ids];
  const r = await env.DB.prepare(`DELETE FROM sessions WHERE user_id NOT IN (${keep.map(() => '?').join(',') || "''"})`).bind(...keep).run();
  await audit(ctx, 'crm_pause', user.email, `${r.meta.changes || 0} sessions ended`);
  return json({ ok: true, state, sessions_ended: r.meta.changes || 0 });
}

export async function resume(ctx) {
  const { env, user } = ctx;
  const state = await getState(env);
  if (!state.off) return error(409, 'already', 'The CRM is not paused.');
  // Checked against the FROZEN record, never the live config or the live users table.
  if (state.by !== user.id || !state.supers.map((e) => e.toLowerCase()).includes(String(user.email).toLowerCase())) {
    await audit(ctx, 'crm_resume_fail', user.email, 'not the account that paused');
    return error(403, 'forbidden', 'Only the account that paused the CRM can turn it back on.');
  }
  const bad = await confirmAction(ctx, RESUME_PHRASE, 'crm_resume');
  if (bad) return bad;
  await setState(env, { off: false }, user.id);
  const queued = (await env.DB.prepare('SELECT COUNT(*) AS n FROM lead_queue').first()).n;
  await audit(ctx, 'crm_resume', user.email, `${queued} queued lead(s)`);
  return json({ ok: true, state: { off: false }, queued });
}

export async function signoutEveryone(ctx) {
  const { env } = ctx;
  const r = await env.DB.prepare('DELETE FROM sessions WHERE token_hash<>?').bind(ctx.session.tokenHash).run();
  await audit(ctx, 'signout_everyone', ctx.user.email, `${r.meta.changes || 0} sessions ended`);
  return json({ ok: true, sessions_ended: r.meta.changes || 0 });
}

/** Called from lead capture while paused: email already sent by the caller; hold the record. */
export async function queueLead(env, lead, label) {
  const payload = await encrypt(env, JSON.stringify({ lead, label }));
  await env.DB.prepare('INSERT INTO lead_queue (id,received_at,enc_payload) VALUES (?,?,?)').bind(newId('q'), nowIso(), payload).run();
}

/** Import everything held during a pause into the leads table (idempotent per queue row). */
export async function importQueue(ctx) {
  const { env } = ctx;
  const rows = (await env.DB.prepare('SELECT id, received_at, enc_payload FROM lead_queue ORDER BY received_at').all()).results;
  let imported = 0, failed = 0;
  for (const q of rows) {
    try {
      const { lead, label } = JSON.parse(await decrypt(env, q.enc_payload));
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO leads (id,created_at,updated_at,form,pipeline,stage,name,email,phone,topic,message,fields,file_key,file_name,page,utm,ip_hash,spam_score,email_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(lead.id, lead.created_at, lead.created_at, lead.form, lead.pipeline, 'new', lead.name, lead.email, lead.phone, lead.topic, lead.message, JSON.stringify(lead.fields || {}), lead.file_key, lead.file_name, lead.page, JSON.stringify(lead.utm || {}), lead.ip_hash, 0, lead.email_status || 'sent'),
        env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)').bind(newId('a'), lead.id, null, 'created', `${label} from the website`, lead.created_at),
        env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)').bind(newId('a'), lead.id, ctx.user.id, 'imported', 'Imported from the paused-period queue', nowIso()),
        env.DB.prepare('DELETE FROM lead_queue WHERE id=?').bind(q.id)
      ]);
      imported++;
    } catch (e) { failed++; console.error('queue import failed', q.id, e); }
  }
  await audit(ctx, 'queue_import', '', `${imported} imported, ${failed} failed`);
  return json({ ok: true, imported, failed });
}

// Team management (admin): users, invites, roles, permissions, hidden sections.
import { json, error, clean, isEmail, readBody, parseJson, newId, nowIso } from './util.js';
import { PERMISSIONS, SECTIONS, ROLES, issueSetToken, publicUser } from './auth.js';
import { audit } from './audit.js';
import { sendEmail, inviteEmail, resetEmail } from './email.js';
import { resolveSecret } from './settings-crypto.js';

function shape(u) {
  return { ...publicUser({ ...u, perms: parseJson(u.perms, []), off: parseJson(u.off, []) }), active: !!u.active, created_at: u.created_at, last_login: u.last_login, has_password: !!u.pass_hash };
}
function cleanPerms(v) { return (Array.isArray(v) ? v : []).filter((p) => PERMISSIONS.includes(p)); }
function cleanOff(v) { return (Array.isArray(v) ? v : []).filter((s) => SECTIONS.includes(s)); }

export async function listTeam(ctx) {
  const rows = (await ctx.env.DB.prepare('SELECT * FROM users ORDER BY active DESC, role, name').all()).results;
  return json({ items: rows.map(shape), roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])), permissions: PERMISSIONS, sections: SECTIONS });
}

async function lastActiveAdmin(env, exceptId) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id<>?").bind(exceptId).first();
  return row.n === 0;
}

export async function invite(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const email = clean(body.email, 254).toLowerCase();
  const name = clean(body.name, 120);
  const role = body.role === 'admin' ? 'admin' : 'staff';
  if (!isEmail(email)) return error(400, 'invalid', 'Enter a valid email.', { fields: { email: 'Enter a valid email.' } });
  const existing = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  let user;
  if (existing) {
    if (existing.active && existing.pass_hash) return error(409, 'exists', 'That person already has an account.');
    await env.DB.prepare('UPDATE users SET name=?, role=?, perms=?, off=?, active=1 WHERE id=?')
      .bind(name || existing.name, role, JSON.stringify(cleanPerms(body.perms)), JSON.stringify(cleanOff(body.off)), existing.id).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(existing.id).first();
  } else {
    const id = newId('u');
    await env.DB.prepare('INSERT INTO users (id,email,name,role,perms,off,active,created_at) VALUES (?,?,?,?,?,?,1,?)')
      .bind(id, email, name, role, JSON.stringify(cleanPerms(body.perms)), JSON.stringify(cleanOff(body.off)), nowIso()).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
  }
  const token = await issueSetToken(env, user.id, 'invite', 24 * 60);
  const link = `${env.SITE_URL}/admin/#set=${token}`;
  const connected = !!(await resolveSecret(env, 'resend')).value;
  let sent = false;
  if (connected) sent = (await sendEmail(env, inviteEmail(env, { name, link, inviter: ctx.user.name || ctx.user.email, to: email }), { kind: 'invite' })).ok;
  await audit(ctx, 'invite', email, `${role}${sent ? '' : ' · link shown to admin'}`);
  // The link is only handed back when it could not be emailed.
  return json({ ok: true, user: shape(user), sent, link: sent ? undefined : link });
}

export async function updateUser(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(ctx.params.id).first();
  if (!u) return error(404, 'not_found', 'User not found.');
  const next = {
    name: body.name !== undefined ? clean(body.name, 120) : u.name,
    role: body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'staff') : u.role,
    perms: body.perms !== undefined ? JSON.stringify(cleanPerms(body.perms)) : u.perms,
    off: body.off !== undefined ? JSON.stringify(cleanOff(body.off)) : u.off,
    active: body.active !== undefined ? (body.active === true || body.active === 'true' ? 1 : 0) : u.active
  };
  if (u.role === 'admin' && u.active && (next.role !== 'admin' || !next.active) && (await lastActiveAdmin(env, u.id))) {
    return error(400, 'last_admin', 'There must be at least one active admin.');
  }
  if (u.id === ctx.user.id && (!next.active || next.role !== 'admin')) return error(400, 'self', "You can't deactivate or demote yourself.");
  await env.DB.prepare('UPDATE users SET name=?, role=?, perms=?, off=?, active=? WHERE id=?').bind(next.name, next.role, next.perms, next.off, next.active, u.id).run();
  if (!next.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id).run();
  const changed = Object.keys(next).filter((k) => String(next[k]) !== String(u[k]));
  await audit(ctx, 'user_update', u.email, changed.join(', '));
  return json({ ok: true, user: shape(await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first()) });
}

export async function resetUser(ctx) {
  const { env } = ctx;
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(ctx.params.id).first();
  if (!u) return error(404, 'not_found', 'User not found.');
  const token = await issueSetToken(env, u.id, 'reset', 15);
  const link = `${env.SITE_URL}/admin/#set=${token}`;
  const connected = !!(await resolveSecret(env, 'resend')).value;
  let sent = false;
  if (connected) sent = (await sendEmail(env, resetEmail(env, { name: u.name, link, minutes: 15, to: u.email }), { kind: 'reset' })).ok;
  await audit(ctx, 'reset_link', u.email, `by admin${sent ? '' : ' · link shown to admin'}`);
  return json({ ok: true, sent, link: sent ? undefined : link });
}

export async function signoutUser(ctx) {
  const { env } = ctx;
  const u = await env.DB.prepare('SELECT id, email FROM users WHERE id=?').bind(ctx.params.id).first();
  if (!u) return error(404, 'not_found', 'User not found.');
  await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id).run();
  await audit(ctx, 'user_signout', u.email, '');
  return json({ ok: true });
}

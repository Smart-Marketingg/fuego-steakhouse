// Audit log: every security-relevant and data-changing action.
import { nowIso, json, csvCell, resolveRange, parseJson, clean } from './util.js';
import { actorMask, superEmails, agencyLabel } from './auth.js';

export async function audit(ctx, action, target = '', detail = '') {
  const { env } = ctx;
  const userId = ctx.user ? ctx.user.id : null;
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  try {
    await env.DB.prepare('INSERT INTO audit_log (user_id, action, target, detail, ip_hash, at) VALUES (?,?,?,?,?,?)')
      .bind(userId, action, String(target).slice(0, 200), d.slice(0, 2000), ctx.ip || null, nowIso()).run();
  } catch (e) { /* auditing must never break the request */ }
}

export const AUDIT_ACTIONS = [
  'login_ok', 'login_fail', 'logout', 'logout_all', 'password_set', 'invite', 'reset_link', 'user_update', 'user_signout',
  'lead_stage', 'lead_note', 'lead_delete', 'lead_export', 'settings_update', 'settings_test', 'automation_update',
  'automation_test', 'media_upload', 'media_delete', 'audit_export', 'weekly_summary'
];

function buildQuery(ctx) {
  const q = ctx.url.searchParams;
  const where = [], args = [];
  const action = clean(q.get('action'), 50);
  if (action) { where.push('a.action=?'); args.push(action); }
  const user = clean(q.get('user'), 100);
  if (user) {
    where.push('(u.email LIKE ? OR u.name LIKE ?)'); args.push(`%${user}%`, `%${user}%`);
    // Non-agency viewers can't search for agency accounts by name or email.
    const hide = ctx.user && !ctx.user.super ? superEmails(ctx.env) : [];
    if (hide.length) { where.push(`lower(u.email) NOT IN (${hide.map(() => '?').join(',')})`); args.push(...hide); }
  }
  const r = resolveRange(q.get('range') || 'any', q.get('from'), q.get('to'), ctx.env.TIMEZONE);
  if (r.from) { where.push('a.at>=?'); args.push(r.from); }
  if (r.to) { where.push('a.at<?'); args.push(r.to); }
  const s = clean(q.get('q'), 100);
  if (s) { where.push('(a.target LIKE ? OR a.detail LIKE ?)'); args.push(`%${s}%`, `%${s}%`); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

export async function listAudit(ctx) {
  const { env } = ctx;
  const { where, args } = buildQuery(ctx);
  const page = Math.max(1, parseInt(ctx.url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50));
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${where}`).bind(...args).first()).n;
  const rows = (await env.DB.prepare(
    `SELECT a.id, a.at, a.user_id, u.name AS user_name, u.email AS user_email, a.action, a.target, a.detail FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.at DESC LIMIT ? OFFSET ?`
  ).bind(...args, limit, (page - 1) * limit).all()).results;
  return json({ items: rows.map((r) => maskRow(ctx, r)), total, page, limit, actions: AUDIT_ACTIONS });
}

// For non-agency viewers, agency accounts appear under the agency label (never their email),
// both as the actor and as the target of sign-in / invite entries.
function maskRow(ctx, r) {
  if (!ctx.user || ctx.user.super) return r;
  const emails = superEmails(ctx.env);
  const label = agencyLabel(ctx.env);
  const out = { ...r };
  if (r.user_email && emails.includes(String(r.user_email).toLowerCase())) { out.user_id = null; out.user_name = label; out.user_email = null; }
  if (r.target && emails.includes(String(r.target).toLowerCase())) out.target = label;
  return out;
}

export async function exportAudit(ctx) {
  const { env } = ctx;
  const { where, args } = buildQuery(ctx);
  const rows = (await env.DB.prepare(
    `SELECT a.at, u.email AS user_email, a.action, a.target, a.detail FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.at DESC LIMIT 20000`
  ).bind(...args).all()).results.map((r) => maskRow(ctx, r));
  await audit(ctx, 'audit_export', '', `${rows.length} rows`);
  const lines = ['at,user,action,target,detail'];
  for (const r of rows) lines.push([r.at, r.user_email || r.user_name || 'system', r.action, r.target, r.detail].map(csvCell).join(','));
  return new Response(lines.join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-${nowIso().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }
  });
}

export { parseJson };

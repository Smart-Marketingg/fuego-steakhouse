// Lead capture (POST /api/lead) and the CRM lead routes.
import { json, error, redirect, clean, isEmail, isPhone, newId, nowIso, readBody, parseJson, csvCell, resolveRange, emailList, sha256Hex, b64 } from './util.js';
import { getConfig, STAGES } from './forms.config.js';
import { originAllowed, actorMask } from './auth.js';
import { audit } from './audit.js';
import { sendEmail, notificationEmail, autoReplyEmail, emailHealth } from './email.js';
import { resolveSecret, getSetting } from './settings-crypto.js';

const LEAD_RATE_MAX = 5, LEAD_RATE_WINDOW_MIN = 10;
const MAX_UPLOAD = 10 * 1024 * 1024;

// ---------- upload validation by magic bytes ----------
const MAGIC = [
  { ext: 'pdf', type: 'application/pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },         // %PDF
  { ext: 'doc', type: 'application/msword', test: (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 },      // OLE2
  { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 } // zip
];
async function validateUpload(file) {
  if (!(file instanceof File) || !file.size) return null;
  if (file.size > MAX_UPLOAD) return { error: 'File must be 10 MB or smaller.' };
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const kind = MAGIC.find((m) => m.test(head));
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!kind || !['pdf', 'doc', 'docx'].includes(ext)) return { error: 'Only PDF, DOC or DOCX files are accepted.' };
  if (kind.ext === 'docx' && ext !== 'docx') return { error: 'Only PDF, DOC or DOCX files are accepted.' };
  return { type: kind.type, ext, name: clean(file.name, 120).replace(/[^\w.\- ]/g, '_') };
}

async function verifyTurnstile(env, token, ip) {
  const secret = (await resolveSecret(env, 'turnstile')).value;
  if (!secret) return true; // not enabled
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip })
    });
    const j = await res.json();
    return !!j.success;
  } catch { return false; }
}

async function leadRateLimited(env, ipHash) {
  const since = new Date(Date.now() - LEAD_RATE_WINDOW_MIN * 60000).toISOString();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE scope=? AND key_hash=? AND at>?').bind('lead_ip', ipHash, since).first();
  if (row.n >= LEAD_RATE_MAX) return true;
  await env.DB.prepare('INSERT INTO auth_attempts (scope,key_hash,at,ok) VALUES (?,?,?,1)').bind('lead_ip', ipHash, nowIso()).run();
  return false;
}

function wantsJson(request) {
  return (request.headers.get('X-Requested-With') || '').toLowerCase().startsWith('crm') ||
    (request.headers.get('Accept') || '').includes('application/json');
}

/** POST /api/lead */
export async function captureLead(ctx) {
  const { request, env, url } = ctx;
  const asJson = wantsJson(request);
  // Non-JS browser posts: send the visitor to the thank-you page's error state
  // (thank-you.js renders the failure copy when `error` is present), never to success copy.
  let formHint = ''; // set once the body is parsed, so the error page can name the form
  const fail = (status, code, message, extra) => asJson
    ? error(status, code, message, extra)
    : redirect(`/thank-you?error=${encodeURIComponent(code)}${formHint ? `&form=${encodeURIComponent(formHint)}` : ''}`, 303);

  // Same-origin only.
  const origin = request.headers.get('Origin') || (request.headers.get('Referer') ? new URL(request.headers.get('Referer')).origin : '');
  if (!originAllowed(origin, url, env)) return fail(403, 'origin', 'Blocked.');

  const body = await readBody(request);
  const { forms } = getConfig(env);
  const formId = clean(body.form, 40);
  formHint = formId;
  const def = forms[formId];
  if (!def) return fail(400, 'invalid', 'Unknown form.', { fields: { form: 'Unknown form' } });

  // Honeypot: bots get a quiet success.
  if (clean(body.website, 50)) return asJson ? json({ ok: true, id: null, thanks: def.thanks }) : redirect(`/thank-you?type=${def.thanks}`, 303);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (await leadRateLimited(env, ctx.ip)) return fail(429, 'rate_limited', 'Too many submissions. Please try again shortly.', { retry_after: LEAD_RATE_WINDOW_MIN * 60 });
  if (!(await verifyTurnstile(env, clean(body['cf-turnstile-response'], 4000), ip))) return fail(400, 'turnstile', 'Please complete the verification and try again.');

  // Validate fields.
  const errors = {}, fields = {};
  let name = '', email = '', phone = '', message = '';
  for (const f of def.fields) {
    const raw = clean(body[f.key], f.max || (f.key === 'message' ? 4000 : 200));
    if (f.required && !raw) { errors[f.key] = `${f.label} is required.`; continue; }
    if (raw && f.type === 'email' && !isEmail(raw)) { errors[f.key] = 'Enter a valid email address.'; continue; }
    if (raw && f.type === 'phone' && !isPhone(raw)) { errors[f.key] = 'Enter a valid phone number.'; continue; }
    if (f.key === 'name') name = raw;
    else if (f.key === 'email') email = raw.toLowerCase();
    else if (f.key === 'phone') phone = raw;
    else if (f.key === 'message') message = raw;
    else if (raw) fields[f.key] = raw;
  }
  if (Object.keys(errors).length) return fail(400, 'invalid', 'Please check the highlighted fields.', { fields: errors });

  // Optional attachment.
  let fileKey = null, fileName = null, attachment = null;
  const upload = await validateUpload(body.file);
  if (upload && upload.error) return fail(400, 'invalid', upload.error, { fields: { file: upload.error } });
  if (upload) {
    fileKey = `leads/${newId('f')}.${upload.ext}`;
    const buf = await body.file.arrayBuffer();
    await env.PRIVATE.put(fileKey, buf, { httpMetadata: { contentType: upload.type }, customMetadata: { name: upload.name } });
    fileName = upload.name;
    attachment = { filename: upload.name, content: b64(buf) };
  }

  const utm = {};
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) { const v = clean(body['utm_' + k], 120); if (v) utm[k] = v; }
  const ref = clean(body.ref, 300); if (ref) utm.ref = ref;
  const landing = clean(body.landing, 300); if (landing) utm.landing = landing;
  const page = clean(body.page, 300) || (request.headers.get('Referer') ? new URL(request.headers.get('Referer')).pathname : '');
  const topic = def.topicFormat ? def.topicFormat(def.topicFrom ? fields[def.topicFrom] : '') : '';

  const lead = {
    id: newId('ld'), created_at: nowIso(), form: formId, pipeline: def.pipeline, stage: 'new',
    name, email, phone, topic, message, fields, file_key: fileKey, file_name: fileName, page, utm, ip_hash: ctx.ip, spam_score: 0
  };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO leads (id,created_at,updated_at,form,pipeline,stage,name,email,phone,topic,message,fields,file_key,file_name,page,utm,ip_hash,spam_score,email_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(lead.id, lead.created_at, lead.created_at, formId, def.pipeline, 'new', name, email, phone, topic, message, JSON.stringify(fields), fileKey, fileName, page, JSON.stringify(utm), ctx.ip, 0, 'pending'),
    env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)').bind(newId('a'), lead.id, null, 'created', `${def.label} from the website`, lead.created_at)
  ]);

  // Email in the background so the visitor isn't kept waiting.
  ctx.waitUntil(notifyForLead(env, lead, def, attachment));

  return asJson ? json({ ok: true, id: lead.id, thanks: def.thanks }) : redirect(`/thank-you?type=${def.thanks}`, 303);
}

async function notifyForLead(env, lead, def, attachment) {
  const routes = parseJson(env.NOTIFY_ROUTES, {});
  const override = (await getSetting(env, 'notify_routes')) || {};
  const notifySetting = await getSetting(env, 'notify_emails');
  const to = emailList(override[lead.form] || routes[lead.form] || notifySetting || env.NOTIFY_EMAILS);
  const r = await sendEmail(env, { ...notificationEmail(env, lead, def, attachment), to }, { kind: 'notification', leadId: lead.id });
  await env.DB.prepare('UPDATE leads SET email_status=?, email_error=? WHERE id=?').bind(r.ok ? 'sent' : 'failed', r.ok ? null : r.error, lead.id).run();
  await env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)')
    .bind(newId('a'), lead.id, null, r.ok ? 'email_sent' : 'email_failed', r.ok ? `Notification sent to ${to.join(', ')}` : `Notification failed: ${r.error}`, nowIso()).run();

  // Optional auto-reply (template editable in the portal).
  const templates = (await getSetting(env, 'autoreply_templates')) || {};
  const tpl = { ...def.autoReply, ...(templates[lead.form] || {}) };
  if (tpl.enabled && lead.email) {
    const ar = await sendEmail(env, autoReplyEmail(env, lead, def, tpl), { kind: 'autoreply', leadId: lead.id });
    await env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)')
      .bind(newId('a'), lead.id, null, ar.ok ? 'email_sent' : 'email_failed', ar.ok ? `Auto-reply sent to ${lead.email}` : `Auto-reply failed: ${ar.error}`, nowIso()).run();
  }
}

/**
 * Safety net run from the cron: leads whose notification never left `pending`
 * (e.g. the Worker was interrupted mid-send) get their emails sent now.
 */
export async function retryPendingNotifications(env) {
  const { forms } = getConfig(env);
  const cutoff = new Date(Date.now() - 10 * 60000).toISOString();
  const rows = (await env.DB.prepare("SELECT * FROM leads WHERE email_status='pending' AND created_at<? ORDER BY created_at LIMIT 20").bind(cutoff).all()).results;
  for (const row of rows) {
    const def = forms[row.form];
    if (!def) { await env.DB.prepare("UPDATE leads SET email_status='skipped' WHERE id=?").bind(row.id).run(); continue; }
    const lead = { ...row, fields: parseJson(row.fields, {}), utm: parseJson(row.utm, {}) };
    let attachment = null;
    if (row.file_key) {
      const obj = await env.PRIVATE.get(row.file_key);
      if (obj) attachment = { filename: row.file_name || 'attachment', content: b64(await obj.arrayBuffer()) };
    }
    await notifyForLead(env, lead, def, attachment);
  }
  return rows.length;
}

// ---------- shaping ----------
function shapeLead(row, cfg) {
  const def = cfg.forms[row.form] || { label: row.form };
  const pl = cfg.pipelines[row.pipeline] || { stages: {} };
  return {
    id: row.id, created_at: row.created_at, updated_at: row.updated_at, form: row.form, form_label: def.label,
    pipeline: row.pipeline, stage: row.stage, stage_label: pl.stages[row.stage] || row.stage,
    name: row.name, email: row.email, phone: row.phone, topic: row.topic, message: row.message,
    fields: parseJson(row.fields, {}), has_file: !!row.file_key, file_name: row.file_name, page: row.page,
    utm: parseJson(row.utm, {}), email_status: row.email_status, email_error: row.email_error
  };
}

function leadFilters(ctx, cfg) {
  const q = ctx.url.searchParams;
  const where = [], args = [];
  const form = clean(q.get('form'), 40);
  if (form && cfg.forms[form]) { where.push('form=?'); args.push(form); }
  const pipeline = clean(q.get('pipeline'), 40);
  if (pipeline && cfg.pipelines[pipeline]) { where.push('pipeline=?'); args.push(pipeline); }
  const stage = clean(q.get('stage'), 20);
  if (stage && STAGES.includes(stage)) { where.push('stage=?'); args.push(stage); }
  const r = resolveRange(q.get('range') || 'any', q.get('from'), q.get('to'), ctx.env.TIMEZONE);
  if (r.from) { where.push('created_at>=?'); args.push(r.from); }
  if (r.to) { where.push('created_at<?'); args.push(r.to); }
  const s = clean(q.get('q'), 100);
  if (s) { where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR topic LIKE ? OR message LIKE ?)'); for (let i = 0; i < 5; i++) args.push(`%${s}%`); }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args, range: r };
}

export async function listLeads(ctx) {
  const { env } = ctx;
  const cfg = getConfig(env);
  const { where, args } = leadFilters(ctx, cfg);
  const page = Math.max(1, parseInt(ctx.url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50));
  const sort = ctx.url.searchParams.get('sort') === 'oldest' ? 'ASC' : 'DESC';
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads ${where}`).bind(...args).first()).n;
  const rows = (await env.DB.prepare(`SELECT * FROM leads ${where} ORDER BY created_at ${sort} LIMIT ? OFFSET ?`).bind(...args, limit, (page - 1) * limit).all()).results;
  // Counts ignore the form/stage filter so tabs stay informative, but respect the date/search filter.
  const { where: w2, args: a2 } = leadFilters({ ...ctx, url: stripParams(ctx.url, ['form', 'pipeline', 'stage', 'page']) }, cfg);
  const byForm = {}, byStage = {};
  for (const r of (await env.DB.prepare(`SELECT form, stage, COUNT(*) AS n FROM leads ${w2} GROUP BY form, stage`).bind(...a2).all()).results) {
    byForm[r.form] = (byForm[r.form] || 0) + r.n;
    byStage[r.stage] = (byStage[r.stage] || 0) + r.n;
  }
  return json({ items: rows.map((r) => shapeLead(r, cfg)), total, page, limit, counts: { by_form: byForm, by_stage: byStage } });
}
function stripParams(url, keys) { const u = new URL(url); keys.forEach((k) => u.searchParams.delete(k)); return u; }

export async function exportLeads(ctx) {
  const { env } = ctx;
  const cfg = getConfig(env);
  const { where, args } = leadFilters(ctx, cfg);
  const rows = (await env.DB.prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT 20000`).bind(...args).all()).results;
  const extraKeys = new Set();
  const shaped = rows.map((r) => shapeLead(r, cfg));
  shaped.forEach((l) => Object.keys(l.fields).forEach((k) => extraKeys.add(k)));
  const extra = [...extraKeys];
  const head = ['id', 'received', 'form', 'stage', 'name', 'email', 'phone', 'topic', 'message', ...extra, 'page', 'utm_source', 'utm_medium', 'utm_campaign', 'attachment'];
  const lines = [head.join(',')];
  for (const l of shaped) {
    lines.push([l.id, l.created_at, l.form_label, l.stage_label, l.name, l.email, l.phone, l.topic, l.message, ...extra.map((k) => l.fields[k] || ''), l.page, l.utm.source || '', l.utm.medium || '', l.utm.campaign || '', l.file_name || ''].map(csvCell).join(','));
  }
  await audit(ctx, 'lead_export', '', `${shaped.length} rows · ${ctx.url.search}`);
  return new Response(lines.join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="leads-${nowIso().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' }
  });
}

export async function getLead(ctx) {
  const { env } = ctx;
  const cfg = getConfig(env);
  const row = await env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(ctx.params.id).first();
  if (!row) return error(404, 'not_found', 'Lead not found.');
  const mask = await actorMask(ctx);
  const notes = (await env.DB.prepare('SELECT n.id, n.body, n.created_at, n.user_id, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.lead_id=? ORDER BY n.created_at DESC').bind(row.id).all()).results
    .map(({ user_id, ...n }) => ({ ...n, user_name: mask(user_id, n.user_name || (user_id ? 'Former team member' : null)) }));
  const activity = (await env.DB.prepare('SELECT a.action, a.detail, a.created_at, a.user_id, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.lead_id=? ORDER BY a.created_at DESC LIMIT 100').bind(row.id).all()).results
    .map(({ user_id, ...a }) => ({ ...a, user_name: mask(user_id, a.user_name || (user_id ? 'Former team member' : null)) }));
  return json({ lead: shapeLead(row, cfg), notes, activity });
}

export async function updateLead(ctx) {
  const { env } = ctx;
  const cfg = getConfig(env);
  const body = await readBody(ctx.request);
  const stage = clean(body.stage, 20);
  if (!STAGES.includes(stage)) return error(400, 'invalid', 'Unknown stage.', { fields: { stage: 'Unknown stage' } });
  const row = await env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(ctx.params.id).first();
  if (!row) return error(404, 'not_found', 'Lead not found.');
  if (row.stage !== stage) {
    const pl = cfg.pipelines[row.pipeline] || { stages: {} };
    const detail = `${pl.stages[row.stage] || row.stage} → ${pl.stages[stage] || stage}`;
    await env.DB.batch([
      env.DB.prepare('UPDATE leads SET stage=?, updated_at=? WHERE id=?').bind(stage, nowIso(), row.id),
      env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)').bind(newId('a'), row.id, ctx.user.id, 'stage', detail, nowIso())
    ]);
    await audit(ctx, 'lead_stage', row.id, detail);
    row.stage = stage;
  }
  return json({ ok: true, lead: shapeLead(row, cfg) });
}

export async function addNote(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const text = clean(body.body, 4000);
  if (!text) return error(400, 'invalid', 'Write something first.', { fields: { body: 'Write something first.' } });
  const row = await env.DB.prepare('SELECT id FROM leads WHERE id=?').bind(ctx.params.id).first();
  if (!row) return error(404, 'not_found', 'Lead not found.');
  const note = { id: newId('n'), lead_id: row.id, user_id: ctx.user.id, body: text, created_at: nowIso() };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (id,lead_id,user_id,body,created_at) VALUES (?,?,?,?,?)').bind(note.id, note.lead_id, note.user_id, note.body, note.created_at),
    env.DB.prepare('INSERT INTO activity (id,lead_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?,?)').bind(newId('a'), row.id, ctx.user.id, 'note', text.slice(0, 140), note.created_at),
    env.DB.prepare('UPDATE leads SET updated_at=? WHERE id=?').bind(note.created_at, row.id)
  ]);
  await audit(ctx, 'lead_note', row.id, '');
  return json({ ok: true, note: { ...note, user_name: ctx.user.name } });
}

export async function deleteLead(ctx) {
  const { env } = ctx;
  const row = await env.DB.prepare('SELECT * FROM leads WHERE id=?').bind(ctx.params.id).first();
  if (!row) return error(404, 'not_found', 'Lead not found.');
  if (row.file_key) { try { await env.PRIVATE.delete(row.file_key); } catch { /* ignore */ } }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM notes WHERE lead_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM activity WHERE lead_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM leads WHERE id=?').bind(row.id)
  ]);
  await audit(ctx, 'lead_delete', row.id, `${row.form} · ${row.name || row.email}`);
  return json({ ok: true });
}

export async function leadFile(ctx) {
  const { env } = ctx;
  const row = await env.DB.prepare('SELECT file_key, file_name FROM leads WHERE id=?').bind(ctx.params.id).first();
  if (!row || !row.file_key) return error(404, 'not_found', 'No attachment.');
  const obj = await env.PRIVATE.get(row.file_key);
  if (!obj) return error(404, 'not_found', 'File is missing from storage.');
  const name = (row.file_name || 'attachment').replace(/["\r\n]/g, '');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    }
  });
}

// ---------- dashboard ----------
export async function dashboard(ctx) {
  const { env } = ctx;
  const cfg = getConfig(env);
  const q = ctx.url.searchParams;
  const r = resolveRange(q.get('range') || 'week', q.get('from'), q.get('to'), env.TIMEZONE);
  const where = [], args = [];
  if (r.from) { where.push('created_at>=?'); args.push(r.from); }
  if (r.to) { where.push('created_at<?'); args.push(r.to); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const newCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE stage='new'").first()).n;
  const inRange = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads ${w}`).bind(...args).first()).n;
  const byForm = {};
  for (const id of Object.keys(cfg.forms)) byForm[id] = { label: cfg.forms[id].label, total: 0, won: 0, new: 0 };
  for (const row of (await env.DB.prepare(`SELECT form, stage, COUNT(*) AS n FROM leads ${w} GROUP BY form, stage`).bind(...args).all()).results) {
    if (!byForm[row.form]) byForm[row.form] = { label: row.form, total: 0, won: 0, new: 0 };
    byForm[row.form].total += row.n;
    if (row.stage === 'won') byForm[row.form].won += row.n;
    if (row.stage === 'new') byForm[row.form].new += row.n;
  }
  const mask = await actorMask(ctx);
  const recent = (await env.DB.prepare(
    'SELECT a.id, a.action, a.detail, a.lead_id, a.created_at, a.user_id, l.name AS lead_name, l.email AS lead_email, u.name AS user_name FROM activity a LEFT JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 15'
  ).all()).results.map(({ user_id, ...r }) => ({ ...r, user_name: mask(user_id, r.user_name) }));
  const email = await emailHealth(env);
  const warnings = [];
  if (!email.connected) warnings.push('Resend is not connected: lead notifications are not being emailed. Add a key in Settings.');
  if (email.failed) warnings.push(`${email.failed} email${email.failed === 1 ? '' : 's'} failed in the last 7 days.`);
  if (!(await resolveSecret(env, 'turnstile')).value) warnings.push('Turnstile is not enabled: forms rely on the honeypot and rate limit only.');
  if (env.FORMS_JSON) { try { JSON.parse(env.FORMS_JSON); } catch { warnings.push('FORMS_JSON is not valid JSON; using the built-in form definitions.'); } }
  return json({ new: newCount, in_range: inRange, range: r.key, range_label: r.key === 'week' ? 'This week' : 'In range', by_form: byForm, email, recent, warnings });
}

export { sha256Hex };

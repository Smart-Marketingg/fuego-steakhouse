// Automations: per-form auto-reply templates and the weekly AI summary (cron).
import { json, error, clean, readBody, isEmail, nowIso, localNow, escapeHtml, emailList, fmtDate } from './util.js';
import { getSetting, setSetting, resolveSecret } from './settings-crypto.js';
import { getConfig } from './forms.config.js';
import { sendEmail, autoReplyEmail, weeklySummaryEmail, PLACEHOLDERS, fillTemplate } from './email.js';
import { weeklyAnalytics } from './analytics.js';
import { audit } from './audit.js';

const SAMPLE_LEAD = (form) => ({
  id: 'ld_sample', name: 'Daniela Ortiz', email: 'daniela@example.com', phone: '(201) 555-0142', message: 'Celebrating a birthday, window table if possible.',
  fields: form === 'event' ? { date: 'Saturday, November 14', guests: '40' } : form === 'reservation' ? { date: 'Saturday, October 24', time: '8:30 PM', party: '6' } : form === 'contact' ? { subject: 'Question about brunch' } : {},
  created_at: nowIso()
});

async function templates(env) {
  const { forms } = getConfig(env);
  const saved = (await getSetting(env, 'autoreply_templates')) || {};
  const out = {};
  for (const [id, def] of Object.entries(forms)) out[id] = { label: def.label, ...def.autoReply, ...(saved[id] || {}) };
  return out;
}

export async function getAutomations(ctx) {
  const { env } = ctx;
  const weekly = (await getSetting(env, 'weekly_summary')) || {};
  const admins = (await env.DB.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all()).results.map((r) => r.email);
  return json({
    templates: await templates(env),
    weekly: { enabled: weekly.enabled !== false, last_run_at: weekly.last_run_at || null, recipients: weekly.recipients || admins.join(', '), hour: env.WEEKLY_SUMMARY_HOUR || '8', timezone: env.TIMEZONE },
    placeholders: PLACEHOLDERS,
    ai_connected: !!(await resolveSecret(env, 'anthropic')).value,
    email_connected: !!(await resolveSecret(env, 'resend')).value
  });
}

export async function putAutomations(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const { forms } = getConfig(env);
  const changed = [];
  if (body.templates && typeof body.templates === 'object') {
    const saved = (await getSetting(env, 'autoreply_templates')) || {};
    for (const [id, t] of Object.entries(body.templates)) {
      if (!forms[id] || typeof t !== 'object') continue;
      saved[id] = { enabled: !!t.enabled, subject: clean(t.subject, 200) || forms[id].autoReply.subject, body: clean(t.body, 4000) || forms[id].autoReply.body };
      changed.push(`template:${id}`);
    }
    await setSetting(env, 'autoreply_templates', saved, ctx.user.id);
  }
  if (body.weekly && typeof body.weekly === 'object') {
    const w = (await getSetting(env, 'weekly_summary')) || {};
    if (body.weekly.enabled !== undefined) w.enabled = !!body.weekly.enabled;
    if (body.weekly.recipients !== undefined) w.recipients = emailList(body.weekly.recipients).join(', ');
    await setSetting(env, 'weekly_summary', w, ctx.user.id);
    changed.push('weekly');
  }
  await audit(ctx, 'automation_update', '', changed.join(', '));
  return json({ ok: true });
}

export async function previewAutoReply(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const { forms } = getConfig(env);
  const form = clean(body.form, 40);
  if (!forms[form]) return error(400, 'invalid', 'Unknown form.');
  const tpl = { ...(await templates(env))[form] };
  if (typeof body.subject === 'string') tpl.subject = clean(body.subject, 200);
  if (typeof body.body === 'string') tpl.body = clean(body.body, 4000);
  const msg = autoReplyEmail(env, SAMPLE_LEAD(form), forms[form], tpl);
  return json({ html: msg.html, subject: msg.subject });
}

export async function testAutoReply(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const { forms } = getConfig(env);
  const form = clean(body.form, 40), to = clean(body.to, 254).toLowerCase();
  if (!forms[form]) return error(400, 'invalid', 'Unknown form.');
  if (!isEmail(to)) return error(400, 'invalid', 'Enter a valid email.', { fields: { to: 'Enter a valid email.' } });
  if (!(await resolveSecret(env, 'resend')).value) return json({ ok: false, error: 'not_connected', message: 'Resend is not connected.' });
  const tpl = (await templates(env))[form];
  const r = await sendEmail(env, { ...autoReplyEmail(env, SAMPLE_LEAD(form), forms[form], tpl), to, subject: `[Test] ${fillTemplate(tpl.subject, SAMPLE_LEAD(form), env)}` }, { kind: 'test' });
  await audit(ctx, 'automation_test', form, `to ${to} · ${r.ok ? 'sent' : r.error}`);
  return r.ok ? json({ ok: true }) : json({ ok: false, error: 'send_failed', message: r.error });
}

// ---------- weekly AI summary ----------
export async function testAnthropic(env) {
  const key = (await resolveSecret(env, 'anthropic')).value;
  if (!key) return { ok: false, error: 'No Anthropic API key set.' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) return { ok: false, error: `Anthropic answered HTTP ${res.status}` };
    return { ok: true, detail: 'Connected.' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

async function summarize(env, facts) {
  const key = (await resolveSecret(env, 'anthropic')).value;
  const fallback = () => `<p>${escapeHtml(facts.plain)}</p>`;
  if (!key) return { html: fallback(), ai: false };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 700,
        system: `You write a short, warm weekly summary for the owner of ${env.BUSINESS_NAME || 'a restaurant'}. Plain language, no jargon, no markdown headings. 3 short paragraphs max, then up to 3 bullet suggestions starting with "- ". Only use the facts given; never invent numbers.`,
        messages: [{ role: 'user', content: `Facts for the week:\n${facts.plain}\n\nLeads in detail (newest first, up to 40):\n${facts.detail}` }]
      })
    });
    if (!res.ok) return { html: fallback(), ai: false };
    const j = await res.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (!text) return { html: fallback(), ai: false };
    const html = text.split(/\n{2,}/).map((p) => {
      const lines = p.split('\n');
      if (lines.every((l) => /^-\s/.test(l))) return `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^-\s/, ''))}</li>`).join('')}</ul>`;
      return `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return { html, ai: true };
  } catch { return { html: fallback(), ai: false }; }
}

/** Builds and sends the weekly summary. Returns {sent_to, ai}. */
export async function runWeeklySummary(env, { force = false } = {}) {
  const w = (await getSetting(env, 'weekly_summary')) || {};
  if (w.enabled === false && !force) return { skipped: 'disabled' };
  const { forms, pipelines } = getConfig(env);
  const L = localNow(env.TIMEZONE);
  const weekKey = `${L.y}-W${Math.ceil(((Date.UTC(L.y, L.m - 1, L.d) - Date.UTC(L.y, 0, 1)) / 86400000 + 1) / 7)}`;
  if (!force && w.last_week_key === weekKey) return { skipped: 'already sent this week' };

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = (await env.DB.prepare('SELECT * FROM leads WHERE created_at>=? ORDER BY created_at DESC').bind(since).all()).results;
  // New leads per form this week; "won" is counted separately by when the stage changed (updated_at).
  const byForm = {};
  for (const r of rows) { byForm[r.form] = byForm[r.form] || { total: 0 }; byForm[r.form].total++; }
  const won = (await env.DB.prepare("SELECT form, COUNT(*) AS n FROM leads WHERE stage='won' AND updated_at>=? GROUP BY form").bind(since).all()).results;
  const open = (await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE stage='new'").first()).n;
  const emailAgg = await env.DB.prepare('SELECT SUM(ok) AS sent, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed FROM email_log WHERE at>=?').bind(since).first();
  const ga = await weeklyAnalytics(env);

  const stats = { 'New leads': rows.length, 'Still waiting for a first reply': open };
  for (const [id, s] of Object.entries(byForm)) stats[forms[id] ? forms[id].label : id] = `${s.total} new · ${(won.find((x) => x.form === id) || { n: 0 }).n} ${pipelines[forms[id]?.pipeline]?.wonLabel || 'won'}`;
  if (ga) { stats['Website sessions'] = ga.sessions; stats['Website users'] = ga.users; stats['Top channels'] = ga.sources; }
  stats['Emails sent / failed'] = `${emailAgg.sent || 0} / ${emailAgg.failed || 0}`;

  const plain = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n');
  const detail = rows.slice(0, 40).map((r) => `${fmtDate(r.created_at, env.TIMEZONE, { dateStyle: 'short', timeStyle: 'short' })} · ${forms[r.form]?.label || r.form} · ${r.name || r.email} · ${r.topic || ''} · stage ${r.stage}${r.message ? ' · "' + r.message.slice(0, 120) + '"' : ''}`).join('\n');
  const summary = await summarize(env, { plain, detail });

  const admins = (await env.DB.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all()).results.map((r) => r.email);
  const to = emailList(w.recipients).length ? emailList(w.recipients) : admins;
  const end = new Date(), start = new Date(Date.now() - 7 * 86400000);
  const periodLabel = `${fmtDate(start.toISOString(), env.TIMEZONE, { dateStyle: 'medium', timeStyle: undefined }).replace(/,?\s\d{1,2}:\d{2}.*$/, '')} – ${fmtDate(end.toISOString(), env.TIMEZONE, { dateStyle: 'medium', timeStyle: undefined }).replace(/,?\s\d{1,2}:\d{2}.*$/, '')}`;
  const r = await sendEmail(env, weeklySummaryEmail(env, { periodLabel, summaryHtml: summary.html, stats, to }), { kind: 'weekly' });
  await setSetting(env, 'weekly_summary', { ...w, last_run_at: nowIso(), last_week_key: weekKey, last_ok: r.ok, last_error: r.ok ? null : r.error }, null);
  try {
    await env.DB.prepare('INSERT INTO audit_log (user_id, action, target, detail, at) VALUES (NULL, ?, ?, ?, ?)').bind('weekly_summary', to.join(','), r.ok ? `sent${summary.ai ? ' (AI)' : ' (plain)'}` : `failed: ${r.error}`, nowIso()).run();
  } catch { /* ignore */ }
  return { sent_to: to, ai: summary.ai, ok: r.ok, error: r.error };
}

export async function runWeeklyNow(ctx) {
  const r = await runWeeklySummary(ctx.env, { force: true });
  await audit(ctx, 'weekly_summary', (r.sent_to || []).join(','), r.ok ? 'manual run' : `manual run failed: ${r.error}`);
  return r.ok ? json({ ok: true, sent_to: r.sent_to, ai: r.ai }) : json({ ok: false, error: r.error || 'send_failed' });
}

/** Called from the cron trigger: only runs at WEEKLY_SUMMARY_HOUR local time on Mondays. */
export async function scheduledWeekly(env) {
  const L = localNow(env.TIMEZONE);
  if (L.wd !== 1 || L.h !== parseInt(env.WEEKLY_SUMMARY_HOUR || '8', 10)) return { skipped: 'not the scheduled hour' };
  return runWeeklySummary(env);
}

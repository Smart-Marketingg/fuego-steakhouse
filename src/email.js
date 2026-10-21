// Email: Resend transport + branded HTML templates.
// Every template is table-based with bgcolor attributes for email clients.
// Inside single-quoted style attributes font names use &quot; never single quotes.
// Nothing business-specific is hard-coded: names, colors, addresses come from vars.

import { escapeHtml as esc, firstName, nowIso, emailList, fmtDate, parseJson } from './util.js';
import { resolveSecret } from './settings-crypto.js';

// ---------- transport ----------
/**
 * Send through Resend. Never throws: returns {ok, id?, error?} and logs to email_log.
 * opts: { kind, leadId }
 */
export async function sendEmail(env, msg, opts = {}) {
  const key = (await resolveSecret(env, 'resend')).value;
  const to = Array.isArray(msg.to) ? msg.to : emailList(msg.to);
  const log = async (ok, errorText, id) => {
    try {
      await env.DB.prepare('INSERT INTO email_log (lead_id, kind, to_addr, ok, error, at) VALUES (?,?,?,?,?,?)')
        .bind(opts.leadId || null, opts.kind || 'other', to.join(','), ok ? 1 : 0, errorText || null, nowIso()).run();
    } catch { /* ignore */ }
    return ok ? { ok: true, id } : { ok: false, error: errorText };
  };
  if (!key) return log(false, 'Resend not connected');
  if (!to.length) return log(false, 'No recipient');
  const payload = {
    from: msg.from || env.MAIL_FROM, to, subject: msg.subject, html: msg.html, text: msg.text,
    reply_to: msg.replyTo || env.MAIL_REPLY_TO || undefined,
    attachments: msg.attachments && msg.attachments.length ? msg.attachments : undefined
  };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { const j = await res.json(); detail = j.message || j.error || detail; } catch { /* ignore */ }
      return log(false, detail);
    }
    const j = await res.json();
    return log(true, null, j.id);
  } catch (e) {
    return log(false, String(e && e.message || e));
  }
}

/** Quick connectivity test for the Settings page (lists domains). */
export async function testResend(env) {
  const key = (await resolveSecret(env, 'resend')).value;
  if (!key) return { ok: false, error: 'No Resend API key set.' };
  try {
    const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
      // A "sending access" key can send but cannot list domains: that is still a working key.
      if (/restricted|only send/i.test(msg)) return { ok: true, detail: 'Key accepted (sending-only key, so domain status cannot be checked here). Use "Send test" in Automations to confirm delivery.' };
      return { ok: false, error: `Resend rejected the key: ${msg}` };
    }
    const j = await res.json();
    const fromDomain = ((env.MAIL_FROM || '').match(/@([^>\s]+)/) || [])[1];
    const d = (j.data || []).find((x) => x.name === fromDomain);
    if (!d) return { ok: true, detail: `Connected. Note: ${fromDomain || 'the sending domain'} is not added in Resend yet.` };
    return { ok: true, detail: `Connected. ${d.name} is ${d.status}.` };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- brand frame ----------
function brand(env) {
  return {
    name: env.BUSINESS_NAME || 'Our team',
    gold: env.BRAND_COLOR || '#c89a52',
    bg: env.BRAND_BG || '#100c0a',
    ink: env.BRAND_INK || '#f3ece1',
    dim: '#b1a594',
    card: '#1b1512',
    line: '#2b231e',
    logo: env.LOGO_URL || '',
    address: env.BUSINESS_ADDRESS || '',
    phone: env.BUSINESS_PHONE || '',
    site: env.SITE_URL || '',
    tz: env.TIMEZONE || 'UTC'
  };
}
const FONT_HEAD = 'font-family:&quot;DM Serif Display&quot;,Georgia,&quot;Times New Roman&quot;,serif;';
const FONT_BODY = 'font-family:&quot;Mulish&quot;,Helvetica,Arial,sans-serif;';

function button(href, label, b, primary = true) {
  const style = primary
    ? `display:inline-block;padding:14px 26px;background:${b.gold};color:#1a1207;${FONT_BODY}font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;text-decoration:none;border-radius:4px;`
    : `display:inline-block;padding:13px 26px;border:1px solid ${b.gold};color:${b.ink};${FONT_BODY}font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;text-decoration:none;border-radius:4px;`;
  return `<td style='padding:0 12px 12px 0;'><a href='${esc(href)}' bgcolor='${primary ? b.gold : b.bg}' style='${style}'>${esc(label)}</a></td>`;
}

/** Wraps content in the branded frame. preheader is hidden preview text. */
export function frame(env, { eyebrow, title, intro, bodyHtml, buttons = [], footerNote = '', preheader = '' }) {
  const b = brand(env);
  const logo = b.logo
    ? `<img src='${esc(b.logo)}' width='96' height='96' alt='${esc(b.name)}' style='display:block;width:96px;height:96px;border:0;'>`
    : `<span style='${FONT_HEAD}font-size:28px;color:${b.ink};'>${esc(b.name)}</span>`;
  return `<!DOCTYPE html>
<html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>${esc(title)}</title></head>
<body bgcolor='${b.bg}' style='margin:0;padding:0;background:${b.bg};'>
<span style='display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;'>${esc(preheader)}</span>
<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' bgcolor='${b.bg}' style='background:${b.bg};'>
<tr><td align='center' style='padding:32px 16px;'>
<table role='presentation' width='600' cellpadding='0' cellspacing='0' border='0' style='max-width:600px;width:100%;'>
  <tr><td align='center' style='padding:0 0 24px;'>${logo}</td></tr>
  <tr><td bgcolor='${b.card}' style='background:${b.card};border:1px solid ${b.line};border-radius:4px;padding:36px 36px 28px;'>
    ${eyebrow ? `<p style='margin:0 0 14px;${FONT_BODY}font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${b.gold};'>${esc(eyebrow)}</p>` : ''}
    <h1 style='margin:0 0 16px;${FONT_HEAD}font-size:34px;line-height:1.1;font-weight:400;color:${b.ink};'>${esc(title)}</h1>
    ${intro ? `<p style='margin:0 0 22px;${FONT_BODY}font-size:16px;line-height:1.65;color:${b.dim};'>${intro}</p>` : ''}
    ${bodyHtml || ''}
    ${buttons.length ? `<table role='presentation' cellpadding='0' cellspacing='0' border='0' style='margin-top:22px;'><tr>${buttons.map((x, i) => button(x.href, x.label, b, i === 0)).join('')}</tr></table>` : ''}
    ${footerNote ? `<p style='margin:22px 0 0;${FONT_BODY}font-size:13px;line-height:1.6;color:${b.dim};'>${footerNote}</p>` : ''}
  </td></tr>
  <tr><td align='center' style='padding:26px 12px 0;${FONT_BODY}font-size:12px;line-height:1.7;color:#847a6c;'>
    <strong style='color:${b.dim};'>${esc(b.name)}</strong><br>${esc(b.address)}${b.site ? `<br><a href='${esc(b.site)}' style='color:${b.gold};text-decoration:none;'>${esc(b.site.replace(/^https?:\/\//, ''))}</a>` : ''}
  </td></tr>
</table></td></tr></table></body></html>`;
}

function fieldTable(env, rows) {
  const b = brand(env);
  const tr = rows.filter((r) => r.value).map((r, i) => {
    let v = esc(r.value);
    if (r.type === 'email') v = `<a href='mailto:${esc(r.value)}' style='color:${b.gold};text-decoration:none;'>${v}</a>`;
    if (r.type === 'phone') v = `<a href='tel:${esc(String(r.value).replace(/[^\d+]/g, ''))}' style='color:${b.gold};text-decoration:none;'>${v}</a>`;
    return `<tr><td bgcolor='${i % 2 ? b.card : '#211915'}' style='padding:10px 14px;${FONT_BODY}font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${b.dim};width:36%;border-bottom:1px solid ${b.line};'>${esc(r.label)}</td>` +
      `<td bgcolor='${i % 2 ? b.card : '#211915'}' style='padding:10px 14px;${FONT_BODY}font-size:15px;color:${b.ink};border-bottom:1px solid ${b.line};'>${v}</td></tr>`;
  }).join('');
  return `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' style='border:1px solid ${b.line};border-radius:4px;border-collapse:separate;overflow:hidden;'>${tr}</table>`;
}
function messageBox(env, label, text) {
  const b = brand(env);
  if (!text) return '';
  return `<table role='presentation' width='100%' cellpadding='0' cellspacing='0' border='0' style='margin-top:18px;'><tr><td bgcolor='#140f0c' style='background:#140f0c;border-left:3px solid ${b.gold};padding:16px 18px;'>` +
    `<p style='margin:0 0 6px;${FONT_BODY}font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${b.gold};'>${esc(label)}</p>` +
    `<p style='margin:0;${FONT_BODY}font-size:15px;line-height:1.65;color:${b.ink};white-space:pre-wrap;'>${esc(text)}</p></td></tr></table>`;
}

// ---------- templates ----------
/** Staff notification for a new lead. */
export function notificationEmail(env, lead, formDef, attachment) {
  const b = brand(env);
  const rows = [];
  for (const f of formDef.fields) {
    if (f.key === 'message') continue;
    const value = ['name', 'email', 'phone'].includes(f.key) ? lead[f.key] : lead.fields[f.key];
    rows.push({ label: f.label, value, type: f.type });
  }
  rows.push({ label: 'Received', value: fmtDate(lead.created_at, b.tz) });
  if (lead.page) rows.push({ label: 'Page', value: lead.page });
  const utm = lead.utm || {};
  const src = [utm.source && `source ${utm.source}`, utm.medium && `medium ${utm.medium}`, utm.campaign && `campaign ${utm.campaign}`].filter(Boolean).join(' · ');
  if (src) rows.push({ label: 'Attribution', value: src });
  const crmLink = `${b.site}/admin/#lead=${lead.id}`;
  const subject = `${b.name} - ${formDef.label} - ${lead.name || lead.email}`;
  const html = frame(env, {
    eyebrow: formDef.eyebrow || formDef.label,
    title: lead.name || lead.email,
    intro: `A new ${esc(formDef.label.toLowerCase())} just came in from the website.`,
    bodyHtml: fieldTable(env, rows) + messageBox(env, 'Message', lead.message) + (attachment ? `<p style='margin:14px 0 0;${FONT_BODY}font-size:13px;color:${b.dim};'>Attachment: ${esc(attachment.filename)} (also in the CRM)</p>` : ''),
    buttons: [
      ...(lead.email ? [{ href: `mailto:${lead.email}?subject=${encodeURIComponent(`Re: your ${formDef.label.toLowerCase()} — ${b.name}`)}`, label: `Reply to ${firstName(lead.name)}` }] : []),
      { href: crmLink, label: 'Open in CRM' }
    ],
    preheader: `${formDef.label}: ${lead.name || lead.email}${lead.topic ? ' · ' + lead.topic : ''}`
  });
  const text = `${formDef.label} from ${lead.name || lead.email}\n\n` + rows.map((r) => `${r.label}: ${r.value || ''}`).join('\n') + (lead.message ? `\n\nMessage:\n${lead.message}` : '') + `\n\nOpen in CRM: ${crmLink}`;
  return { subject, html, text, replyTo: lead.email || undefined, attachments: attachment ? [attachment] : undefined };
}

export const PLACEHOLDERS = ['{first_name}', '{name}', '{email}', '{date}', '{time}', '{party}', '{guests}', '{subject}', '{business}', '{phone_number}', '{for_date}'];

export function fillTemplate(str, lead, env) {
  const f = lead.fields || {};
  const map = {
    first_name: firstName(lead.name), name: lead.name || 'there', email: lead.email || '',
    date: f.date || '', time: f.time || '', party: f.party ? (/^\d+$/.test(f.party) ? `a party of ${f.party}` : f.party) : 'your party',
    guests: f.guests || '', subject: f.subject || '', business: env.BUSINESS_NAME || '', phone_number: env.BUSINESS_PHONE || '',
    for_date: f.date ? ` for ${f.date}` : ''
  };
  return String(str || '').replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

/** Guest auto-reply from a per-form template {subject, body}. */
export function autoReplyEmail(env, lead, formDef, template) {
  const b = brand(env);
  const subject = fillTemplate(template.subject, lead, env);
  const body = fillTemplate(template.body, lead, env);
  const rows = [];
  for (const f of formDef.fields) {
    if (['name', 'email', 'phone', 'message'].includes(f.key)) continue;
    const v = lead.fields[f.key];
    if (v) rows.push({ label: f.label, value: v });
  }
  const html = frame(env, {
    eyebrow: formDef.eyebrow || formDef.label,
    title: `Thank you, ${firstName(lead.name)}.`,
    intro: esc(body).replace(/\n/g, '<br>'),
    bodyHtml: rows.length ? `<p style='margin:0 0 8px;${FONT_BODY}font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${b.gold};'>Your request</p>` + fieldTable(env, rows) : '',
    buttons: [{ href: `${b.site}/menus`, label: 'View our menus' }, { href: b.site, label: 'Visit the site' }],
    footerNote: `Need to change anything? Reply to this email${b.phone ? ` or call <a href='tel:${esc(b.phone.replace(/[^\d+]/g, ''))}' style='color:${b.gold};text-decoration:none;'>${esc(b.phone)}</a>` : ''}.`,
    preheader: body.slice(0, 120)
  });
  return { subject, html, text: `${body}\n\n${b.name}\n${b.address}`, to: lead.email };
}

export function inviteEmail(env, { name, link, inviter, to }) {
  const b = brand(env);
  return {
    to, subject: `You're invited to the ${b.name} CRM`,
    html: frame(env, {
      eyebrow: 'Team invitation', title: `Welcome, ${firstName(name)}.`,
      intro: `${esc(inviter || 'An admin')} added you to the ${esc(b.name)} CRM. Set your password to get started. This link works once and expires in 24 hours.`,
      buttons: [{ href: link, label: 'Set my password' }],
      footerNote: `If you weren't expecting this, you can ignore it.`
    }),
    text: `You were added to the ${b.name} CRM. Set your password: ${link}`
  };
}
export function resetEmail(env, { name, link, minutes, to }) {
  const b = brand(env);
  return {
    to, subject: `Reset your ${b.name} CRM password`,
    html: frame(env, {
      eyebrow: 'Password reset', title: `Hi ${firstName(name)},`,
      intro: `Use the button below to choose a new password. The link works once and expires in ${minutes} minutes.`,
      buttons: [{ href: link, label: 'Reset password' }],
      footerNote: `Didn't ask for this? Ignore this email and your password stays the same.`
    }),
    text: `Reset your password: ${link} (expires in ${minutes} minutes)`
  };
}

export function weeklySummaryEmail(env, { periodLabel, summaryHtml, stats, to }) {
  const b = brand(env);
  const rows = Object.entries(stats || {}).map(([label, value]) => ({ label, value: String(value) }));
  return {
    to, subject: `${b.name} - Weekly summary - ${periodLabel}`,
    html: frame(env, {
      eyebrow: 'Weekly summary', title: periodLabel,
      intro: 'Here is what happened on the website and in the CRM last week.',
      bodyHtml: fieldTable(env, rows) + `<div style='margin-top:20px;${FONT_BODY}font-size:15px;line-height:1.7;color:${b.ink};'>${summaryHtml}</div>`,
      buttons: [{ href: `${b.site}/admin/`, label: 'Open the CRM' }]
    }),
    text: Object.entries(stats || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  };
}

/** Email delivery health for the dashboard. */
export async function emailHealth(env) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const agg = await env.DB.prepare('SELECT SUM(ok) AS sent, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS failed FROM email_log WHERE at>?').bind(since).first();
  const lastErr = await env.DB.prepare('SELECT error, at FROM email_log WHERE ok=0 ORDER BY at DESC LIMIT 1').first();
  const lastOk = await env.DB.prepare('SELECT at FROM email_log WHERE ok=1 ORDER BY at DESC LIMIT 1').first();
  const connected = !!(await resolveSecret(env, 'resend')).value;
  return { connected, sent: agg.sent || 0, failed: agg.failed || 0, last_error: lastErr ? `${lastErr.error} (${lastErr.at})` : null, last_sent_at: lastOk ? lastOk.at : null };
}

export { parseJson };

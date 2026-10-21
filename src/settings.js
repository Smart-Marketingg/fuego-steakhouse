// Settings (admin): business info, notification routing, encrypted integration keys, connection tests.
import { json, error, clean, readBody, emailList, isEmail } from './util.js';
import { getSetting, setSetting, integrationStatus, resolveSecret, ga4PropertyId, INTEGRATIONS } from './settings-crypto.js';
import { audit } from './audit.js';
import { testResend } from './email.js';
import { testGa4 } from './analytics.js';
import { testAnthropic } from './automation.js';
import { getConfig } from './forms.config.js';

export async function getSettings(ctx) {
  const { env } = ctx;
  const keys = await integrationStatus(env);
  const routesVar = (() => { try { return JSON.parse(env.NOTIFY_ROUTES || '{}'); } catch { return {}; } })();
  return json({
    business: {
      name: env.BUSINESS_NAME || '', site_url: env.SITE_URL || '', address: env.BUSINESS_ADDRESS || '', phone: env.BUSINESS_PHONE || '',
      timezone: env.TIMEZONE || 'UTC', mail_from: env.MAIL_FROM || '', mail_reply_to: env.MAIL_REPLY_TO || '', media_url: env.MEDIA_URL || ''
    },
    notify_emails: (await getSetting(env, 'notify_emails')) || env.NOTIFY_EMAILS || '',
    notify_emails_default: env.NOTIFY_EMAILS || '',
    notify_routes: { ...routesVar, ...((await getSetting(env, 'notify_routes')) || {}) },
    forms: Object.fromEntries(Object.entries(getConfig(env).forms).map(([k, v]) => [k, v.label])),
    keys,
    ga4_property_id: (await getSetting(env, 'ga4_property_id')) || (env.GA4_PROPERTY_ID !== 'none' ? env.GA4_PROPERTY_ID : '') || '',
    turnstile_site_key: (await getSetting(env, 'turnstile_site_key')) || ''
  });
}

export async function putSettings(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const changed = [];
  if (body.notify_emails !== undefined) {
    const list = emailList(body.notify_emails);
    if (String(body.notify_emails).trim() && !list.length) return error(400, 'invalid', 'Enter valid email addresses.', { fields: { notify_emails: 'Enter valid email addresses.' } });
    await setSetting(env, 'notify_emails', list.join(', ') || null, ctx.user.id); changed.push('notify_emails');
  }
  if (body.notify_routes !== undefined && typeof body.notify_routes === 'object') {
    const routes = {};
    for (const [form, v] of Object.entries(body.notify_routes)) { const l = emailList(v); if (l.length) routes[clean(form, 40)] = l.join(', '); }
    await setSetting(env, 'notify_routes', routes, ctx.user.id); changed.push('notify_routes');
  }
  if (body.turnstile_site_key !== undefined) { await setSetting(env, 'turnstile_site_key', clean(body.turnstile_site_key, 100) || null, ctx.user.id); changed.push('turnstile_site_key'); }
  if (body.keys && typeof body.keys === 'object') {
    const allowed = ['resend_api_key', 'turnstile_secret', 'anthropic_api_key', 'ga_service_account', 'ga4_property_id', 'google_client_id', 'google_client_secret'];
    for (const k of allowed) {
      if (body.keys[k] === undefined) continue;
      const v = typeof body.keys[k] === 'string' ? body.keys[k].trim() : '';
      if (k === 'ga4_property_id' && v && !/^\d+$/.test(v)) return error(400, 'invalid', 'GA4 property ID is numeric.', { fields: { ga4_property_id: 'Numbers only.' } });
      if (k === 'ga_service_account' && v) { try { const j = JSON.parse(v); if (!j.client_email || !j.private_key) throw new Error(); } catch { return error(400, 'invalid', 'Paste the full service account JSON.', { fields: { ga_service_account: 'Invalid JSON key file.' } }); } }
      await setSetting(env, k, v || null, ctx.user.id);
      changed.push(k + (v ? '' : ' (removed)'));
    }
  }
  await audit(ctx, 'settings_update', '', changed.join(', '));
  return json({ ok: true, changed });
}

export async function testIntegration(ctx) {
  const { env } = ctx;
  const name = ctx.params.integration;
  let result;
  if (name === 'resend') result = await testResend(env);
  else if (name === 'ga4') result = await testGa4(env);
  else if (name === 'anthropic') result = await testAnthropic(env);
  else if (name === 'turnstile') {
    const secret = (await resolveSecret(env, 'turnstile')).value;
    if (!secret) result = { ok: false, error: 'No Turnstile secret set.' };
    else {
      try {
        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, response: 'test' }) });
        const j = await res.json();
        const codes = j['error-codes'] || [];
        result = codes.includes('invalid-input-secret') ? { ok: false, error: 'Secret rejected by Cloudflare.' } : { ok: true, detail: 'Secret accepted by Cloudflare (token check reported: ' + (codes.join(', ') || 'ok') + ').' };
      } catch (e) { result = { ok: false, error: String(e.message || e) }; }
    }
  } else return error(404, 'not_found', 'Unknown integration.');
  await audit(ctx, 'settings_test', name, result.ok ? 'ok' : `failed: ${result.error}`);
  return json(result);
}

export { INTEGRATIONS, ga4PropertyId, isEmail };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notificationEmail, autoReplyEmail, fillTemplate, frame } from '../src/email.js';
import { getConfig, publicConfig, STAGES, DEFAULT_FORMS, DEFAULT_PIPELINES } from '../src/forms.config.js';
import { encrypt, decrypt } from '../src/settings-crypto.js';

const env = {
  BUSINESS_NAME: 'Fuego Steakhouse & Bar', SITE_URL: 'https://www.fuegosteaks.com', BUSINESS_ADDRESS: '921 JFK Blvd', BUSINESS_PHONE: '(201) 455-6055',
  BRAND_COLOR: '#c89a52', LOGO_URL: 'https://www.fuegosteaks.com/assets/fuego-logo.png', TIMEZONE: 'America/New_York', SETTINGS_KEY: 'test-key'
};
const lead = { id: 'ld_1', created_at: '2026-10-21T18:00:00.000Z', form: 'reservation', name: 'Daniela Ortiz', email: 'd@example.com', phone: '2015550142', topic: 'Party of 6', message: 'Birthday <3', fields: { date: 'Oct 24', time: '8:30 PM', party: '6' }, page: '/', utm: { source: 'google' } };

test('every pipeline has exactly the 5 internal stages', () => {
  for (const [id, p] of Object.entries(DEFAULT_PIPELINES)) {
    assert.deepEqual(Object.keys(p.stages), STAGES, id);
    assert.ok(DEFAULT_FORMS[p.form], `${id} points at a form`);
  }
  for (const f of Object.values(DEFAULT_FORMS)) assert.ok(DEFAULT_PIPELINES[f.pipeline]);
});

test('FORMS_JSON override and public config shape', () => {
  assert.equal(getConfig({ FORMS_JSON: '{bad json' }).forms, DEFAULT_FORMS);
  const pub = publicConfig(env);
  assert.ok(pub.forms.reservation.fields.length);
  assert.equal(JSON.stringify(pub).includes('topicFormat'), false);
});

test('notification email is branded, escaped and has the CRM deep link', () => {
  const m = notificationEmail(env, lead, DEFAULT_FORMS.reservation, null);
  assert.equal(m.subject, 'Fuego Steakhouse & Bar - Reservation - Daniela Ortiz');
  assert.ok(m.html.includes('/admin/#lead=ld_1'));
  assert.ok(m.html.includes('Birthday &lt;3'));
  assert.ok(m.html.includes('mailto:d@example.com'));
  assert.ok(m.html.includes("bgcolor='"));
  assert.ok(!/style='[^']*&#39;/.test(m.html) && !/font-family:[^;"]*'[^;"]*;/.test(m.html.replace(/'(?=[^']*=)/g, '')), 'no single-quoted font names inside style attributes');
  assert.ok(m.html.includes('&quot;DM Serif Display&quot;'));
  assert.equal(m.replyTo, 'd@example.com');
});

test('auto-reply placeholders fill from the lead', () => {
  assert.equal(fillTemplate('Hi {first_name}, {date} at {time} for {party}. {unknown}', lead, env), 'Hi Daniela, Oct 24 at 8:30 PM for a party of 6. {unknown}');
  const m = autoReplyEmail(env, lead, DEFAULT_FORMS.reservation, DEFAULT_FORMS.reservation.autoReply);
  assert.equal(m.to, 'd@example.com');
  assert.ok(m.html.includes('Thank you, Daniela.'));
  assert.ok(m.html.includes('(201) 455-6055'));
});

test('frame has no hard-coded business name', () => {
  const html = frame({ ...env, BUSINESS_NAME: 'Other Biz', SITE_URL: 'https://other.example' }, { title: 'T', bodyHtml: '' });
  assert.ok(!html.includes('Fuego'));
  assert.ok(html.includes('Other Biz'));
});

test('settings encryption round-trips and is key-bound', async () => {
  const ct = await encrypt(env, 're_secret_123');
  assert.notEqual(ct, 're_secret_123');
  assert.equal(await decrypt(env, ct), 're_secret_123');
  await assert.rejects(decrypt({ SETTINGS_KEY: 'other' }, ct));
});

test('schema creates every column the code reads (including users.off)', () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const required = {
    users: ['id', 'email', 'name', 'pass_hash', 'salt', 'role', 'perms', 'off', 'active', 'created_at', 'last_login'],
    sessions: ['token_hash', 'user_id', 'expires_at', 'last_seen', 'remember', 'ip_hash', 'ua'],
    set_tokens: ['token_hash', 'user_id', 'kind', 'expires_at', 'used_at'],
    leads: ['id', 'created_at', 'updated_at', 'form', 'pipeline', 'stage', 'name', 'email', 'phone', 'topic', 'message', 'fields', 'file_key', 'file_name', 'page', 'utm', 'ip_hash', 'spam_score', 'email_status', 'email_error'],
    notes: ['lead_id', 'user_id', 'body'], activity: ['lead_id', 'user_id', 'action', 'detail'], settings: ['key', 'enc_value', 'updated_by', 'updated_at'],
    auth_attempts: ['scope', 'key_hash', 'at', 'ok'], audit_log: ['user_id', 'action', 'target', 'detail', 'ip_hash', 'at'], media: ['key', 'name', 'type', 'size', 'uploaded_by', 'at'],
    email_log: ['lead_id', 'kind', 'to_addr', 'ok', 'error', 'at'], cache: ['key', 'value', 'expires_at']
  };
  for (const [table, cols] of Object.entries(required)) {
    const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([^;]*)\\);`, 's').exec(schema);
    assert.ok(m, `table ${table}`);
    for (const c of cols) assert.ok(new RegExp(`^\\s*${c}\\s`, 'm').test(m[1]), `${table}.${c}`);
  }
  const oneline = readFileSync(new URL('../schema.oneline.sql', import.meta.url), 'utf8').trim();
  assert.equal(oneline.split('\n').length, 1, 'schema.oneline.sql is a single line');
  assert.ok(oneline.includes('off TEXT NOT NULL'));
});

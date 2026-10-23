import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, permissionsFor, sectionsFor, hashPassword, verifyPassword, passwordOk, originAllowed, PERMISSIONS, SECTIONS } from '../src/auth.js';

const admin = { id: 'a', role: 'admin', perms: [], off: [], active: true };
const staff = { id: 's', role: 'staff', perms: [], off: [], active: true };

test('can() has a two-argument signature and enforces roles', () => {
  assert.equal(can.length, 2);
  for (const p of PERMISSIONS) assert.ok(can(admin, p), p);
  assert.ok(can(staff, 'leads.view'));
  assert.ok(!can(staff, 'team.manage'));
  assert.ok(!can(staff, 'leads.delete'));
  assert.ok(!can(null, 'leads.view'));
  assert.ok(!can({ ...admin, active: false }, 'leads.view'));
  assert.ok(!can(admin, 'made.up'));
});

test('extra perms apply to staff but hidden sections win', () => {
  const s = { ...staff, perms: ['leads.export', 'team.manage'] };
  assert.ok(can(s, 'leads.export'));
  assert.ok(can(s, 'team.manage'));
  const hidden = { ...s, off: ['leads'] };
  assert.ok(!can(hidden, 'leads.view'));
  assert.ok(!can(hidden, 'leads.export'));
  assert.ok(!sectionsFor(hidden).includes('leads'));
  assert.ok(sectionsFor(admin).length === SECTIONS.length);
  assert.ok(!sectionsFor(staff).includes('settings'));
  assert.deepEqual(permissionsFor({ ...staff, perms: ['bogus'] }), permissionsFor(staff));
});

test('passwords: PBKDF2 round trip, per-user salt, constant-time verify', async () => {
  const { hash, salt } = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', hash, salt));
  assert.ok(!(await verifyPassword('wrong', hash, salt)));
  const second = await hashPassword('correct horse battery');
  assert.notEqual(second.salt, salt);
  assert.notEqual(second.hash, hash);
  assert.ok(!(await verifyPassword('x', null, null)));
  assert.ok(passwordOk('abcdefghij'));
  assert.ok(!passwordOk('short'));
});

test('originAllowed accepts the site, the request host and only this Worker\'s workers.dev hosts', () => {
  const env = { SITE_URL: 'https://www.fuegosteaks.com', WORKER_NAME: 'fuego-steakhouse' };
  const url = new URL('https://www.fuegosteaks.com/api/lead');
  assert.ok(originAllowed('https://www.fuegosteaks.com', url, env));
  assert.ok(originAllowed('https://fuego-steakhouse-preview.acct.workers.dev', url, env));
  assert.ok(originAllowed('https://fuego-steakhouse.acct.workers.dev', url, env));
  assert.ok(originAllowed('http://127.0.0.1:8788', new URL('http://127.0.0.1:8788/api/lead'), env), 'local dev: origin equals request host');
  assert.ok(!originAllowed('http://localhost:8788', url, env), 'localhost is not special in production');
  assert.ok(!originAllowed('https://evil.workers.dev', url, env));
  assert.ok(!originAllowed('https://notfuego-steakhouse.acct.workers.dev', url, env));
  assert.ok(!originAllowed('https://fuego-steakhouse.acct.workers.dev', url, { SITE_URL: env.SITE_URL }), 'no WORKER_NAME, no workers.dev');
  assert.ok(!originAllowed('https://evil.example', url, env));
  assert.ok(!originAllowed('', url, env));
  assert.ok(!originAllowed('garbage', url, env));
});

import { superEmails, isSuper, userFromRow, agencyLabel, publicUser } from '../src/auth.js';

test('agency accounts come from SUPER_ADMINS and never leak through publicUser()', () => {
  const env = { SUPER_ADMINS: ' Jullien@SmartMarketingg.com, ops@agency.test ' };
  assert.deepEqual(superEmails(env), ['jullien@smartmarketingg.com', 'ops@agency.test']);
  assert.deepEqual(superEmails({}), []);
  const row = { id: 'u1', email: 'jullien@smartmarketingg.com', name: 'J', role: 'admin', perms: '[]', off: '[]', active: 1 };
  const u = userFromRow(env, row);
  assert.equal(u.super, true);
  assert.equal(isSuper(env, { ...u, role: 'staff' }), false, 'a staff row with the email is not an agency account');
  assert.equal(isSuper(env, { email: 'owner@client.test', role: 'admin' }), false);
  assert.equal('super' in publicUser(u), false, 'team/list shaping must not expose the flag');
  assert.equal(agencyLabel({}), 'Smart Marketing');
  assert.equal(agencyLabel({ AGENCY_NAME: 'Agency X' }), 'Agency X');
});

import { requireSuper, PAUSE_PHRASE, RESUME_PHRASE } from '../src/system.js';

test('system routes answer 404 to non-agency users and pass agency users', async () => {
  const mw = requireSuper();
  const r1 = await mw({ user: null });
  assert.equal(r1.status, 401);
  const r2 = await mw({ user: { id: 'x', role: 'admin', super: false } });
  assert.equal(r2.status, 404);
  assert.equal(await mw({ user: { id: 'y', role: 'admin', super: true } }), undefined);
  assert.ok(PAUSE_PHRASE && RESUME_PHRASE && PAUSE_PHRASE !== RESUME_PHRASE);
});

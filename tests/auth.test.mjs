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

test('originAllowed accepts the site, previews and localhost only', () => {
  const env = { SITE_URL: 'https://www.fuegosteaks.com' };
  const url = new URL('https://www.fuegosteaks.com/api/lead');
  assert.ok(originAllowed('https://www.fuegosteaks.com', url, env));
  assert.ok(originAllowed('https://fuego-steakhouse-preview.acct.workers.dev', url, env));
  assert.ok(originAllowed('http://localhost:8788', url, env));
  assert.ok(!originAllowed('https://evil.example', url, env));
  assert.ok(!originAllowed('', url, env));
  assert.ok(!originAllowed('garbage', url, env));
});

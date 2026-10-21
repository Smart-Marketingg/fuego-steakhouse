import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, isEmail, isPhone, csvCell, resolveRange, timingSafeEqual, escapeHtml, emailList } from '../src/util.js';

test('clean strips control chars, trims and caps length', () => {
  assert.equal(clean('  hi\u0000there\u0007 ', 100), 'hithere');
  assert.equal(clean('x'.repeat(50), 10).length, 10);
  assert.equal(clean(null), '');
});

test('email and phone validation', () => {
  assert.ok(isEmail('a@b.co'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('not an email'));
  assert.ok(isPhone('(201) 455-6055'));
  assert.ok(!isPhone('123'));
});

test('csvCell escapes and neutralises formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
});

test('resolveRange produces sensible bounds in the business time zone', () => {
  const tz = 'America/New_York';
  const today = resolveRange('today', null, null, tz);
  assert.ok(today.from && !today.to);
  assert.ok(new Date(today.from).getTime() <= Date.now());
  const week = resolveRange('week', null, null, tz);
  assert.ok(new Date(week.from).getTime() <= new Date(today.from).getTime());
  const last = resolveRange('lastmonth', null, null, tz);
  assert.ok(last.from && last.to && last.from < last.to);
  const custom = resolveRange('custom', '2026-10-01', '2026-10-07', tz);
  assert.equal(custom.from, '2026-10-01T04:00:00.000Z'); // EDT
  assert.equal(custom.to, '2026-10-08T04:00:00.000Z');
  assert.equal(resolveRange('bogus', null, null, tz).key, 'any');
});

test('timingSafeEqual and escapeHtml', () => {
  assert.ok(timingSafeEqual('abc', 'abc'));
  assert.ok(!timingSafeEqual('abc', 'abd'));
  assert.ok(!timingSafeEqual('abc', 'abcd'));
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('emailList splits and filters', () => {
  assert.deepEqual(emailList('a@b.co, bad, c@d.io'), ['a@b.co', 'c@d.io']);
});

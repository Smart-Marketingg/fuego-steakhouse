// Bootstraps the first admin: prints the one-line SQL that creates the user row
// and a one-time setup token, plus the /admin/#set=<token> link to open.
//
//   node scripts/bootstrap-admin.mjs jullien@smartmarketingg.com "Jullien"
//   npx wrangler d1 execute fuego-steakhouse --remote --command "<printed SQL>"
//
// Nothing is sent anywhere; the token is only shown here and stored as a hash.
import { webcrypto } from 'node:crypto';

const [email, name = 'Admin'] = process.argv.slice(2);
// Site URL for the printed link: SITE_URL env var, else read from wrangler.jsonc, else the Fuego default.
import { readFileSync } from 'node:fs';
let siteUrl = process.env.SITE_URL;
if (!siteUrl) { try { siteUrl = /"SITE_URL":\s*"([^"]+)"/.exec(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))[1]; } catch { siteUrl = 'https://www.fuegosteaks.com'; } }
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node scripts/bootstrap-admin.mjs jullien@smartmarketingg.com "Jullien"');
  process.exit(1);
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const token = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
const hashBuf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
const tokenHash = Buffer.from(hashBuf).toString('hex');
const userId = 'u_' + b64url(webcrypto.getRandomValues(new Uint8Array(12)));
const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const sql =
  `INSERT INTO users (id,email,name,role,perms,off,active) VALUES (${q(userId)},${q(email.toLowerCase())},${q(name)},'admin','[]','[]',1) ` +
  `ON CONFLICT(email) DO UPDATE SET role='admin', active=1; ` +
  `INSERT INTO set_tokens (token_hash,user_id,kind,expires_at) SELECT ${q(tokenHash)}, id, 'set', ${q(expires)} FROM users WHERE email=${q(email.toLowerCase())};`;

console.log('\n1) Run this (one line) in the D1 console or with wrangler d1 execute:\n');
console.log(sql);
console.log('\n2) Then open within 24 hours:\n');
console.log(`   ${siteUrl}/admin/#set=${token}\n`);

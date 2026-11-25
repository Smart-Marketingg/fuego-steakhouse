#!/usr/bin/env node
// SEO GUARD — stops a deploy that would erase SEO work.
//
// Cloudflare runs this before every deploy (it is the build command). It compares
// the site files with seo-lock.json. If a title, meta description, canonical,
// schema block, tracking tag, verification tag, redirect, robots.txt rule, sitemap
// URL, preload or image alt text that is in the lock is missing or different, the
// build fails and the live site stays on the last good deploy.
//
//   node tools/seo-guard.mjs            check (what Cloudflare runs)
//   node tools/seo-guard.mjs update     re-record the lock after an INTENDED SEO change
//
// No dependencies. Needs Node 18 or newer. See SEO-GUARD.md.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('--')) || 'check';
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const repo = resolve(opt('repo') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const lockPath = resolve(opt('lock') || join(repo, 'seo-lock.json'));
const oldLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
const custom = Object.assign({ siteDir: '.', ignore: [], mustContain: [], mustExist: [] }, oldLock?.custom);
// --site lets the same lock be checked against another copy of the site (for example a download of the live pages).
const site = resolve(opt('site') || join(repo, custom.siteDir));

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', '.wrangler', 'tools', '_tools', '_src', '_ds', 'export',
  'screenshots', 'admin', 'google-apps-script', 'scripts', 'tests', 'docs', 'backend', 'uploads']);
const KEY_FILES = ['robots.txt', 'sitemap.xml', '_redirects', '_headers', '404.html', 'llms.txt', 'llms-full.txt',
  'BingSiteAuth.xml', 'functions/_middleware.js'];
const SEO_ROUTE = /^functions\/(_middleware|sitemap\.xml|robots\.txt|rss\.xml)\.js$/;
const MARKER_RE = /id="[a-z0-9]+-(?:ssr|shell)"|<!--[a-z0-9]+-lcp-->/g;
const VERIFY_FILE = /^(google[0-9a-f]{12,}\.html|[0-9a-f]{32}\.txt)$/;
const TAG_RES = [/\bG-[A-Z0-9]{10}\b/g, /\bGTM-[A-Z0-9]{6,9}\b/g, /\bAW-\d{9,12}\b/g];
const PIXEL_RE = /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g;

const posix = p => p.split(sep).join('/');
const squash = s => s.replace(/\s+/g, ' ').trim();
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 12);
const globToRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const ignoreRes = custom.ignore.map(globToRe);
const ignored = rel => ignoreRes.some(r => r.test(rel));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith('.')) walk(full, out); }
    else out.push(full);
  }
  return out;
}

function attrs(tag) {
  const o = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in o)) o[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return o;
}

function tagIds(text) {
  const ids = new Set();
  for (const re of TAG_RES) for (const m of text.matchAll(re)) ids.add(m[0]);
  for (const m of text.matchAll(PIXEL_RE)) ids.add('MetaPixel-' + m[1]);
  return [...ids].sort();
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
function schemaTypes(v, out = []) {
  if (Array.isArray(v)) v.forEach(x => schemaTypes(x, out));
  else if (v && typeof v === 'object') {
    if (v['@type']) out.push(...[].concat(v['@type']));
    if (v['@graph']) schemaTypes(v['@graph'], out);
  }
  return out;
}

function readPage(html) {
  const p = {};
  const schema = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    try { const j = JSON.parse(raw); schema.push({ types: schemaTypes(j).join('+') || '(no @type)', hash: sha(JSON.stringify(sortKeys(j))) }); }
    catch { schema.push({ types: '(template or invalid JSON)', hash: sha(squash(raw)) }); }
  }
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  p.lang = attrs((clean.match(/<html\b[^>]*>/i) || [''])[0]).lang || '';
  p.title = squash((clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  const meta = {}, og = {}, verify = {};
  for (const m of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]); const key = (a.name || a.property || '').toLowerCase(); const val = squash(a.content || '');
    if (!key) continue;
    if (['description', 'robots'].includes(key)) meta[key] ??= val;
    else if (['og:title', 'og:description', 'og:image'].includes(key)) og[key] ??= val;
    else if (['google-site-verification', 'msvalidate.01', 'facebook-domain-verification', 'p:domain_verify'].includes(key)) verify[key] ??= val;
  }
  p.description = meta.description || '';
  p.robots = meta.robots || '';
  p.canonical = ''; const preloads = [];
  for (const m of clean.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]); const rel = (a.rel || '').toLowerCase();
    if (rel === 'canonical') p.canonical ||= a.href || '';
    if (rel === 'preload' && (a.href || a.imagesrcset)) preloads.push(a.href || a.imagesrcset);
  }
  p.og = og; p.verify = verify;
  p.schema = schema.sort((a, b) => (a.types + a.hash).localeCompare(b.types + b.hash));
  p.tags = tagIds(html);
  p.markers = [...new Set(html.match(MARKER_RE) || [])].sort();
  p.preloads = [...new Set(preloads)].sort();
  p.h1 = (clean.match(/<h1\b/gi) || []).length;
  p.scripts = [...new Set([...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1])
    .filter(s => !/^(https?:)?\/\//.test(s)).map(s => s.replace(/[?#].*$/, '').replace(/^\.?\//, '')))].sort();
  const alts = {};
  for (const m of clean.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]); const src = a.src || a['dc-src'] || a['data-src'] || '';
    if (!src || src.includes('{{') || src.startsWith('data:')) continue;
    const alt = squash(a.alt || '');
    if (alt || !(src in alts)) alts[src] = alt;
  }
  p.alts = Object.fromEntries(Object.entries(alts).filter(([, v]) => v).sort());
  p.imgs = Object.keys(alts).sort();
  return p;
}

const lines = text => text.split(/\r?\n/).map(squash).filter(l => l && !l.startsWith('#'));

function snapshot() {
  const files = walk(site).map(f => posix(relative(site, f))).filter(r => !ignored(r)).sort();
  const snap = { pages: {}, files: {}, tagFiles: {} };
  for (const rel of files) {
    if (rel.endsWith('.html') && !rel.endsWith('.dc.html') && !VERIFY_FILE.test(rel)) {
      const p = readPage(readFileSync(join(site, rel), 'utf8'));
      snap.pages[rel] = p;
    } else if (/\.(js|mjs)$/.test(rel) && !/\.min\.js$/.test(rel) && statSync(join(site, rel)).size < 2e6) {
      const ids = tagIds(readFileSync(join(site, rel), 'utf8'));
      if (ids.length) snap.tagFiles[rel] = ids;
    }
  }
  for (const rel of files) if (KEY_FILES.includes(rel) || VERIFY_FILE.test(rel) || SEO_ROUTE.test(rel)) snap.files[rel] = true;
  const read = f => existsSync(join(site, f)) ? readFileSync(join(site, f), 'utf8') : null;
  const r = read('robots.txt'); if (r !== null) snap.robots = lines(r);
  const d = read('_redirects'); if (d !== null) snap.redirects = lines(d);
  const h = read('_headers'); if (h !== null) snap.headers = lines(h);
  const s = read('sitemap.xml'); if (s !== null) snap.sitemap = [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]).sort();
  return snap;
}

// ---------- compare ----------
const problems = [];   // { where, msg, detail }
const notes = [];
const bad = (where, msg, detail) => problems.push({ where, msg, detail });
const q = s => JSON.stringify(s);

function compare(lock, now) {
  for (const [rel, was] of Object.entries(lock.pages || {})) {
    const is = now.pages[rel];
    if (!is) { bad(rel, 'the page was deleted', 'If that is intended, add a redirect for it and run the update command.'); continue; }
    const field = (name, label) => {
      if (was[name] === is[name]) return;
      if (was[name] && !is[name]) bad(rel, `${label} was removed`, `locked:  ${q(was[name])}`);
      else bad(rel, `${label} was changed`, `locked:  ${q(was[name])}\n now:     ${q(is[name])}`);
    };
    field('title', 'page title'); field('description', 'meta description'); field('canonical', 'canonical tag');
    field('lang', 'html lang');
    if (was.robots !== is.robots) {
      if (/noindex/i.test(is.robots) && !/noindex/i.test(was.robots)) bad(rel, 'the page is now set to NOINDEX (Google would drop it)', `now: ${q(is.robots)}`);
      else field('robots', 'robots meta tag');
    }
    for (const [k, v] of Object.entries(was.og || {})) if (is.og[k] !== v) bad(rel, `${k} was ${is.og[k] ? 'changed' : 'removed'}`, `locked:  ${q(v)}` + (is.og[k] ? `\n now:     ${q(is.og[k])}` : ''));
    for (const [k, v] of Object.entries(was.verify || {})) if (is.verify[k] !== v) bad(rel, `verification tag ${k} was ${is.verify[k] ? 'changed' : 'removed'}`, `locked:  ${q(v)}  (Search Console / Bing would lose access)`);
    const left = is.schema.map(s => s.types + '#' + s.hash);
    for (const s of was.schema || []) {
      const i = left.indexOf(s.types + '#' + s.hash);
      if (i >= 0) { left.splice(i, 1); continue; }
      const sameType = left.findIndex(x => x.startsWith(s.types + '#'));
      if (sameType >= 0) { left.splice(sameType, 1); bad(rel, `schema (JSON-LD) block "${s.types}" was changed`, 'Its content is different from the locked version.'); }
      else bad(rel, `schema (JSON-LD) block "${s.types}" was removed`);
    }
    for (const id of was.tags || []) if (!is.tags.includes(id)) bad(rel, `tracking tag ${id} is missing`);
    for (const src of was.scripts || []) if (!is.scripts.includes(src) && (lock.tagFiles?.[src])) bad(rel, `the page no longer loads ${src}`, `That file carries ${lock.tagFiles[src].join(', ')}.`);
    for (const mk of was.markers || []) if (!is.markers.includes(mk)) bad(rel, 'the pre-rendered / fast-paint block was removed', `${mk}  (crawlers and page speed depend on it; rerun the tools/ script that creates it)`);
    for (const href of was.preloads || []) if (!is.preloads.includes(href)) bad(rel, 'a speed preload was removed', href);
    if (was.h1 !== is.h1) bad(rel, `the page had ${was.h1} H1 heading(s), now ${is.h1}`);
    let lost = [];
    for (const [src, alt] of Object.entries(was.alts || {})) {
      if (!is.imgs.includes(src)) continue;            // image itself removed: fine
      if (!is.alts[src]) lost.push(`${src}  (was ${q(alt)})`);
      else if (is.alts[src] !== alt) notes.push(`${rel}: alt text changed on ${src}`);
    }
    if (lost.length) bad(rel, `image alt text was removed from ${lost.length} image(s)`, lost.slice(0, 5).join('\n ') + (lost.length > 5 ? `\n … and ${lost.length - 5} more` : ''));
  }
  for (const rel of Object.keys(now.pages)) if (!lock.pages?.[rel]) notes.push(`${rel}: new page, not in the lock yet (run the update command to protect it)`);

  for (const rel of Object.keys(lock.files || {})) if (!existsSync(join(site, rel))) bad(rel, 'the file is missing');
  for (const [rel, ids] of Object.entries(lock.tagFiles || {})) for (const id of ids) if (!(now.tagFiles[rel] || []).includes(id)) bad(rel, `tracking tag ${id} is missing from this file`);

  const list = (name, file, label) => {
    if (!lock[name]) return;
    const cur = new Set(now[name] || []);
    const gone = lock[name].filter(l => !cur.has(l));
    if (gone.length) bad(file, `${gone.length} ${label} removed`, gone.slice(0, 8).join('\n ') + (gone.length > 8 ? `\n … and ${gone.length - 8} more` : ''));
  };
  list('redirects', '_redirects', 'redirect rule(s)');
  list('sitemap', 'sitemap.xml', 'URL(s)');
  list('robots', 'robots.txt', 'line(s)');
  list('headers', '_headers', 'line(s)');
  const added = (name) => (now[name] || []).filter(l => !(lock[name] || []).includes(l));
  for (const l of added('robots')) if (/^disallow\s*:\s*\S/i.test(l)) bad('robots.txt', 'a new Disallow rule was added (it can block Google)', l);
  for (const l of added('headers')) if (/noindex/i.test(l)) bad('_headers', 'a new noindex header was added', l);

  for (const c of custom.mustContain) {
    const f = join(repo, c.file);
    if (!existsSync(f)) bad(c.file, 'the file is missing', c.why);
    else if (!readFileSync(f, 'utf8').includes(c.text)) bad(c.file, `is missing ${q(c.text)}`, c.why);
  }
  for (const f of custom.mustExist) if (!existsSync(join(repo, f))) bad(f, 'the file is missing');
}

function report() {
  // The same problem on many pages (a tag stripped site-wide) is shown once.
  const same = new Map();
  for (const p of problems) { const k = p.msg + '|' + (p.detail || ''); if (!same.has(k)) same.set(k, []); same.get(k).push(p); }
  const by = new Map();
  for (const ps of same.values()) if (ps.length > 3) {
    const pages = ps.map(p => p.where);
    by.set(`${pages.length} pages`, [...(by.get(`${pages.length} pages`) || []), { msg: ps[0].msg, detail: (ps[0].detail ? ps[0].detail + '\n' : '') + 'on: ' + pages.slice(0, 6).join(', ') + (pages.length > 6 ? ` … and ${pages.length - 6} more` : '') }]);
    ps.forEach(p => { p.grouped = true; });
  }
  for (const p of problems) { if (p.grouped) continue; if (!by.has(p.where)) by.set(p.where, []); by.get(p.where).push(p); }
  const out = [];
  for (const [where, ps] of by) {
    out.push(`\n  ${where}`);
    for (const p of ps) { out.push(`    x ${p.msg}`); if (p.detail) out.push(...p.detail.split('\n').map(l => `        ${l.trim()}`)); }
  }
  return out.join('\n');
}

// ---------- run ----------
const now = snapshot();
const counts = `${Object.keys(now.pages).length} pages, ${(now.redirects || []).length} redirects, ${(now.sitemap || []).length} sitemap URLs`;

if (mode === 'update') {
  if (oldLock) compare(oldLock, now);
  const lock = { _about: 'SEO lock. Cloudflare refuses to deploy if the site no longer matches this file. Do not edit by hand: run "node tools/seo-guard.mjs update" after an intended SEO change and commit the result. See SEO-GUARD.md.',
    custom, ...now };
  // Keep the lock small: image lists are only needed for the copy being checked, and only tag-carrying scripts matter.
  lock.pages = Object.fromEntries(Object.entries(now.pages).map(([rel, p]) => {
    const { imgs, ...keep } = p; keep.scripts = p.scripts.filter(s => now.tagFiles[s]); return [rel, keep]; }));
  writeFileSync(lockPath, JSON.stringify(lock, null, 1) + '\n');
  console.log(`SEO GUARD: lock ${oldLock ? 'updated' : 'created'} (${counts}).`);
  if (problems.length) console.log(`\nThese ${problems.length} difference(s) from the old lock are now accepted. Make sure every one is intended:` + report());
  if (!oldLock) console.log('Commit seo-lock.json together with tools/seo-guard.mjs.');
  process.exit(0);
}

if (!oldLock) {
  console.error('SEO GUARD: seo-lock.json is missing — deploy stopped.\nThis push replaced or removed the SEO lock. Restore seo-lock.json and tools/seo-guard.mjs from the last good commit on main.');
  process.exit(1);
}
compare(oldLock, now);
if (notes.length) console.log('SEO GUARD notes (these do not block):\n' + notes.map(n => '  - ' + n).join('\n') + '\n');
if (problems.length) {
  console.error(`SEO GUARD: ${problems.length} problem(s) — DEPLOY STOPPED. The live site was not changed.` + report());
  console.error(`
What happened: this push would undo SEO work that is locked in seo-lock.json.
Usually it is a fresh Claude Design export or an older copy of the site.

To fix:
  1. Pull the latest main and put back the items listed above
     (copy them from main: do not re-type them).
  2. Push again. The check runs again by itself.

If the SEO change is intended, ask Jullien, or run
     node tools/seo-guard.mjs update
and commit seo-lock.json in the same push.`);
  process.exit(1);
}
console.log(`SEO GUARD: OK (${counts} match the lock).`);

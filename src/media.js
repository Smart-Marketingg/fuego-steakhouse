// Media library: site images in the public MEDIA bucket, served from MEDIA_URL.
import { json, error, clean, newId, nowIso, readBody } from './util.js';
import { audit } from './audit.js';
import { actorMask } from './auth.js';

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
const MAX_IMAGE = 15 * 1024 * 1024;

function publicUrl(env, key) { return `${(env.MEDIA_URL || '').replace(/\/$/, '')}/${key}`; }

export async function listMedia(ctx) {
  const rows = (await ctx.env.DB.prepare('SELECT m.*, u.name AS uploaded_by_name FROM media m LEFT JOIN users u ON u.id=m.uploaded_by ORDER BY m.at DESC LIMIT 500').all()).results;
  const mask = await actorMask(ctx);
  return json({ items: rows.map((r) => ({ key: r.key, name: r.name, type: r.type, size: r.size, url: publicUrl(ctx.env, r.key), uploaded_by: mask(r.uploaded_by, r.uploaded_by_name) || '', at: r.at })), media_url: ctx.env.MEDIA_URL || '' });
}

export async function uploadMedia(ctx) {
  const { env } = ctx;
  const body = await readBody(ctx.request);
  const file = body.file;
  if (!(file instanceof File) || !file.size) return error(400, 'invalid', 'Choose an image to upload.', { fields: { file: 'Choose an image.' } });
  if (file.size > MAX_IMAGE) return error(400, 'invalid', 'Images must be 15 MB or smaller.', { fields: { file: 'Too large.' } });
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let type = null;
  if (head[0] === 0xff && head[1] === 0xd8) type = 'image/jpeg';
  else if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) type = 'image/png';
  else if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45) type = 'image/webp';
  else if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) type = 'image/gif';
  else if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) type = 'image/avif';
  else if (file.type === 'image/svg+xml') type = 'image/svg+xml';
  if (!type) return error(400, 'invalid', 'Only JPG, PNG, WebP, GIF, AVIF or SVG images are accepted.', { fields: { file: 'Unsupported type.' } });
  const name = clean(file.name, 120).replace(/[^\w.\- ]/g, '_') || 'image';
  // Replace keeps the same public URL; otherwise a new slug-based key.
  const replaceKey = clean(body.key, 200);
  let key = replaceKey;
  if (!key) {
    const base = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
    key = `site/${base}-${newId('m').slice(2, 8)}.${IMAGE_TYPES[type]}`;
  } else {
    const exists = await env.DB.prepare('SELECT key FROM media WHERE key=?').bind(key).first();
    if (!exists) return error(404, 'not_found', 'Nothing to replace.');
  }
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare('INSERT INTO media (key,name,type,size,uploaded_by,at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name, type=excluded.type, size=excluded.size, uploaded_by=excluded.uploaded_by, at=excluded.at')
    .bind(key, name, type, file.size, ctx.user.id, nowIso()).run();
  await audit(ctx, 'media_upload', key, `${name} · ${file.size} bytes${replaceKey ? ' · replaced' : ''}`);
  return json({ ok: true, item: { key, name, type, size: file.size, url: publicUrl(env, key), uploaded_by: ctx.user.name, at: nowIso() } });
}

export async function deleteMedia(ctx) {
  const { env } = ctx;
  const key = ctx.params.key;
  const row = await env.DB.prepare('SELECT key FROM media WHERE key=?').bind(key).first();
  if (!row) return error(404, 'not_found', 'File not found.');
  await env.MEDIA.delete(key);
  await env.DB.prepare('DELETE FROM media WHERE key=?').bind(key).run();
  await audit(ctx, 'media_delete', key, '');
  return json({ ok: true });
}

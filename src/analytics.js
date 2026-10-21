// GA4 Data API without an SDK: sign a service-account JWT (RS256, WebCrypto),
// exchange it for an access token, run reports, cache 15 minutes in D1.
import { json, b64url, parseJson } from './util.js';
import { resolveSecret, ga4PropertyId, cacheGet, cacheSet } from './settings-crypto.js';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const CACHE_TTL = 15 * 60;

function pemToDer(pem) {
  const b = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function accessToken(env, sa) {
  const cached = await cacheGet(env, 'ga4_token');
  if (cached && cached.exp > Date.now() / 1000 + 60) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  const j = await res.json();
  await cacheSet(env, 'ga4_token', { token: j.access_token, exp: now + (j.expires_in || 3600) }, j.expires_in || 3600);
  return j.access_token;
}

async function runReport(env, token, propertyId, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error.message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const j = await res.json();
  return (j.rows || []).map((r) => ({ d: (r.dimensionValues || []).map((x) => x.value), m: (r.metricValues || []).map((x) => Number(x.value) || 0) }));
}

async function connection(env) {
  const sa = parseJson((await resolveSecret(env, 'ga4')).value, null);
  const propertyId = await ga4PropertyId(env);
  if (!sa || !sa.client_email || !sa.private_key) return { error: 'GA4 service account is not connected. Add it in Settings.' };
  if (!propertyId) return { error: 'GA4 property ID is not set. Add the numeric property ID in Settings.' };
  return { sa, propertyId };
}

export async function testGa4(env) {
  const c = await connection(env);
  if (c.error) return { ok: false, error: c.error };
  try {
    const token = await accessToken(env, c.sa);
    const rows = await runReport(env, token, c.propertyId, { dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] });
    return { ok: true, detail: `Connected to property ${c.propertyId}. ${rows[0] ? rows[0].m[0] : 0} sessions in the last 7 days.` };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

export async function analytics(ctx) {
  const { env } = ctx;
  const range = ['7d', '28d', '90d'].includes(ctx.url.searchParams.get('range')) ? ctx.url.searchParams.get('range') : '28d';
  const c = await connection(env);
  if (c.error) return json({ connected: false, reason: c.error });
  const cacheKey = `ga4_report_${range}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return json(cached);
  const days = parseInt(range, 10);
  const dateRanges = [{ startDate: `${days - 1}daysAgo`, endDate: 'today' }];
  try {
    const token = await accessToken(env, c.sa);
    const [totals, daily, pages, sources, conv] = await Promise.all([
      runReport(env, token, c.propertyId, { dateRanges, metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'screenPageViews' }] }),
      runReport(env, token, c.propertyId, { dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
      runReport(env, token, c.propertyId, { dateRanges, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }),
      runReport(env, token, c.propertyId, { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
      runReport(env, token, c.propertyId, { dateRanges, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['generate_lead', 'form_submit', 'lead'] } } } })
    ]);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const leadRows = (await env.DB.prepare("SELECT COALESCE(NULLIF(json_extract(utm,'$.source'),''),'direct / none') AS source, COUNT(*) AS n FROM leads WHERE created_at>=? GROUP BY source ORDER BY n DESC LIMIT 10").bind(since).all()).results;
    const t = totals[0] ? totals[0].m : [0, 0, 0, 0];
    const data = {
      connected: true, range, cached_at: new Date().toISOString(),
      totals: { sessions: t[0], users: t[1], conversions: t[2], pageviews: t[3], leads: leadRows.reduce((a, r) => a + r.n, 0) },
      daily: daily.map((r) => ({ date: `${r.d[0].slice(0, 4)}-${r.d[0].slice(4, 6)}-${r.d[0].slice(6, 8)}`, sessions: r.m[0], users: r.m[1] })),
      top_pages: pages.map((r) => ({ path: r.d[0], views: r.m[0] })),
      sources: sources.map((r) => ({ source: r.d[0], sessions: r.m[0] })),
      conversions: conv.map((r) => ({ event: r.d[0], count: r.m[0] })),
      leads_by_source: leadRows.map((r) => ({ source: r.source, leads: r.n }))
    };
    await cacheSet(env, cacheKey, data, CACHE_TTL);
    return json(data);
  } catch (e) {
    return json({ connected: false, reason: `GA4 request failed: ${String(e.message || e)}` });
  }
}

/** Compact stats for the weekly summary (null when not connected). */
export async function weeklyAnalytics(env) {
  const c = await connection(env);
  if (c.error) return null;
  try {
    const token = await accessToken(env, c.sa);
    const dateRanges = [{ startDate: '7daysAgo', endDate: 'yesterday' }];
    const [totals, sources] = await Promise.all([
      runReport(env, token, c.propertyId, { dateRanges, metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }] }),
      runReport(env, token, c.propertyId, { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 5 })
    ]);
    const t = totals[0] ? totals[0].m : [0, 0, 0];
    return { sessions: t[0], users: t[1], conversions: t[2], sources: sources.map((r) => `${r.d[0]} ${r.m[0]}`).join(', ') };
  } catch { return null; }
}

// Fuego Steakhouse & Bar — one Worker for the website and the CRM API.
//   /api/*            -> routes below
//   everything else   -> static assets (clean URLs), with security headers
import { Router } from './router.js';
import { json, error, redirect, ipHash } from './util.js';
import { applySecurityHeaders } from './headers.js';
import { publicConfig } from './forms.config.js';
import { integrationStatus } from './settings-crypto.js';
import * as auth from './auth.js';
import * as leads from './leads.js';
import * as team from './team.js';
import * as media from './media.js';
import * as settings from './settings.js';
import * as audit from './audit.js';
import { analytics } from './analytics.js';
import * as automation from './automation.js';

const VERSION = '1.0.0';
const api = new Router();
const P = auth.requirePerm;

// ---- public ----
api.post('/api/lead', leads.captureLead);
api.get('/api/health', async (ctx) => {
  let db = true;
  try { await ctx.env.DB.prepare('SELECT 1').first(); } catch { db = false; }
  const integ = db ? await integrationStatus(ctx.env) : {};
  return json({ ok: db, version: VERSION, db, settings_key: !!ctx.env.SETTINGS_KEY, integrations: Object.fromEntries(Object.entries(integ).map(([k, v]) => [k, !!v.set])) });
});
api.get('/api/config', async (ctx) => json(publicConfig(ctx.env)));

// ---- auth ----
api.post('/api/auth/login', auth.login);
api.post('/api/auth/logout', auth.logout);
api.post('/api/auth/logout-all', auth.requireAuth(), auth.logoutAll);
api.get('/api/auth/me', auth.requireAuth(), auth.me);
api.post('/api/auth/ping', auth.requireAuth(), auth.ping);
api.get('/api/auth/set/:token', auth.checkSetToken);
api.post('/api/auth/set', auth.setPassword);
api.post('/api/auth/forgot', auth.forgot);
api.get('/api/auth/google', auth.googleStart);
api.get('/api/auth/google/callback', auth.googleCallback);

// ---- dashboard & leads ----
api.get('/api/dashboard', P('dashboard.view'), leads.dashboard);
api.get('/api/leads', P('leads.view'), leads.listLeads);
api.get('/api/leads/export.csv', P('leads.export'), leads.exportLeads);
api.get('/api/leads/:id', P('leads.view'), leads.getLead);
api.patch('/api/leads/:id', P('leads.edit'), leads.updateLead);
api.post('/api/leads/:id/notes', P('notes.add'), leads.addNote);
api.delete('/api/leads/:id', P('leads.delete'), leads.deleteLead);
api.get('/api/leads/:id/file', P('leads.view'), leads.leadFile);

// ---- analytics / automations / media ----
api.get('/api/analytics', P('analytics.view'), analytics);
api.get('/api/automations', P('automations.manage'), automation.getAutomations);
api.put('/api/automations', P('automations.manage'), automation.putAutomations);
api.post('/api/automations/preview', P('automations.manage'), automation.previewAutoReply);
api.post('/api/automations/test', P('automations.manage'), automation.testAutoReply);
api.post('/api/automations/weekly/run', P('automations.manage'), automation.runWeeklyNow);
api.get('/api/media', P('media.manage'), media.listMedia);
api.post('/api/media', P('media.manage'), media.uploadMedia);
api.delete('/api/media', P('media.manage'), (ctx) => { ctx.params.key = ctx.url.searchParams.get('key') || ''; return media.deleteMedia(ctx); });
api.delete('/api/media/:key', P('media.manage'), media.deleteMedia);

// ---- team / settings / audit (admin) ----
api.get('/api/team', P('team.manage'), team.listTeam);
api.post('/api/team/invite', P('team.manage'), team.invite);
api.patch('/api/team/:id', P('team.manage'), team.updateUser);
api.post('/api/team/:id/reset', P('team.manage'), team.resetUser);
api.post('/api/team/:id/signout', P('team.manage'), team.signoutUser);
api.get('/api/settings', P('settings.manage'), settings.getSettings);
api.put('/api/settings', P('settings.manage'), settings.putSettings);
api.post('/api/settings/test/:integration', P('settings.manage'), settings.testIntegration);
api.get('/api/audit', P('audit.view'), audit.listAudit);
api.get('/api/audit/export.csv', P('audit.view'), audit.exportAudit);

// Old hash-style paths that may still be bookmarked (#/ is handled client-side; these are the no-hash leftovers).
const LEGACY = { '/index.html': '/', '/private-events': '/large-events', '/events': '/entertainment', '/reviews-gallery': '/gallery', '/gift-cards-rewards': '/gift-cards' };

async function handleApi(request, env, ctx, url) {
  const c = { request, env, url, waitUntil: (p) => ctx.waitUntil(p.catch ? p.catch((e) => console.error('background task failed', e)) : p), params: {}, user: null, session: null };
  c.ip = await ipHash(request, env);
  if (!env.SETTINGS_KEY && url.pathname !== '/api/health') {
    return error(503, 'not_configured', 'SETTINGS_KEY is not set. See README §3 (Secrets).');
  }
  // POST /api/lead is public and uses its own origin check; everything else below needs CSRF + session.
  if (!(url.pathname === '/api/lead' && request.method === 'POST')) {
    const csrf = auth.csrfCheck(c);
    if (csrf) return csrf;
    try {
      const s = await auth.loadSession(c);
      if (s) { c.user = s.user; c.session = s; }
    } catch (e) {
      if (/no such table/i.test(String(e))) return error(503, 'no_schema', 'Database schema has not been run yet. See README §4, step 5.');
      throw e;
    }
  }
  const res = await api.handle(c);
  return res || error(404, 'not_found', 'No such API route.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;
    try {
      // Apex -> www (both are attached as custom domains).
      let siteHost = '';
      try { siteHost = new URL(env.SITE_URL).host; } catch { /* ignore */ }
      if (siteHost && url.host !== siteHost && siteHost === 'www.' + url.host) {
        response = redirect(`https://${siteHost}${url.pathname}${url.search}`, 301);
      } else if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env, ctx, url);
      } else if (LEGACY[url.pathname]) {
        response = redirect(LEGACY[url.pathname] + url.search, 301);
      } else if (url.pathname === '/admin') {
        response = redirect('/admin/' + url.search, 301);
      } else {
        // Static site. /admin/* gets no-store + CSP from applySecurityHeaders below.
        response = await env.ASSETS.fetch(request);
      }
    } catch (e) {
      console.error('unhandled', e && e.stack || e);
      response = url.pathname.startsWith('/api/')
        ? error(500, 'server_error', 'Something went wrong on our side.')
        : new Response('Something went wrong on our side.', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
    return applySecurityHeaders(response, url.pathname, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await auth.pruneAttempts(env); } catch (e) { console.error('prune failed', e); }
      try {
        const n = await leads.retryPendingNotifications(env);
        if (n) console.log('retried pending notifications', n);
      } catch (e) { console.error('notification retry failed', e); }
      try {
        const r = await automation.scheduledWeekly(env);
        console.log('weekly summary', JSON.stringify(r));
      } catch (e) { console.error('weekly summary failed', e); }
    })());
  }
};

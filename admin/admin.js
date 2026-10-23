/* ============================================================
   FUEGO STEAKHOUSE & BAR — staff CRM portal
   Vanilla JS, no build step. Hash-routed single page app.
   Sections: utils · api · state/router · components · auth screens ·
             shell · views (dashboard, leads, analytics, automations,
             media, team, settings, audit) · boot
   CSP: no inline scripts/handlers/styles. All user data goes through esc().
   ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     UTILS
     ============================================================ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Escape user data before it goes into innerHTML. Always. */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function icon(name, cls) {
    return `<svg class="ico ${cls || ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }
  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(null, a), ms); };
  }
  function tz() { return (S.me && S.me.business && S.me.business.timezone) || 'America/New_York'; }
  function bizName() { return (S.me && S.me.business && S.me.business.name) || 'Fuego Steakhouse & Bar'; }

  /** Exact date in the business timezone, e.g. "Oct 21, 2026, 3:14 PM". */
  function fmtDate(iso, opts) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const o = Object.assign({ timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }, opts || {});
    try { return new Intl.DateTimeFormat('en-US', o).format(d); } catch (e) { return d.toLocaleString(); }
  }
  function fmtDay(iso) { return fmtDate(iso, { hour: undefined, minute: undefined }); }
  /** Relative time: "just now", "5m ago", "3h ago", "2d ago", else short date. */
  function fmtRel(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
    return fmtDate(iso, { hour: undefined, minute: undefined, year: undefined });
  }
  function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function fmtBytes(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  }
  function qs(obj) {
    const p = new URLSearchParams();
    Object.keys(obj || {}).forEach((k) => { const v = obj[k]; if (v !== undefined && v !== null && v !== '') p.set(k, v); });
    return p.toString();
  }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    // Fallback for older browsers / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'hidden-input';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  const RANGES = [
    ['any', 'Any time'], ['24h', 'Last 24 hours'], ['today', 'Today'], ['7d', 'Last 7 days'], ['week', 'This week'],
    ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90d', 'Last 90 days'],
    ['year', 'This year'], ['custom', 'Custom range']
  ];
  function rangeOptions(cur) {
    return RANGES.map(([v, l]) => `<option value="${v}"${v === (cur || 'any') ? ' selected' : ''}>${l}</option>`).join('');
  }
  function rangeLabel(v) { const r = RANGES.find((x) => x[0] === v); return r ? r[1] : 'Any time'; }

  /* ============================================================
     API
     ============================================================ */
  class ApiError extends Error {
    constructor(code, message, status, data) { super(message || code); this.code = code; this.status = status; this.data = data || null; }
  }
  /**
   * api(path, {method, body, query, silent401})
   * Adds CSRF header + credentials, parses JSON, throws ApiError.
   * 401 anywhere (except where silent401) shows the sign-in screen.
   */
  async function api(path, opts) {
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const url = path + (opts.query ? (path.includes('?') ? '&' : '?') + qs(opts.query) : '');
    const headers = {};
    let body;
    if (method !== 'GET') headers['X-Requested-With'] = 'crm';
    if (opts.body instanceof FormData) body = opts.body;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    setSync('busy');
    let res;
    try {
      res = await fetch(url, { method, headers, body, credentials: 'same-origin' });
    } catch (e) {
      setSync('off');
      toast('You appear to be offline. Check your connection and try again.', 'err');
      throw new ApiError('offline', 'You appear to be offline', 0);
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) { try { data = await res.json(); } catch (e) { data = null; } }
    else { try { data = { text: await res.text() }; } catch (e) { data = null; } }
    if (res.status === 401 && !opts.silent401) {
      setSync('off');
      onSignedOut();
      throw new ApiError('unauthorized', 'Signed out', 401, data);
    }
    setSync(res.ok ? 'ok' : 'ok');
    if (!res.ok) {
      const code = (data && data.error) || ('http_' + res.status);
      const msg = (data && data.message) || humanError(code, res.status);
      throw new ApiError(code, msg, res.status, data);
    }
    S.lastSync = Date.now(); updateSyncText();
    return data;
  }
  function humanError(code, status) {
    const map = {
      forbidden: "You don't have access to this.",
      section_off: 'This section is turned off for your account.',
      csrf: 'Request blocked (security check). Reload and try again.',
      invalid: 'Some fields need attention.',
      rate_limited: 'Too many attempts. Please wait a few minutes.',
      not_connected: 'Not connected.',
      expired: 'This link has expired.',
      bad_credentials: 'Email or password is incorrect.'
    };
    if (map[code]) return map[code];
    if (status >= 500) return 'The server had a problem. Please try again.';
    return 'Something went wrong (' + code + ').';
  }
  function isForbidden(e) { return e && (e.code === 'forbidden' || e.code === 'section_off'); }

  /* ============================================================
     STATE + ROUTER
     ============================================================ */
  const S = {
    me: null,          // /api/auth/me payload
    config: null,      // /api/config payload (forms, pipelines, stages)
    health: null,      // /api/health
    route: { path: '/dashboard', query: {} },
    lastSync: 0,
    shellMounted: false,
    viewToken: 0,      // bumps on each render; async loaders ignore stale tokens
    idleTimer: null,
    syncTimer: null
  };
  const SECTIONS = {
    dashboard:   { label: 'Dashboard',   icon: 'dashboard',   group: 'Work' },
    leads:       { label: 'Leads',       icon: 'leads',       group: 'Work' },
    analytics:   { label: 'Analytics',   icon: 'analytics',   group: 'Insight' },
    automations: { label: 'Automations', icon: 'automations', group: 'Insight' },
    media:       { label: 'Media',       icon: 'media',       group: 'Content' },
    team:        { label: 'Team',        icon: 'team',        group: 'Admin' },
    settings:    { label: 'Settings',    icon: 'settings',    group: 'Admin' },
    audit:       { label: 'Audit log',   icon: 'audit',       group: 'Admin' }
  };
  const STAGES = ['new', 'contacted', 'scheduled', 'won', 'closed'];

  function roleLabel(u) { return u && u.super ? 'Super admin' : ((u && u.role) || 'staff'); }
  function can(perm) { return !!(S.me && Array.isArray(S.me.permissions) && S.me.permissions.includes(perm)); }
  function hasSection(id) { return !!(S.me && Array.isArray(S.me.sections) && S.me.sections.includes(id)); }
  function forms() { return (S.config && S.config.forms) || {}; }
  function pipelines() { return (S.config && S.config.pipelines) || {}; }
  function formLabel(id) { const f = forms()[id]; return f ? f.label : (id || '—'); }
  function pipelineFor(formId) { const f = forms()[formId]; return f ? pipelines()[f.pipeline] : null; }
  function stageLabel(formId, stage) {
    const p = pipelineFor(formId);
    return (p && p.stages && p.stages[stage]) || stage;
  }

  /** Parse location.hash into {path, query}. Handles the special #lead=, #set=, #error= forms. */
  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (/^lead=/.test(h)) return { path: '/leads', query: { lead: h.slice(5) }, canonical: false };
    if (/^set=/.test(h)) return { path: 'set', token: h.slice(4), query: {} };
    if (/^error=/.test(h)) return { path: '/', error: h.slice(6), query: {} };
    const i = h.indexOf('?');
    const path = (i >= 0 ? h.slice(0, i) : h) || '/dashboard';
    const query = Object.fromEntries(new URLSearchParams(i >= 0 ? h.slice(i + 1) : ''));
    return { path, query, canonical: true };
  }
  function hashFor(path, query) { const q = qs(query); return '#' + path + (q ? '?' + q : ''); }
  /** navigate('/leads', {form:'event'}, {replace:true}) */
  function navigate(path, query, opts) {
    const next = hashFor(path, query || {});
    if (opts && opts.replace) { history.replaceState(null, '', next); route(); }
    else if (location.hash === next) route();
    else location.hash = next;
  }
  /** Merge changes into the current query and re-route (used by filters). */
  function setQuery(changes, opts) {
    const q = Object.assign({}, S.route.query, changes);
    Object.keys(q).forEach((k) => { if (q[k] === '' || q[k] == null) delete q[k]; });
    navigate(S.route.path, q, opts);
  }

  const VIEWS = {}; // section id → render(root, query)

  function route() {
    if (!S.me) return; // auth screens handle themselves
    const r = parseHash();
    if (r.path === 'set' || r.error) { navigate('/dashboard', {}, { replace: true }); return; }
    if (!r.canonical) { navigate(r.path, r.query, { replace: true }); return; }
    let section = r.path.replace(/^\//, '').split('/')[0];
    if (!SECTIONS[section] || !hasSection(section)) {
      const first = (S.me.sections || []).find((s) => SECTIONS[s]) || 'dashboard';
      if (section !== first) { navigate('/' + first, {}, { replace: true }); return; }
    }
    const prev = S.route;
    S.route = { path: '/' + section, query: r.query, section };
    renderShell();
    $$('.crm-nav').forEach((a) => { if (a.dataset.section === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    closeNav();
    const main = $('#crmMain');
    const same = prev && prev.section === section && main.dataset.view === section;
    const view = VIEWS[section];
    if (!view) { main.innerHTML = stateHtml('warn', 'Not available', 'This section is not part of this build.'); return; }
    if (same && view.update) { view.update(main, r.query, prev.query); return; }
    S.viewToken++;
    main.dataset.view = section;
    main.innerHTML = '';
    document.title = SECTIONS[section].label + ' · CRM · ' + bizName();
    view.render(main, r.query, S.viewToken);
  }

  /* ============================================================
     COMPONENTS
     ============================================================ */
  // ---- toast
  function toast(msg, type, ms) {
    const host = $('#crmToasts'); if (!host) return;
    const t = el(`<div class="toast ${type || ''}" role="status"><span>${esc(msg)}</span><button type="button" aria-label="Dismiss">${icon('close', 'ico-sm')}</button></div>`);
    t.querySelector('button').addEventListener('click', () => t.remove());
    host.appendChild(t);
    setTimeout(() => { if (t.isConnected) t.remove(); }, ms || (type === 'err' ? 6500 : 3800));
  }

  // ---- states
  function skeleton(rows) {
    let h = '<div class="skel" aria-busy="true" aria-label="Loading">';
    for (let i = 0; i < (rows || 5); i++) h += `<div class="skel-bar ${['w80', 'w60', 'w40', ''][i % 4]}"></div>`;
    return h + '</div>';
  }
  function skeletonTiles(n) {
    let h = '<div class="tiles" aria-busy="true">';
    for (let i = 0; i < (n || 4); i++) h += '<div class="tile"><div class="skel-bar w40"></div><div class="skel-bar tall w60"></div></div>';
    return h + '</div>';
  }
  function stateHtml(kind, title, text, actionHtml) {
    const ic = { empty: 'inbox', warn: 'warn', error: 'warn', off: 'plug', ok: 'check' }[kind] || 'inbox';
    return `<div class="state"><span>${icon(ic)}</span><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${actionHtml || ''}</div>`;
  }
  function emptyHtml(title, hint) { return stateHtml('empty', title, hint); }
  function errorHtml(e, retryAct) {
    if (isForbidden(e)) return stateHtml('warn', "You don't have access to this", e.code === 'section_off' ? 'This section is turned off for your account.' : 'Ask an admin if you think you should.');
    const msg = (e && e.message) || 'Something went wrong.';
    return stateHtml('error', 'Could not load', msg, `<button type="button" class="btn btn-ghost btn-sm" data-act="${retryAct || 'retry'}">Retry</button>`);
  }
  function notConnectedHtml(title, text, showSettings) {
    const link = showSettings && hasSection('settings') ? '<a class="btn btn-ghost btn-sm" href="#/settings">Open Settings</a>' : '';
    return stateHtml('off', title, text, link);
  }

  // ---- dialog (modal) with focus trap, Esc to close
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function openDialog(opts) {
    const host = $('#crmDialogs');
    const last = document.activeElement;
    const id = 'dlg' + Math.random().toString(36).slice(2, 8);
    const scrim = el(`<div class="dlg-scrim"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
      <div class="dlg-head"><h2 id="${id}-t">${esc(opts.title)}</h2><button type="button" class="btn-icon" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="dlg-body">${opts.body || ''}</div>
      ${opts.footer !== false ? `<div class="dlg-foot">${opts.footer || ''}</div>` : ''}
    </div></div>`);
    const dlg = scrim.firstElementChild;
    if (opts.width) dlg.style.setProperty('--dlg-w', opts.width);
    function close(result) {
      if (!scrim.isConnected) return;
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (opts.onClose) opts.onClose(result);
      if (last && last.focus) last.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const f = $$(FOCUSABLE, dlg).filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], lastEl = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
    }
    scrim.addEventListener('click', (e) => { if (e.target === scrim && opts.dismissible !== false) close(); });
    scrim.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
    host.appendChild(scrim);
    const auto = $('[autofocus]', dlg) || $$(FOCUSABLE, dlg).find((x) => !x.hasAttribute('data-close')) || dlg;
    setTimeout(() => auto.focus && auto.focus(), 0);
    if (opts.onMount) opts.onMount(dlg, close);
    return { el: dlg, close };
  }
  /** In-app confirmation (never window.confirm). Resolves true/false. */
  function confirmDialog(o) {
    return new Promise((resolve) => {
      let done = false;
      openDialog({
        title: o.title || 'Are you sure?',
        body: `<p>${esc(o.text || '')}</p>`,
        footer: `<button type="button" class="btn btn-ghost btn-sm" data-close>Cancel</button><button type="button" class="btn ${o.danger ? 'btn-danger' : 'btn-gold'} btn-sm" data-ok autofocus>${esc(o.confirm || 'Confirm')}</button>`,
        onMount(dlg, close) { $('[data-ok]', dlg).addEventListener('click', () => { done = true; close(true); }); },
        onClose() { resolve(done); }
      });
    });
  }
  function copyBoxHtml(label, value) {
    return `<div class="field"><label for="cb-${esc(label).replace(/\W/g, '')}">${esc(label)}</label><div class="copybox"><input id="cb-${esc(label).replace(/\W/g, '')}" type="text" readonly value="${esc(value)}"><button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-copy="${esc(value)}">Copy</button></div></div>`;
  }

  // ---- pager
  function pagerHtml(total, page, limit, act) {
    total = Number(total) || 0; page = Number(page) || 1; limit = Number(limit) || 50;
    const pages = Math.max(1, Math.ceil(total / limit));
    const from = total ? (page - 1) * limit + 1 : 0, to = Math.min(total, page * limit);
    return `<nav class="pager" aria-label="Pagination"><span>${total ? `${from}–${to} of ${fmtNum(total)}` : 'No results'}</span>
      <span class="btns"><button type="button" class="btn btn-ghost btn-xs" data-act="${act}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span class="muted small">Page ${page} of ${pages}</span>
      <button type="button" class="btn btn-ghost btn-xs" data-act="${act}" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button></span></nav>`;
  }

  // ---- sync indicator
  function setSync(state) {
    const d = $('#syncDot'); if (!d) return;
    d.className = 'dot' + (state === 'busy' ? ' busy' : state === 'off' ? ' off' : '');
  }
  function updateSyncText() {
    const t = $('#syncText'); if (!t) return;
    const d = $('#syncDot');
    if (d && d.classList.contains('off')) { t.textContent = 'Offline'; return; }
    t.textContent = S.lastSync ? 'Synced ' + fmtRel(new Date(S.lastSync).toISOString()) : 'Not synced';
  }

  /* ============================================================
     GLOBAL EVENT DELEGATION
     Elements carry data-act="name"; handlers live in ACTIONS.
     ============================================================ */
  const ACTIONS = {};
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const fn = ACTIONS[t.dataset.act];
    if (fn) { if (t.tagName === 'A' && !t.getAttribute('href')) e.preventDefault(); fn(t, e); }
  });
  ACTIONS.retry = () => { const m = $('#crmMain'); if (m) { m.dataset.view = ''; } route(); };
  ACTIONS.copy = async (b) => { const ok = await copyText(b.dataset.copy || ''); toast(ok ? 'Copied to clipboard' : 'Could not copy — select the text and copy it manually', ok ? '' : 'err'); };
  ACTIONS.nav = (b) => { navigate(b.dataset.path, b.dataset.query ? Object.fromEntries(new URLSearchParams(b.dataset.query)) : {}); };

  /* ============================================================
     AUTH SCREENS
     ============================================================ */
  function onSignedOut() {
    if (!S.me) return;
    S.me = null;
    stopIdle();
    renderSignIn({ notice: 'You were signed out. Sign in again to continue.' });
  }

  function renderSignIn(o) {
    o = o || {};
    stopIdle();
    S.shellMounted = false;
    document.title = 'Sign in · CRM · Fuego Steakhouse & Bar';
    const app = $('#app');
    app.innerHTML = `<div class="crm-auth"><div class="crm-auth-card">
      <img class="logo" src="/assets/fuego-logo.png" alt="" width="84" height="84">
      <p class="eyebrow"><span class="hair"></span>Staff portal</p>
      <h1>Sign in</h1>
      <p class="sub">Fuego Steakhouse &amp; Bar · CRM</p>
      <div id="authAlert" role="alert">${o.notice ? `<p class="crm-auth-alert ${o.noticeType || ''}">${esc(o.notice)}</p>` : ''}</div>
      <form id="loginForm" novalidate>
        <div class="field"><label for="liEmail">Email</label><input id="liEmail" name="email" type="email" autocomplete="username" required inputmode="email"></div>
        <div class="field"><label for="liPass">Password</label><input id="liPass" name="password" type="password" autocomplete="current-password" required></div>
        <label class="check"><input type="checkbox" name="remember" id="liRemember"> Keep me signed in</label>
        <button type="submit" class="btn btn-gold" id="liSubmit">Sign in</button>
        <div class="crm-auth-foot"><button type="button" class="btn-link dim" id="liForgot">Forgot password?</button></div>
        <div id="googleWrap"></div>
      </form>
      <form id="forgotForm" hidden novalidate>
        <p class="muted small">Enter your email and we'll send a reset link if an account exists.</p>
        <div class="field"><label for="fgEmail">Email</label><input id="fgEmail" name="email" type="email" autocomplete="username" required inputmode="email"></div>
        <button type="submit" class="btn btn-gold">Send reset link</button>
        <div class="crm-auth-foot"><button type="button" class="btn-link dim" id="fgBack">Back to sign in</button></div>
      </form>
    </div></div>`;
    const alertBox = $('#authAlert');
    const setAlert = (msg, type) => { alertBox.innerHTML = msg ? `<p class="crm-auth-alert ${type || ''}">${esc(msg)}</p>` : ''; };
    if (o.error === 'google') setAlert("Google sign-in didn't work. Your Google account must match an active staff account.", 'err');

    // Google button only when the integration is configured.
    api('/api/health', { silent401: true }).then((h) => {
      S.health = h;
      if (h && h.integrations && h.integrations.google) {
        $('#googleWrap').innerHTML = `<div class="crm-auth-or">or</div><a class="btn btn-ghost" href="/api/auth/google">Sign in with Google</a>`;
      }
    }).catch(() => { /* health is optional here */ });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#liEmail').value.trim(), password = $('#liPass').value;
      if (!email || !password) { setAlert('Enter your email and password.', 'err'); return; }
      const btn = $('#liSubmit'); btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await api('/api/auth/login', { method: 'POST', body: { email, password, remember: $('#liRemember').checked }, silent401: true });
        setAlert('');
        await startApp();
      } catch (err) {
        if (err.status === 401) setAlert('Email or password is incorrect.', 'err');
        else if (err.status === 429) setAlert('Too many attempts. Please wait a few minutes and try again.', 'err');
        else if (err.code === 'offline') setAlert('You appear to be offline.', 'err');
        else setAlert(err.message || 'Could not sign in.', 'err');
      } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
    });
    $('#liForgot').addEventListener('click', () => { $('#loginForm').hidden = true; $('#forgotForm').hidden = false; $('#fgEmail').value = $('#liEmail').value; setAlert(''); $('#fgEmail').focus(); });
    $('#fgBack').addEventListener('click', () => { $('#forgotForm').hidden = true; $('#loginForm').hidden = false; setAlert(''); $('#liEmail').focus(); });
    $('#forgotForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#fgEmail').value.trim();
      if (!email) { setAlert('Enter your email.', 'err'); return; }
      try { await api('/api/auth/forgot', { method: 'POST', body: { email }, silent401: true }); } catch (err) { /* always generic */ }
      setAlert('If that email exists we sent a link. Check your inbox.', 'ok');
    });
    setTimeout(() => { const f = $('#liEmail'); if (f) f.focus(); }, 0);
  }

  function renderSetPassword(token) {
    const app = $('#app');
    document.title = 'Set password · CRM · Fuego Steakhouse & Bar';
    app.innerHTML = `<div class="crm-auth"><div class="crm-auth-card">
      <img class="logo" src="/assets/fuego-logo.png" alt="" width="84" height="84">
      <p class="eyebrow"><span class="hair"></span>Staff portal</p>
      <h1>Set your password</h1>
      <div id="setBody">${skeleton(3)}</div>
    </div></div>`;
    const body = $('#setBody');
    const clearToken = () => history.replaceState(null, '', location.pathname);
    // POST so the one-time token never appears in a URL (request logs, proxies).
    api('/api/auth/set/check', { method: 'POST', body: { token }, silent401: true }).then((r) => {
      const kind = r.kind === 'reset' ? 'Reset the password for' : 'Create a password for';
      body.innerHTML = `<p class="sub">${esc(kind)} <strong>${esc(r.email)}</strong>.</p>
        <div id="setAlert" role="alert"></div>
        <form id="setForm" novalidate>
          <div class="field"><label for="spPass">New password</label><input id="spPass" type="password" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters.</span></div>
          <div class="field"><label for="spPass2">Confirm password</label><input id="spPass2" type="password" autocomplete="new-password" minlength="10" required></div>
          <button type="submit" class="btn btn-gold" id="spSubmit">Save password and sign in</button>
        </form>`;
      const setAlert = (m, t) => { $('#setAlert').innerHTML = m ? `<p class="crm-auth-alert ${t || ''}">${esc(m)}</p>` : ''; };
      $('#setForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const p1 = $('#spPass').value, p2 = $('#spPass2').value;
        if (p1.length < 10) { setAlert('Use at least 10 characters.', 'err'); return; }
        if (p1 !== p2) { setAlert("Those passwords don't match.", 'err'); return; }
        const btn = $('#spSubmit'); btn.disabled = true;
        try {
          await api('/api/auth/set', { method: 'POST', body: { token, password: p1 }, silent401: true });
          clearToken();
          toast('Password saved. Welcome!');
          await startApp();
        } catch (err) {
          btn.disabled = false;
          if (err.status === 410 || err.code === 'expired') { body.innerHTML = expiredHtml(); return; }
          setAlert(err.message || 'Could not save the password.', 'err');
        }
      });
      $('#spPass').focus();
    }).catch((err) => {
      body.innerHTML = (err.status === 410 || err.code === 'expired' || err.status === 404) ? expiredHtml() : stateHtml('error', 'Could not check this link', err.message);
    });
    function expiredHtml() {
      return `<p class="crm-auth-alert err">This link has expired or was already used.</p>
        <div class="crm-auth-foot"><button type="button" class="btn-link" id="spNew">Request a new link</button></div>`;
    }
    body.addEventListener('click', (e) => {
      if (e.target.id === 'spNew') { clearToken(); renderSignIn(); const f = $('#liForgot'); if (f) f.click(); }
    });
  }

  /* ============================================================
     SHELL (header + sidebar + main)
     ============================================================ */
  function renderShell() {
    if (S.shellMounted && $('#crmMain')) return;
    const u = S.me.user || {};
    const groups = [];
    (S.me.sections || []).forEach((id) => {
      const s = SECTIONS[id]; if (!s) return;
      let g = groups.find((x) => x.name === s.group);
      if (!g) { g = { name: s.group, items: [] }; groups.push(g); }
      g.items.push(id);
    });
    const navHtml = groups.map((g) => `<div class="group">${esc(g.name)}</div>` + g.items.map((id) =>
      `<a class="crm-nav" href="#/${id}" data-section="${id}">${icon(SECTIONS[id].icon)}<span>${esc(SECTIONS[id].label)}</span></a>`).join('')).join('');
    const site = (S.me.business && S.me.business.site_url) || '/';
    $('#app').innerHTML = `<div class="crm-shell">
      <header class="crm-top">
        <button type="button" class="btn-icon crm-menu-btn" id="navToggle" aria-label="Menu" aria-expanded="false" aria-controls="crmSide">${icon('menu')}</button>
        <a class="crm-brand" href="#/dashboard" aria-label="CRM home"><img src="/assets/fuego-logo.png" alt="" width="44" height="44"><span class="crm-brand-text"><b>Fuego</b><span>CRM</span></span></a>
        <div class="crm-sync" aria-live="off"><span class="dot" id="syncDot"></span><span id="syncText">Synced just now</span></div>
        <button type="button" class="btn btn-ghost btn-sm" data-act="refresh" aria-label="Refresh">${icon('refresh', 'ico-sm')}<span class="btn-refresh-text">Refresh</span></button>
        <div class="crm-user">
          <button type="button" class="crm-user-btn" id="userBtn" aria-haspopup="true" aria-expanded="false" aria-controls="userMenu">
            <span class="crm-avatar" aria-hidden="true">${esc(initials(u.name || u.email))}</span>
            <span class="who"><b>${esc(u.name || u.email || 'Staff')}</b><span>${esc(roleLabel(u))}</span></span>
          </button>
          <div class="crm-user-menu" id="userMenu" hidden>
            <div class="meta">${esc(u.email || '')}<br><span class="gold">${esc(roleLabel(u))}</span></div>
            <button type="button" data-act="lock">${icon('lock', 'ico-sm')} Lock (sign out)</button>
          </div>
        </div>
      </header>
      <aside class="crm-side" id="crmSide"><nav aria-label="Sections">${navHtml}</nav>
        <div class="crm-side-foot">${esc(bizName())}<br><a href="${esc(site)}" target="_blank" rel="noopener">Open website ↗</a></div>
      </aside>
      <div class="crm-scrim" id="crmScrim"></div>
      <main class="crm-main" id="crmMain" tabindex="-1"></main>
    </div>`;
    S.shellMounted = true;
    $('#navToggle').addEventListener('click', () => { const side = $('#crmSide'); side.classList.contains('open') ? closeNav() : openNav(); });
    $('#crmScrim').addEventListener('click', closeNav);
    const ub = $('#userBtn'), um = $('#userMenu');
    ub.addEventListener('click', () => { const open = um.hidden; um.hidden = !open; ub.setAttribute('aria-expanded', String(open)); if (open) $('button', um).focus(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.crm-user')) { um.hidden = true; ub.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !um.hidden) { um.hidden = true; ub.setAttribute('aria-expanded', 'false'); ub.focus(); } });
    clearInterval(S.syncTimer); S.syncTimer = setInterval(updateSyncText, 30000);
    updateSyncText();
  }
  function openNav() { $('#crmSide').classList.add('open'); $('#crmScrim').classList.add('show'); $('#navToggle').setAttribute('aria-expanded', 'true'); }
  function closeNav() { const s = $('#crmSide'); if (!s) return; s.classList.remove('open'); $('#crmScrim').classList.remove('show'); $('#navToggle').setAttribute('aria-expanded', 'false'); }

  ACTIONS.refresh = () => { const m = $('#crmMain'); if (m) m.dataset.view = ''; route(); };
  ACTIONS.lock = async () => {
    try { await api('/api/auth/logout', { method: 'POST', silent401: true }); } catch (e) { /* ignore */ }
    S.me = null; stopIdle();
    renderSignIn({ notice: 'Locked. Sign in to continue.', noticeType: 'ok' });
  };

  // ---- idle handling: the server signs a non-remembered session out after 30 min
  // without requests. We only keep it alive while the person is actually using the
  // page: every 5 min, ping if there was input since the last ping. An idle tab
  // therefore times out as the spec requires; a 401 drops us to sign-in via api().
  let lastActivity = Date.now(), lastPing = Date.now();
  const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
  function noteActivity() { lastActivity = Date.now(); }
  function startIdle() {
    stopIdle();
    ACTIVITY_EVENTS.forEach((ev) => document.addEventListener(ev, noteActivity, { passive: true }));
    S.idleTimer = setInterval(() => {
      if (lastActivity > lastPing) { lastPing = Date.now(); api('/api/auth/ping', { method: 'POST' }).catch(() => { /* handled */ }); }
    }, 5 * 60 * 1000);
  }
  function stopIdle() {
    clearInterval(S.idleTimer); S.idleTimer = null;
    ACTIVITY_EVENTS.forEach((ev) => document.removeEventListener(ev, noteActivity));
  }

  /* ============================================================
     VIEW: DASHBOARD
     ============================================================ */
  VIEWS.dashboard = {
    render(root, q, token) {
      const range = q.range || 'any';
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Overview</p><h1>Dashboard</h1></div>
        <div class="page-actions"><div class="field-inline"><label for="dbRange" class="sr-only">Date range</label><select id="dbRange">${rangeOptions(range)}</select></div>
        <div class="custom-range" id="dbCustom" ${range === 'custom' ? '' : 'hidden'}><label for="dbFrom" class="sr-only">From</label><input type="date" id="dbFrom" value="${esc(q.from || '')}"><label for="dbTo" class="sr-only">To</label><input type="date" id="dbTo" value="${esc(q.to || '')}"><button type="button" class="btn btn-ghost btn-xs" data-act="dbApply">Apply</button></div></div></div>
        <div id="dbBody">${skeletonTiles(4)}<div class="grid-2"><div class="card">${skeleton(4)}</div><div class="card">${skeleton(4)}</div></div></div>`;
      $('#dbRange').addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === 'custom') { $('#dbCustom').hidden = false; $('#dbFrom').focus(); return; }
        setQuery({ range: v === 'any' ? '' : v, from: '', to: '' });
      });
      this.load(q, token);
    },
    update(root, q) { this.render(root, q, ++S.viewToken); },
    async load(q, token) {
      const body = $('#dbBody'); if (!body) return;
      const query = { range: q.range || undefined, from: q.from, to: q.to };
      let d;
      try { d = await api('/api/dashboard', { query }); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      const filtered = !!(q.range && q.range !== 'any');
      const byForm = d.by_form || {};
      const tiles = [
        `<a class="tile accent" href="#/leads?stage=new"><span class="k">New</span><span class="v">${fmtNum(d.new)}</span><span class="s">awaiting first contact</span></a>`,
        `<a class="tile" href="${esc(hashFor('/leads', { range: q.range || 'week', from: q.from, to: q.to }))}"><span class="k">${filtered ? 'In range' : 'This week'}</span><span class="v">${fmtNum(d.in_range)}</span><span class="s">${esc(d.range_label || (filtered ? rangeLabel(q.range) : 'This week'))}</span></a>`
      ].concat(Object.keys(forms()).map((id) => {
        const c = byForm[id] || { total: 0, won: 0 };
        const p = pipelineFor(id);
        return `<a class="tile" href="#/leads?form=${esc(id)}"><span class="k">${esc(formLabel(id))}</span><span class="v">${fmtNum(c.total)}</span><span class="s">${fmtNum(c.won)} ${esc(p && p.wonLabel ? p.wonLabel : 'won')}</span></a>`;
      }));
      const em = d.email || {};
      let emailHtml;
      if (!em.connected) {
        emailHtml = `<div class="state compact">${icon('plug')}<p>Not connected — add a Resend key in Settings to send notifications and auto-replies.</p>${hasSection('settings') ? '<a class="btn btn-ghost btn-xs" href="#/settings">Open Settings</a>' : ''}</div>`;
      } else {
        emailHtml = `<div class="health">
          <div class="row"><span>Status</span><span class="pill ok">Connected</span></div>
          <div class="row"><span>Sent (7 days)</span><b>${fmtNum(em.sent)}</b></div>
          <div class="row"><span>Failed (7 days)</span><b class="${em.failed ? 'gold' : ''}">${fmtNum(em.failed)}</b></div>
          <div class="row"><span>Last sent</span><span title="${esc(fmtDate(em.last_sent_at))}">${esc(fmtRel(em.last_sent_at))}</span></div>
          ${em.last_error ? `<div class="lasterr">Last error: ${esc(em.last_error)}</div>` : ''}
        </div>`;
      }
      const recent = (d.recent || []);
      const recentHtml = recent.length ? `<ul class="activity">${recent.map((a) => `<li><span class="when" title="${esc(fmtDate(a.created_at))}">${esc(fmtRel(a.created_at))}</span>
        <span class="what">${a.lead_id ? `<a class="row-btn" href="#/leads?lead=${esc(a.lead_id)}">${esc(a.lead_name || 'Lead')}</a>` : `<b>${esc(a.lead_name || '')}</b>`} <span class="muted">· ${esc(actionLabel(a.action))}</span>${a.detail ? ` <span class="muted">— ${esc(a.detail)}</span>` : ''}<br><span class="who">${esc(a.user_name || 'System')}</span></span></li>`).join('')}</ul>`
        : emptyHtml('No activity yet', 'Stage changes, notes and new leads will show up here.');
      const warns = d.warnings || [];
      body.innerHTML = `<div class="tiles">${tiles.join('')}</div>
        ${warns.length ? `<ul class="warnings">${warns.map((w) => `<li class="notice warn">${icon('warn')}<span>${esc(w)}</span></li>`).join('')}</ul>` : ''}
        <div class="grid-2" ${warns.length ? 'data-after-warn' : ''}>
          <div class="card"><div class="card-head"><h2>Recent activity</h2>${hasSection('leads') ? '<a class="btn-link small" href="#/leads">All leads</a>' : ''}</div>${recentHtml}</div>
          <div class="card"><div class="card-head"><h2>Email delivery</h2><span class="sub">Last 7 days</span></div>${emailHtml}</div>
        </div>`;
      if (warns.length) $('.grid-2', body).classList.add('mt');
    }
  };
  ACTIONS.dbApply = () => { setQuery({ range: 'custom', from: $('#dbFrom').value, to: $('#dbTo').value }); };
  function actionLabel(a) {
    const m = { stage: 'stage changed', lead_stage: 'stage changed', note: 'note added', lead_note: 'note added', created: 'new lead', lead_new: 'new lead', lead_delete: 'lead deleted', lead_export: 'exported CSV' };
    return m[a] || String(a || '').replace(/_/g, ' ');
  }

  /* ============================================================
     VIEW: LEADS (list + pipeline + detail panel)
     ============================================================ */
  const LV = { items: [], total: 0, counts: {}, q: {}, token: 0, openId: null, dragId: null, pipeItems: [] };

  VIEWS.leads = {
    render(root, q, token) {
      LV.q = q; LV.token = token;
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Inbox</p><h1>Leads</h1></div>
        <div class="page-actions">
          <div class="seg" role="group" aria-label="View"><button type="button" data-act="lvView" data-view="list" aria-pressed="${q.view !== 'pipeline'}">List</button><button type="button" data-act="lvView" data-view="pipeline" aria-pressed="${q.view === 'pipeline'}">Pipeline</button></div>
          ${can('leads.export') ? `<a class="btn btn-ghost btn-sm" id="lvExport" href="/api/leads/export.csv" target="_blank" rel="noopener">Export CSV</a>` : ''}
        </div></div>
        <div class="leads-layout" id="lvLayout"><div class="leads-main">
          <div class="tabs" id="lvTabs" role="tablist" aria-label="Form type"></div>
          <div class="toolbar">
            <div class="search"><label for="lvQ" class="sr-only">Search leads</label><input id="lvQ" type="search" placeholder="Search name, email, phone, message…" value="${esc(q.q || '')}" autocomplete="off"></div>
            <div class="field-inline"><label for="lvStage" class="sr-only">Stage</label><select id="lvStage"><option value="">All stages</option>${STAGES.map((s) => `<option value="${s}"${q.stage === s ? ' selected' : ''}>${esc(stageOptionLabel(q, s))}</option>`).join('')}</select></div>
            <div class="field-inline"><label for="lvRange" class="sr-only">Received</label><select id="lvRange">${rangeOptions(q.range)}</select></div>
            <div class="custom-range" id="lvCustom" ${q.range === 'custom' ? '' : 'hidden'}><label for="lvFrom" class="sr-only">From</label><input type="date" id="lvFrom" value="${esc(q.from || '')}"><label for="lvTo" class="sr-only">To</label><input type="date" id="lvTo" value="${esc(q.to || '')}"><button type="button" class="btn btn-ghost btn-xs" data-act="lvApplyRange">Apply</button></div>
            <button type="button" class="btn-link dim small" data-act="lvClear">Clear filters</button>
          </div>
          <div id="lvBody">${skeleton(8)}</div>
        </div><aside id="lvPanel" hidden></aside></div>`;
      $('#lvQ').addEventListener('input', debounce((e) => setQuery({ q: e.target.value.trim(), page: '' }, { replace: true }), 320));
      $('#lvStage').addEventListener('change', (e) => setQuery({ stage: e.target.value, page: '' }));
      $('#lvRange').addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === 'custom') { $('#lvCustom').hidden = false; $('#lvFrom').focus(); return; }
        setQuery({ range: v === 'any' ? '' : v, from: '', to: '', page: '' });
      });
      document.addEventListener('keydown', onLeadsKey);
      this.renderTabs();
      this.load();
      if (q.lead) openLead(q.lead);
    },
    /** Called on hash changes while already on Leads: keep the toolbar DOM, refetch. */
    update(root, q, prevQ) {
      LV.q = q;
      const filterKeys = ['view', 'form', 'pipe', 'stage', 'range', 'from', 'to', 'q', 'page'];
      const changed = filterKeys.some((k) => (q[k] || '') !== (prevQ[k] || ''));
      // sync controls that may have been changed via navigation (back button, clear filters)
      const st = $('#lvStage'); if (st && st.value !== (q.stage || '')) st.value = q.stage || '';
      const rg = $('#lvRange'); if (rg && rg.value !== (q.range || 'any')) rg.value = q.range || 'any';
      const cu = $('#lvCustom'); if (cu) cu.hidden = q.range !== 'custom';
      const sq = $('#lvQ'); if (sq && document.activeElement !== sq && sq.value !== (q.q || '')) sq.value = q.q || '';
      $$('.seg [data-view]', root).forEach((b) => b.setAttribute('aria-pressed', String((q.view === 'pipeline') === (b.dataset.view === 'pipeline'))));
      if (changed) { LV.token = ++S.viewToken; this.renderTabs(); this.load(); }
      if ((q.lead || '') !== (prevQ.lead || '')) { if (q.lead) openLead(q.lead); else closePanel(false); }
    },
    renderTabs() {
      const q = LV.q, tabs = $('#lvTabs'); if (!tabs) return;
      const bf = (LV.counts && LV.counts.by_form) || {};
      if (q.view === 'pipeline') {
        // pipeline tabs: one per pipeline, count = sum of its forms
        const ps = pipelines(); const ids = Object.keys(ps);
        const cur = q.pipe && ps[q.pipe] ? q.pipe : ids[0];
        tabs.innerHTML = ids.map((id) => {
          const n = Object.keys(forms()).filter((f) => forms()[f].pipeline === id).reduce((a, f) => a + (bf[f] || 0), 0);
          return `<button type="button" role="tab" aria-selected="${id === cur}" data-act="lvPipe" data-pipe="${esc(id)}">${esc(ps[id].label)} <span class="count">${fmtNum(n)}</span></button>`;
        }).join('');
      } else {
        const all = Object.keys(bf).reduce((a, k) => a + (bf[k] || 0), 0);
        tabs.innerHTML = `<button type="button" role="tab" aria-selected="${!q.form}" data-act="lvForm" data-form="">All <span class="count">${fmtNum(all)}</span></button>` +
          Object.keys(forms()).map((id) => `<button type="button" role="tab" aria-selected="${q.form === id}" data-act="lvForm" data-form="${esc(id)}">${esc(formLabel(id))} <span class="count">${fmtNum(bf[id] || 0)}</span></button>`).join('');
      }
      const ex = $('#lvExport'); if (ex) ex.href = '/api/leads/export.csv?' + qs(leadsQuery(q));
    },
    async load() {
      const q = LV.q, token = LV.token, body = $('#lvBody'); if (!body) return;
      body.innerHTML = q.view === 'pipeline' ? skeleton(10) : skeleton(8);
      const isPipe = q.view === 'pipeline';
      let query = leadsQuery(q);
      if (isPipe) {
        const ids = Object.keys(pipelines());
        const cur = q.pipe && pipelines()[q.pipe] ? q.pipe : ids[0];
        query = Object.assign({}, query, { form: undefined, pipeline: cur, page: 1, limit: 500 });
      } else {
        query.page = Number(q.page) || 1; query.limit = 50;
      }
      let d;
      try { d = await api('/api/leads', { query }); } catch (e) { if (token === LV.token) body.innerHTML = errorHtml(e); return; }
      if (token !== LV.token) return;
      LV.items = d.items || []; LV.total = d.total || 0; LV.counts = d.counts || {};
      this.renderTabs();
      if (isPipe) renderBoard(body, query.pipeline); else renderList(body);
    }
  };
  function stageOptionLabel(q, s) {
    // When a form is selected use that pipeline's labels; otherwise generic.
    if (q.form && forms()[q.form]) return stageLabel(q.form, s);
    return { new: 'New', contacted: 'Contacted', scheduled: 'Scheduled', won: 'Won', closed: 'Closed' }[s];
  }
  function leadsQuery(q) {
    return { form: q.form || undefined, stage: q.stage || undefined, range: q.range || undefined, from: q.from || undefined, to: q.to || undefined, q: q.q || undefined };
  }
  function onLeadsKey(e) {
    if (e.key === 'Escape' && LV.openId && !$('.dlg-scrim')) { closePanel(true); }
  }
  ACTIONS.lvView = (b) => setQuery({ view: b.dataset.view === 'pipeline' ? 'pipeline' : '', page: '' });
  ACTIONS.lvForm = (b) => setQuery({ form: b.dataset.form, page: '' });
  ACTIONS.lvPipe = (b) => setQuery({ pipe: b.dataset.pipe });
  ACTIONS.lvApplyRange = () => setQuery({ range: 'custom', from: $('#lvFrom').value, to: $('#lvTo').value, page: '' });
  ACTIONS.lvClear = () => navigate('/leads', { view: LV.q.view || '', lead: LV.q.lead || '' });
  ACTIONS.lvPage = (b) => setQuery({ page: b.dataset.page });
  ACTIONS.openLead = (b) => setQuery({ lead: b.dataset.id });
  ACTIONS.closePanel = () => closePanel(true);

  // ---- list view (table on desktop → cards on mobile via CSS)
  function renderList(body) {
    const items = LV.items, q = LV.q;
    if (!items.length) {
      const filtered = !!(q.form || q.stage || q.range || q.q);
      body.innerHTML = filtered ? emptyHtml('No leads match these filters', 'Try widening the date range or clearing filters.') : emptyHtml('No leads yet', 'Submissions from the website forms will appear here the moment they arrive.');
      return;
    }
    body.innerHTML = `<div class="tbl-wrap cards"><table class="tbl" id="lvTable"><thead><tr>
        <th scope="col">Contact</th><th scope="col">Form</th><th scope="col">Interest / topic</th><th scope="col">Stage</th><th scope="col">Received</th></tr></thead>
      <tbody>${items.map(leadRowHtml).join('')}</tbody></table></div>${pagerHtml(LV.total, Number(q.page) || 1, 50, 'lvPage')}`;
    const tb = $('tbody', body);
    tb.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && !e.target.closest('a')) setQuery({ lead: tr.dataset.id }); });
    tb.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-id]')) { e.preventDefault(); setQuery({ lead: e.target.dataset.id }); } });
    markOpenRow();
  }
  function leadRowHtml(l) {
    const contact = [l.email, l.phone].filter(Boolean).map(esc).join(' · ');
    return `<tr class="row-link${l.id === LV.openId ? ' is-open' : ''}" data-id="${esc(l.id)}" tabindex="0" aria-label="Open ${esc(l.name || l.email || 'lead')}">
      <td data-label="Contact" class="no-label contact-cell"><b>${esc(l.name || l.email || '—')}</b><span class="sub">${contact}</span></td>
      <td data-label="Form"><span class="cellv">${esc(l.form_label || formLabel(l.form))}</span></td>
      <td data-label="Topic"><span class="cellv">${esc(l.topic || '—')}</span></td>
      <td data-label="Stage"><span class="pill stage-${esc(l.stage)}">${esc(l.stage_label || stageLabel(l.form, l.stage))}</span></td>
      <td data-label="Received" class="nowrap"><span class="cellv" title="${esc(fmtDate(l.created_at))}">${esc(fmtRel(l.created_at))}</span></td></tr>`;
  }
  function markOpenRow() { $$('#lvTable tr[data-id]').forEach((tr) => tr.classList.toggle('is-open', tr.dataset.id === LV.openId)); }

  // ---- pipeline board
  function renderBoard(body, pipeId) {
    const p = pipelines()[pipeId]; if (!p) { body.innerHTML = emptyHtml('No pipeline configured'); return; }
    const items = LV.items;
    const total = items.length, won = items.filter((l) => l.stage === 'won').length;
    const stats = `<div class="pipe-stats"><span><b>${pct(won, total)}%</b> ${esc(p.wonLabel || 'won')} · ${fmtNum(won)} of ${fmtNum(total)}</span>${total >= 500 ? '<span class="muted">Showing the 500 most recent</span>' : ''}</div>`;
    if (!total) { body.innerHTML = stats + emptyHtml('Nothing in this pipeline', 'New ' + (p.label || '').toLowerCase() + ' leads will appear in the first column.'); return; }
    body.innerHTML = stats + `<div class="board" id="board">${STAGES.map((s) => {
      const col = items.filter((l) => l.stage === s);
      return `<section class="col" data-stage="${s}" aria-label="${esc(p.stages[s] || s)}"><div class="col-head"><span>${esc(p.stages[s] || s)}</span><span class="count">${col.length}</span></div>
        <div class="col-body">${col.map((l) => pipeCardHtml(l, p)).join('') || '<div class="col-empty">Drop here</div>'}</div></section>`;
    }).join('')}</div>`;
    const board = $('#board');
    const canEdit = can('leads.edit');
    if (canEdit) {
      board.addEventListener('dragstart', (e) => { const c = e.target.closest('.pcard'); if (!c) return; LV.dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', c.dataset.id); } catch (err) { /* IE */ } });
      board.addEventListener('dragend', (e) => { const c = e.target.closest('.pcard'); if (c) c.classList.remove('dragging'); $$('.col.drag-over', board).forEach((x) => x.classList.remove('drag-over')); });
      board.addEventListener('dragover', (e) => { const col = e.target.closest('.col'); if (!col || !LV.dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drag-over'); });
      board.addEventListener('dragleave', (e) => { const col = e.target.closest('.col'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
      board.addEventListener('drop', (e) => { const col = e.target.closest('.col'); if (!col) return; e.preventDefault(); col.classList.remove('drag-over'); const id = LV.dragId; LV.dragId = null; if (id) moveCard(id, col.dataset.stage); });
      board.addEventListener('change', (e) => { const sel = e.target.closest('select[data-stage-for]'); if (sel) moveCard(sel.dataset.stageFor, sel.value); });
    }
  }
  function pipeCardHtml(l, p) {
    const canEdit = can('leads.edit');
    return `<article class="pcard" data-id="${esc(l.id)}" ${canEdit ? 'draggable="true"' : ''}>
      <div class="name"><button type="button" class="row-btn" data-act="openLead" data-id="${esc(l.id)}">${esc(l.name || l.email || '—')}</button></div>
      ${l.topic ? `<div class="topic">${esc(l.topic)}</div>` : ''}
      <div class="meta"><span>${esc(l.email || l.phone || '')}</span><span title="${esc(fmtDate(l.created_at))}">${esc(fmtRel(l.created_at))}</span></div>
      ${canEdit ? `<div class="stage-select"><label class="sr-only" for="ps-${esc(l.id)}">Stage</label><select id="ps-${esc(l.id)}" data-stage-for="${esc(l.id)}">${STAGES.map((s) => `<option value="${s}"${l.stage === s ? ' selected' : ''}>${esc(p.stages[s] || s)}</option>`).join('')}</select></div>` : ''}
    </article>`;
  }
  /** Optimistic stage move on the board; reverts the card on API error. */
  async function moveCard(id, stage) {
    const lead = LV.items.find((l) => l.id === id); if (!lead || lead.stage === stage) return;
    const prevStage = lead.stage;
    const card = $(`#board .pcard[data-id="${CSS.escape(id)}"]`);
    const place = (st) => {
      const colBody = $(`#board .col[data-stage="${st}"] .col-body`); if (!colBody || !card) return;
      const ph = $('.col-empty', colBody); if (ph) ph.remove();
      colBody.prepend(card);
      const sel = $('select', card); if (sel) sel.value = st;
      refreshColCounts();
    };
    lead.stage = stage; place(stage); if (card) card.classList.add('saving');
    try {
      const r = await api('/api/leads/' + encodeURIComponent(id), { method: 'PATCH', body: { stage } });
      if (r && r.lead) Object.assign(lead, r.lead);
      toast('Moved to ' + stageLabel(lead.form, stage));
      if (LV.openId === id) openLead(id, true);
    } catch (e) {
      lead.stage = prevStage; place(prevStage);
      toast(e.message || 'Could not update the stage', 'err');
    } finally { if (card) card.classList.remove('saving'); }
  }
  function refreshColCounts() {
    $$('#board .col').forEach((col) => {
      const n = $$('.pcard', col).length; $('.count', col).textContent = n;
      const b = $('.col-body', col); if (!n && !$('.col-empty', b)) b.innerHTML = '<div class="col-empty">Drop here</div>';
    });
    const total = LV.items.length, won = LV.items.filter((l) => l.stage === 'won').length;
    const s = $('.pipe-stats b'); if (s) s.textContent = pct(won, total) + '%';
    const span = $('.pipe-stats span'); const p = pipelines()[LV.q.pipe] || pipelines()[Object.keys(pipelines())[0]];
    if (span && p) span.innerHTML = `<b>${pct(won, total)}%</b> ${esc(p.wonLabel || 'won')} · ${fmtNum(won)} of ${fmtNum(total)}`;
  }

  // ---- detail panel (sticky aside ≥1100px, full-screen overlay below)
  async function openLead(id, silent) {
    const panel = $('#lvPanel'); if (!panel) return;
    const first = LV.openId !== id;
    LV.openId = id; markOpenRow();
    panel.hidden = false; panel.className = 'panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Lead details'); panel.tabIndex = -1;
    $('#lvLayout').classList.add('has-panel');
    if (first || !silent) panel.innerHTML = `<div class="panel-head"><div><h2>Loading…</h2></div><button type="button" class="btn-icon panel-close" data-act="closePanel" aria-label="Close">${icon('close')}</button></div>${skeleton(10)}`;
    if (first) setTimeout(() => panel.focus(), 0);
    let d;
    try { d = await api('/api/leads/' + encodeURIComponent(id)); }
    catch (e) {
      if (LV.openId !== id) return;
      panel.innerHTML = `<div class="panel-head"><div><h2>Lead</h2></div><button type="button" class="btn-icon panel-close" data-act="closePanel" aria-label="Close">${icon('close')}</button></div>${e.status === 404 ? emptyHtml('Lead not found', 'It may have been deleted.') : errorHtml(e, 'retryLead')}`;
      return;
    }
    if (LV.openId !== id) return;
    renderPanel(panel, d);
  }
  ACTIONS.retryLead = () => { if (LV.openId) openLead(LV.openId); };
  function closePanel(nav) {
    const panel = $('#lvPanel');
    LV.openId = null; markOpenRow();
    if (panel) { panel.hidden = true; panel.innerHTML = ''; panel.className = ''; }
    const lay = $('#lvLayout'); if (lay) lay.classList.remove('has-panel');
    if (nav && LV.q.lead) setQuery({ lead: '' }, { replace: true });
    const m = $('#crmMain'); if (m) m.focus();
  }
  function renderPanel(panel, d) {
    const l = d.lead || {}, p = pipelineFor(l.form) || { stages: {} };
    const fieldsDef = (forms()[l.form] && forms()[l.form].fields) || [];
    const skip = { name: 1, email: 1, phone: 1, message: 1 };
    const fieldRows = [];
    fieldRows.push(['Email', l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '—']);
    fieldRows.push(['Phone', l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : '—']);
    const f = l.fields || {};
    fieldsDef.forEach((fd) => { if (!skip[fd.key] && f[fd.key] != null && f[fd.key] !== '') fieldRows.push([fd.label || fd.key, esc(f[fd.key])]); });
    Object.keys(f).forEach((k) => { if (!skip[k] && !fieldsDef.some((fd) => fd.key === k) && f[k] !== '' && f[k] != null) fieldRows.push([k, esc(f[k])]); });
    if (l.page) fieldRows.push(['Page', esc(l.page)]);
    const utm = l.utm || {}; const utmTxt = Object.keys(utm).filter((k) => utm[k]).map((k) => `${k.replace(/^utm_/, '')}: ${utm[k]}`).join(' · ');
    if (utmTxt) fieldRows.push(['Source', esc(utmTxt)]);
    if (l.email_status) fieldRows.push(['Auto-reply', esc(l.email_status)]);
    const subject = `Re: your ${l.form_label || formLabel(l.form)} — ${bizName()}`;
    const canEdit = can('leads.edit');
    const curIdx = STAGES.indexOf(l.stage);
    const stepper = `<div class="stepper" role="group" aria-label="Stage">${STAGES.map((s, i) => {
      const cls = (i < curIdx ? 'done' : '') + (i === curIdx ? ' cur' : '');
      const inner = `<span class="dotl"></span><span class="lbl">${esc(p.stages[s] || s)}</span>`;
      return canEdit ? `<button type="button" class="${cls}" data-act="setStage" data-id="${esc(l.id)}" data-stage="${s}" aria-pressed="${i === curIdx}" ${i === curIdx ? 'disabled' : ''}>${inner}</button>` : `<span class="${cls}" aria-current="${i === curIdx ? 'step' : 'false'}">${inner}</span>`;
    }).join('')}</div>`;
    const notes = d.notes || [], act = d.activity || [];
    panel.innerHTML = `
      <div class="panel-head"><div><p class="eyebrow"><span class="hair"></span>${esc(l.form_label || formLabel(l.form))}</p><h2>${esc(l.name || l.email || 'Lead')}</h2>
        <p class="sub">Received ${esc(fmtDate(l.created_at))} · <span class="pill stage-${esc(l.stage)}">${esc(l.stage_label || stageLabel(l.form, l.stage))}</span></p></div>
        <button type="button" class="btn-icon panel-close" data-act="closePanel" aria-label="Close details">${icon('close')}</button></div>
      <div class="panel-actions">
        ${l.email ? `<a class="btn btn-gold btn-sm" href="mailto:${esc(l.email)}?subject=${encodeURIComponent(subject)}">${icon('mail', 'ico-sm')} Reply by email</a>` : ''}
        ${l.phone ? `<a class="btn btn-ghost btn-sm" href="tel:${esc(String(l.phone).replace(/[^+\d]/g, ''))}">${icon('phone', 'ico-sm')} Call</a>` : ''}
        ${l.has_file ? `<a class="btn btn-ghost btn-sm" href="/api/leads/${esc(l.id)}/file" target="_blank" rel="noopener">${icon('file', 'ico-sm')} Open ${esc(l.file_name ? '· ' + l.file_name : 'attachment')}</a>` : ''}
      </div>
      <section><h3>Stage</h3>${stepper}</section>
      <section><h3>Details</h3><table class="kv"><tbody>${fieldRows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table></section>
      ${l.message ? `<section><h3>Message</h3><div class="msgbox">${esc(l.message)}</div></section>` : ''}
      <section><h3>Notes</h3>
        ${notes.length ? `<ul class="notes" id="noteList">${notes.map(noteHtml).join('')}</ul>` : '<p class="muted small" id="noteEmpty">No notes yet.</p><ul class="notes" id="noteList"></ul>'}
        ${can('notes.add') ? `<form id="noteForm" class="field"><label for="noteBody">Add a note</label><textarea id="noteBody" rows="3" placeholder="Called back, left voicemail…" required></textarea><div class="form-actions"><button type="submit" class="btn btn-ghost btn-sm">Add note</button></div></form>` : ''}
      </section>
      <section><h3>History</h3>${act.length ? `<ul class="hist">${act.map((a) => `<li><span class="when" title="${esc(fmtDate(a.created_at))}">${esc(fmtRel(a.created_at))}</span><span>${esc(actionLabel(a.action))}${a.detail ? ` — ${esc(a.detail)}` : ''} <span class="by">· ${esc(a.user_name || 'System')}</span></span></li>`).join('')}</ul>` : '<p class="muted small">No activity recorded.</p>'}</section>
      ${can('leads.delete') ? `<div class="danger-zone"><button type="button" class="btn btn-danger btn-xs" data-act="deleteLead" data-id="${esc(l.id)}" data-name="${esc(l.name || l.email || 'this lead')}">${icon('trash', 'ico-sm')} Delete lead</button></div>` : ''}`;
    const nf = $('#noteForm', panel);
    if (nf) nf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ta = $('#noteBody', panel); const body = ta.value.trim(); if (!body) return;
      const btn = $('button', nf); btn.disabled = true;
      try {
        const r = await api('/api/leads/' + encodeURIComponent(l.id) + '/notes', { method: 'POST', body: { body } });
        const note = (r && r.note) || { body, user_name: (S.me.user && S.me.user.name) || 'You', created_at: new Date().toISOString() };
        const list = $('#noteList', panel); list.insertAdjacentHTML('afterbegin', noteHtml(note));
        const em = $('#noteEmpty', panel); if (em) em.remove();
        ta.value = ''; toast('Note added');
      } catch (err) { toast(err.message || 'Could not add the note', 'err'); }
      finally { btn.disabled = false; }
    });
  }
  function noteHtml(n) { return `<li>${esc(n.body)}<span class="by">${esc(n.user_name || 'Staff')} · <time title="${esc(fmtDate(n.created_at))}">${esc(fmtRel(n.created_at))}</time></span></li>`; }
  ACTIONS.setStage = async (b) => {
    const id = b.dataset.id, stage = b.dataset.stage;
    $$('.stepper button').forEach((x) => { x.disabled = true; });
    try {
      const r = await api('/api/leads/' + encodeURIComponent(id), { method: 'PATCH', body: { stage } });
      const lead = LV.items.find((l) => l.id === id);
      if (lead) { lead.stage = stage; if (r && r.lead) Object.assign(lead, r.lead); }
      toast('Stage updated');
      // refresh the row / card and the panel
      const tr = $(`#lvTable tr[data-id="${CSS.escape(id)}"]`); if (tr && lead) tr.outerHTML = leadRowHtml(lead);
      if ($('#board') && lead) { const card = $(`#board .pcard[data-id="${CSS.escape(id)}"]`); const col = $(`#board .col[data-stage="${stage}"] .col-body`); if (card && col) { const ph = $('.col-empty', col); if (ph) ph.remove(); col.prepend(card); const sel = $('select', card); if (sel) sel.value = stage; refreshColCounts(); } }
      openLead(id, true);
    } catch (e) { toast(e.message || 'Could not update the stage', 'err'); openLead(id, true); }
  };
  ACTIONS.deleteLead = async (b) => {
    const ok = await confirmDialog({ title: 'Delete this lead?', text: `${b.dataset.name} and any notes or attachment will be permanently removed. This cannot be undone.`, confirm: 'Delete lead', danger: true });
    if (!ok) return;
    try {
      await api('/api/leads/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
      toast('Lead deleted');
      closePanel(true);
      LV.token = ++S.viewToken; VIEWS.leads.load();
    } catch (e) { toast(e.message || 'Could not delete the lead', 'err'); }
  };

  /* ============================================================
     VIEW: ANALYTICS
     ============================================================ */
  VIEWS.analytics = {
    render(root, q, token) {
      const range = ['7d', '28d', '90d'].includes(q.range) ? q.range : '28d';
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Website</p><h1>Analytics</h1></div>
        <div class="page-actions"><div class="seg" role="group" aria-label="Range">${['7d', '28d', '90d'].map((r) => `<button type="button" data-act="anRange" data-range="${r}" aria-pressed="${r === range}">${r.replace('d', ' days')}</button>`).join('')}</div></div></div>
        <div id="anBody">${skeletonTiles(3)}<div class="card">${skeleton(6)}</div></div>`;
      this.load(range, token);
    },
    update(root, q) { this.render(root, q, ++S.viewToken); },
    async load(range, token) {
      const body = $('#anBody');
      let d;
      try { d = await api('/api/analytics', { query: { range } }); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      if (!d.connected) {
        body.innerHTML = `<div class="card">${notConnectedHtml('Google Analytics is not connected', (d.reason || 'GA4 not connected') + '. To connect: in Settings, add the GA4 property ID and a service-account JSON key that has Viewer access to the property.', true)}</div>`;
        return;
      }
      const t = d.totals || {};
      const daily = d.daily || [];
      body.innerHTML = `<div class="tiles">
          <div class="tile"><span class="k">Sessions</span><span class="v">${fmtNum(t.sessions)}</span></div>
          <div class="tile"><span class="k">Users</span><span class="v">${fmtNum(t.users)}</span></div>
          <div class="tile"><span class="k">Conversions</span><span class="v">${fmtNum(t.conversions)}</span></div>
        </div>
        <div class="card"><div class="card-head"><h2>Sessions per day</h2><span class="sub">Cached ${esc(fmtRel(d.cached_at))}</span></div>${barChart(daily)}</div>
        <div class="grid-2" id="anGrid">
          <div class="card"><div class="card-head"><h2>Top pages</h2></div>${simpleTable(['Page', 'Views'], (d.top_pages || []).map((r) => [r.path, fmtNum(r.views)]), 'No page data in this range.')}</div>
          <div class="card"><div class="card-head"><h2>Sources</h2></div>${simpleTable(['Source', 'Sessions'], (d.sources || []).map((r) => [r.source, fmtNum(r.sessions)]), 'No source data in this range.')}</div>
          <div class="card"><div class="card-head"><h2>Leads by source</h2><span class="sub">From form attribution (UTM / referrer)</span></div>${simpleTable(['Source', 'Leads'], (d.leads_by_source || []).map((r) => [r.source || 'direct', fmtNum(r.leads)]), 'No leads with attribution yet.')}</div>
        </div>`;
      $('#anGrid').classList.add('mt');
    }
  };
  ACTIONS.anRange = (b) => setQuery({ range: b.dataset.range });
  function simpleTable(heads, rows, empty) {
    if (!rows.length) return `<p class="muted small">${esc(empty)}</p>`;
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${heads.map((h, i) => `<th scope="col" class="${i ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  /** Inline SVG bar chart, no libraries. */
  function barChart(daily) {
    if (!daily.length) return '<p class="muted small">No daily data in this range.</p>';
    const W = 640, H = 170, padL = 34, padB = 22, padT = 8;
    const max = Math.max(1, ...daily.map((d) => Number(d.sessions) || 0));
    const n = daily.length, gap = n > 40 ? 1 : 3, bw = (W - padL) / n - gap;
    const bars = daily.map((d, i) => {
      const v = Number(d.sessions) || 0, h = Math.round(((H - padB - padT) * v) / max);
      const x = padL + i * (bw + gap), y = H - padB - h;
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y}" width="${Math.max(1, bw).toFixed(1)}" height="${h}" rx="1"><title>${esc(d.date)}: ${fmtNum(v)} sessions, ${fmtNum(d.users)} users</title></rect>`;
    }).join('');
    const ticks = [0, Math.round(max / 2), max].map((v) => { const y = H - padB - Math.round(((H - padB - padT) * v) / max); return `<text class="lbl" x="${padL - 6}" y="${y + 4}" text-anchor="end">${fmtNum(v)}</text><line class="axis" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/>`; }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions per day, ${n} days, peak ${fmtNum(max)}">${ticks}${bars}
      <text class="lbl" x="${padL}" y="${H - 6}">${esc(daily[0].date)}</text><text class="lbl" x="${W}" y="${H - 6}" text-anchor="end">${esc(daily[n - 1].date)}</text></svg>`;
  }

  /* ============================================================
     VIEW: AUTOMATIONS
     ============================================================ */
  const AV = { data: null };
  VIEWS.automations = {
    render(root, q, token) {
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Email</p><h1>Automations</h1><p class="sub">Auto-replies go out the moment a form is submitted. The weekly summary is written by AI every Monday morning.</p></div></div><div id="auBody"><div class="card">${skeleton(6)}</div></div>`;
      this.load(token);
    },
    async load(token) {
      const body = $('#auBody');
      let d;
      try { d = await api('/api/automations'); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      AV.data = d;
      const ph = d.placeholders || [];
      const tpls = d.templates || {};
      const cards = Object.keys(forms()).map((id) => {
        const t = tpls[id] || { enabled: false, subject: '', body: '' };
        return `<section class="card" data-tpl="${esc(id)}"><div class="tpl-head"><h2>${esc(formLabel(id))} auto-reply</h2>
            <label class="switch"><input type="checkbox" data-f="enabled" ${t.enabled ? 'checked' : ''}><span class="track"></span><span>${t.enabled ? 'On' : 'Off'}</span></label></div>
          <div class="stack">
            <div class="field"><label for="au-${esc(id)}-s">Subject</label><input id="au-${esc(id)}-s" type="text" data-f="subject" value="${esc(t.subject)}" maxlength="200"></div>
            <div class="field"><label for="au-${esc(id)}-b">Body</label><textarea id="au-${esc(id)}-b" data-f="body" rows="5">${esc(t.body)}</textarea>
              <span class="hint">Placeholders (click to insert):</span><div class="chips">${ph.map((p) => `<button type="button" class="chip" data-act="auChip" data-ph="${esc(p)}" data-form="${esc(id)}">${esc(p)}</button>`).join('')}</div></div>
          </div>
          <div class="tpl-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="auPreview" data-form="${esc(id)}">Preview</button>
            <div class="test"><label for="au-${esc(id)}-t" class="sr-only">Send test to</label><input id="au-${esc(id)}-t" type="email" placeholder="you@example.com" autocomplete="email"><button type="button" class="btn btn-ghost btn-sm" data-act="auTest" data-form="${esc(id)}">Send test</button></div></div>
          <div class="inline-result" data-result></div>
        </section>`;
      }).join('');
      const w = d.weekly || {};
      const emailNotice = d.email_connected === false ? `<div class="notice warn">${icon('warn')}<span>Email is not connected — auto-replies, tests and the weekly summary will not send until a Resend key is added${hasSection('settings') ? ' in <a href="#/settings">Settings</a>' : ''}. You can still edit and save templates.</span></div>` : '';
      const aiNotice = d.ai_connected === false ? `<div class="notice">${icon('plug')}<span>Anthropic is not connected, so the weekly summary is sent as plain figures without the AI write-up.${hasSection('settings') ? ' Add a key in <a href="#/settings">Settings</a>.' : ''}</span></div>` : '';
      body.innerHTML = `<div class="stack">${emailNotice}${cards}
        <section class="card" id="auWeekly"><div class="tpl-head"><h2>Weekly AI summary</h2><label class="switch"><input type="checkbox" id="wkEnabled" ${w.enabled ? 'checked' : ''}><span class="track"></span><span>${w.enabled ? 'On' : 'Off'}</span></label></div>
          <p class="muted small">Every Monday at 8:00 the portal emails a short summary of last week's leads, stages and follow-ups.</p>
          ${aiNotice}
          <div class="weekly-meta"><div><b>Last run</b>${w.last_run_at ? `<span title="${esc(fmtDate(w.last_run_at))}">${esc(fmtDate(w.last_run_at))}</span>` : '<span class="muted">Never</span>'}</div></div>
          <div class="field"><label for="wkRecipients">Recipients</label><input id="wkRecipients" type="text" value="${esc(Array.isArray(w.recipients) ? w.recipients.join(', ') : (w.recipients || ''))}" placeholder="owner@fuegosteaks.com, manager@fuegosteaks.com"><span class="hint">Comma-separated email addresses.</span></div>
          <div class="tpl-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="auRunWeekly">Run now</button></div>
          <div class="inline-result" data-result></div>
        </section></div>
        <div class="save-bar"><span class="form-msg" id="auMsg"></span><button type="button" class="btn btn-gold" data-act="auSave">Save automations</button></div>`;
      body.addEventListener('change', (e) => { const sw = e.target.closest('.switch input'); if (sw) sw.parentElement.lastElementChild.textContent = sw.checked ? 'On' : 'Off'; });
    }
  };
  function tplValues(id) {
    const c = $(`[data-tpl="${CSS.escape(id)}"]`); if (!c) return null;
    return { enabled: $('[data-f=enabled]', c).checked, subject: $('[data-f=subject]', c).value, body: $('[data-f=body]', c).value };
  }
  function setResult(scope, msg, ok) { const r = $('[data-result]', scope); if (r) { r.textContent = msg; r.className = 'inline-result ' + (ok ? 'ok' : 'err'); } }
  ACTIONS.auChip = (b) => {
    const ta = $(`[data-tpl="${CSS.escape(b.dataset.form)}"] [data-f=body]`); if (!ta) return;
    const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, s) + b.dataset.ph + ta.value.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + b.dataset.ph.length;
  };
  ACTIONS.auPreview = async (b) => {
    const id = b.dataset.form, v = tplValues(id); if (!v) return;
    b.disabled = true;
    try {
      const r = await api('/api/automations/preview', { method: 'POST', body: { form: id, subject: v.subject, body: v.body } });
      openDialog({ title: 'Preview · ' + (r.subject || v.subject || formLabel(id)), width: '720px', footer: '<button type="button" class="btn btn-ghost btn-sm" data-close>Close</button>',
        onMount(dlg) { const f = document.createElement('iframe'); f.setAttribute('sandbox', ''); f.setAttribute('title', 'Email preview'); f.srcdoc = r.html || ''; $('.dlg-body', dlg).appendChild(f); } });
    } catch (e) { toast(e.message || 'Could not render the preview', 'err'); }
    finally { b.disabled = false; }
  };
  ACTIONS.auTest = async (b) => {
    const id = b.dataset.form, card = b.closest('.card'), to = $(`#au-${CSS.escape(id)}-t`).value.trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { setResult(card, 'Enter a valid email address for the test.', false); return; }
    b.disabled = true; setResult(card, 'Sending…', true);
    try {
      const r = await api('/api/automations/test', { method: 'POST', body: { form: id, to } });
      if (r && r.error === 'not_connected') setResult(card, 'Not connected — add a Resend key in Settings before sending test emails.', false);
      else if (r && r.ok === false) setResult(card, r.message || r.error || 'Could not send the test.', false);
      else setResult(card, 'Test sent to ' + to + ' (uses the saved template — save first to test edits).', true);
    } catch (e) { setResult(card, e.code === 'not_connected' ? 'Not connected — add a Resend key in Settings before sending test emails.' : (e.message || 'Could not send the test.'), false); }
    finally { b.disabled = false; }
  };
  ACTIONS.auRunWeekly = async (b) => {
    const card = $('#auWeekly'); b.disabled = true; setResult(card, 'Running…', true);
    try {
      const r = await api('/api/automations/weekly/run', { method: 'POST' });
      if (r && r.error === 'not_connected') setResult(card, 'Not connected — add a Resend key in Settings first.', false);
      else if (r && r.ok === false) setResult(card, r.message || r.error || 'Could not run the summary.', false);
      else setResult(card, 'Summary sent to ' + ((r.sent_to || []).join(', ') || 'no recipients'), true);
    } catch (e) { setResult(card, e.message || 'Could not run the summary.', false); }
    finally { b.disabled = false; }
  };
  ACTIONS.auSave = async (b) => {
    const templates = {}; Object.keys(forms()).forEach((id) => { const v = tplValues(id); if (v) templates[id] = v; });
    const weekly = { enabled: $('#wkEnabled').checked, recipients: $('#wkRecipients').value.split(',').map((s) => s.trim()).filter(Boolean) };
    const msg = $('#auMsg'); b.disabled = true; msg.textContent = ''; msg.className = 'form-msg';
    try { await api('/api/automations', { method: 'PUT', body: { templates, weekly } }); toast('Automations saved'); msg.textContent = 'Saved.'; msg.className = 'form-msg ok'; }
    catch (e) { msg.textContent = e.message || 'Could not save.'; msg.className = 'form-msg err'; }
    finally { b.disabled = false; }
  };

  /* ============================================================
     VIEW: MEDIA
     ============================================================ */
  const MV = { items: [] };
  VIEWS.media = {
    render(root, q, token) {
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Content</p><h1>Media</h1><p class="sub">Images served from the media CDN. Copy a link to use it on the website.</p></div>
        <div class="page-actions"><button type="button" class="btn btn-gold btn-sm" data-act="mdUpload">${icon('upload', 'ico-sm')} Upload image</button><input id="mediaUpload" class="hidden-input" type="file" accept="image/*" aria-label="Upload image" tabindex="-1"><input id="mediaReplace" class="hidden-input" type="file" accept="image/*" aria-label="Replace image" tabindex="-1"></div></div>
        <p class="media-progress" id="mediaProgress" aria-live="polite"></p>
        <div id="mdBody">${skeleton(6)}</div>`;
      $('#mediaUpload').addEventListener('change', (e) => { if (e.target.files[0]) uploadMedia(e.target.files[0]); e.target.value = ''; });
      $('#mediaReplace').addEventListener('change', (e) => { const inp = e.target; if (inp.files[0]) uploadMedia(inp.files[0], inp.dataset.key); inp.value = ''; inp.dataset.key = ''; });
      this.load(token);
    },
    async load(token) {
      const body = $('#mdBody');
      let d;
      try { d = await api('/api/media'); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      MV.items = d.items || [];
      renderMediaGrid();
    }
  };
  function renderMediaGrid() {
    const body = $('#mdBody'); if (!body) return;
    if (!MV.items.length) { body.innerHTML = emptyHtml('No images uploaded yet', 'Upload a JPG, PNG or WebP and copy its link into the website.'); return; }
    body.innerHTML = `<div class="media-grid">${MV.items.map((m) => `<article class="media-item" data-key="${esc(m.key)}">
        <div class="media-thumb">${/^image\//.test(m.type || '') ? `<img src="${esc(m.url)}" alt="${esc(m.name)}" loading="lazy">` : icon('file')}</div>
        <div class="media-body"><div class="name" title="${esc(m.name)}">${esc(m.name)}</div><div class="meta">${esc(fmtBytes(m.size))} · ${esc(fmtRel(m.at))}${m.uploaded_by ? ' · ' + esc(m.uploaded_by) : ''}</div>
          <div class="media-actions"><button type="button" class="btn btn-ghost btn-xs" data-act="copy" data-copy="${esc(m.url)}">Copy link</button><button type="button" class="btn btn-ghost btn-xs" data-act="mdReplace" data-key="${esc(m.key)}">Replace</button><button type="button" class="btn btn-danger btn-xs" data-act="mdDelete" data-key="${esc(m.key)}" data-name="${esc(m.name)}" aria-label="Delete ${esc(m.name)}">${icon('trash', 'ico-sm')}</button></div></div>
      </article>`).join('')}</div>`;
  }
  async function uploadMedia(file, key) {
    const prog = $('#mediaProgress');
    if (!/^image\//.test(file.type)) { toast('Only image files can be uploaded here.', 'err'); return; }
    prog.textContent = (key ? 'Replacing ' : 'Uploading ') + file.name + '…';
    const fd = new FormData(); fd.append('file', file, file.name); if (key) fd.append('key', key);
    try {
      const r = await api('/api/media', { method: 'POST', body: fd });
      const item = r.item;
      const i = MV.items.findIndex((m) => m.key === item.key);
      if (i >= 0) MV.items[i] = item; else MV.items.unshift(item);
      renderMediaGrid(); toast(key ? 'Image replaced' : 'Image uploaded');
    } catch (e) { toast(e.message || 'Upload failed', 'err'); }
    finally { prog.textContent = ''; }
  }
  ACTIONS.mdUpload = () => { $('#mediaUpload').click(); };
  ACTIONS.mdReplace = (b) => { const inp = $('#mediaReplace'); inp.dataset.key = b.dataset.key; inp.click(); };
  ACTIONS.mdDelete = async (b) => {
    const ok = await confirmDialog({ title: 'Delete this image?', text: `${b.dataset.name} will be removed from the CDN. Any page still using its link will show a broken image.`, confirm: 'Delete image', danger: true });
    if (!ok) return;
    // Keys contain slashes (site/…), so the Worker takes the key as a query param.
    try { await api('/api/media', { method: 'DELETE', query: { key: b.dataset.key } }); MV.items = MV.items.filter((m) => m.key !== b.dataset.key); renderMediaGrid(); toast('Image deleted'); }
    catch (e) { toast(e.message || 'Could not delete', 'err'); }
  };

  /* ============================================================
     VIEW: TEAM
     ============================================================ */
  const TV = { items: [] };
  const STAFF_EXTRA_PERMS = ['leads.delete', 'leads.export', 'automations.manage', 'media.manage', 'audit.view'];
  const PERM_LABELS = { 'leads.delete': 'Delete leads', 'leads.export': 'Export CSV', 'automations.manage': 'Manage automations', 'media.manage': 'Manage media', 'audit.view': 'View audit log' };
  VIEWS.team = {
    render(root, q, token) {
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Admin</p><h1>Team</h1></div>
        <div class="page-actions"><button type="button" class="btn btn-gold btn-sm" data-act="tmInvite">Invite someone</button></div></div><div id="tmBody">${skeleton(6)}</div>`;
      this.load(token);
    },
    async load(token) {
      const body = $('#tmBody');
      let d;
      try { d = await api('/api/team'); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      TV.items = d.items || [];
      renderTeam();
    }
  };
  function renderTeam() {
    const body = $('#tmBody'); if (!body) return;
    if (!TV.items.length) { body.innerHTML = emptyHtml('No team members', 'Invite someone to get started.'); return; }
    body.innerHTML = `<div class="tbl-wrap cards"><table class="tbl"><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last login</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${TV.items.map((u) => `<tr data-id="${esc(u.id)}">
        <td data-label="Name" class="no-label"><b>${esc(u.name || '—')}</b>${!u.has_password ? '<span class="sub">Invite pending</span>' : ''}</td>
        <td data-label="Email"><span class="cellv">${esc(u.email)}</span></td>
        <td data-label="Role"><span class="pill role-${esc(u.role)}">${esc(roleLabel(u))}</span></td>
        <td data-label="Status"><span class="pill ${u.active ? 'ok' : ''}">${u.active ? 'Active' : 'Inactive'}</span></td>
        <td data-label="Last login" class="nowrap"><span class="cellv" title="${esc(fmtDate(u.last_login))}">${u.last_login ? esc(fmtRel(u.last_login)) : '<span class="dim">Never</span>'}</span></td>
        <td class="cell-actions no-label"><button type="button" class="btn btn-ghost btn-xs" data-act="tmEdit" data-id="${esc(u.id)}">Edit</button>${!u.has_password ? `<button type="button" class="btn btn-ghost btn-xs" data-act="tmResend" data-id="${esc(u.id)}" data-email="${esc(u.email)}">Resend invite</button>` : `<button type="button" class="btn btn-ghost btn-xs" data-act="tmReset" data-id="${esc(u.id)}" data-email="${esc(u.email)}">Reset password</button>`}<button type="button" class="btn btn-ghost btn-xs" data-act="tmSignout" data-id="${esc(u.id)}" data-email="${esc(u.email)}">Sign out everywhere</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  function userFormHtml(u) {
    u = u || { role: 'staff', perms: [], off: [], active: true };
    const perms = u.perms || [], off = u.off || [];
    return `<form id="userForm" class="stack" novalidate>
      <div class="form-grid">
        <div class="field"><label for="ufEmail">Email</label><input id="ufEmail" type="email" value="${esc(u.email || '')}" ${u.id ? 'readonly' : 'required autofocus'} autocomplete="off"></div>
        <div class="field"><label for="ufName">Name</label><input id="ufName" type="text" value="${esc(u.name || '')}" ${u.id ? 'autofocus' : ''}></div>
        <div class="field"><label for="ufRole">Role</label><select id="ufRole"><option value="staff"${u.role !== 'admin' ? ' selected' : ''}>Staff</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select><span class="hint">Admins have every permission and section.</span></div>
        ${u.id ? `<div class="field"><span class="field-label-text sr-only">Status</span><label class="switch" for="ufActive"><input type="checkbox" id="ufActive" ${u.active ? 'checked' : ''}><span class="track"></span><span>Active account</span></label></div>` : ''}
      </div>
      <fieldset class="field" id="ufPermsWrap" ${u.role === 'admin' ? 'hidden' : ''}><legend class="sr-only">Extra permissions</legend><span class="field-label-text">Extra permissions (staff)</span><div class="checks">${STAFF_EXTRA_PERMS.map((p) => `<label class="check"><input type="checkbox" name="perm" value="${p}" ${perms.includes(p) ? 'checked' : ''}> ${esc(PERM_LABELS[p] || p)}</label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend class="sr-only">Hidden sections</legend><span class="field-label-text">Hide sections</span><div class="checks">${Object.keys(SECTIONS).map((s) => `<label class="check dim"><input type="checkbox" name="off" value="${s}" ${off.includes(s) ? 'checked' : ''}> ${esc(SECTIONS[s].label)}</label>`).join('')}</div></fieldset>
      <p class="form-msg err" id="ufMsg" role="alert"></p>
    </form>`;
  }
  function readUserForm(dlg) {
    return {
      email: $('#ufEmail', dlg).value.trim(), name: $('#ufName', dlg).value.trim(), role: $('#ufRole', dlg).value,
      perms: $$('input[name=perm]:checked', dlg).map((x) => x.value), off: $$('input[name=off]:checked', dlg).map((x) => x.value),
      active: $('#ufActive', dlg) ? $('#ufActive', dlg).checked : undefined
    };
  }
  function wireUserForm(dlg) {
    $('#ufRole', dlg).addEventListener('change', (e) => { $('#ufPermsWrap', dlg).hidden = e.target.value === 'admin'; });
  }
  function showLinkDialog(title, text, link) {
    openDialog({ title, body: `<p>${esc(text)}</p>${copyBoxHtml('Link', link)}`, footer: '<button type="button" class="btn btn-gold btn-sm" data-close>Done</button>' });
  }
  ACTIONS.tmInvite = () => {
    openDialog({ title: 'Invite a team member', width: '620px', body: userFormHtml(null),
      footer: '<button type="button" class="btn btn-ghost btn-sm" data-close>Cancel</button><button type="button" class="btn btn-gold btn-sm" data-save>Send invite</button>',
      onMount(dlg, close) {
        wireUserForm(dlg);
        const save = async () => {
          const v = readUserForm(dlg), msg = $('#ufMsg', dlg);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) { msg.textContent = 'Enter a valid email.'; return; }
          $('[data-save]', dlg).disabled = true; msg.textContent = '';
          try {
            const r = await api('/api/team/invite', { method: 'POST', body: { email: v.email, name: v.name, role: v.role, perms: v.perms, off: v.off } });
            close(); toast('Invite created for ' + v.email);
            if (r.link) showLinkDialog('Invite link', 'Email is not connected, so the invite was not sent. Share this link with ' + v.email + ' — it lets them set a password.', r.link);
            VIEWS.team.load(++S.viewToken);
          } catch (e) { msg.textContent = fieldErrors(e) || e.message; $('[data-save]', dlg).disabled = false; }
        };
        $('[data-save]', dlg).addEventListener('click', save);
        $('#userForm', dlg).addEventListener('submit', (e) => { e.preventDefault(); save(); });
      } });
  };
  ACTIONS.tmEdit = (b) => {
    const u = TV.items.find((x) => x.id === b.dataset.id); if (!u) return;
    openDialog({ title: 'Edit ' + (u.name || u.email), width: '620px', body: userFormHtml(u),
      footer: '<button type="button" class="btn btn-ghost btn-sm" data-close>Cancel</button><button type="button" class="btn btn-gold btn-sm" data-save>Save changes</button>',
      onMount(dlg, close) {
        wireUserForm(dlg);
        const save = async () => {
          const v = readUserForm(dlg), msg = $('#ufMsg', dlg);
          $('[data-save]', dlg).disabled = true; msg.textContent = '';
          try {
            const r = await api('/api/team/' + encodeURIComponent(u.id), { method: 'PATCH', body: { name: v.name, role: v.role, perms: v.perms, off: v.off, active: v.active } });
            const i = TV.items.findIndex((x) => x.id === u.id); if (i >= 0 && r.user) TV.items[i] = Object.assign({}, TV.items[i], r.user);
            renderTeam(); close(); toast('Saved');
            if (S.me.user && S.me.user.id === u.id) { S.me = await api('/api/auth/me'); S.shellMounted = false; route(); }
          } catch (e) { msg.textContent = fieldErrors(e) || e.message; $('[data-save]', dlg).disabled = false; }
        };
        $('[data-save]', dlg).addEventListener('click', save);
        $('#userForm', dlg).addEventListener('submit', (e) => { e.preventDefault(); save(); });
      } });
  };
  ACTIONS.tmResend = async (b) => {
    const ok = await confirmDialog({ title: 'Resend the invite?', text: `${b.dataset.email} will get a new invite link that works once and expires in 24 hours. Older invite links stop working.`, confirm: 'Resend invite' });
    if (!ok) return;
    try {
      const r = await api('/api/team/' + encodeURIComponent(b.dataset.id) + '/invite', { method: 'POST' });
      if (r.link) showLinkDialog('Invite link', 'Email is not connected, so the invite was not sent. Share this link with ' + b.dataset.email + ' — it lets them set a password.', r.link);
      else toast('Invite resent to ' + b.dataset.email);
    } catch (e) { toast(e.message || 'Could not resend the invite', 'err'); }
  };
  ACTIONS.tmReset = async (b) => {
    const ok = await confirmDialog({ title: 'Send a password reset?', text: `${b.dataset.email} will get a link that expires in 15 minutes.`, confirm: 'Send reset link' });
    if (!ok) return;
    try {
      const r = await api('/api/team/' + encodeURIComponent(b.dataset.id) + '/reset', { method: 'POST' });
      if (r.link) showLinkDialog('Reset link', 'Email is not connected, so the link was not sent. Share it with ' + b.dataset.email + ' (expires in 15 minutes).', r.link);
      else toast('Reset link sent to ' + b.dataset.email);
    } catch (e) { toast(e.message || 'Could not create a reset link', 'err'); }
  };
  ACTIONS.tmSignout = async (b) => {
    const ok = await confirmDialog({ title: 'Sign out everywhere?', text: `Every active session for ${b.dataset.email} will be ended. They can sign in again right away.`, confirm: 'Sign out everywhere', danger: true });
    if (!ok) return;
    try { await api('/api/team/' + encodeURIComponent(b.dataset.id) + '/signout', { method: 'POST' }); toast('All sessions ended for ' + b.dataset.email); }
    catch (e) { toast(e.message || 'Could not sign them out', 'err'); }
  };
  function fieldErrors(e) {
    const f = e && e.data && e.data.fields; if (!f) return '';
    return Object.keys(f).map((k) => `${k}: ${f[k]}`).join(' · ');
  }

  /* ============================================================
     VIEW: SETTINGS
     ============================================================ */
  const INTEGRATIONS = [
    { id: 'resend', label: 'Resend', hint: 'Transactional email: lead notifications, auto-replies, invites.', field: 'resend_api_key', test: true },
    { id: 'turnstile', label: 'Turnstile secret', hint: 'Server-side verification for the website forms (the site key is above).', field: 'turnstile_secret', test: true },
    { id: 'ga4', label: 'Google Analytics 4', hint: 'Service account JSON with Viewer access to the property.', field: 'ga_service_account', textarea: true, extra: { field: 'ga4_property_id', label: 'Property ID' }, test: true },
    { id: 'anthropic', label: 'Anthropic', hint: 'Writes the weekly AI summary.', field: 'anthropic_api_key', test: true },
    { id: 'google', label: 'Google sign-in', hint: 'Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as Cloudflare secrets.', readonly: true }
  ];
  const SV = { data: null, removals: {} };
  VIEWS.settings = {
    render(root, q, token) {
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Admin</p><h1>Settings</h1></div></div><div id="stBody"><div class="card">${skeleton(6)}</div></div>`;
      this.load(token);
    },
    async load(token) {
      const body = $('#stBody');
      let d;
      try { d = await api('/api/settings'); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      SV.data = d; SV.removals = {};
      const b = d.business || {}, keys = d.keys || {}, routes = d.notify_routes || {};
      body.innerHTML = `<div class="stack">
        <section class="card"><div class="card-head"><h2>Business</h2><span class="sub">Set in wrangler.jsonc · read-only</span></div>
          <div class="biz">${[['Name', b.name], ['Website', b.site_url], ['Phone', b.phone], ['Address', b.address], ['Timezone', b.timezone], ['Mail from', b.mail_from], ['Reply-to', b.mail_reply_to]].map(([k, v]) => `<div><b>${k}</b><span>${esc(v || '—')}</span></div>`).join('')}</div></section>
        <section class="card"><div class="card-head"><h2>Notifications</h2><span class="sub">Who gets an email when a form is submitted</span></div>
          <div class="stack">
            <div class="field"><label for="stNotify">Notification emails</label><input id="stNotify" type="text" value="${esc(d.notify_emails || '')}" placeholder="info@fuegosteaks.com, manager@fuegosteaks.com"><span class="hint">Comma-separated. Used for every form unless a route below overrides it.</span></div>
            <div><span class="field-label-text">Per-form routes</span><div class="routes">${Object.keys(forms()).map((id) => `<div class="field"><label for="stRoute-${esc(id)}">${esc(formLabel(id))}</label><input id="stRoute-${esc(id)}" type="text" data-route="${esc(id)}" value="${esc(routes[id] || '')}" placeholder="Default"></div>`).join('')}</div></div>
            <div class="field"><label for="stTsSite">Turnstile site key</label><input id="stTsSite" type="text" value="${esc(d.turnstile_site_key || '')}" placeholder="0x…"><span class="hint">Public key rendered on the website forms. Leave blank to disable the widget.</span></div>
          </div></section>
        <section><div class="card-head"><h2>Integrations</h2><span class="sub">Cloudflare secrets always win over portal values</span></div>
          <div class="keys">${INTEGRATIONS.map((it) => integrationCard(it, keys[it.id] || { set: false, source: 'none' }, d)).join('')}</div></section>
        </div>
        <div class="save-bar"><span class="form-msg" id="stMsg"></span><button type="button" class="btn btn-gold" data-act="stSave">Save settings</button></div>`;
    }
  };
  function keyStatusHtml(k) {
    if (!k || !k.set) return `<span class="dot"></span><span>Not set</span>`;
    const src = k.source === 'secret' ? 'Set via Cloudflare secret' : 'Set in portal';
    return `<span class="dot on"></span><span>${src}${k.last4 ? ` · ····${esc(k.last4)}` : ''}</span>`;
  }
  function integrationCard(it, k, d) {
    const inputId = 'key-' + it.id;
    return `<section class="card" data-int="${it.id}"><div class="card-head"><h2>${esc(it.label)}</h2></div>
      <div class="key-status" data-status>${keyStatusHtml(k)}</div>
      <p class="muted small">${esc(it.hint)}</p>
      ${it.readonly ? '' : `<div class="stack">
        ${it.extra ? `<div class="field"><label for="${inputId}-extra">${esc(it.extra.label)}</label><input id="${inputId}-extra" type="text" inputmode="numeric" data-key="${it.extra.field}" value="${esc(d[it.extra.field] || '')}" placeholder="123456789"></div>` : ''}
        <div class="field"><label for="${inputId}">${k.set ? 'Replace with a new ' : 'Enter '}${it.textarea ? 'JSON key' : 'key'}</label>${it.textarea ? `<textarea id="${inputId}" data-key="${it.field}" rows="4" placeholder='{"type":"service_account", …}' autocomplete="off" spellcheck="false"></textarea>` : `<input id="${inputId}" type="password" data-key="${it.field}" autocomplete="new-password" placeholder="${k.set ? 'Leave blank to keep the current key' : 'Paste the key'}">`}</div>
      </div>
      <div class="key-foot">
        ${it.test ? `<button type="button" class="btn btn-ghost btn-xs" data-act="stTest" data-int="${it.id}">Test connection</button>` : ''}
        ${k.source === 'portal' ? `<button type="button" class="btn-link dim" data-act="stRemove" data-int="${it.id}" data-key="${it.field}">Remove portal value</button>` : ''}
      </div>
      <div class="inline-result" data-result></div>`}
    </section>`;
  }
  ACTIONS.stRemove = (b) => {
    const card = b.closest('.card');
    SV.removals[b.dataset.key] = true;
    $('[data-status]', card).innerHTML = `<span class="dot"></span><span>Will be removed when you save</span>`;
    b.replaceWith(el('<span class="muted small">Pending removal</span>'));
  };
  ACTIONS.stTest = async (b) => {
    const card = b.closest('.card'); b.disabled = true; setResult(card, 'Testing…', true);
    try {
      const r = await api('/api/settings/test/' + b.dataset.int, { method: 'POST' });
      if (r.ok) setResult(card, 'Connected' + (r.detail ? ' · ' + r.detail : ''), true);
      else setResult(card, 'Failed: ' + (r.error || r.detail || 'unknown error'), false);
    } catch (e) { setResult(card, 'Failed: ' + (e.message || 'unknown error'), false); }
    finally { b.disabled = false; }
  };
  ACTIONS.stSave = async (b) => {
    const msg = $('#stMsg');
    const routes = {}; $$('[data-route]').forEach((i) => { if (i.value.trim()) routes[i.dataset.route] = i.value.trim(); });
    const keys = {};
    $$('[data-key]').forEach((i) => {
      const f = i.dataset.key, v = i.value.trim();
      if (f === 'ga4_property_id') { if (v !== String((SV.data && SV.data.ga4_property_id) || '')) keys[f] = v; return; }
      if (v) keys[f] = v;
    });
    Object.keys(SV.removals).forEach((f) => { if (!keys[f]) keys[f] = ''; });
    const body = { notify_emails: $('#stNotify').value.trim(), notify_routes: routes, turnstile_site_key: $('#stTsSite').value.trim() };
    if (Object.keys(keys).length) body.keys = keys;
    b.disabled = true; msg.textContent = ''; msg.className = 'form-msg';
    try {
      await api('/api/settings', { method: 'PUT', body });
      toast('Settings saved'); msg.textContent = 'Saved.'; msg.className = 'form-msg ok';
      VIEWS.settings.load(++S.viewToken); // reload so statuses + last4 refresh and secrets are not left in inputs
    } catch (e) { msg.textContent = fieldErrors(e) || e.message || 'Could not save.'; msg.className = 'form-msg err'; b.disabled = false; }
  };

  /* ============================================================
     VIEW: AUDIT LOG
     ============================================================ */
  const XV = { actions: [] };
  VIEWS.audit = {
    render(root, q, token) {
      root.innerHTML = `<div class="page-head"><div><p class="eyebrow"><span class="hair"></span>Admin</p><h1>Audit log</h1></div>
        <div class="page-actions"><a class="btn btn-ghost btn-sm" id="xpExport" href="/api/audit/export.csv" target="_blank" rel="noopener">Export CSV</a></div></div>
        <div class="toolbar">
          <div class="field-inline"><label for="xpAction" class="sr-only">Action</label><select id="xpAction"><option value="">All actions</option></select></div>
          <div class="field-inline"><label for="xpUser" class="sr-only">User</label><input id="xpUser" type="text" placeholder="User name or email" value="${esc(q.user || '')}"></div>
          <div class="field-inline"><label for="xpRange" class="sr-only">Date range</label><select id="xpRange">${rangeOptions(q.range)}</select></div>
          <div class="custom-range" id="xpCustom" ${q.range === 'custom' ? '' : 'hidden'}><label for="xpFrom" class="sr-only">From</label><input type="date" id="xpFrom" value="${esc(q.from || '')}"><label for="xpTo" class="sr-only">To</label><input type="date" id="xpTo" value="${esc(q.to || '')}"><button type="button" class="btn btn-ghost btn-xs" data-act="xpApplyRange">Apply</button></div>
          <div class="search"><label for="xpQ" class="sr-only">Search</label><input id="xpQ" type="search" placeholder="Search target or detail…" value="${esc(q.q || '')}"></div>
          <button type="button" class="btn-link dim small" data-act="xpClear">Clear filters</button>
        </div><div id="xpBody">${skeleton(8)}</div>`;
      $('#xpAction').addEventListener('change', (e) => setQuery({ action: e.target.value, page: '' }));
      $('#xpUser').addEventListener('input', debounce((e) => setQuery({ user: e.target.value.trim(), page: '' }, { replace: true }), 320));
      $('#xpQ').addEventListener('input', debounce((e) => setQuery({ q: e.target.value.trim(), page: '' }, { replace: true }), 320));
      $('#xpRange').addEventListener('change', (e) => { const v = e.target.value; if (v === 'custom') { $('#xpCustom').hidden = false; $('#xpFrom').focus(); return; } setQuery({ range: v === 'any' ? '' : v, from: '', to: '', page: '' }); });
      this.fillActions(q);
      this.load(q, token);
    },
    update(root, q) {
      const a = $('#xpAction'); if (a && a.value !== (q.action || '')) a.value = q.action || '';
      const r = $('#xpRange'); if (r && r.value !== (q.range || 'any')) r.value = q.range || 'any';
      const c = $('#xpCustom'); if (c) c.hidden = q.range !== 'custom';
      ['xpUser:user', 'xpQ:q'].forEach((p) => { const [id, k] = p.split(':'); const i = $('#' + id); if (i && document.activeElement !== i && i.value !== (q[k] || '')) i.value = q[k] || ''; });
      this.load(q, ++S.viewToken);
    },
    fillActions(q) {
      const sel = $('#xpAction'); if (!sel) return;
      sel.innerHTML = '<option value="">All actions</option>' + XV.actions.map((a) => `<option value="${esc(a)}"${q.action === a ? ' selected' : ''}>${esc(a.replace(/_/g, ' '))}</option>`).join('');
    },
    async load(q, token) {
      const body = $('#xpBody'); body.innerHTML = skeleton(8);
      const query = { action: q.action, user: q.user, range: q.range, from: q.from, to: q.to, q: q.q, page: Number(q.page) || 1, limit: 50 };
      const ex = $('#xpExport'); if (ex) ex.href = '/api/audit/export.csv?' + qs(Object.assign({}, query, { page: undefined, limit: undefined }));
      let d;
      try { d = await api('/api/audit', { query }); } catch (e) { if (token === S.viewToken) body.innerHTML = errorHtml(e); return; }
      if (token !== S.viewToken) return;
      if (Array.isArray(d.actions) && d.actions.length && d.actions.join() !== XV.actions.join()) { XV.actions = d.actions; this.fillActions(q); }
      const items = d.items || [];
      if (!items.length) { body.innerHTML = emptyHtml('No audit entries', (q.action || q.user || q.q || q.range) ? 'Try clearing a filter.' : 'Sign-ins, edits and exports will be recorded here.'); return; }
      body.innerHTML = `<div class="tbl-wrap cards"><table class="tbl"><thead><tr><th scope="col">When</th><th scope="col">User</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th></tr></thead>
        <tbody>${items.map((r) => `<tr><td data-label="When" class="nowrap no-label"><b title="${esc(fmtDate(r.at))}">${esc(fmtDate(r.at))}</b></td><td data-label="User"><span class="cellv">${esc(r.user_name || r.user_id || 'System')}</span></td><td data-label="Action"><span class="pill">${esc(String(r.action || '').replace(/_/g, ' '))}</span></td><td data-label="Target"><span class="cellv">${esc(r.target || '—')}</span></td><td data-label="Detail"><span class="cellv">${esc(r.detail || '')}</span></td></tr>`).join('')}</tbody></table></div>
        ${pagerHtml(d.total, query.page, 50, 'xpPage')}`;
    }
  };
  ACTIONS.xpPage = (b) => setQuery({ page: b.dataset.page });
  ACTIONS.xpApplyRange = () => setQuery({ range: 'custom', from: $('#xpFrom').value, to: $('#xpTo').value, page: '' });
  ACTIONS.xpClear = () => navigate('/audit', {});

  /* ============================================================
     BOOT
     ============================================================ */
  /** After sign-in (or on load with a valid cookie): fetch me + config, mount shell, route. */
  async function startApp() {
    S.me = await api('/api/auth/me', { silent401: true });
    try { S.config = await api('/api/config'); }
    catch (e) { S.config = { forms: {}, pipelines: {}, stages: STAGES }; toast('Form configuration could not be loaded; labels may be missing.', 'warn'); }
    S.shellMounted = false;
    renderShell();
    startIdle();
    const h = parseHash();
    if (h.path === 'set' || h.error || h.path === '/') navigate('/dashboard', {}, { replace: true }); else route();
  }
  async function boot() {
    const h = parseHash();
    if (h.path === 'set' && h.token) { renderSetPassword(h.token); return; }
    try { await startApp(); }
    catch (e) {
      if (e.status === 401) renderSignIn({ error: h.error });
      else if (e.code === 'offline') $('#app').innerHTML = `<div class="crm-auth"><div class="crm-auth-card">${stateHtml('error', "You're offline", 'The portal needs a connection to load.', '<button type="button" class="btn btn-ghost btn-sm" data-act="reload">Retry</button>')}</div></div>`;
      else $('#app').innerHTML = `<div class="crm-auth"><div class="crm-auth-card">${stateHtml('error', 'Could not load the portal', e.message || '', '<button type="button" class="btn btn-ghost btn-sm" data-act="reload">Retry</button>')}</div></div>`;
    }
  }
  ACTIONS.reload = () => location.reload();
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (!S.me) { if (h.path === 'set' && h.token) renderSetPassword(h.token); return; }
    route();
  });
  window.addEventListener('online', () => { setSync('ok'); updateSyncText(); });
  window.addEventListener('offline', () => { setSync('off'); updateSyncText(); });
  // Coming back to the tab is user activity: check the session is still alive (a 401 shows sign-in).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me) { noteActivity(); api('/api/auth/ping', { method: 'POST' }).catch(() => { /* handled */ }); } });

  boot();
})();

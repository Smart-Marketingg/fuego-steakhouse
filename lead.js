/* ============================================================
   FUEGO STEAKHOUSE — lead.js
   Posts the site's forms to the first-party API (POST /api/lead,
   Cloudflare Worker + D1). Dependency-free, ES5, loads on every page
   BEFORE app.js / app.min.js.

   window.FuegoLead.submit(form, type, extraFields) -> Promise
     resolves { ok:true, thanks }            -> page is navigating to /thank-you
     resolves { ok:false, fields, message }  -> 400 validation; caller shows `message`
     resolves { ok:false, error }            -> network / 5xx / 429; a friendly
                                                message was already shown in the form
   ============================================================ */
(function (w, d) {
  'use strict';

  /* ---------- old hash links: /#/menus -> /menus ---------- */
  var hash = w.location.hash || '';
  if (hash.indexOf('#/') === 0) {
    var clean = hash.slice(1).split('?')[0];
    if (/^\/[A-Za-z0-9\-\/]*$/.test(clean)) { w.location.replace(clean + w.location.search); return; }
  }

  var ATTRIB_KEY = 'fn-attrib';
  var THANKS_KEY = 'fn-thanks';
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FORM_IDS = ['reserveForm', 'eventForm', 'contactForm', 'newsForm'];
  var ERROR_MESSAGE = "We couldn't send that just now. Please call (201) 455-6055 or try again in a minute.";
  var TURNSTILE_MESSAGE = 'Please complete the verification step and try again.';

  function ssGet(k) { try { return w.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { w.sessionStorage.setItem(k, v); } catch (e) {} }

  function parseQuery(search) {
    var out = {}, parts = (search || '').replace(/^\?/, '').split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var kv = parts[i].split('=');
      try { out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) {}
    }
    return out;
  }

  /* ---------- attribution: captured once per session, on the first page ---------- */
  function attribution() {
    var raw = ssGet(ATTRIB_KEY);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    var q = parseQuery(w.location.search);
    var a = { landing: w.location.pathname + w.location.search, ref: d.referrer || '' };
    for (var i = 0; i < UTM.length; i++) if (q[UTM[i]]) a[UTM[i]] = q[UTM[i]];
    ssSet(ATTRIB_KEY, JSON.stringify(a));
    return a;
  }
  attribution();

  /* ---------- honeypot ---------- */
  var hpStyled = false;
  function ensureHoneypot(form) {
    if (!form || form.querySelector('[name="website"]')) return;
    if (!hpStyled) {
      var st = d.createElement('style');
      st.textContent = '.fn-hp{position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important}';
      d.head.appendChild(st); hpStyled = true;
    }
    var hp = d.createElement('input');
    hp.type = 'text'; hp.name = 'website'; hp.className = 'fn-hp';
    hp.tabIndex = -1; hp.setAttribute('autocomplete', 'off'); hp.setAttribute('aria-hidden', 'true');
    form.insertBefore(hp, form.firstChild);
  }

  /* ---------- helpers ---------- */
  function submitButton(form) { return form.querySelector('button[type="submit"], input[type="submit"], button:not([type])'); }
  function messageEl(form) {
    var el = form.querySelector('.msg');
    if (!el) {
      el = d.createElement('span');
      el.className = 'msg err'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
      var btn = submitButton(form);
      if (btn) form.insertBefore(el, btn); else form.appendChild(el);
    }
    return el;
  }
  function showMessage(form, text) {
    var el = messageEl(form);
    el.textContent = text;
    if (!/\berr\b/.test(el.className)) el.className += ' err';
  }
  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) { btn.setAttribute('data-label', btn.textContent); btn.disabled = true; btn.textContent = 'Sending…'; }
    else { btn.disabled = false; if (btn.getAttribute('data-label')) btn.textContent = btn.getAttribute('data-label'); }
  }

  function collect(form, type, extra) {
    var pairs = [], els = form.elements, i, el;
    for (i = 0; i < els.length; i++) {
      el = els[i];
      if (!el.name || el.disabled) continue;
      if (el.type === 'submit' || el.type === 'button' || el.type === 'file') continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      pairs.push([el.name, el.value]);
    }
    pairs.push(['form', type]);
    pairs.push(['page', w.location.pathname]);
    var a = attribution(), k;
    for (k in a) if (a.hasOwnProperty(k) && a[k]) pairs.push([k, a[k]]);
    for (k in (extra || {})) if (extra.hasOwnProperty(k) && extra[k] != null) pairs.push([k, String(extra[k])]);
    /* Turnstile token (lives inside the .cf-turnstile widget; may sit outside form.elements) */
    if (form.querySelector('.cf-turnstile') && !form.querySelector('[name="cf-turnstile-response"]')) {
      var tok = d.querySelector('[name="cf-turnstile-response"]');
      if (tok && tok.value) pairs.push(['cf-turnstile-response', tok.value]);
    }
    var out = [];
    for (i = 0; i < pairs.length; i++) out.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
    return out.join('&');
  }

  function fieldLabel(form, key) {
    var el = form.querySelector('[name="' + key + '"]');
    var lab = el && el.id ? form.querySelector('label[for="' + el.id + '"]') : null;
    return lab ? lab.textContent.replace(/\s+/g, ' ').trim() : key.charAt(0).toUpperCase() + key.slice(1);
  }
  function firstError(form, fields) {
    for (var k in fields) if (fields.hasOwnProperty(k)) {
      var v = String(fields[k] || ''), label = fieldLabel(form, k);
      if (/\s/.test(v) && v.length > 12) return v; /* API sent a sentence */
      if (/email/i.test(v) || k === 'email') return 'Please enter a valid email address.';
      if (/phone/i.test(v) || k === 'phone') return 'Please enter a valid phone number.';
      if (/long|max/i.test(v)) return label + ' is too long.';
      return 'Please enter ' + (k === 'name' ? 'your name' : 'a valid ' + label.toLowerCase()) + '.';
    }
    return 'Please check the form and try again.';
  }

  /* ---------- submit ---------- */
  function submit(form, type, extra) {
    ensureHoneypot(form);
    var btn = submitButton(form);
    var body = collect(form, type, extra);
    setBusy(btn, true);
    if (!w.fetch) {
      setBusy(btn, false); showMessage(form, ERROR_MESSAGE);
      return Promise.resolve({ ok: false, error: 'no_fetch' });
    }
    return w.fetch('/api/lead', {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Requested-With': 'crm-site', 'Accept': 'application/json' },
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().then(function (j) { return { status: res.status, json: j }; }, function () { return { status: res.status, json: null }; });
    }).then(function (r) {
      var j = r.json || {};
      if (r.status === 200 && j.ok) {
        ssSet(THANKS_KEY, j.thanks || type);
        w.location.href = '/thank-you';
        return { ok: true, thanks: j.thanks || type };
      }
      setBusy(btn, false);
      if (r.status === 400 && j.error === 'invalid' && j.fields) {
        return { ok: false, fields: j.fields, message: firstError(form, j.fields) };
      }
      if (r.status === 400 && j.error === 'turnstile') { showMessage(form, TURNSTILE_MESSAGE); return { ok: false, error: 'turnstile' }; }
      showMessage(form, ERROR_MESSAGE);
      return { ok: false, error: j.error || ('http_' + r.status) };
    })['catch'](function (err) {
      setBusy(btn, false);
      showMessage(form, ERROR_MESSAGE);
      return { ok: false, error: String(err && err.message || err || 'network') };
    });
  }

  /* ---------- auto: honeypot on every known form ---------- */
  function init() {
    for (var i = 0; i < FORM_IDS.length; i++) ensureHoneypot(d.getElementById(FORM_IDS[i]));
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init); else init();

  w.FuegoLead = { submit: submit, ensureHoneypot: ensureHoneypot, attribution: attribution, showMessage: showMessage, ERROR_MESSAGE: ERROR_MESSAGE };
})(window, document);

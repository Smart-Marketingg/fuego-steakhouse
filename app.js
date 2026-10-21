/* ============================================================
   FUEGO STEAKHOUSE — interactions
   ============================================================ */
(function () {
  'use strict';

  /* ---------- form output: first-party API ----------
     Forms post to /api/lead (Cloudflare Worker + D1) through lead.js,
     which must be loaded before this file. On success lead.js navigates
     to /thank-you; on a validation error it resolves with `message`. */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function sendLead(formEl, type, extra, msgEl) {
    if (!window.FuegoLead) {
      if (msgEl) msgEl.textContent = "We couldn't send that just now. Please call (201) 455-6055 or try again in a minute.";
      return;
    }
    window.FuegoLead.submit(formEl, type, extra).then(function (r) {
      if (r && !r.ok && r.message && msgEl) msgEl.textContent = r.message;
    });
  }

  /* ---------- hero video: start + loop from 4s ---------- */
  var hv = document.getElementById('heroVideo');
  if (hv) {
    var START = 4;
    var canSeek = function () { return hv.duration && hv.duration > START + 4; };
    var seekStart = function () { try { if (canSeek() && hv.currentTime < START) hv.currentTime = START; } catch (e) {} };
    hv.addEventListener('loadedmetadata', seekStart);
    if (hv.readyState >= 1) seekStart();
    hv.addEventListener('ended', function () { if (canSeek()) hv.currentTime = START; hv.play().catch(function () {}); });
    var tryPlay = function () { hv.play().catch(function () {}); };
    hv.addEventListener('canplay', tryPlay);
    tryPlay();
  }

  /* ---------- sticky header ---------- */
  var header = document.getElementById('header');
  function onScroll() {
    if (window.scrollY > 40) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- mobile nav ---------- */
  var burger = document.getElementById('burger');
  function toggleMenu(force) {
    var open = force !== undefined ? force : !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    if (burger) burger.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  }
  if (burger) burger.addEventListener('click', function () { toggleMenu(); });
  document.querySelectorAll('[data-mclose]').forEach(function (el) {
    el.addEventListener('click', function () { toggleMenu(false); });
  });

  /* ---------- stars ---------- */
  var starSVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"/></svg>';
  document.querySelectorAll('.stars').forEach(function (s) {
    s.innerHTML = starSVG.repeat(5);
  });

  /* ---------- reviews carousel ---------- */
  var track = document.getElementById('reviewTrack');
  if (track) {
    var idx = 0;
    var total = track.children.length;
    function perView() { return window.innerWidth < 760 ? 1 : 3; }
    function update() {
      var pv = perView();
      var max = Math.max(0, total - pv);
      if (idx > max) idx = max;
      var card = track.children[0];
      var gap = parseFloat(getComputedStyle(track).columnGap) || 30;
      var step = card.getBoundingClientRect().width + gap;
      track.style.transform = 'translateX(' + (-idx * step) + 'px)';
      track.style.transition = 'transform .5s cubic-bezier(.22,.61,.36,1)';
    }
    var nextBtn = document.getElementById('revNext');
    var prevBtn = document.getElementById('revPrev');
    if (nextBtn) nextBtn.addEventListener('click', function () {
      idx = Math.min(idx + 1, Math.max(0, total - perView())); update();
    });
    if (prevBtn) prevBtn.addEventListener('click', function () {
      idx = Math.max(idx - 1, 0); update();
    });
    window.addEventListener('resize', update);
    update();
  }

  /* ---------- reveal on scroll ---------- */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- reserve modal ---------- */
  var scrim = document.getElementById('modalScrim');
  var form = document.getElementById('reserveForm');
  var success = document.getElementById('reserveSuccess');
  var lastFocus = null;

  if (scrim) {

  var modalEl = scrim.querySelector('.modal');
  var modalTop = scrim.querySelector('.modal-top');
  var OT_SRC = '//www.opentable.com/widget/reservation/loader?rid=1473520&type=standard&theme=tall&color=3&dark=true&iframe=true&domain=com&lang=en-US&newtab=false&ot_source=Restaurant%20website&cfe=true';
  var otWrap = null;
  function buildOtWidget() {
    var w = document.createElement('div');
    w.id = 'otWidget';
    w.className = 'modal-body ot-widget';
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = OT_SRC;
    w.appendChild(s);
    return w;
  }
  function detach(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  var choiceWrap = null;
  function buildChoice() {
    var w = document.createElement('div');
    w.id = 'reserveChoice';
    w.className = 'modal-body reserve-choice';
    w.innerHTML = '<p class="eyebrow"><span class="hair"></span>Reservations</p>' +
      '<h3>Reserve a Table</h3>' +
      '<p class="rc-sub">How would you like to book?</p>' +
      '<div class="rc-actions">' +
      '<button type="button" class="btn btn-gold" id="rcOnline">Reserve Online</button>' +
      '<a class="btn btn-ghost" href="tel:+12017787496" id="rcCall">Call Now</a>' +
      '</div>';
    return w;
  }
  function showOtWidget() {
    detach(choiceWrap); choiceWrap = null;
    if (!otWrap || !otWrap.parentNode) {
      detach(otWrap);
      otWrap = buildOtWidget();
      if (modalEl) modalEl.appendChild(otWrap);
    }
  }

  var currentMode = '';
  function openModal(mode) {
    currentMode = mode === 'event' ? 'event' : '';
    lastFocus = document.activeElement;
    scrim.hidden = false;
    requestAnimationFrame(function () { scrim.classList.add('open'); });
    document.body.style.overflow = 'hidden';
    if (currentMode === 'event') {
      /* Book Your Event: ONLY the lead form — OpenTable widget removed from DOM */
      detach(otWrap); otWrap = null;
      if (modalEl) modalEl.classList.add('modal-form');
      if (modalTop) modalTop.hidden = false;
      if (success && !success.parentNode) modalEl.appendChild(success);
      if (form && !form.parentNode) modalEl.insertBefore(form, success || null);
      if (form) form.hidden = false;
      if (success) success.hidden = true;
      var eb = document.getElementById('modalEyebrow'); if (eb) eb.textContent = 'Private Events';
      var tt = document.getElementById('modalTitle'); if (tt) tt.textContent = 'Book Your Event';
      var sb = document.getElementById('modalSub'); if (sb) sb.textContent = 'Tell us about your celebration and our events team will reach out to craft it with you.';
    } else {
      /* Make a Reservation: choice step first — Reserve Online or Call Now */
      detach(form);
      detach(success);
      detach(otWrap); otWrap = null;
      if (modalEl) modalEl.classList.remove('modal-form');
      if (modalTop) modalTop.hidden = true;
      if (!choiceWrap || !choiceWrap.parentNode) {
        detach(choiceWrap);
        choiceWrap = buildChoice();
        if (modalEl) modalEl.appendChild(choiceWrap);
        choiceWrap.querySelector('#rcOnline').addEventListener('click', showOtWidget);
      }
    }
  }
  function closeModal() {
    scrim.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(function () { scrim.hidden = true; }, 350);
    if (lastFocus) lastFocus.focus();
  }
  /* ---------- mobile sticky action bar (stops at the footer) ---------- */
  (function () {
    if (document.getElementById('mobileBar')) return;
    var bar = document.createElement('div');
    bar.id = 'mobileBar';
    bar.className = 'mobile-bar';
    bar.innerHTML = '<button class="btn btn-gold" data-reserve>Reserve a Table</button>' +
      '<a class="btn btn-ghost" href="large-events.html">Private Events</a>';
    document.body.appendChild(bar);
    var footer = document.querySelector('.footer');
    if (footer) {
      var dock = function () {
        var fTop = footer.getBoundingClientRect().top;
        var vh = window.innerHeight;
        if (fTop <= vh) {
          /* footer entered the viewport: pin the bar to sit directly on top of it */
          bar.classList.add('bar-docked');
          bar.style.bottom = (vh - fTop) + 'px';
        } else {
          bar.classList.remove('bar-docked');
          bar.style.bottom = '';
        }
      };
      window.addEventListener('scroll', dock, { passive: true });
      window.addEventListener('resize', dock);
      dock();
    }
  })();

  document.querySelectorAll('[data-reserve]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openModal(b.getAttribute('data-mode')); });
  });
  document.getElementById('modalClose').addEventListener('click', closeModal);
  var successDoneBtn = document.getElementById('successDone');
  if (successDoneBtn) successDoneBtn.addEventListener('click', closeModal);
  scrim.addEventListener('click', function (e) { if (e.target === scrim) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && scrim.classList.contains('open')) closeModal();
  });

  /* focus trap */
  scrim.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var f = scrim.querySelectorAll('button, input, select, a[href]');
    f = Array.prototype.filter.call(f, function (el) { return el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* party pills */
  var partySize = '2';
  document.getElementById('partyPills').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    this.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
    b.classList.add('sel'); partySize = b.getAttribute('data-size');
  });

  /* submit */
  var msg = document.getElementById('reserveMsg');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.textContent = '';
    var name = document.getElementById('rName');
    var email = document.getElementById('rEmail');
    var phone = document.getElementById('rPhone');
    var date = document.getElementById('rDate');
    var time = document.getElementById('rTime');
    var emailOk = EMAIL_RE.test(email.value.trim());
    if (!name.value.trim()) { msg.textContent = 'Please enter your name.'; name.focus(); return; }
    if (!emailOk) { msg.textContent = 'Please enter a valid email address.'; email.focus(); return; }
    if (!phone.value.trim()) { msg.textContent = 'Please enter a phone number.'; phone.focus(); return; }
    if (!date.value) { msg.textContent = 'Please choose a date.'; date.focus(); return; }
    if (!time.value) { msg.textContent = 'Please choose a time.'; time.focus(); return; }

    /* Book Your Event (modal) -> `event` pipeline; Reserve a Table -> `reservation`.
       The modal has no guests field, so the party pill is sent as `guests` for events. */
    if (currentMode === 'event') sendLead(form, 'event', { guests: partySize }, msg);
    else sendLead(form, 'reservation', { party: partySize }, msg);
  });

  } /* end reserve modal (only when #modalScrim present) */

  /* ---------- newsletter ---------- */
  var news = document.getElementById('newsForm');
  var newsMsg = document.getElementById('newsMsg');
  if (news) news.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('newsEmail').value.trim();
    if (!EMAIL_RE.test(v)) { newsMsg.textContent = 'Enter a valid email address.'; newsMsg.className = 'msg err'; return; }
    newsMsg.textContent = '';
    sendLead(news, 'newsletter', null, newsMsg);
  });

  /* ---------- private event inquiry (large-events.html #eventForm) ---------- */
  var evForm = document.getElementById('eventForm');
  if (evForm) {
    var evMsg = document.getElementById('evMsg');
    evForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!evMsg) { evMsg = evForm.querySelector('.msg'); }
      if (!evMsg) { evMsg = document.createElement('span'); evMsg.className = 'msg err'; evMsg.setAttribute('role', 'status'); evForm.insertBefore(evMsg, evForm.querySelector('button[type="submit"]')); }
      evMsg.textContent = '';
      var name = document.getElementById('evName'), email = document.getElementById('evEmail'), phone = document.getElementById('evPhone');
      if (!name.value.trim()) { evMsg.textContent = 'Please enter your name.'; name.focus(); return; }
      if (!EMAIL_RE.test(email.value.trim())) { evMsg.textContent = 'Please enter a valid email address.'; email.focus(); return; }
      if (!phone.value.trim()) { evMsg.textContent = 'Please enter a phone number.'; phone.focus(); return; }
      sendLead(evForm, 'event', null, evMsg);
    });
  }

  /* ---------- contact form (contact.html #contactForm) ---------- */
  var ctForm = document.getElementById('contactForm');
  if (ctForm) {
    var ctMsg = document.getElementById('ctMsg');
    ctForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!ctMsg) { ctMsg = ctForm.querySelector('.msg'); }
      if (!ctMsg) { ctMsg = document.createElement('span'); ctMsg.className = 'msg err'; ctMsg.setAttribute('role', 'status'); ctForm.insertBefore(ctMsg, ctForm.querySelector('button[type="submit"]')); }
      ctMsg.textContent = '';
      var name = document.getElementById('cName'), email = document.getElementById('cEmail'), message = document.getElementById('cMessage');
      if (!name.value.trim()) { ctMsg.textContent = 'Please enter your name.'; name.focus(); return; }
      if (!EMAIL_RE.test(email.value.trim())) { ctMsg.textContent = 'Please enter a valid email address.'; email.focus(); return; }
      if (!message.value.trim()) { ctMsg.textContent = 'Please enter a message.'; message.focus(); return; }
      sendLead(ctForm, 'contact', null, ctMsg);
    });
  }

  /* ---------- active nav on scroll ---------- */
  var sections = ['entertainment', 'private-events', 'contact'];
  var navLinks = document.querySelectorAll('.nav a');
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          navLinks.forEach(function (a) {
            a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id);
          });
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (id) { var el = document.getElementById(id); if (el) spy.observe(el); });
    var top = document.getElementById('top');
    if (top) spy.observe(top);
  }

  /* ---------- menu viewer (in-page PDF modal + keep download) ---------- */
  (function initMenuViewer() {
    var scrim = document.createElement('div');
    scrim.className = 'mv-scrim';
    scrim.hidden = true;
    scrim.innerHTML =
      '<div class="mv" role="dialog" aria-modal="true" aria-label="Menu viewer">' +
        '<div class="mv-head">' +
          '<h3 class="mv-title">Menu</h3>' +
          '<div class="mv-actions">' +
            '<a class="btn btn-gold mv-dl" download data-no-viewer><span class="lbl">Download</span> Menu</a>' +
            '<button class="mv-close" type="button" aria-label="Close menu">&times;</button>' +
          '</div>' +
        '</div>' +
        '<iframe class="mv-frame" title="Menu preview"></iframe>' +
      '</div>';
    document.body.appendChild(scrim);

    var frame = scrim.querySelector('.mv-frame');
    var titleEl = scrim.querySelector('.mv-title');
    var dlA = scrim.querySelector('.mv-dl');
    var lastMvFocus = null;

    function openViewer(url, label) {
      lastMvFocus = document.activeElement;
      titleEl.textContent = label || 'Menu';
      frame.src = url + (url.indexOf('#') === -1 ? '#view=FitH&toolbar=0' : '');
      dlA.href = url;
      scrim.hidden = false;
      requestAnimationFrame(function () { scrim.classList.add('open'); });
      document.body.style.overflow = 'hidden';
    }
    function closeViewer() {
      scrim.classList.remove('open');
      document.body.style.overflow = '';
      setTimeout(function () { scrim.hidden = true; frame.src = 'about:blank'; }, 380);
      if (lastMvFocus) { try { lastMvFocus.focus(); } catch (e) {} }
    }

    scrim.querySelector('.mv-close').addEventListener('click', closeViewer);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeViewer(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && scrim.classList.contains('open')) closeViewer();
    });

    function labelFor(a) {
      var l = a.getAttribute('data-menu-title');
      if (l) return l;
      var h = a.querySelector('h3, h4');
      if (h && h.textContent.trim()) return h.textContent.trim();
      l = a.getAttribute('aria-label');
      if (l) return l.replace(/\s*\(pdf\)/i, '').trim();
      return (a.textContent || 'Menu').replace(/view menu/i, '').trim() || 'Menu';
    }

    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (a.hasAttribute('data-no-viewer')) return;
      if (!/\.pdf(\?|#|$)/i.test(href)) return;
      e.preventDefault();
      openViewer(a.href, labelFor(a));
    });
  })();
})();

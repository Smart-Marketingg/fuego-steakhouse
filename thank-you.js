/* ============================================================
   FUEGO STEAKHOUSE — thank-you.js
   Per-form copy for /thank-you. Source of truth for which form was
   sent: sessionStorage['fn-thanks'] (set by lead.js, consumed here),
   then ?type=, then the generic contact copy.
   ============================================================ */
(function (w, d) {
  'use strict';

  var COPY = {
    reservation: {
      eyebrow: 'Reservation Received',
      lead: "We've received your reservation request and will confirm by phone or email shortly.",
      steps: [
        ['We review availability', 'Our host team checks the book for your date, time and party size.'],
        ['We confirm by phone or email', 'Expect a confirmation shortly. For same-day tables, call (201) 455-6055.'],
        ['Arrive & enjoy', 'Your table will be ready. Come hungry.']
      ],
      ctas: [['View Menus', 'menus.html'], ['Back to Home', 'index.html']]
    },
    event: {
      eyebrow: 'Inquiry Received',
      lead: 'Our events team has your inquiry and will reach out to start planning your celebration with you.',
      steps: [
        ['Our events team reviews', 'We look over your date, guest count and the details you shared.'],
        ['A planner reaches out', 'Within one business day, by phone or email, to talk through the vision.'],
        ['Tour, tasting & proposal', "We'll walk the space, taste the menu and put a proposal together."]
      ],
      ctas: [['View Menus', 'menus.html'], ['Gallery', 'gallery.html']]
    },
    contact: {
      eyebrow: 'Message Sent',
      lead: "We've received your message and our team will get back to you shortly.",
      steps: [
        ['We read it', 'Your message lands with our front-of-house team.'],
        ['The right person replies', 'Within one business day, by email or phone.'],
        ['Anything urgent?', "Call (201) 455-6055 and we'll help right away."]
      ],
      ctas: [['Back to Home', 'index.html'], ['View Menus', 'menus.html']]
    },
    newsletter: {
      eyebrow: "You’re On The List",
      lead: "You're subscribed. Look out for updates on events, specials and more.",
      steps: [
        ['Welcome email', 'A hello from Fuego lands in your inbox shortly.'],
        ['Events & specials, monthly', 'One email a month with what’s on and what’s new.'],
        ['Unsubscribe any time', 'One click at the bottom of every email.']
      ],
      ctas: [['Back to Home', 'index.html'], ['Gift Cards', 'gift-cards.html']]
    }
  };

  function queryType() {
    var m = /[?&]type=([^&#]*)/.exec(w.location.search || '');
    try { return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
  }

  var type = '';
  try {
    type = w.sessionStorage.getItem('fn-thanks') || '';
    if (type) w.sessionStorage.removeItem('fn-thanks');
  } catch (e) {}
  if (!COPY[type]) type = queryType();
  var c = COPY[type] || COPY.contact;

  /* The API sends non-JavaScript form posts here with ?error=<code> when a submission
     was NOT accepted. Never show success copy in that case. */
  var errMatch = /[?&]error=([^&#]*)/.exec(w.location.search || '');
  if (errMatch) {
    var code = decodeURIComponent(errMatch[1] || '');
    var reasons = {
      invalid: 'Some of the details were missing or invalid, so we could not send your request.',
      turnstile: 'The spam check did not complete, so we could not send your request.',
      rate_limited: 'Too many submissions came from your connection in a short time.',
      origin: 'The request did not come from our website, so it was not accepted.'
    };
    c = {
      eyebrow: 'Not Sent',
      lead: (reasons[code] || 'Something went wrong and your request was not sent.') + ' Please go back and try again, or call (201) 455-6055 and we will take care of it.',
      steps: [
        ['Go back and retry', 'Use your browser’s back button; your details are usually still filled in.'],
        ['Check the required fields', 'Name, a valid email address and a phone number where we can reach you.'],
        ['Or just call us', '(201) 455-6055 — we are happy to take your request by phone.']
      ],
      ctas: [['Back to Home', 'index.html'], ['Call Us', 'tel:+12014556055']]
    };
    var h1 = d.getElementById('tyHeading'); if (h1) h1.textContent = 'Sorry, that didn’t go through.';
    var mark = d.querySelector('.ty-mark'); if (mark) mark.classList.add('ty-mark-error');
    type = 'error';
  }

  function text(id, v) { var el = d.getElementById(id); if (el) el.textContent = v; }
  text('tyEyebrow', c.eyebrow);
  text('tyMessage', c.lead);
  d.title = c.eyebrow + ' | Fuego Steakhouse & Bar';

  var steps = d.getElementById('tySteps');
  if (steps) {
    steps.innerHTML = '';
    for (var i = 0; i < c.steps.length; i++) {
      var li = d.createElement('li'); li.className = 'ty-step';
      var n = d.createElement('span'); n.className = 'num'; n.setAttribute('aria-hidden', 'true'); n.textContent = '0' + (i + 1);
      var h = d.createElement('h3'); h.textContent = c.steps[i][0];
      var p = d.createElement('p'); p.textContent = c.steps[i][1];
      li.appendChild(n); li.appendChild(h); li.appendChild(p);
      steps.appendChild(li);
    }
  }

  var actions = d.getElementById('tyActions');
  if (actions) {
    actions.innerHTML = '';
    for (var j = 0; j < c.ctas.length; j++) {
      var a = d.createElement('a');
      a.className = 'btn ' + (j === 0 ? 'btn-gold' : 'btn-ghost');
      a.href = c.ctas[j][1]; a.textContent = c.ctas[j][0];
      actions.appendChild(a);
    }
  }
  d.documentElement.setAttribute('data-thanks', type || 'contact');
})(window, document);

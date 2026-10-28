/* ============================================================
   FUEGO — Events Calendar (read-only public view)
   ============================================================ */
(function () {
  'use strict';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  /* recurring weekly events shown to guests */
  var RECURRING = [
    { title: 'Social Night',   time: '3:00 PM – 6:00 PM',  weekday: 4 },
    { title: 'Happy Hour',     time: '2:00 PM – 6:00 PM', weekdays: [1, 2, 3, 4, 5] },
    { title: 'Lunch Specials', time: '11:00 AM – 4:00 PM', weekdays: [1, 2, 3, 4, 5] },
    { title: 'Brunch', time: '10:00 AM – 4:00 PM', weekdays: [0, 6] },
    { title: "Ladies' Night · DJ Oz", time: '7:00 PM – 11:00 PM', weekday: 4 },
    { title: 'DJ Oz', time: '9:30 PM – 1:30 AM', weekday: 5, from: '2026-11-01' }
  ];

  /* one-off dated events */
  var DATED = {
    '2026-11-06': [{ title: 'Flamenco Nights with Romero', time: '7:30 PM' }],
    '2026-11-07': [{ title: 'DJ Alex Pro', time: '9:30 PM – 1:30 AM' }],
    '2026-11-08': [{ title: 'Qué Lo Qué Brunch', time: '12:00 PM – 4:00 PM' }],
    '2026-11-13': [{ title: 'Latin Jazz · Oriente López Trio', time: '7:00 PM – 9:30 PM' }],
    '2026-11-14': [{ title: 'DJ Sabbat', time: '9:30 PM – 1:30 AM' }],
    '2026-11-20': [{ title: 'Flamenco Nights with Romero', time: '7:30 PM' }],
    '2026-11-21': [{ title: 'DJ Alex Pro', time: '9:30 PM – 1:30 AM' }],
    '2026-11-25': [{ title: 'Thanksgiving Eve · DJ Oz & DJ Alex Pro', time: '' }],
    '2026-11-27': [{ title: 'Latin Jazz · Oriente López Trio', time: '7:00 PM – 9:30 PM' }],
    '2026-11-28': [{ title: 'DJ Alex Pro', time: '9:30 PM – 1:30 AM' }]
  };

  var view = new Date(); view.setDate(1);
  var iso = function (y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); };

  var grid = document.getElementById('calGrid');
  var titleEl = document.getElementById('calTitle');
  if (!grid || !titleEl) return;

  function occurrencesFor(weekday, dateStr) {
    var list = [];
    RECURRING.forEach(function (rc) {
      var match = rc.weekdays ? rc.weekdays.indexOf(weekday) >= 0 : rc.weekday === weekday;
      if (match && (!rc.from || dateStr >= rc.from)) list.push(rc);
    });
    (DATED[dateStr] || []).forEach(function (ev) { list.push(ev); });
    return list;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function render() {
    var y = view.getFullYear(), m = view.getMonth();
    titleEl.textContent = MONTHS[m] + ' ' + y;

    var first = new Date(y, m, 1).getDay();
    var daysIn = new Date(y, m + 1, 0).getDate();
    var prevDays = new Date(y, m, 0).getDate();

    var today = new Date();
    var todayStr = iso(today.getFullYear(), today.getMonth(), today.getDate());

    grid.innerHTML = '';
    for (var i = 0; i < 42; i++) {
      var cell = document.createElement('div');
      cell.className = 'cal-cell';
      var dayNum, cy = y, cm = m, other = false;

      if (i < first) { dayNum = prevDays - first + 1 + i; cm = m - 1; other = true; if (cm < 0) { cm = 11; cy = y - 1; } }
      else if (i >= first + daysIn) { dayNum = i - first - daysIn + 1; cm = m + 1; other = true; if (cm > 11) { cm = 0; cy = y + 1; } }
      else { dayNum = i - first + 1; }

      var weekday = new Date(cy, cm, dayNum).getDay();
      var dateStr = iso(cy, cm, dayNum);
      if (other) cell.classList.add('other-month');
      if (dateStr === todayStr) cell.classList.add('today');

      var head = document.createElement('div');
      head.className = 'cal-cell-head';
      var num = document.createElement('span'); num.className = 'cal-num'; num.textContent = dayNum;
      head.appendChild(num);
      cell.appendChild(head);

      var evWrap = document.createElement('div'); evWrap.className = 'cal-events';
      occurrencesFor(weekday, dateStr).forEach(function (ev) {
        var chip = document.createElement('div');
        chip.className = 'cal-event' + ((DATED[dateStr] || []).indexOf(ev) >= 0 ? ' is-special' : ' is-recurring');
        chip.innerHTML = (ev.time ? '<span class="ce-time">' + ev.time.split('–')[0].trim() + '</span>' : '') +
                         '<span class="ce-title">' + escapeHtml(ev.title) + '</span>';
        evWrap.appendChild(chip);
      });
      cell.appendChild(evWrap);
      grid.appendChild(cell);
    }
  }

  function go(delta) { view.setMonth(view.getMonth() + delta); render(); }
  var prev = document.getElementById('calPrev'); if (prev) prev.addEventListener('click', function () { go(-1); });
  var next = document.getElementById('calNext'); if (next) next.addEventListener('click', function () { go(1); });
  var todayBtn = document.getElementById('calToday'); if (todayBtn) todayBtn.addEventListener('click', function () { view = new Date(); view.setDate(1); render(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  });

  render();
})();

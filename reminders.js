/*
 * Spenderrr – Bill reminders and weekly / monthly report cards  (app version is set in index.html)
 * -------------------------------------------------------------------------------------------------
 *  - Bills: add utility and other regular bills (due day, how often, optional amount, when to remind).
 *  - "Bills" card on Recent: what's overdue or due soon, with "Mark paid" (opens the app's own Add form,
 *    filled in, so the expense is saved by the app itself) and "Already paid".
 *  - Add to calendar: a repeating calendar event (.ics) with alerts, or Google Calendar, so the phone
 *    reminds you even when Spenderrr is closed.
 *  - Report cards: last week's report on Monday–Wednesday, last month's on the 1st–5th. Share it by
 *    email, WhatsApp or the phone's share menu.
 *  - Settings → "Bills & reports": manage bills, turn each card on or off, share a report any time.
 * Data stays on the device: spenderrr.bills (bills, included in backups by backup.js) and
 * spenderrr.reminders (this device's card settings, not backed up).
 */
(function () {
  'use strict';

  var DATA_KEY = 'spendlog.v1', BILLS_KEY = 'spenderrr.bills', PREFS_KEY = 'spenderrr.reminders', CUR_KEY = 'spendlog.currency';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAY = 86400000, MAX_AMOUNT = 1e9, MAX_BILLS = 100;
  // Bill types: name, app category, sub-category (the app's Utilities chips), emoji.
  var TYPES = [
    { id: 'electricity', label: 'Electricity', cat: 'utilities', sub: 'Electricity', emoji: '💡' },
    { id: 'water', label: 'Water', cat: 'utilities', sub: 'Water', emoji: '🚰' },
    { id: 'gas', label: 'Gas', cat: 'utilities', sub: 'Gas', emoji: '🔥' },
    { id: 'internet', label: 'Internet', cat: 'utilities', sub: 'Internet', emoji: '🌐' },
    { id: 'phone', label: 'Phone', cat: 'utilities', sub: 'Phone', emoji: '📱' },
    { id: 'rent', label: 'Rent', cat: 'household', sub: '', emoji: '🏠' },
    { id: 'emi', label: 'EMI', cat: 'emi', sub: '', emoji: '🏦' },
    { id: 'insurance', label: 'Insurance', cat: 'insurance', sub: '', emoji: '🛡️' },
    { id: 'other', label: 'Other', cat: 'other', sub: '', emoji: '📌' }
  ];
  var FREQ = [['monthly', 'Monthly', 1], ['bimonthly', 'Every 2 months', 2], ['quarterly', 'Every 3 months', 3], ['yearly', 'Yearly', 12]];
  var REMIND = [[0, 'On the day'], [1, '1 day before'], [3, '3 days before'], [7, '1 week before']];
  var LABEL = {
    breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks', grocery: 'Grocery', shopping: 'Shopping',
    household: 'Household', utilities: 'Utilities', transport: 'Travel', other: 'Other',
    emi: 'EMI', insurance: 'Insurance', maid: 'Maid', fuel: 'Fuel', lpg: 'LPG', gift: 'Gift'
  };
  var EMOJI = {
    breakfast: '☕', lunch: '🥪', dinner: '🍽️', snacks: '🍿', grocery: '🛒', shopping: '🛍️',
    household: '🏠', utilities: '💡', transport: '🚕', other: '📌', emi: '🏦', insurance: '🛡️', maid: '🧹', fuel: '⛽', lpg: '🔥', gift: '🎁'
  };

  // ---------- Storage ----------
  function readObj(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
  }
  function writeObj(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch (e) { toast('Could not save on this device'); return false; } }
  function cleanText(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F<>`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
  function typeOf(id) { return TYPES.filter(function (t) { return t.id === id; })[0] || TYPES[TYPES.length - 1]; }
  function validBill(x) {
    return !!(x && typeof x.id === 'string' && /^b_[a-z0-9]{4,40}$/.test(x.id) && typeof x.name === 'string' &&
      (x.day === -1 || (x.day >= 1 && x.day <= 28)) && FREQ.some(function (f) { return f[0] === x.freq; }) &&
      (x.month === undefined || (x.month >= 0 && x.month <= 11)) &&
      (x.amount === null || x.amount === undefined || (isFinite(Number(x.amount)) && Number(x.amount) >= 0 && Number(x.amount) <= MAX_AMOUNT)));
  }
  function bills() { var s = readObj(BILLS_KEY); return Array.isArray(s.b) ? s.b.filter(validBill) : []; }
  function saveBills(list) { var s = readObj(BILLS_KEY); s.b = list.slice(0, MAX_BILLS); return writeObj(BILLS_KEY, s); }
  function prefs() {
    var p = readObj(PREFS_KEY);
    return { billsCard: p.billsCard !== false, weekly: p.weekly !== false, monthly: p.monthly !== false, dismissed: p.dismissed && typeof p.dismissed === 'object' ? p.dismissed : {} };
  }
  function savePrefs(p) {
    // Forget dismissals older than ~3 months so this never grows.
    var keep = {}, cutoff = Date.now() - 100 * DAY;
    Object.keys(p.dismissed || {}).forEach(function (k) { if (Number(p.dismissed[k]) > cutoff) keep[k] = p.dismissed[k]; });
    p.dismissed = keep;
    writeObj(PREFS_KEY, p);
  }
  function newId() { return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- Money and dates ----------
  function currency() {
    var c = ''; try { c = localStorage.getItem(CUR_KEY) || ''; } catch (e) { /* ignore */ }
    if (c === 'INR') return { sym: '₹', loc: 'en-IN' };
    if (c === 'EUR') return { sym: '€', loc: 'en-IE' };
    return { sym: '$', loc: 'en-US' };
  }
  function money(n) {
    var c = currency(), v = Math.abs(Number(n) || 0);
    return (n < 0 ? '−' : '') + c.sym + v.toLocaleString(c.loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function round(n) { return Math.round(n * 100) / 100; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function short(d) { return SHORT[d.getMonth()] + ' ' + d.getDate(); }
  function daysIn(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function dueIn(y, m, bill) { return new Date(y, m, bill.day === -1 ? daysIn(y, m) : Math.min(bill.day, daysIn(y, m))); }
  function step(bill) { return FREQ.filter(function (f) { return f[0] === bill.freq; })[0][2]; }
  // Is month m (0–11) a due month for this bill? Monthly: always. Others: counted from bill.month.
  function dueMonth(bill, m) { var s = step(bill); return s === 1 || ((m - (bill.month || 0)) % s + 12) % s === 0; }
  // The last due date on or before `d`, and the next one after it.
  function dueAround(bill, d) {
    var today = dayStart(d), prev = null, next = null, y = today.getFullYear(), m = today.getMonth(), i, dt;
    for (i = 0; i < 13 && !prev; i++) {
      var pm = m - i, py = y + Math.floor(pm / 12); pm = ((pm % 12) + 12) % 12;
      if (dueMonth(bill, pm)) { dt = dueIn(py, pm, bill); if (dt <= today) prev = dt; }
    }
    for (i = 0; i < 14 && !next; i++) {
      var nm = m + i, ny = y + Math.floor(nm / 12); nm = nm % 12;
      if (dueMonth(bill, nm)) { dt = dueIn(ny, nm, bill); if (dt > today) next = dt; }
    }
    return { prev: prev, next: next };
  }
  // What to show for a bill today: overdue (last due date not paid), due today, due soon, or later.
  // A due date counts as paid when it was marked paid in Spenderrr, or when an expense for this bill
  // was logged from 10 days before it onwards (so a late payment settles an overdue bill).
  // Each logged expense pays for one due date only.
  var EARLY = 10 * DAY;
  function billExpenses(bill) {
    var nm = String(bill.name || '').toLowerCase();
    return entries().filter(function (x) {
      if (!x || x.cat !== bill.cat || !isFinite(Number(x.ts))) return false;
      return bill.sub ? x.sub === bill.sub : !!(nm && String(x.note || '').toLowerCase().indexOf(nm) >= 0);
    }).sort(function (x, y) { return Number(x.ts) - Number(y.ts); });
  }
  function payFor(bill, due, list, used) {
    if ((bill.paid || {})[ymd(due)]) return true;
    var from = due.getTime() - EARLY;
    for (var i = 0; i < list.length; i++) {
      if (!used[i] && Number(list[i].ts) >= from) { used[i] = true; return true; }
    }
    return false;
  }
  function status(bill, now) {
    now = now || new Date();
    var today = dayStart(now), around = dueAround(bill, now), list = billExpenses(bill), used = {};
    var since = dayStart(new Date(Number(bill.createdAt) || 0));
    if (around.prev && around.prev >= since && !payFor(bill, around.prev, list, used)) {
      var late = Math.round((today - around.prev) / DAY);
      return { due: around.prev, days: -late, state: late === 0 ? 'today' : 'overdue', show: true };
    }
    // Paid early: look at the due date after it.
    for (var i = 0; i < 3 && around.next && payFor(bill, around.next, list, used); i++) around = dueAround(bill, around.next);
    var left = Math.round((around.next - today) / DAY);
    return { due: around.next, days: left, state: left <= Math.max(Number(bill.remind) || 0, 0) ? 'soon' : 'later', show: left <= Math.max(Number(bill.remind) || 0, 0) };
  }
  // The most recent expense for this bill: same category and sub-category (Utilities → Electricity),
  // or, for bills without one (Rent, EMI…), an expense whose note names the bill.
  function lastBill(bill) {
    var best = null;
    billExpenses(bill).forEach(function (x) { var ts = Number(x.ts); if (!best || ts > best.ts) best = { amount: round(share(x)), ts: ts }; });
    return best;
  }
  function lastBillText(bill, last) {
    if (!last) return 'It\'s time for your ' + bill.name.toLowerCase() + ' bill';
    var d = new Date(last.ts);
    var now = new Date(), lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var lastMonth = d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth();
    return (lastMonth ? 'Last month\'s bill: ' : 'Last bill: ') + money(last.amount) + ' · paid ' + short(d) +
      (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function statusText(st) {
    if (st.state === 'today') return 'Due today';
    if (st.state === 'overdue') return 'Overdue ' + (-st.days) + (st.days === -1 ? ' day' : ' days') + ' · was due ' + short(st.due);
    if (st.days === 1) return 'Due tomorrow · ' + short(st.due);
    return 'Due in ' + st.days + ' days · ' + short(st.due);
  }

  // ---------- Expenses (read only; the app saves its own) ----------
  function entries() { var o = readObj(DATA_KEY); return Array.isArray(o.e) ? o.e : []; }
  function share(x) { var v = x.split && x.split.my !== undefined && x.split.my !== null ? Number(x.split.my) : Number(x.amount); return isFinite(v) ? v : 0; }
  function catLabel(id) {
    if (LABEL[id]) return LABEL[id];
    var yours = (window.__spxExtra || []).filter(function (x) { return x.id === id; })[0];
    return yours ? cleanText(yours.label, 24) : 'Other';
  }
  function catColor(id) { return 'var(--c-' + (/^[A-Za-z0-9_-]+$/.test(id) ? id : 'other') + ', #7A8391)'; }

  // ---------- Reports ----------
  function weekStart(d) { var s = dayStart(d), w = (s.getDay() + 6) % 7; return new Date(s.getFullYear(), s.getMonth(), s.getDate() - w); }
  function period(kind, now) {
    now = now || new Date();
    if (kind === 'week') {
      var end = weekStart(now), start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 7);
      var last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
      return { kind: kind, start: start, end: end, prevStart: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7),
        key: 'w-' + ymd(start), title: 'Week of ' + short(start) + ' – ' + (start.getMonth() === last.getMonth() ? last.getDate() : short(last)), word: 'week' };
    }
    var ms = new Date(now.getFullYear(), now.getMonth() - 1, 1), me = new Date(now.getFullYear(), now.getMonth(), 1);
    return { kind: kind, start: ms, end: me, prevStart: new Date(now.getFullYear(), now.getMonth() - 2, 1),
      key: 'm-' + ms.getFullYear() + '-' + pad(ms.getMonth() + 1), title: MONTHS[ms.getMonth()] + ' ' + ms.getFullYear(), word: 'month' };
  }
  function report(kind, now) {
    var p = period(kind, now), a = p.start.getTime(), b = p.end.getTime(), pa = p.prevStart.getTime();
    var total = 0, prev = 0, count = 0, byCat = {};
    entries().forEach(function (x) {
      var ts = Number(x && x.ts), v = share(x);
      if (ts >= a && ts < b) { total += v; count++; var c = typeof x.cat === 'string' ? x.cat : 'other'; byCat[c] = (byCat[c] || 0) + v; }
      else if (ts >= pa && ts < a) prev += v;
    });
    var cats = Object.keys(byCat).map(function (c) { return { id: c, label: catLabel(c), amount: round(byCat[c]) }; })
      .filter(function (c) { return c.amount > 0; }).sort(function (x, y) { return y.amount - x.amount; });
    var r = { period: p, total: round(total), prev: round(prev), count: count, cats: cats };
    if (kind === 'month' && window.SpenderrrLedger && typeof window.SpenderrrLedger.moneyIn === 'function') {
      try { r.moneyIn = window.SpenderrrLedger.moneyIn(a, b); } catch (e) { /* leave out */ }
    }
    return r;
  }
  function change(r) {
    if (!(r.prev > 0)) return '';
    var pct = Math.round((r.total - r.prev) / r.prev * 100);
    if (pct === 0) return 'Same as the ' + r.period.word + ' before';
    return (pct > 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '% vs the ' + r.period.word + ' before (' + money(r.prev) + ')';
  }
  function reportText(r) {
    var lines = ['📊 Spenderrr · ' + (r.period.kind === 'week' ? 'Weekly' : 'Monthly') + ' report', r.period.title, ''];
    lines.push('Spent: ' + money(r.total) + ' (' + r.count + (r.count === 1 ? ' entry' : ' entries') + ')');
    var ch = change(r); if (ch) lines.push(ch);
    if (r.moneyIn !== undefined && r.moneyIn > 0) lines.push('Money in: ' + money(r.moneyIn) + ' · Balance: ' + money(round(r.moneyIn - r.total)));
    if (r.cats.length) {
      lines.push('', 'Where it went');
      r.cats.slice(0, 8).forEach(function (c) {
        lines.push((EMOJI[c.id] || '📌') + ' ' + c.label + ' — ' + money(c.amount) + ' (' + Math.round(c.amount / r.total * 100) + '%)');
      });
    }
    lines.push('', 'Sent from Spenderrr');
    return lines.join('\n');
  }
  function sendReport(r, how) {
    var text = reportText(r), subject = 'Spenderrr ' + (r.period.kind === 'week' ? 'weekly' : 'monthly') + ' report · ' + r.period.title;
    if (how === 'email') { location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text); return; }
    if (how === 'whatsapp') { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); return; }
    if (navigator.share) { navigator.share({ title: subject, text: text }).catch(function () { /* closed */ }); return; }
    copy(text);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Report copied. Paste it anywhere.'); }, function () { toast('Could not copy the report'); });
    } else toast('Sharing is not available in this browser');
  }

  // ---------- Calendar ----------
  function icsText(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
  function icsDate(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function rrule(bill) {
    var day = bill.day === -1 ? -1 : bill.day;
    if (bill.freq === 'yearly') return 'FREQ=YEARLY;BYMONTH=' + ((bill.month || 0) + 1) + ';BYMONTHDAY=' + day;
    return 'FREQ=MONTHLY;INTERVAL=' + step(bill) + ';BYMONTHDAY=' + day;
  }
  function firstDue(bill) { var a = dueAround(bill, new Date()); return a.prev && a.prev.getTime() === dayStart(new Date()).getTime() ? a.prev : a.next; }
  function eventTitle(bill) { return typeOf(bill.type).emoji + ' ' + bill.name + ' bill due' + (bill.amount ? ' (' + money(bill.amount) + ')' : ''); }
  function ics(bill) {
    var start = firstDue(bill), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    var now = new Date(), stamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + '00Z';
    var r = Number(bill.remind) || 0, title = eventTitle(bill);
    var alarm = function (trigger) { return ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(title), 'TRIGGER:' + trigger, 'END:VALARM']; };
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Spenderrr//Bill reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', 'UID:' + bill.id + '@spenderrr', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + icsDate(start), 'DTEND;VALUE=DATE:' + icsDate(end), 'RRULE:' + rrule(bill),
      'SUMMARY:' + icsText(title), 'DESCRIPTION:' + icsText('Reminder from Spenderrr. Open the app and tap Mark paid to log it.'), 'TRANSP:TRANSPARENT']
      // 9 AM on the due day, and 9 AM the chosen number of days before.
      .concat(alarm('PT9H')).concat(r > 0 ? alarm('-P' + (r - 1 > 0 ? (r - 1) + 'D' : '') + 'T15H') : [])
      .concat(['END:VEVENT', 'END:VCALENDAR']);
    return lines.join('\r\n') + '\r\n';
  }
  function downloadIcs(bill) {
    var name = (bill.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bill') + '-reminder.ics';
    var blob = new Blob([ics(bill)], { type: 'text/calendar;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    toast('Open the downloaded file to add it to your calendar');
  }
  function googleLink(bill) {
    var start = firstDue(bill), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(eventTitle(bill)) +
      '&dates=' + icsDate(start) + '/' + icsDate(end) + '&recur=' + encodeURIComponent('RRULE:' + rrule(bill)) +
      '&details=' + encodeURIComponent('Reminder from Spenderrr. Open the app and tap Mark paid to log it.');
  }
  function openCalendar(bill) {
    var box = sheet('Add to calendar', 'spx-cal');
    box.appendChild(el('p', { class: 'help' }, 'Your phone\'s calendar will remind you about ' + bill.name + ' every ' +
      ({ monthly: 'month', bimonthly: '2 months', quarterly: '3 months', yearly: 'year' })[bill.freq] + ', even when Spenderrr is closed.'));
    var phone = el('button', { type: 'button', class: 'primary', id: 'spxIcs' }, 'Phone calendar (iPhone, Android, Outlook)');
    phone.onclick = function () { downloadIcs(bill); };
    var g = el('button', { type: 'button', class: 'ghost', id: 'spxGcal' }, 'Google Calendar');
    g.onclick = function () { window.open(googleLink(bill), '_blank', 'noopener'); };
    box.append(phone, g, el('p', { class: 'help' }, 'Phone calendar adds alerts at 9 AM' + (Number(bill.remind) ? ' on the day and ' + remindWord(bill.remind) : ' on the day') +
      '. Google Calendar uses your usual notification settings.'));
  }
  function remindWord(n) { n = Number(n) || 0; return n === 7 ? 'a week before' : n === 1 ? 'the day before' : n + ' days before'; }

  // ---------- Small UI helpers (the app's own styles) ----------
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 2800);
  }
  function sheet(title, id) {
    closeSheet(id);
    var scrim = el('div', { class: 'scrim spx-scrim', id: id });
    var box = el('div', { class: 'sheet', role: 'dialog', 'aria-label': title });
    var head = el('div', { class: 'sheet-h' });
    head.appendChild(el('h3', {}, title));
    var x = el('button', { class: 'x', type: 'button', 'aria-label': 'Close' }, '✕');
    x.onclick = function () { closeSheet(id); };
    head.appendChild(x);
    box.appendChild(head);
    scrim.appendChild(box);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(id); });
    document.body.appendChild(scrim);
    return box;
  }
  function closeSheet(id) { var s = document.getElementById(id); if (s) s.remove(); }
  function seg(options, value, label) {
    var g = el('div', { class: 'spx-seg', role: 'group', 'aria-label': label });
    options.forEach(function (o) {
      var b = el('button', { type: 'button', 'aria-pressed': String(o[0] === value), 'data-v': String(o[0]) }, o[1]);
      b.onclick = function () { [].forEach.call(g.children, function (c) { c.setAttribute('aria-pressed', String(c === b)); }); if (g.onpick) g.onpick(o[0]); };
      g.appendChild(b);
    });
    g.value = function () { var p = g.querySelector('[aria-pressed="true"]'); return p ? p.getAttribute('data-v') : null; };
    return g;
  }
  function toggle(id, label, on, onChange) {
    var b = el('button', { type: 'button', class: 'toggle', id: id, 'aria-pressed': String(!!on) });
    b.append(el('span', { class: 'tg-dot' }), el('span', {}, label));
    b.onclick = function () { var v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); onChange(v); };
    return b;
  }
  var css = '' +
    '.spx-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:12px 14px;margin:0 0 14px}' +
    '.spx-card .spx-h{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}' +
    '.spx-card .spx-h button{border:0;background:transparent;color:var(--accent);font-weight:700;font-size:12px;text-transform:none;letter-spacing:0;padding:4px 0}' +
    '.spx-card .spx-h .spx-x{color:var(--muted);font-size:15px;padding:2px 4px}' +
    '.spx-bill{display:grid;grid-template-columns:4px 1fr auto;gap:4px 10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}' +
    '.spx-bill:first-of-type{border-top:0}.spx-bill i{align-self:stretch;border-radius:2px;grid-row:span 4}' +
    '.spx-bill b{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.spx-bill .amt{font-weight:800;font-variant-numeric:tabular-nums;text-align:right}' +
    '.spx-bill .last{grid-column:2/4;font-size:13px;color:var(--ink);font-weight:600}.spx-bill .last.new{color:var(--accent)}' +
    '.spx-bill .when{grid-column:2/4;font-size:12px;color:var(--muted);font-weight:600}.spx-bill .when.bad{color:var(--bad,#C2412D)}.spx-bill .when.warn{color:var(--accent)}' +
    '.spx-bill .acts2{grid-column:2/4;display:flex;gap:8px;margin-top:4px}.spx-bill .acts2 button{flex:1}.spx-bill .acts2 button{padding:6px 10px;font-size:13px;border-radius:10px;white-space:nowrap}' +
    '.spx-bill .acts2 .go{background:var(--accent);color:var(--on-accent);border:0;font-weight:700}' +
    '.spx-next{font-size:14px;color:var(--muted);margin-top:6px}.spx-next b{color:var(--ink)}' +
    '.spx-big{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;margin:6px 0 0}.spx-sub2{font-size:13px;color:var(--muted);font-weight:600}' +
    '.spx-bars{display:flex;flex-direction:column;gap:7px;margin:10px 0 4px}.spx-bars .r{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:13px;font-weight:600}' +
    '.spx-bars .r span:last-of-type{font-variant-numeric:tabular-nums}.spx-bars .t{grid-column:1/-1;height:6px;border-radius:3px;background:var(--sunk,#E9EDF2);overflow:hidden}' +
    '.spx-bars .t i{display:block;height:100%;border-radius:3px}' +
    '.spx-share{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.spx-share button{padding:9px 6px;font-size:14px;border-radius:10px}' +
    '.spx-seg{display:flex;flex-wrap:wrap;gap:6px}.spx-seg button{border:1.5px solid var(--line);background:var(--surface);border-radius:999px;padding:7px 12px;font-weight:600;font-size:14px}' +
    '.spx-seg button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}' +
    '.spx-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.spx-err{color:var(--bad,#C2412D);font-size:13px;font-weight:600;min-height:1em}' +
    '.spx-row2{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;padding:11px 2px;border-radius:0}' +
    '.spx-row2 i{width:4px;align-self:stretch;border-radius:2px;flex:none}.spx-row2 .t{flex:1;min-width:0}' +
    '.spx-row2 .t b{display:block;font-weight:700;color:var(--ink)}.spx-row2 .t span{display:block;font-size:12px;color:var(--muted)}' +
    '.spx-row2 .a{font-weight:800;font-variant-numeric:tabular-nums;color:var(--ink)}' +
    '#spxRemSection{border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:10px}';

  // ---------- Bills list and form ----------
  function openBills() {
    var box = sheet('Bills', 'spx-bills-sheet');
    var list = bills();
    if (!list.length) box.appendChild(el('p', { class: 'help' }, 'Add the bills you pay regularly, like electricity, internet or rent. ' +
      'Spenderrr shows them on Recent when they\'re due, and you can add them to your phone\'s calendar.'));
    var wrap = el('div', {});
    list.map(function (b) { return { b: b, st: status(b) }; })
      .sort(function (x, y) { return x.st.due - y.st.due; })
      .forEach(function (it) {
        var b = it.b, t = typeOf(b.type), row = el('button', { type: 'button', class: 'spx-row2', 'data-bill': b.id });
        var i = el('i', { style: 'background:' + catColor(b.cat) });
        var tx = el('span', { class: 't' });
        var lb = lastBill(b);
        tx.append(el('b', {}, t.emoji + ' ' + b.name), el('span', {}, statusText(it.st) + ' · ' + FREQ.filter(function (f) { return f[0] === b.freq; })[0][1]),
          el('span', {}, lb ? lastBillText(b, lb) : 'No payment logged yet'));
        row.append(i, tx, el('span', { class: 'a' }, lb ? money(lb.amount) : b.amount ? money(b.amount) : ''));
        row.onclick = function () { openBillForm(b); };
        wrap.appendChild(row);
      });
    box.appendChild(wrap);
    var add = el('button', { type: 'button', class: 'primary', id: 'spxAddBill' }, '+ Add bill');
    add.onclick = function () { openBillForm(null); };
    box.appendChild(add);
  }

  function openBillForm(bill) {
    var editing = !!bill, now = new Date();
    bill = bill || { type: 'electricity', name: 'Electricity', freq: 'monthly', day: Math.min(now.getDate(), 28), month: now.getMonth(), remind: 3, amount: null };
    var box = sheet(editing ? 'Edit bill' : 'New bill', 'spx-bill-form');
    var chosen = bill.type || 'other', nameTouched = editing;

    box.appendChild(el('span', { class: 'lab' }, 'Type'));
    var chips = el('div', { class: 'chips', id: 'spxBillType' });
    TYPES.forEach(function (t) {
      var c = el('button', { type: 'button', class: 'chip', 'data-type': t.id, 'aria-pressed': String(t.id === chosen), style: '--cc:' + catColor(t.cat) });
      c.append(el('i', { style: 'background:' + catColor(t.cat) }), document.createTextNode(t.label));
      c.onclick = function () {
        chosen = t.id;
        [].forEach.call(chips.children, function (x) { x.setAttribute('aria-pressed', String(x === c)); });
        if (!nameTouched) name.value = t.id === 'other' ? '' : t.label;
      };
      chips.appendChild(c);
    });
    box.appendChild(chips);

    var two = el('div', { class: 'spx-two' });
    var nl = el('div', {}); nl.appendChild(el('label', { class: 'lab', for: 'spxBillName' }, 'Name'));
    var name = el('input', { class: 'inp', id: 'spxBillName', maxlength: '30', placeholder: 'e.g. Electricity', autocomplete: 'off' });
    name.value = bill.name || ''; name.oninput = function () { nameTouched = true; };
    nl.appendChild(name);
    var al = el('div', {}); al.appendChild(el('label', { class: 'lab', for: 'spxBillAmt' }, 'Usual amount'));
    var amt = el('input', { class: 'inp', id: 'spxBillAmt', inputmode: 'decimal', placeholder: 'Optional', autocomplete: 'off' });
    amt.value = bill.amount ? String(bill.amount) : '';
    al.appendChild(amt);
    two.append(nl, al);
    box.appendChild(two);

    box.appendChild(el('span', { class: 'lab' }, 'Repeats'));
    var freq = seg(FREQ.map(function (f) { return [f[0], f[1]]; }), bill.freq, 'Repeats');
    freq.id = 'spxBillFreq';
    box.appendChild(freq);

    var two2 = el('div', { class: 'spx-two' });
    var dl = el('div', {}); dl.appendChild(el('label', { class: 'lab', for: 'spxBillDay' }, 'Due on'));
    var day = el('select', { class: 'inp', id: 'spxBillDay' });
    for (var d = 1; d <= 28; d++) day.appendChild(el('option', { value: String(d) }, 'Day ' + d));
    day.appendChild(el('option', { value: '-1' }, 'Last day'));
    day.value = String(bill.day);
    dl.appendChild(day);
    var ml = el('div', { id: 'spxBillMonthWrap' }); ml.appendChild(el('label', { class: 'lab', for: 'spxBillMonth' }, 'Next due month'));
    var month = el('select', { class: 'inp', id: 'spxBillMonth' });
    MONTHS.forEach(function (m, i) { month.appendChild(el('option', { value: String(i) }, m)); });
    month.value = String(editing ? nextDueMonth(bill) : now.getMonth());
    ml.appendChild(month);
    two2.append(dl, ml);
    box.appendChild(two2);
    function showMonth(f) { ml.style.visibility = f === 'monthly' ? 'hidden' : 'visible'; }
    showMonth(bill.freq);
    freq.onpick = showMonth;

    box.appendChild(el('span', { class: 'lab' }, 'Remind me'));
    var remind = seg(REMIND, Number(bill.remind) || 0, 'Remind me');
    remind.id = 'spxBillRemind';
    box.appendChild(remind);

    var err = el('p', { class: 'spx-err', role: 'alert' });
    box.appendChild(err);
    var save = el('button', { type: 'button', class: 'primary', id: 'spxSaveBill' }, editing ? 'Save' : 'Add bill');
    box.appendChild(save);
    save.onclick = function () {
      var n = cleanText(name.value, 30), a = String(amt.value).replace(/[,\s]/g, '').replace(/^[$₹€]/, '');
      if (!n) { err.textContent = 'Give the bill a name'; name.focus(); return; }
      var num = a === '' ? null : Number(a);
      if (num !== null && !(isFinite(num) && num >= 0 && num <= MAX_AMOUNT)) { err.textContent = 'Enter the amount as a number, or leave it empty'; amt.focus(); return; }
      var t = typeOf(chosen), f = freq.value(), list = bills();
      var item = {
        id: editing ? bill.id : newId(), type: t.id, name: n, cat: t.cat, sub: t.sub, amount: num === null ? null : round(num),
        freq: f, day: Number(day.value), month: f === 'monthly' ? 0 : Number(month.value), remind: Number(remind.value()) || 0,
        paid: editing ? (bill.paid || {}) : {}, createdAt: editing ? (bill.createdAt || Date.now()) : Date.now()
      };
      if (!editing && list.length >= MAX_BILLS) { err.textContent = 'You can keep up to ' + MAX_BILLS + ' bills'; return; }
      if (editing) list = list.map(function (x) { return x.id === item.id ? item : x; }); else list.push(item);
      if (!saveBills(list)) return;
      closeSheet('spx-bill-form');
      if (document.getElementById('spx-bills-sheet')) openBills();
      draw();
      toast(editing ? 'Saved ' + n : 'Added ' + n);
      if (!editing) openCalendar(item);
    };

    if (editing) {
      var btns = el('div', { class: 'btns' });
      var cal = el('button', { type: 'button', class: 'ghost', id: 'spxBillCal' }, 'Add to calendar');
      cal.onclick = function () { openCalendar(bill); };
      var del = el('button', { type: 'button', class: 'ghost', id: 'spxDelBill' }, 'Delete');
      del.style.color = 'var(--bad,#C2412D)';
      del.onclick = function () {
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
        saveBills(bills().filter(function (x) { return x.id !== bill.id; }));
        closeSheet('spx-bill-form');
        if (document.getElementById('spx-bills-sheet')) openBills();
        draw();
        toast('Deleted ' + bill.name + '. Remove it from your calendar too if you added it.');
      };
      btns.append(cal, del);
      box.appendChild(btns);
    }
  }
  function nextDueMonth(bill) { var a = dueAround(bill, new Date()); return (a.next || new Date()).getMonth(); }

  // ---------- Mark paid: fill in the app's own Add form ----------
  var pending = null;
  function markPaid(bill, dueKey) {
    var fab = document.getElementById('fab');
    if (!fab) { setPaid(bill.id, dueKey); return; }
    pending = { id: bill.id, due: dueKey, count: entries().length };
    fab.click();
    var tries = 0;
    (function fill() {
      var amt = document.getElementById('fAmt');
      if (!amt) { if (++tries < 20) return setTimeout(fill, 50); pending = null; return; }
      var form = amt.closest('form') || document;
      var last = lastBill(bill), guess = last ? last.amount : bill.amount;
      if (guess) { amt.value = String(guess); amt.dispatchEvent(new Event('input', { bubbles: true })); }
      var chip = form.querySelector('button.chip[data-cat="' + bill.cat + '"]');
      if (chip && chip.getAttribute('aria-pressed') !== 'true') chip.click();
      if (bill.sub) {
        setTimeout(function () {
          var sub = [].filter.call(form.querySelectorAll('button.chip:not([data-cat])'), function (b) { return b.textContent.trim() === bill.sub; })[0];
          if (sub && sub.getAttribute('aria-pressed') !== 'true') sub.click();
        }, 30);
      }
      var note = document.getElementById('fNote');
      if (note) { note.value = bill.name + ' bill'; note.dispatchEvent(new Event('input', { bubbles: true })); }
      toast(guess ? 'Filled in last bill\'s amount. Change it if needed, then tap Add expense' : 'Enter this bill\'s amount, then tap Add expense');
      if (!guess) amt.focus();
    })();
  }
  function setPaid(id, dueKey) {
    var list = bills(), name = '';
    list.forEach(function (b) {
      if (b.id !== id) return;
      name = b.name;
      var p = {};
      // Keep only the last 24 paid dates.
      Object.keys(b.paid || {}).sort().slice(-23).forEach(function (k) { p[k] = b.paid[k]; });
      p[dueKey] = Date.now();
      b.paid = p;
    });
    saveBills(list);
    draw();
    return name;
  }
  // Called after the app saves its data: if the Add form we filled was saved, the bill is paid.
  function afterAppSave() {
    if (!pending) return;
    if (entries().length > pending.count) {
      var p = pending; pending = null;
      var n = setPaid(p.id, p.due);
      if (n) setTimeout(function () { toast(n + ' marked paid'); }, 600);
    }
  }

  // ---------- Cards on Recent ----------
  function activeView() {
    var t = document.querySelector('nav.tabs button[aria-selected="true"]');
    return t ? t.getAttribute('data-view') : 'recent';
  }
  function place(card, after) {
    var main = document.getElementById('main'), old = document.getElementById(card.id);
    if (old && old.getAttribute('data-sig') === card.getAttribute('data-sig')) return;   // nothing changed
    if (old) { old.replaceWith(card); return; }
    var anchor = null;
    after.forEach(function (id) { var e = document.getElementById(id); if (e && e.parentNode === main) anchor = e; });
    if (anchor) anchor.insertAdjacentElement('afterend', card); else main.insertBefore(card, main.firstChild);
  }
  function remove(id) { var e = document.getElementById(id); if (e) e.remove(); }

  function billsCard() {
    var list = bills(), pr = prefs();
    if (!pr.billsCard || !list.length) { remove('spx-bills'); return; }
    var items = list.map(function (b) { return { b: b, st: status(b) }; }).sort(function (x, y) { return x.st.due - y.st.due; });
    var due = items.filter(function (it) { return it.st.show; });
    var card = el('section', { id: 'spx-bills', class: 'spx-card', 'aria-label': 'Bills' });
    var h = el('div', { class: 'spx-h' });
    var all = el('button', { type: 'button', id: 'spxAllBills' }, 'All bills');
    all.onclick = openBills;
    h.append(el('span', {}, due.length ? 'Bills due' : 'Bills'), all);
    card.appendChild(h);
    if (!due.length) {
      var nx = items[0], line = el('div', { class: 'spx-next' });
      line.append(document.createTextNode('Next: '), el('b', {}, nx.b.name), document.createTextNode(' · ' + statusText(nx.st)));
      card.appendChild(line);
    }
    due.forEach(function (it) {
      var b = it.b, st = it.st, row = el('div', { class: 'spx-bill', 'data-bill': b.id });
      var when = el('span', { class: 'when ' + (st.state === 'overdue' ? 'bad' : st.state === 'today' ? 'warn' : '') }, statusText(st));
      var last = lastBill(b), note = el('span', { class: 'last' + (last ? '' : ' new') }, lastBillText(b, last));
      it.last = last;
      var acts = el('div', { class: 'acts2' });
      var done = el('button', { type: 'button', class: 'ghost spx-already' }, 'Already paid');
      done.onclick = function () { setPaid(b.id, ymd(st.due)); toast(b.name + ' marked paid'); };
      var pay = el('button', { type: 'button', class: 'go spx-pay' }, 'Mark paid');
      pay.onclick = function () { markPaid(b, ymd(st.due)); };
      acts.append(done, pay);
      row.append(el('i', { style: 'background:' + catColor(b.cat) }), el('b', {}, typeOf(b.type).emoji + ' ' + b.name),
        el('span', { class: 'amt' }, last ? money(last.amount) : b.amount ? money(b.amount) : ''), when, note, acts);
      card.appendChild(row);
    });
    card.setAttribute('data-sig', JSON.stringify(items.map(function (it) { return [it.b, it.st.state, it.st.days, it.last || null]; })) + currency().sym);
    place(card, ['spx-summary']);
  }

  function reportCard(kind, show) {
    var id = 'spx-report-' + kind;
    if (!show) { remove(id); return; }
    var r = report(kind), pr = prefs();
    if (pr.dismissed[r.period.key] || (!r.count && !r.prev)) { remove(id); return; }
    var card = el('section', { id: id, class: 'spx-card', 'aria-label': (kind === 'week' ? 'Weekly' : 'Monthly') + ' report' });
    var h = el('div', { class: 'spx-h' });
    var x = el('button', { type: 'button', class: 'spx-x', 'aria-label': 'Hide this report' }, '✕');
    x.onclick = function () { var p = prefs(); p.dismissed[r.period.key] = Date.now(); savePrefs(p); remove(id); };
    h.append(el('span', {}, (kind === 'week' ? 'Last week · ' : 'Last month · ') + r.period.title), x);
    card.appendChild(h);
    fillReport(card, r);
    card.setAttribute('data-sig', JSON.stringify([r.total, r.prev, r.count, r.cats, r.moneyIn]) + currency().sym);
    place(card, ['spx-summary', 'spx-bills', 'spx-report-month']);
  }
  function fillReport(box, r) {
    box.appendChild(el('div', { class: 'spx-big' }, money(r.total)));
    box.appendChild(el('div', { class: 'spx-sub2' }, r.count + (r.count === 1 ? ' entry' : ' entries') + (change(r) ? ' · ' + change(r) : '')));
    if (r.moneyIn !== undefined && r.moneyIn > 0) box.appendChild(el('div', { class: 'spx-sub2' }, 'Money in ' + money(r.moneyIn) + ' · Balance ' + money(round(r.moneyIn - r.total))));
    var bars = el('div', { class: 'spx-bars' });
    r.cats.slice(0, 5).forEach(function (c) {
      var row = el('div', { class: 'r' }), pct = r.total > 0 ? Math.round(c.amount / r.total * 100) : 0;
      var track = el('span', { class: 't' }), fill = el('i', { style: 'width:' + Math.max(pct, 2) + '%;background:' + catColor(c.id) });
      track.appendChild(fill);
      row.append(el('span', {}, c.label), el('span', {}, money(c.amount) + ' · ' + pct + '%'), track);
      bars.appendChild(row);
    });
    box.appendChild(bars);
    var s = el('div', { class: 'spx-share' });
    [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['share', 'Share…']].forEach(function (o) {
      var b = el('button', { type: 'button', class: 'ghost', 'data-share': o[0] }, o[1]);
      b.onclick = function () { sendReport(r, o[0]); };
      s.appendChild(b);
    });
    box.appendChild(s);
  }
  function openReport(kind) {
    var r = report(kind), box = sheet((kind === 'week' ? 'Last week · ' : 'Last month · ') + r.period.title, 'spx-report-sheet');
    if (!r.count) box.appendChild(el('p', { class: 'help' }, 'No expenses in this ' + r.period.word + '.'));
    fillReport(box, r);
  }

  var drawing = false;
  function draw() {
    var main = document.getElementById('main');
    if (!main || drawing) return;
    drawing = true;
    try {
      if (activeView() !== 'recent') { ['spx-bills', 'spx-report-month', 'spx-report-week'].forEach(remove); return; }
      var now = new Date(), pr = prefs(), wd = now.getDay();
      billsCard();
      reportCard('month', pr.monthly && now.getDate() <= 5);
      reportCard('week', pr.weekly && wd >= 1 && wd <= 3);
    } catch (e) { console.warn('Bills and reports card', e); } finally { drawing = false; }
  }

  // ---------- Settings → Bills & reports ----------
  function enhanceSettings() {
    var root = document.getElementById('sheetRoot');
    var title = root && root.querySelector('.sheet-h h3');
    if (!title || title.textContent.trim() !== 'Settings' || root.querySelector('#spxRemSection')) return;
    var sheetEl = title.closest('.sheet'), pr = prefs();
    var sec = el('div', { id: 'spxRemSection' });
    sec.appendChild(el('span', { class: 'lab', style: 'margin:0' }, 'Bills & reports'));
    var n = bills().length;
    sec.appendChild(el('p', { class: 'help' }, n ? 'You have ' + n + (n === 1 ? ' bill' : ' bills') + ' with reminders.' :
      'Get reminders for bills like electricity, internet or rent, and a summary of your spending every week and month.'));
    var mb = el('button', { type: 'button', class: 'ghost', id: 'spxManageBills' }, n ? 'Manage bills' : '+ Add a bill');
    mb.onclick = function () { var c = document.getElementById('closeSheet'); if (c) c.click(); openBills(); };
    sec.appendChild(mb);
    sec.appendChild(toggle('spxTgBills', 'Show bills due on Recent', pr.billsCard, function (v) { var p = prefs(); p.billsCard = v; savePrefs(p); draw(); }));
    sec.appendChild(toggle('spxTgWeekly', 'Weekly report card (Mondays)', pr.weekly, function (v) { var p = prefs(); p.weekly = v; savePrefs(p); draw(); }));
    sec.appendChild(toggle('spxTgMonthly', 'Monthly report card (1st of the month)', pr.monthly, function (v) { var p = prefs(); p.monthly = v; savePrefs(p); draw(); }));
    sec.appendChild(el('span', { class: 'lab', style: 'margin:4px 0 0' }, 'Share a report now'));
    var btns = el('div', { class: 'btns' });
    [['week', 'Last week'], ['month', 'Last month']].forEach(function (o) {
      var b = el('button', { type: 'button', class: 'ghost', id: 'spxReport' + (o[0] === 'week' ? 'Week' : 'Month') }, o[1]);
      b.onclick = function () { var c = document.getElementById('closeSheet'); if (c) c.click(); openReport(o[0]); };
      btns.appendChild(b);
    });
    sec.appendChild(btns);
    var foot = sheetEl.lastElementChild;
    if (foot && foot.tagName === 'P') foot.insertAdjacentElement('beforebegin', sec); else sheetEl.appendChild(sec);
  }

  // ---------- Start ----------
  function start() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);
    var main = document.getElementById('main');
    if (main) new MutationObserver(function (list) {
      // Redraw when the app re-renders, not for the cards these add-ons draw.
      var ours = list.every(function (m) {
        return [].concat([].slice.call(m.addedNodes), [].slice.call(m.removedNodes)).every(function (n) { return n.id && n.id.indexOf('spx-') === 0; });
      });
      if (!ours) draw();
    }).observe(main, { childList: true });
    var root = document.getElementById('sheetRoot');
    if (root) new MutationObserver(function () {
      enhanceSettings();
      // The Add form was closed without saving: forget the pending "Mark paid".
      if (pending && !document.getElementById('fAmt')) setTimeout(function () { if (pending && !document.getElementById('fAmt')) { afterAppSave(); pending = null; } }, 300);
    }).observe(root, { childList: true, subtree: true });
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('nav.tabs')) setTimeout(draw, 0); });
    window.addEventListener('storage', draw);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) draw(); });   // a new day while the app was open
    var set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k) {
      var r = set.apply(this, arguments);
      if (this === window.localStorage) {
        if (k === DATA_KEY) setTimeout(function () { afterAppSave(); draw(); }, 0);
        else if (k === BILLS_KEY || k === CUR_KEY) setTimeout(draw, 0);
      }
      return r;
    };
    draw();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SpenderrrReminders = {
    bills: bills, status: status, dueAround: dueAround, report: report, reportText: reportText, ics: ics, googleLink: googleLink,
    openBills: openBills, openBillForm: openBillForm, openReport: openReport, setPaid: setPaid, prefs: prefs
  };
})();

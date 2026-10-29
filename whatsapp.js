/*
 * Spenderrr – Send split summaries on WhatsApp  (app version is set in index.html)
 * -----------------------------------------------------------------------------
 * When you open a friend on the Split screen and tap "Send summary":
 *  - the summary is rewritten in a WhatsApp-friendly layout (sections, bold totals,
 *    one line per expense, category emoji) — Copy and Share use the same text;
 *  - a green "Send on WhatsApp" button opens WhatsApp with the message ready to send;
 *  - an optional WhatsApp number per friend opens their chat directly. Without one,
 *    WhatsApp asks who to send it to.
 * Free: it uses WhatsApp's click-to-chat link (wa.me). Nothing goes through a server.
 */
(function () {
  'use strict';

  var DATA_KEY = 'spendlog.v1';
  var CONTACTS_KEY = 'spenderrr.contacts';   // { "Ravi": "+19195551234" } — included in backups
  var MAX_ITEMS = 25;                         // keeps the message short enough for WhatsApp links

  var EMOJI = {
    breakfast: '☕', lunch: '🥪', dinner: '🍽️', snacks: '🍿', grocery: '🛒', shopping: '🛍️',
    household: '🏠', utilities: '💡', transport: '🚕', other: '📌',
    emi: '🏦', insurance: '🛡️', maid: '🧹', fuel: '⛽', lpg: '🔥', gift: '🎁'
  };
  var LABEL = {
    breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks', grocery: 'Grocery', shopping: 'Shopping',
    household: 'Household', utilities: 'Utilities', transport: 'Travel', other: 'Other',
    emi: 'EMI', insurance: 'Insurance', maid: 'Maid', fuel: 'Fuel', lpg: 'LPG', gift: 'Gift'
  };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- Data ----------
  function load() {
    try { return JSON.parse(localStorage.getItem(DATA_KEY)) || {}; } catch (e) { return {}; }
  }
  function contacts() {
    try { return JSON.parse(localStorage.getItem(CONTACTS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveContact(name, phone) {
    var c = contacts();
    if (phone) c[name] = phone; else delete c[name];
    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  function money(n) {
    var v = Math.round(Math.abs(Number(n) || 0) * 100) / 100;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function day(ts) { var d = new Date(ts); return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fullDay(ts) { return day(ts) + ' ' + new Date(ts).getFullYear(); }
  // WhatsApp uses * _ ~ ` for formatting; keep them out of names and notes so the layout never breaks.
  function clean(s) { return String(s || '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim(); }
  function catLabel(id) {
    if (LABEL[id]) return LABEL[id];
    var yours = (window.__spxExtra || []).filter(function (x) { return x.id === id; })[0];   // categories you created
    if (yours) return clean(yours.label);
    return clean(id).replace(/^./, function (c) { return c.toUpperCase(); }) || 'Other';
  }

  // Everything between you and one friend, oldest first.
  function ledger(name, data) {
    data = data || load();
    var owesMe = [], iOwe = [], payments = [];
    (data.e || []).forEach(function (x) {
      var sp = x && x.split;
      if (!sp || !Array.isArray(sp.parts)) return;
      var theirs = sp.parts.filter(function (p) { return p.name === name; })[0];
      var mine = sp.parts.filter(function (p) { return p.name === 'Me'; })[0];
      var item = { ts: Number(x.ts) || 0, cat: x.cat, note: x.note, bill: Number(x.amount) || 0 };
      if (sp.paidBy === 'Me' && theirs) { item.amt = Number(theirs.amt) || 0; owesMe.push(item); }
      else if (sp.paidBy === name && mine) { item.amt = Number(mine.amt) || 0; iOwe.push(item); }
    });
    (data.s || []).forEach(function (s) {
      if (s && s.name === name) payments.push({ ts: Number(s.ts) || 0, amt: Number(s.amt) || 0, dir: s.dir });
    });
    function byTime(a, b) { return a.ts - b.ts; }
    owesMe.sort(byTime); iOwe.sort(byTime); payments.sort(byTime);
    var sum = function (list) { return list.reduce(function (t, i) { return t + i.amt; }, 0); };
    var paidIn = sum(payments.filter(function (p) { return p.dir === 'in'; }));
    var paidOut = sum(payments.filter(function (p) { return p.dir !== 'in'; }));
    var balance = Math.round((sum(owesMe) - sum(iOwe) - paidIn + paidOut) * 100) / 100;   // + = they owe you
    return { owesMe: owesMe, iOwe: iOwe, payments: payments, balance: balance };
  }

  // ---------- The message ----------
  // Your name for the message: the name on the Google account Drive backup is connected to
  // (first name; full name if your friend has the same first name). No Drive name → "you".
  function senderName(friend) {
    var acct = null;
    try { acct = (JSON.parse(localStorage.getItem('__spendlog_backup_meta') || '{}') || {}).driveAccount; } catch (e) { /* ignore */ }
    var full = clean(acct && typeof acct.name === 'string' ? acct.name : '').replace(/[<>]/g, '').slice(0, 40);
    if (!full || full.indexOf('@') >= 0) return '';
    var first = full.split(' ')[0], f = String(friend || '').toLowerCase();
    if (first.toLowerCase() !== f) return first;
    return full.toLowerCase() !== f ? full : '';
  }

  // Third-person wording so the message reads the same for whoever opens it:
  // "Ravi owes Saberi", "Saberi paid Ravi", "Ravi's share". Without your name: "Ravi owes you", "You paid Ravi".
  function message(name, now, data, me) {
    now = now || Date.now();
    var L = ledger(name, data), who = clean(name) || 'there';
    me = me === undefined ? senderName(who) : clean(me);
    var I = me || 'You', mine = me ? me + "'s" : 'your', meObj = me || 'you';
    function owes(a, b) { return a + (a === 'You' ? ' owe ' : ' owes ') + b; }
    var lines = ['🧾 *Split summary · ' + (me ? who + ' & ' + me : who) + '*', '_As of ' + fullDay(now) + '_'];

    function section(title, items, shareWord) {
      if (!items.length) return;
      lines.push('', '*' + title + '*');
      var shown = items.slice(-MAX_ITEMS);
      if (items.length > shown.length) lines.push('_…' + (items.length - shown.length) + ' earlier ' + (items.length - shown.length === 1 ? 'item' : 'items') + ' included in the total_');
      shown.forEach(function (i) {
        var note = clean(i.note);
        lines.push((EMOJI[i.cat] || '📌') + ' ' + catLabel(i.cat) + (note ? ' · ' + note : '') + ' — *' + money(i.amt) + '*');
        lines.push('      ' + day(i.ts) + ' · bill ' + money(i.bill) + ' · ' + shareWord + ' share');
      });
    }
    section(owes(who, meObj), L.owesMe, who + "'s");
    section(owes(I, who), L.iOwe, mine);
    if (L.payments.length) {
      lines.push('', '*Payments*');
      L.payments.slice(-MAX_ITEMS).forEach(function (p) {
        lines.push('✅ ' + (p.dir === 'in' ? who + ' paid ' + meObj + ' ' : I + ' paid ' + who + ' ') + money(p.amt) + ' · ' + day(p.ts));
      });
    }
    if (!L.owesMe.length && !L.iOwe.length && !L.payments.length) lines.push('', 'No shared expenses yet.');

    lines.push('', '━━━━━━━━━━━━━━');
    if (L.balance > 0) lines.push('💰 *Total: ' + owes(who, meObj) + ' ' + money(L.balance) + '*');
    else if (L.balance < 0) lines.push('💸 *Total: ' + owes(I, who) + ' ' + money(L.balance) + '*');
    else lines.push('✅ *All settled up*');
    lines.push('', '_Sent from Spenderrr_');
    return lines.join('\n');
  }

  // ---------- Phone numbers and links ----------
  // Accepts "+1 (919) 555-1234", "0091 98765 43210" … returns "+19195551234", or '' when not valid.
  function normalizePhone(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var intl = /^\+/.test(s) || /^00/.test(s.replace(/\D/g, ''));
    var digits = s.replace(/\D/g, '').replace(/^00/, '');
    if (!intl || digits.length < 8 || digits.length > 15 || digits.charAt(0) === '0') return null;
    return '+' + digits;
  }
  function link(name, text) {
    var phone = contacts()[name];
    var base = phone ? 'https://wa.me/' + phone.replace(/\D/g, '') : 'https://wa.me/';
    return base + '?text=' + encodeURIComponent(text);
  }
  function open(url) {
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Screen ----------
  var css = '' +
    '.wa-btn{display:flex;width:100%;justify-content:center;align-items:center;gap:8px;border:0;border-radius:999px;' +
    'min-height:46px;margin:10px 0 2px;padding:10px 16px;background:#25D366;color:#0B3D1E;font-weight:700;font-size:15px;cursor:pointer}' +
    '.wa-btn svg{width:18px;height:18px}' +
    '.wa-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}' +
    '.wa-row .inp{flex:1 1 160px;min-width:0}' +
    '.wa-note{font-size:12px;color:var(--muted,#5B6678);margin-top:6px;line-height:1.4}' +
    '.wa-err{color:var(--bad,#C2412D)}';
  var ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text) e.textContent = text;
    return e;
  }

  function personName(box) {
    var h = box.closest('.sheet') && box.closest('.sheet').querySelector('.sheet-h h3');
    return h ? h.textContent.trim() : '';
  }

  function enhance(textarea) {
    if (textarea.dataset.wa) return;
    textarea.dataset.wa = '1';
    var name = personName(textarea);
    if (!name) return;
    var text = message(name);
    textarea.value = text;
    textarea.defaultValue = text;
    textarea.style.minHeight = '260px';

    var acts = textarea.parentElement.querySelector('#copySum') && textarea.parentElement.querySelector('#copySum').parentElement;
    var btn = el('button', { type: 'button', class: 'wa-btn', id: 'waSend' });
    btn.innerHTML = ICON + '<span>Send on WhatsApp</span>';
    btn.addEventListener('click', function () { open(link(name, textarea.value)); });
    textarea.insertAdjacentElement('afterend', btn);

    var row = el('div', { class: 'wa-row' });
    var input = el('input', {
      class: 'inp', id: 'waPhone', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
      placeholder: 'e.g. +1 919 555 1234', 'aria-label': name + "'s WhatsApp number"
    });
    input.value = contacts()[name] || '';
    var save = el('button', { type: 'button', class: 'ghost', id: 'waSave' }, 'Save');
    var note = el('div', { class: 'wa-note', id: 'waNote' });
    function showNote(msg, bad) { note.textContent = msg; note.classList.toggle('wa-err', !!bad); }
    function describe() {
      var p = contacts()[name];
      showNote((p ? 'Opens your chat with ' + name + ' (' + p + ').'
        : 'Number is optional. Without it, WhatsApp asks who to send it to. Include the country code, e.g. +1 919 555 1234.') +
        ' Words between *stars* show in bold on WhatsApp.');
    }
    save.addEventListener('click', function () {
      var p = normalizePhone(input.value);
      if (p === null) { showNote('Add the country code first, e.g. +1 for US or +91 for India.', true); return; }
      saveContact(name, p);
      input.value = p;
      describe();
    });
    row.append(input, save);
    (acts || btn).insertAdjacentElement('afterend', row);
    row.insertAdjacentElement('afterend', note);
    describe();
  }

  function start() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);
    var root = document.getElementById('sheetRoot') || document.body;
    new MutationObserver(function () {
      var t = document.getElementById('sumText');
      if (t) enhance(t);
    }).observe(root, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SpenderrrWhatsApp = { message: message, senderName: senderName, ledger: ledger, link: link, normalizePhone: normalizePhone };
})();

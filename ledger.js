/*
 * Spenderrr – Money in (credit) and money out (debit)  (app version is set in index.html)
 * -------------------------------------------------------------------------------------
 *  - Debit = money out: the app's expenses, plus EMI, Insurance, Maid, Fuel, LPG, Gift and categories you create.
 *  - Credit = money in: Salary, Interest, Refund, Gift, Other income and categories you create.
 *  - "Money out / Money in" switch at the top of the Add form.
 *  - Monthly summary card: Money in, Money out, Balance.
 *  - Money in list (edit / delete) and Manage categories.
 * Data stays on the device: spenderrr.credits (money in) and spenderrr.categories (your categories).
 * Both are included in backups and merged across devices by backup.js.
 */
(function () {
  'use strict';

  var DATA_KEY = 'spendlog.v1', CREDITS_KEY = 'spenderrr.credits', CATS_KEY = 'spenderrr.categories';
  // Colours for your own categories: all clearly different from the built-in ones and from each other
  // (checked by the tests), and dark enough for white text.
  var PALETTE = [
    ['#800000', 'Maroon'], ['#CD5C5C', 'Rose'], ['#FF5722', 'Tangerine'], ['#8B4513', 'Chestnut'], ['#A1887F', 'Taupe'],
    ['#827717', 'Moss'], ['#556B2F', 'Olive'], ['#004D40', 'Pine'], ['#4682B4', 'Steel blue'], ['#000080', 'Navy'],
    ['#1A237E', 'Midnight'], ['#9932CC', 'Orchid'], ['#C71585', 'Magenta'], ['#880E4F', 'Wine'], ['#455A64', 'Slate'], ['#212121', 'Charcoal']
  ];
  // Built-in categories and their colours (money out, then money in).
  var BUILT_IN_COLORS = [
    ['Breakfast', '#D99A12'], ['Lunch', '#E26C24'], ['Dinner', '#C2412D'], ['Snacks', '#D2588A'], ['Grocery', '#2F9152'],
    ['Shopping', '#7552D3'], ['Household', '#957446'], ['Utilities', '#2A78CC'], ['Travel', '#16969A'], ['Other', '#7A8391'],
    ['EMI', '#3F51B5'], ['Insurance', '#8E44AD'], ['Maid', '#5D8C1F'], ['Fuel', '#9C6B00'], ['LPG', '#0073E6'], ['Gift', '#BA68C8'],
    ['Salary', '#2E7D32'], ['Interest', '#00897B'], ['Refund', '#5C6BC0'], ['Gift', '#D81B60'], ['Other income', '#6D4C41']
  ];
  var CREDIT_BUILT_IN = [
    { id: 'salary', label: 'Salary', color: '#2E7D32', emoji: '💼' },
    { id: 'interest', label: 'Interest', color: '#00897B', emoji: '🏦' },
    { id: 'refund', label: 'Refund', color: '#5C6BC0', emoji: '↩️' },
    { id: 'gift_in', label: 'Gift', color: '#D81B60', emoji: '🎁' },
    { id: 'other_in', label: 'Other income', color: '#6D4C41', emoji: '💰' }
  ];
  var DEBIT_BUILT_IN = ['breakfast', 'lunch', 'dinner', 'snacks', 'grocery', 'shopping', 'household', 'utilities', 'transport', 'other', 'emi', 'insurance', 'maid', 'fuel', 'lpg', 'gift'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MAX_AMOUNT = 1e9;

  // ---------- Storage ----------
  function read(key) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
  }
  function write(key, v) { localStorage.setItem(key, JSON.stringify(v)); }
  function cleanLabel(s) { return String(s == null ? '' : s).replace(/[<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }
  function cleanNote(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 120); }
  function validCat(x) { return !!(x && /^c_[a-z0-9_]{1,40}$/.test(x.id) && typeof x.label === 'string' && cleanLabel(x.label) && /^#[0-9A-Fa-f]{6}$/.test(x.color)); }
  function validCredit(x) {
    return !!(x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) && isFinite(Number(x.amount)) &&
      Number(x.amount) > 0 && Number(x.amount) <= MAX_AMOUNT && isFinite(Number(x.ts)) && typeof x.cat === 'string');
  }
  function credits() { var s = read(CREDITS_KEY); return Array.isArray(s.e) ? s.e.filter(validCredit) : []; }
  function saveCredits(list) { var s = read(CREDITS_KEY); s.e = list; write(CREDITS_KEY, s); }
  function customCats() {
    var c = read(CATS_KEY);
    return { debit: (Array.isArray(c.debit) ? c.debit : []).filter(validCat), credit: (Array.isArray(c.credit) ? c.credit : []).filter(validCat) };
  }
  function saveCustom(c) { var all = read(CATS_KEY); all.debit = c.debit; all.credit = c.credit; write(CATS_KEY, all); }

  // ---------- One colour per category ----------
  function hex(h) { return String(h || '').toUpperCase(); }
  function inPalette(h) { return PALETTE.some(function (p) { return p[0] === hex(h); }); }
  // Who already uses each colour: { '#3F51B5': 'EMI', ... } (leave out one category when changing its colour).
  function colourOwners(exceptId) {
    var owners = {}, c = customCats();
    BUILT_IN_COLORS.forEach(function (b) { owners[hex(b[1])] = b[0]; });
    c.debit.concat(c.credit).forEach(function (x) { if (x.id !== exceptId) owners[hex(x.color)] = cleanLabel(x.label); });
    return owners;
  }
  function firstFreeColour(exceptId) {
    var owners = colourOwners(exceptId);
    var p = PALETTE.filter(function (x) { return !owners[x[0]]; })[0];
    return p ? p[0] : null;
  }
  // Two categories can end up with the same colour when two phones each add one before syncing.
  // Repair the same way on every device: oldest-by-id keeps its colour, the next gets the first free one.
  // (index.html runs the same rule before the app starts.)
  function fixColours(c) {
    var used = {}, changed = false;
    BUILT_IN_COLORS.forEach(function (b) { used[hex(b[1])] = 1; });
    c.debit.concat(c.credit).slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }).forEach(function (x) {
      if (used[hex(x.color)]) {
        var free = PALETTE.filter(function (p) { return !used[p[0]]; })[0];
        if (free) { x.color = free[0]; changed = true; }
      }
      used[hex(x.color)] = 1;
    });
    return changed;
  }
  function checkColour(color, exceptId) {
    if (!inPalette(color)) return 'Pick a colour.';
    var owner = colourOwners(exceptId)[hex(color)];
    if (owner) return 'That colour is already used by ' + owner + '. Pick another.';
    return null;
  }
  function changeColour(side, id, color) {
    side = side === 'credit' ? 'credit' : 'debit';
    var c = customCats(), cat = c[side].filter(function (x) { return x.id === id; })[0];
    if (!cat) return { error: 'Category not found.' };
    var problem = checkColour(color, id);
    if (problem) return { error: problem };
    cat.color = hex(color);
    saveCustom(c);
    var st = document.getElementById('spx-category-colors');
    if (side === 'debit' && st) st.textContent += ':root{--c-' + id + ':' + cat.color + '}';   // app chips update at once
    return { category: cat };
  }
  function creditCategories() {
    return CREDIT_BUILT_IN.concat(customCats().credit.map(function (x) {
      return { id: x.id, label: cleanLabel(x.label), color: x.color, emoji: '📌', custom: true };
    }));
  }
  function creditCat(id) {
    return creditCategories().filter(function (c) { return c.id === id; })[0] || CREDIT_BUILT_IN[CREDIT_BUILT_IN.length - 1];
  }
  function debitEntries() { var o = read(DATA_KEY); return Array.isArray(o.e) ? o.e : []; }

  // ---------- Totals ----------
  function round(n) { return Math.round(n * 100) / 100; }
  function monthRange(d) {
    return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
  }
  // Money out counts your share of split bills, like the app's own totals.
  function moneyOut(start, end) {
    return round(debitEntries().reduce(function (t, x) {
      var ts = Number(x && x.ts);
      if (!(ts >= start && ts < end)) return t;
      var v = x.split && x.split.my !== undefined && x.split.my !== null ? Number(x.split.my) : Number(x.amount);
      return t + (isFinite(v) ? v : 0);
    }, 0));
  }
  function moneyIn(start, end) {
    return round(credits().reduce(function (t, x) { var ts = Number(x.ts); return ts >= start && ts < end ? t + Number(x.amount) : t; }, 0));
  }
  function summary(d) {
    d = d || new Date();
    var r = monthRange(d), i = moneyIn(r[0], r[1]), o = moneyOut(r[0], r[1]);
    return { month: MONTHS[d.getMonth()] + ' ' + d.getFullYear(), in: i, out: o, balance: round(i - o) };
  }
  function money(n) {
    var a = Math.abs(Number(n) || 0);
    return (n < 0 ? '−' : '') + '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function localInput(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function when(ts) {
    var d = new Date(ts), h = d.getHours(), m = pad(d.getMinutes());
    return d.getDate() + ' ' + SHORT[d.getMonth()] + ' · ' + ((h % 12) || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ---------- Small UI helpers (uses the app's own styles) ----------
  var css = '' +
    '.spx-side{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--sunk,#E9EDF2);border-radius:12px;padding:4px}' +
    '.spx-side button{border:0;border-radius:9px;padding:10px 6px;font-weight:700;font-size:14px;color:var(--muted);background:transparent}' +
    '.spx-side button[aria-pressed=true]{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.12)}' +
    '.spx-side button[aria-pressed=true].in{color:var(--good,#2E8B57)}.spx-side button[aria-pressed=true].out{color:var(--bad,#C2412D)}' +
    '.spx-side small{display:block;font-size:11px;font-weight:600;opacity:.8}' +
    '#spx-summary{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:12px 14px;margin:0 0 14px}' +
    '#spx-summary .spx-h{display:flex;justify-content:space-between;align-items:center;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}' +
    '#spx-summary .spx-g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}' +
    '#spx-summary .spx-g div{min-width:0}#spx-summary .spx-g span{display:block;font-size:12px;color:var(--muted);font-weight:600}' +
    '#spx-summary .spx-g b{display:block;font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#spx-summary .in b{color:var(--good,#2E8B57)}#spx-summary .out b{color:var(--bad,#C2412D)}' +
    '#spx-summary .spx-a{display:flex;gap:8px;margin-top:10px}#spx-summary .spx-a button{flex:1;padding:9px 10px;font-size:14px;border-radius:10px}' +
    '.spx-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;padding:10px 4px;border-radius:0}' +
    '.spx-row i{width:4px;align-self:stretch;border-radius:2px;flex:none}.spx-row .t{flex:1;min-width:0}' +
    '.spx-row .t b{display:block;font-weight:700;color:var(--ink)}.spx-row .t span{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.spx-row .a{font-weight:800;color:var(--good,#2E8B57);font-variant-numeric:tabular-nums}' +
    '.spx-mh{display:flex;justify-content:space-between;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700;margin-top:6px}' +
    '.spx-sw{display:flex;flex-wrap:wrap;gap:8px}.spx-sw button{width:34px;height:34px;border-radius:50%;border:3px solid transparent;padding:0}' +
    '.spx-sw button[aria-pressed=true]{border-color:var(--ink)}' +
    '.spx-err{color:var(--bad,#C2412D);font-size:13px;font-weight:600;min-height:1em}' +
    '.spx-addcat{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;padding:10px 12px;' +
    'border:1.5px dashed var(--line);border-radius:12px;font-size:14px;color:var(--muted)}' +
    '.spx-addcat button{padding:8px 12px;font-size:14px;border-radius:10px;white-space:nowrap;color:var(--accent)}' +
    '.spx-sw button[disabled]{opacity:.22;cursor:not-allowed;background-image:linear-gradient(135deg,transparent 45%,#fff 45%,#fff 55%,transparent 55%)!important}' +
    '.spx-dot{width:28px;height:28px;border-radius:50%;border:2px solid var(--surface);box-shadow:0 0 0 1.5px var(--line);padding:0;flex:none}' +
    // Money out looks like Money in: an "Amount" label over a boxed field (same border, size and weight)
    '.spx-amt-lab{margin-bottom:6px}' +
    '#sheetRoot .amtfield{border:1.5px solid var(--line);border-radius:12px;padding:0 12px;background:var(--surface);gap:0}' +
    '#sheetRoot .amtfield:focus-within{border-color:var(--accent)}#sheetRoot .amtfield span{display:none}' +
    '#sheetRoot .amtfield input,.spx-amt{font-family:var(--f-body);font-size:22px!important;font-weight:800!important;line-height:1.45}' +
    '#sheetRoot .amtfield input{padding:11px 0}' +
    // Date and time: iPhone gives date pickers a fixed minimum width; let them fit the box instead
    'input[type=datetime-local]{-webkit-appearance:none;appearance:none;display:block;width:100%;min-width:0;max-width:100%;' +
    'box-sizing:border-box;min-height:48px;text-align:left;background:var(--surface);color:var(--ink)}' +
    'input[type=datetime-local]::-webkit-date-and-time-value{text-align:left;margin:0}' +
    '#sheetRoot .row2{grid-template-columns:minmax(0,1fr) auto;align-items:stretch}' +
    '#sheetRoot .row2 > *{min-width:0}#sheetRoot .row2 .ghost{display:flex;align-items:center;justify-content:center;padding:0 18px}';
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = document.getElementById('slb-toast');
    if (!t) return;
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.style.display = 'none'; }, 2500);
  }
  // A bottom sheet in the app's own style.
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
  function sideSwitch(active, onOut, onIn) {
    var seg = el('div', { class: 'spx-side', role: 'group', 'aria-label': 'Money out or money in' });
    var out = el('button', { type: 'button', class: 'out', id: 'spxSideOut', 'aria-pressed': String(active === 'out') });
    out.append(document.createTextNode('Money out'), el('small', {}, 'Debit'));
    var inn = el('button', { type: 'button', class: 'in', id: 'spxSideIn', 'aria-pressed': String(active === 'in') });
    inn.append(document.createTextNode('Money in'), el('small', {}, 'Credit'));
    out.onclick = onOut; inn.onclick = onIn;
    seg.append(out, inn);
    return seg;
  }
  function chip(label, color, pressed) {
    var c = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(!!pressed), style: '--cc:' + color });
    var dot = el('i', { style: 'background:' + color });
    c.append(dot, document.createTextNode(label));
    return c;
  }

  // "Don't see your category?" + Add category button, shown under the category chips.
  function addCategoryPrompt(id, onClick) {
    var row = el('div', { class: 'spx-addcat', id: id + 'Row' });
    var b = el('button', { type: 'button', class: 'ghost', id: id }, '+ Add category');
    b.onclick = onClick;
    row.append(el('span', {}, 'Don’t see your category? Add your own.'), b);
    return row;
  }
  // Colour swatches. Colours already used by another category are shown crossed out and can't be picked.
  function colourPicker(current, exceptId) {
    var owners = colourOwners(exceptId), wrap = el('div', { class: 'spx-sw', id: 'spxSwatches', role: 'radiogroup', 'aria-label': 'Colour' });
    var chosen = current && !owners[hex(current)] && inPalette(current) ? hex(current) : firstFreeColour(exceptId);
    PALETTE.forEach(function (p) {
      var used = owners[p[0]];
      var b = el('button', { type: 'button', role: 'radio', 'aria-label': p[1] + (used ? ' (used by ' + used + ')' : ''),
        'aria-checked': String(p[0] === chosen), 'aria-pressed': String(p[0] === chosen), style: 'background:' + p[0] });
      if (used) { b.disabled = true; b.title = 'Used by ' + used; b.setAttribute('aria-disabled', 'true'); }
      b.dataset.color = p[0];
      b.onclick = function () {
        chosen = p[0];
        [].forEach.call(wrap.children, function (c) {
          c.setAttribute('aria-pressed', String(c.dataset.color === chosen));
          c.setAttribute('aria-checked', String(c.dataset.color === chosen));
        });
      };
      wrap.appendChild(b);
    });
    return { el: wrap, get: function () { return chosen; } };
  }

  // ---------- Money in form ----------
  function openCreditForm(existing, preset) {
    var editing = !!existing;
    var box = sheet(editing ? 'Edit money in' : 'New money in', 'spx-credit');
    if (!editing) {
      box.appendChild(sideSwitch('in', function () {
        var amt = box.querySelector('#spxAmt').value;
        closeSheet('spx-credit');
        openAppForm(amt);
      }, function () {}));
    }
    var amtWrap = el('label', {});
    amtWrap.appendChild(el('span', { class: 'lab' }, 'Amount'));
    var amt = el('input', { class: 'inp spx-amt', id: 'spxAmt', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', 'aria-label': 'Amount received' });
    amt.value = existing ? String(existing.amount) : (preset && preset.amount ? String(preset.amount) : '');
    amtWrap.appendChild(amt);
    box.appendChild(amtWrap);

    box.appendChild(el('span', { class: 'lab' }, 'Category'));
    var chips = el('div', { class: 'chips', id: 'spxCreditCats' });
    var chosen = existing ? existing.cat : (preset && preset.cat) || null;
    function drawChips() {
      chips.textContent = '';
      creditCategories().forEach(function (c) {
        var b = chip(c.label, c.color, c.id === chosen);
        b.dataset.cat = c.id;
        b.onclick = function () { chosen = c.id; drawChips(); };
        chips.appendChild(b);
      });
    }
    drawChips();
    box.appendChild(chips);
    box.appendChild(addCategoryPrompt('spxAddCreditCat', function () {
      openCategoryForm('credit', function (cat) { chosen = cat.id; drawChips(); });
    }));

    var noteWrap = el('label', {});
    noteWrap.appendChild(el('span', { class: 'lab' }, 'Note (optional)'));
    var note = el('input', { class: 'inp', id: 'spxNote', maxlength: '120', placeholder: 'From where', autocomplete: 'off' });
    note.value = existing ? existing.note || '' : '';
    noteWrap.appendChild(note);
    box.appendChild(noteWrap);

    var dateWrap = el('label', {});
    dateWrap.appendChild(el('span', { class: 'lab' }, 'Date and time'));
    var date = el('input', { class: 'inp', id: 'spxWhen', type: 'datetime-local' });
    date.value = localInput(existing ? existing.ts : Date.now());
    dateWrap.appendChild(date);
    box.appendChild(dateWrap);

    var err = el('div', { class: 'spx-err', id: 'spxErr', role: 'alert' });
    box.appendChild(err);
    var save = el('button', { type: 'button', class: 'primary', id: 'spxSave' }, editing ? 'Save changes' : 'Add money in');
    save.style.background = 'var(--good,#2E8B57)';
    save.onclick = function () {
      var value = Number(String(amt.value).replace(/[^0-9.]/g, ''));
      if (!(value > 0)) { err.textContent = 'Enter an amount above 0.'; return; }
      if (value > MAX_AMOUNT) { err.textContent = 'That amount is too large.'; return; }
      if (!chosen) { err.textContent = 'Pick a category.'; return; }
      var ts = date.value ? new Date(date.value).getTime() : Date.now();
      if (!isFinite(ts)) ts = Date.now();
      var list = credits();
      var item = { id: existing ? existing.id : newId('cr_'), amount: round(value), cat: chosen, note: cleanNote(note.value), ts: ts,
        createdAt: existing ? existing.createdAt || Date.now() : Date.now() };
      if (existing) list = list.map(function (x) { return x.id === existing.id ? item : x; });
      else list.push(item);
      saveCredits(list);
      closeSheet('spx-credit');
      toast((editing ? 'Saved' : 'Added') + ' ' + money(item.amount) + ' · ' + creditCat(chosen).label);
      refresh();
    };
    box.appendChild(save);
    if (editing) {
      var del = el('button', { type: 'button', class: 'ghost', id: 'spxDelete' }, 'Delete');
      del.style.color = 'var(--bad,#C2412D)';
      del.onclick = function () {
        if (!confirm('Delete this money in entry (' + money(existing.amount) + ')?')) return;
        saveCredits(credits().filter(function (x) { return x.id !== existing.id; }));
        closeSheet('spx-credit');
        toast('Deleted');
        refresh();
      };
      box.appendChild(del);
    }
    setTimeout(function () { try { amt.focus(); } catch (e) { /* ignore */ } }, 50);
  }

  // Open the app's own Add form (money out), optionally with an amount already typed.
  function openAppForm(amount) {
    var fab = document.getElementById('fab');
    if (!fab) return;
    fab.click();
    setTimeout(function () {
      var a = document.getElementById('fAmt');
      if (a && amount) { a.value = amount; a.dispatchEvent(new Event('input', { bubbles: true })); }
    }, 30);
  }

  // ---------- Category form (both sides) ----------
  function openCategoryForm(side, onDone) {
    var box = sheet('New category', 'spx-cat');
    box.appendChild(sideSwitch(side === 'credit' ? 'in' : 'out',
      function () { side = 'debit'; mark(); }, function () { side = 'credit'; mark(); }));
    function mark() {
      box.querySelector('#spxSideOut').setAttribute('aria-pressed', String(side === 'debit'));
      box.querySelector('#spxSideIn').setAttribute('aria-pressed', String(side === 'credit'));
    }
    var nameWrap = el('label', {});
    nameWrap.appendChild(el('span', { class: 'lab' }, 'Name'));
    var name = el('input', { class: 'inp', id: 'spxCatName', maxlength: '24', placeholder: 'e.g. Rent, School fees, Bonus', autocomplete: 'off' });
    nameWrap.appendChild(name);
    box.appendChild(nameWrap);
    box.appendChild(el('span', { class: 'lab' }, 'Colour'));
    var picker = colourPicker(null, null);
    box.appendChild(picker.el);
    box.appendChild(el('p', { class: 'help', style: 'margin:0;font-size:12px' }, 'Each category has its own colour. Crossed-out colours are already used.'));
    var err = el('div', { class: 'spx-err', id: 'spxCatErr', role: 'alert' });
    box.appendChild(err);
    var save = el('button', { type: 'button', class: 'primary', id: 'spxCatSave' }, 'Add category');
    save.onclick = function () {
      var res = addCategory(side, name.value, picker.get());
      if (res.error) { err.textContent = res.error; return; }
      closeSheet('spx-cat');
      toast('Added ' + res.category.label + ' to ' + (side === 'credit' ? 'money in' : 'money out'));
      if (onDone) onDone(res.category, side);
    };
    box.appendChild(save);
    setTimeout(function () { try { name.focus(); } catch (e) { /* ignore */ } }, 50);
  }

  function existingLabels(side) {
    if (side === 'credit') return creditCategories().map(function (c) { return c.label.toLowerCase(); });
    var list = window.__spxCatList || [];
    return list.map(function (c) { return String(c.label).toLowerCase(); });
  }
  // Creates a category. Money-out categories join the app's own list straight away.
  function addCategory(side, rawLabel, color) {
    side = side === 'credit' ? 'credit' : 'debit';
    var label = cleanLabel(rawLabel);
    if (!label) return { error: 'Enter a name.' };
    if (existingLabels(side).indexOf(label.toLowerCase()) >= 0) return { error: label + ' already exists.' };
    if (!color && !firstFreeColour(null)) return { error: 'All colours are in use. Change or delete a category first.' };
    var problem = checkColour(color, null);
    if (problem) return { error: problem };
    var c = customCats();
    var slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'cat';
    var cat = { id: 'c_' + slug + '_' + Math.random().toString(36).slice(2, 6), label: label, color: hex(color) };
    c[side].push(cat);
    saveCustom(c);
    return { category: cat };
  }
  function usedBy(side, id) {
    if (side === 'credit') return credits().filter(function (x) { return x.cat === id; }).length;
    return debitEntries().filter(function (x) { return x && x.cat === id; }).length;
  }
  function deleteCategory(side, id) {
    var n = usedBy(side, id);
    if (n) return { error: 'Used by ' + n + (n === 1 ? ' entry' : ' entries') + '. Change those first.' };
    var c = customCats();
    c[side] = c[side].filter(function (x) { return x.id !== id; });
    saveCustom(c);
    return { ok: true, reload: side === 'debit' };
  }

  // ---------- Money in list and categories ----------
  function openList() {
    var box = sheet('Money in', 'spx-list');
    var top = el('div', { class: 'spx-a', style: 'display:flex;gap:8px' });
    var add = el('button', { type: 'button', class: 'primary', id: 'spxListAdd' }, '+ Money in');
    add.style.background = 'var(--good,#2E8B57)'; add.style.padding = '12px';
    add.onclick = function () { closeSheet('spx-list'); openCreditForm(null); };
    var cats = el('button', { type: 'button', class: 'ghost', id: 'spxManage' }, 'Categories');
    cats.style.padding = '12px';
    cats.onclick = function () { closeSheet('spx-list'); openManage(); };
    top.append(add, cats);
    box.appendChild(top);
    var list = credits().sort(function (a, b) { return b.ts - a.ts || b.createdAt - a.createdAt; });
    if (!list.length) { box.appendChild(el('p', { class: 'help', id: 'spxEmpty' }, 'No money in yet. Add salary, interest, refunds and more.')); return; }
    var month = null, wrap = null;
    list.forEach(function (x) {
      var d = new Date(x.ts), key = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
      if (key !== month) {
        month = key;
        var r = monthRange(d), head = el('div', { class: 'spx-mh' });
        head.append(el('span', {}, key), el('span', {}, money(moneyIn(r[0], r[1]))));
        box.appendChild(head);
        wrap = el('div', {});
        box.appendChild(wrap);
      }
      var c = creditCat(x.cat);
      var row = el('button', { type: 'button', class: 'spx-row', 'data-id': x.id });
      var bar = el('i', { style: 'background:' + c.color });
      var t = el('span', { class: 't' });
      t.append(el('b', {}, c.label), el('span', {}, when(x.ts) + (x.note ? ' · ' + x.note : '')));
      row.append(bar, t, el('span', { class: 'a' }, '+' + money(x.amount)));
      row.onclick = function () { closeSheet('spx-list'); openCreditForm(x); };
      wrap.appendChild(row);
    });
  }

  function openManage() {
    var box = sheet('Your categories', 'spx-manage');
    var c = customCats();
    [['debit', 'Money out (Debit)'], ['credit', 'Money in (Credit)']].forEach(function (s) {
      box.appendChild(el('span', { class: 'lab' }, s[1]));
      var list = el('div', { id: 'spxManage-' + s[0] });
      if (!c[s[0]].length) list.appendChild(el('p', { class: 'help' }, 'None yet.'));
      c[s[0]].forEach(function (cat) {
        var row = el('div', { class: 'spx-row' });
        var t = el('span', { class: 't' });
        var n = usedBy(s[0], cat.id);
        t.append(el('b', {}, cleanLabel(cat.label)), el('span', {}, n ? 'Used by ' + n + (n === 1 ? ' entry' : ' entries') : 'Not used yet'));
        var del = el('button', { type: 'button', class: 'ghost', 'aria-label': 'Delete ' + cleanLabel(cat.label) }, 'Delete');
        del.style.padding = '8px 12px'; del.style.fontSize = '13px';
        del.onclick = function () {
          var r = deleteCategory(s[0], cat.id);
          if (r.error) { toast(r.error); return; }
          toast('Deleted ' + cleanLabel(cat.label));
          if (r.reload) { reloadThenReopen(null); return; }
          openManage();
        };
        var dot = el('button', { type: 'button', class: 'spx-dot', 'aria-label': 'Change colour of ' + cleanLabel(cat.label), style: 'background:' + cat.color });
        dot.onclick = function () { openColourForm(s[0], cat); };
        t.querySelector('span').textContent += ' · tap the colour to change it';
        row.append(dot, t, del);
        list.appendChild(row);
      });
      box.appendChild(list);
    });
    var add = el('button', { type: 'button', class: 'primary', id: 'spxManageAdd' }, '+ Add category');
    add.onclick = function () {
      openCategoryForm('debit', function (cat, side) {
        if (side === 'debit') reloadThenReopen(null); else openManage();
      });
    };
    box.appendChild(add);
  }

  function openColourForm(side, cat) {
    var box = sheet('Colour for ' + cleanLabel(cat.label), 'spx-colour');
    var picker = colourPicker(cat.color, cat.id);
    box.appendChild(picker.el);
    box.appendChild(el('p', { class: 'help', style: 'margin:0;font-size:12px' }, 'Crossed-out colours are used by other categories.'));
    var err = el('div', { class: 'spx-err', id: 'spxColourErr', role: 'alert' });
    box.appendChild(err);
    var save = el('button', { type: 'button', class: 'primary', id: 'spxColourSave' }, 'Save colour');
    save.onclick = function () {
      var r = changeColour(side, cat.id, picker.get());
      if (r.error) { err.textContent = r.error; return; }
      closeSheet('spx-colour');
      toast(cleanLabel(cat.label) + ' colour changed');
      openManage();
      refresh();
    };
    box.appendChild(save);
  }

  // ---------- Add form: Money out / Money in switch, and "Add category" for money out ----------
  function enhanceAppForm() {
    var root = document.getElementById('sheetRoot');
    var amt = root && root.querySelector('#fAmt');
    // New and edit expense: "Amount" label above the boxed amount, like Money in
    var box = amt && amt.closest('.amtfield');
    if (box && !(box.previousElementSibling && box.previousElementSibling.classList.contains('spx-amt-lab'))) {
      box.insertAdjacentElement('beforebegin', el('label', { class: 'lab spx-amt-lab', for: 'fAmt' }, 'Amount'));
    }
    var sheetEl = amt && amt.closest('.sheet');
    if (!sheetEl || sheetEl.dataset.spx) return;
    var title = sheetEl.querySelector('.sheet-h h3');
    if (!title || !/^new expense$/i.test(title.textContent.trim())) return;
    sheetEl.dataset.spx = '1';
    var sw = sideSwitch('out', function () {}, function () {
      var a = document.getElementById('fAmt');
      var amount = a ? a.value : '';
      var close = document.getElementById('closeSheet');
      if (close) close.click();
      openCreditForm(null, { amount: amount });
    });
    title.closest('.sheet-h').insertAdjacentElement('afterend', sw);
    // "Don't see your category?" + Add category, under the category chips
    var chipsLists = sheetEl.querySelectorAll('.chips');
    var last = chipsLists[chipsLists.length - 1];
    if (last && !sheetEl.querySelector('#spxAddDebitCat')) {
      last.insertAdjacentElement('afterend', addCategoryPrompt('spxAddDebitCat', function () {
        var a = document.getElementById('fAmt'), n = sheetEl.querySelector('input[placeholder="Where or what"]');
        var keep = { amount: a ? a.value : '', note: n ? n.value : '' };
        openCategoryForm('debit', function (cat, side) {
          if (side === 'credit') return;
          // The app reads its categories when it starts: reload once, then reopen the form
          // with what was typed and the new category picked.
          reloadThenReopen({ amount: keep.amount, note: keep.note, label: cat.label });
        });
      }));
    }
  }

  function reloadThenReopen(state) {
    try { sessionStorage.setItem('spx.reopen', JSON.stringify(state || {})); } catch (e) { /* ignore */ }
    setTimeout(function () { location.reload(); }, 400);
  }
  function reopenAfterReload() {
    var st;
    try { st = JSON.parse(sessionStorage.getItem('spx.reopen') || 'null'); sessionStorage.removeItem('spx.reopen'); } catch (e) { st = null; }
    if (!st || !st.label) return;
    openAppForm(st.amount || '');
    setTimeout(function () {
      var nn = document.querySelector('#sheetRoot input[placeholder="Where or what"]');
      if (nn && st.note) { nn.value = st.note; nn.dispatchEvent(new Event('input', { bubbles: true })); }
      if (st.label) {
        var pick = [].filter.call(document.querySelectorAll('#sheetRoot button.chip'), function (b) { return b.textContent.trim() === st.label; })[0];
        if (pick) pick.click();
      }
    }, 120);
  }

  // ---------- Monthly summary card ----------
  function activeView() {
    var t = document.querySelector('nav.tabs button[aria-selected="true"]');
    return t ? t.getAttribute('data-view') : 'recent';
  }
  function shownMonth() {
    if (activeView() === 'month') {
      var main = document.getElementById('main'), found = null;
      if (main) {
        var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, null), n;
        while ((n = walker.nextNode())) {
          var m = /^\s*(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})\s*$/.exec(n.nodeValue);
          if (m) { found = new Date(Number(m[2]), MONTHS.indexOf(m[1]), 1); break; }
        }
      }
      if (found) return found;
    }
    return new Date();
  }
  var drawing = false;
  function drawSummary() {
    var main = document.getElementById('main');
    if (!main || drawing) return;
    var view = activeView(), old = document.getElementById('spx-summary');
    if (view !== 'recent' && view !== 'month') { if (old) old.remove(); return; }
    drawing = true;
    try {
      var s = summary(shownMonth());
      var card = el('section', { id: 'spx-summary', 'aria-label': 'Money in and out' });
      var h = el('div', { class: 'spx-h' });
      h.append(el('span', {}, s.month), el('span', {}, 'Balance = in − out'));
      var g = el('div', { class: 'spx-g' });
      [['in', 'Money in', s.in, 'spxIn'], ['out', 'Money out', s.out, 'spxOut'], ['bal', 'Balance', s.balance, 'spxBal']].forEach(function (k) {
        var d = el('div', { class: k[0] });
        d.append(el('span', {}, k[1]), el('b', { id: k[3] }, money(k[2])));
        g.appendChild(d);
      });
      var a = el('div', { class: 'spx-a' });
      var add = el('button', { type: 'button', class: 'ghost', id: 'spxAddIn' }, '+ Money in');
      add.style.color = 'var(--good,#2E8B57)';
      add.onclick = function () { openCreditForm(null); };
      var list = el('button', { type: 'button', class: 'ghost', id: 'spxOpenList' }, 'Money in list');
      list.onclick = openList;
      a.append(add, list);
      card.append(h, g, a);
      if (old) old.replaceWith(card); else main.insertBefore(card, main.firstChild);
    } finally { drawing = false; }
  }
  function refresh() { drawSummary(); }

  // ---------- Money in for the app's Excel report ----------
  // The report (Excel button) is built by the app and only knows expenses. Just before it is saved,
  // add a "Summary" sheet (money in, money out, balance) and a "Money in" sheet for the same period.
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDay(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function clock(ts) { return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  // The period picked in the report sheet: this week (from Monday), this month, last month or everything.
  function reportPeriod() {
    var picked = document.querySelector('#sheetRoot .opt[aria-pressed="true"]');
    var k = picked ? picked.getAttribute('data-k') : 'all', now = new Date();
    var label = picked ? (picked.querySelector('span') || picked).textContent.trim() : 'All entries';
    if (k === 'week') {
      var mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
      return { label: label, start: mon.getTime(), end: new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7).getTime() };
    }
    if (k === 'month') { var m = monthRange(now); return { label: label, start: m[0], end: m[1] }; }
    if (k === 'lastmonth') { var l = monthRange(new Date(now.getFullYear(), now.getMonth() - 1, 1)); return { label: label, start: l[0], end: l[1] }; }
    return { label: label, start: -Infinity, end: Infinity };
  }
  function addMoneyIn(XLSX, wb) {
    if (!wb || !wb.SheetNames || wb.__spxMoneyIn || wb.SheetNames.indexOf('Expenses') < 0) return;
    wb.__spxMoneyIn = true;
    var per = reportPeriod();
    var list = credits().filter(function (x) { return Number(x.ts) >= per.start && Number(x.ts) < per.end; })
      .sort(function (a, b) { return a.ts - b.ts; });
    var rows = [['Date', 'Time', 'Day', 'Category', 'Note', 'Amount']];
    list.forEach(function (x) { rows.push([isoDay(x.ts), clock(x.ts), DAY_NAMES[new Date(x.ts).getDay()], creditCat(x.cat).label, x.note || '', round(Number(x.amount))]); });
    if (!list.length) rows.push(['', '', '', 'No money in for this period', '', 0]);
    rows.push([], ['', '', '', '', 'Total', round(list.reduce(function (t, x) { return t + Number(x.amount); }, 0))]);
    var inSheet = XLSX.utils.aoa_to_sheet(rows);
    inSheet['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 6 }, { wch: 16 }, { wch: 28 }, { wch: 12 }];
    var dates = credits().concat(debitEntries()).map(function (x) { return Number(x && x.ts); }).filter(isFinite);
    var start = isFinite(per.start) ? per.start : (dates.length ? Math.min.apply(null, dates) : Date.now());
    var end = isFinite(per.end) ? per.end : Date.now() + 1;
    var i = moneyIn(start, end), o = moneyOut(start, end);
    var sum = XLSX.utils.aoa_to_sheet([
      ['Spenderrr report', per.label],
      ['Period', isoDay(start) + ' to ' + isoDay(end - 1)],
      [],
      ['Money in (credit)', i],
      ['Money out (debit, your share)', o],
      ['Balance', round(i - o)],
      [],
      ['Money in by category', 'Amount']
    ].concat(creditCategories().map(function (c) {
      return [c.label, round(list.filter(function (x) { return creditCat(x.cat).id === c.id; }).reduce(function (t, x) { return t + Number(x.amount); }, 0))];
    }).filter(function (r) { return r[1]; })));
    sum['!cols'] = [{ wch: 30 }, { wch: 24 }];
    var at = wb.SheetNames.indexOf('Expenses') + 1;
    wb.SheetNames.splice(at, 0, 'Money in');
    wb.Sheets['Money in'] = inSheet;
    wb.SheetNames.unshift('Summary');
    wb.Sheets.Summary = sum;
  }
  // The app won't make a report for a period with no expenses. If that period has money in, make it here.
  function moneyInOnlyReport(e) {
    var btn = e.target.closest && e.target.closest('#sheetRoot button');
    if (!btn || btn.textContent.trim() !== 'Download Excel file' || !window.XLSX) return;
    var per = reportPeriod();
    var inRange = function (x) { var ts = Number(x && x.ts); return ts >= per.start && ts < per.end; };
    if (debitEntries().some(inRange) || !credits().some(inRange)) return;    // the app's own report handles it
    e.preventDefault();
    e.stopImmediatePropagation();
    var X = window.XLSX, wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['No expenses in this period']]), 'Expenses');
    try {
      X.writeFile(wb, 'Spend report - ' + per.label + ' - ' + isoDay(Date.now()) + '.xlsx');
      toastMsg('Report downloaded to your Downloads folder');
    } catch (err) { toastMsg('Could not make the report: ' + (err && err.message ? err.message : err)); }
  }
  function toastMsg(text) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = text; t.hidden = false;
    clearTimeout(toastMsg.timer);
    toastMsg.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function hookExcel() {
    var X = window.XLSX;
    if (!X || X.__spxHooked) return;
    X.__spxHooked = true;
    document.addEventListener('click', moneyInOnlyReport, true);
    var root = document.getElementById('sheetRoot');
    if (root) new MutationObserver(function () {
      [].forEach.call(root.querySelectorAll('p'), function (p) {
        if (/^The workbook has /.test(p.textContent) && !p.__spx) {
          p.__spx = true;
          p.textContent = 'A colour-coded Dashboard sheet: money in, money out and balance, where the money went, ' +
            'week-by-week totals, and every entry with date, time, split and money in (with filter buttons). ' +
            'Periods longer than a month add one tab per month with entries, newest first.';
        }
      });
    }).observe(root, { childList: true, subtree: true });
    ['writeFile', 'writeFileXLSX', 'write', 'writeXLSX'].forEach(function (name) {
      var orig = X[name];
      if (typeof orig !== 'function') return;
      X[name] = function (wb) {
        try { addMoneyIn(X, wb); } catch (e) { console.warn('Money in not added to the report', e); }
        return orig.apply(this, arguments);
      };
    });
  }

  // ---------- Start ----------
  function start() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);
    var cats = customCats();
    if (fixColours(cats)) saveCustom(cats);         // e.g. two phones picked the same colour
    var sheetRoot = document.getElementById('sheetRoot');
    if (sheetRoot) new MutationObserver(enhanceAppForm).observe(sheetRoot, { childList: true, subtree: true });
    var main = document.getElementById('main');
    if (main) new MutationObserver(function (list) {
      // Redraw when the app re-renders (not for our own card).
      var ours = list.every(function (m) {
        return [].every.call(m.addedNodes, function (n) { return n.id === 'spx-summary'; }) &&
          [].every.call(m.removedNodes, function (n) { return n.id === 'spx-summary'; });
      });
      if (!ours) drawSummary();
    }).observe(main, { childList: true });
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('nav.tabs')) setTimeout(drawSummary, 0);
    });
    window.addEventListener('storage', drawSummary);
    // The app saves its own entries without telling us: redraw shortly after its saves.
    var set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k) {
      var r = set.apply(this, arguments);
      if (this === window.localStorage && (k === DATA_KEY || k === CREDITS_KEY)) setTimeout(drawSummary, 0);
      return r;
    };
    drawSummary();
    reopenAfterReload();
    hookExcel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.SpenderrrLedger = {
    summary: summary, moneyIn: moneyIn, moneyOut: moneyOut, monthRange: monthRange, credits: credits,
    creditCategories: creditCategories, customCats: customCats, addCategory: addCategory, deleteCategory: deleteCategory,
    openCreditForm: openCreditForm, openList: openList, openManage: openManage, cleanLabel: cleanLabel,
    changeColour: changeColour, colourOwners: colourOwners,
    palette: function () { return PALETTE.map(function (p) { return { color: p[0], name: p[1] }; }); },
    builtInColours: function () { return BUILT_IN_COLORS.map(function (b) { return { label: b[0], color: b[1] }; }); }
  };
})();

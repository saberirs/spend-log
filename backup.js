/*
 * Spenderrr – Auto Backup & Restore  (app version is set in index.html)
 * ----------------------------------------
 * Drop-in script. Add ONE line before </body> in index.html:
 *     <script src="backup.js"></script>
 *
 * What it does
 *  - Backs up ALL of the app's saved data (localStorage) once a day after 6 PM,
 *    plus a "Back up now" button.
 *  - Writes to:  <folder you pick>/spend-expense-backup/October_2026/spend-log-backup.json
 *    The same file is replaced every day; a new month gets a new folder.
 *  - The file also lists expenses by category (app order), each sorted by date and time,
 *    so it can be read directly. Restore uses the "data" section.
 *  - spend-log-backup.xlsx is saved next to it: the same list in Excel, coloured like the app.
 *  - Merge, not replace: each save combines this device with what is already in the backup
 *    (matched by entry id; edits and deletions are kept), so phones and computers sharing
 *    one Google Drive never wipe out each other's entries.
 *  - Saves after every change (Google Drive while signed in, phone folder while allowed),
 *    plus the 6 PM daily backup/reminder for anything still waiting.
 *  - Duplicate files in Google Drive are merged into the newest one; extras go to Drive's trash.
 *  - Restore lists every backup found (each month, with date and record count).
 *  - Safety: never replaces a backup with a much smaller one without asking,
 *    and offers a restore when the app opens with no entries (new phone, reinstall).
 *  - Browsers without folder access (Firefox, iPhone, some older Android Chrome)
 *    fall back to downloading spend-expense-backup_October_2026.json each evening.
 */
(function () {
  'use strict';

  // ---------- Settings ----------
  var BACKUP_HOUR = 18;                         // 6 PM local time
  var ROOT_FOLDER = 'spend-expense-backup';
  var FILE_NAME = 'spend-log-backup.json';
  var META_KEY = '__spendlog_backup_meta';      // excluded from the backup itself
  var SYNC_KEY = '__spendlog_sync_base';        // what each backup file looked like at the last save (excluded too)
  var CONTACTS_KEY = 'spenderrr.contacts';      // WhatsApp numbers (whatsapp.js)
  var CREDITS_KEY = 'spenderrr.credits';        // money in (ledger.js)
  var CATS_KEY = 'spenderrr.categories';        // categories you created (ledger.js)
  var BILLS_KEY = 'spenderrr.bills';            // bill reminders (reminders.js)
  var PAY_KEY = 'spenderrr.paymodes';           // payment mode of each expense (ledger.js)
  // Only these are backed up, merged and restored; anything else in a file is ignored.
  var ALLOWED_KEYS = ['spendlog.v1', CONTACTS_KEY, CREDITS_KEY, CATS_KEY, BILLS_KEY, PAY_KEY];
  var PAY_OUT = [['credit_card', 'Credit card'], ['upi', 'UPI'], ['cash', 'Cash'], ['food_card', 'Food card / Sodexo']];
  var PAY_IN = [['cash', 'Cash'], ['debit', 'Debit card / Account']];
  function payLabel(side, v) { var p = (side === 'in' ? PAY_IN : PAY_OUT).filter(function (x) { return x[0] === v; })[0]; return p ? p[1] : ''; }
  var CHANGE_DELAY = 3000;                      // wait this long after the last change, then back up
  var DB_NAME = 'spendlog-backup';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var supportsFolder = typeof window.showDirectoryPicker === 'function' && window.self === window.top;

  // ---------- Small helpers ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function monthFolder(d) { d = d || new Date(); return MONTHS[d.getMonth()] + '_' + d.getFullYear(); }

  function getMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { return {}; }
  }
  function setMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  // The app keeps everything (entries, split people, splits, messages) in one key.
  var DATA_KEY = 'spendlog.v1';

  // Number of records in a set of saved data: every list inside spendlog.v1 added up.
  function countIn(data) {
    var n = 0;
    try {
      var o = JSON.parse((data && data[DATA_KEY]) || 'null');
      if (o && typeof o === 'object') Object.keys(o).forEach(function (k) { if (Array.isArray(o[k])) n += o[k].length; });
    } catch (e) { /* not counted */ }
    try {
      var c = JSON.parse((data && data[CREDITS_KEY]) || 'null');
      if (c && Array.isArray(c.e)) n += c.e.length;          // money in entries
    } catch (e) { /* not counted */ }
    return n;
  }
  function records(n) { return n + (n === 1 ? ' record' : ' records'); }
  function localRecords() {
    var d = {}; d[DATA_KEY] = localStorage.getItem(DATA_KEY); d[CREDITS_KEY] = localStorage.getItem(CREDITS_KEY);
    return countIn(d);
  }
  var MAX_BACKUP_BYTES = 20 * 1024 * 1024;     // a real backup is far smaller; a giant file would freeze the app
  function parseBackup(text) {
    if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) return null;
    try {
      var b = JSON.parse(text);
      if (!b || typeof b !== 'object' || !b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return null;
      b.deleted = cleanDeleted(b.deleted);
      return b;
    } catch (e) { return null; }
  }

  // Everything the app saved on this device (not this script's own bookkeeping).
  function localData() {
    var data = {};
    ALLOWED_KEYS.forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) data[k] = v; });
    return sanitizeData(data);
  }

  // ---------- Checking data that comes in (restore file, Google Drive, folder) ----------
  // A backup file could be edited or come from somewhere else. Keep only what Spenderrr knows,
  // in the shape it expects, so nothing unexpected is written into the app.
  var BAD_NAMES = ['__proto__', 'constructor', 'prototype'];
  function plainObject(str) {
    try { var o = JSON.parse(str); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; }
  }
  function cleanText(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max); }
  function cleanLabel(s) { return cleanText(s, 60).replace(/[<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24); }
  function validCat(x) { return !!(x && /^c_[a-z0-9_]{1,40}$/.test(x.id) && typeof x.label === 'string' && cleanLabel(x.label) && /^#[0-9A-Fa-f]{6}$/.test(x.color)); }
  function validCredit(x) {
    return !!(x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) && typeof x.cat === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.cat) &&
      isFinite(Number(x.amount)) && Number(x.amount) > 0 && Number(x.amount) <= 1e9 && isFinite(Number(x.ts)));
  }
  // Maps keyed by item ids use no prototype, so ids like "__proto__" or "hasOwnProperty" are plain keys.
  function dict() { return Object.create(null); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function copyDict(o) { var d = dict(); Object.keys(o && typeof o === 'object' ? o : {}).forEach(function (k) { d[k] = o[k]; }); return d; }
  // An id is a short string or number, never a built-in name such as "__proto__" or "toString".
  function okId(v) { return (typeof v === 'string' || (typeof v === 'number' && isFinite(v))) && String(v).length > 0 && String(v).length <= 100 && !(String(v) in Object.prototype); }
  function num(v) { var n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN); return isFinite(n) ? n : null; }
  function textOf(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) : ''; }
  // Anything else in an item: plain text, numbers, true/false and null, a few levels deep, nothing that can carry code.
  function plainValue(v, depth) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') return textOf(v, 1000);
    if (depth >= 5 || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) return v.slice(0, 200).map(function (x) { var c = plainValue(x, depth + 1); return c === undefined ? null : c; });
    var o = {};
    Object.keys(v).slice(0, 50).forEach(function (k) {
      if (k.length > 64 || k in Object.prototype) return;
      var c = plainValue(v[k], depth + 1);
      if (c !== undefined) o[k] = c;
    });
    return o;
  }
  function plainItem(x) { var o = plainValue(x, 0); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; }
  var MAX_ITEMS = 50000;
  // Expenses, payments and people: each field in the shape the app expects; anything broken is left out.
  var CHECK_ITEM = {
    e: function (x) {
      var o = plainItem(x), amt = o && num(o.amount), ts = o && num(o.ts);
      if (!o || !okId(o.id) || amt === null || Math.abs(amt) > 1e9 || ts === null) return null;
      o.amount = amt; o.ts = ts;
      o.cat = typeof o.cat === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.cat) ? o.cat : 'other';
      if (o.note !== undefined) o.note = textOf(o.note, 500);
      if (o.createdAt !== undefined) o.createdAt = num(o.createdAt) === null ? ts : num(o.createdAt);
      if (o.split !== undefined && o.split !== null) {
        var sp = o.split, parts = Array.isArray(sp.parts) ? sp.parts : [];
        if (!sp || typeof sp !== 'object' || typeof sp.paidBy !== 'string') o.split = null;
        else {
          sp.paidBy = textOf(sp.paidBy, 60);
          sp.parts = parts.slice(0, 50).filter(function (pt) { return pt && typeof pt.name === 'string' && pt.name.length <= 60 && !(pt.name in Object.prototype) && num(pt.amt) !== null; })
            .map(function (pt) { return { name: pt.name, amt: num(pt.amt) }; });
          sp.my = num(sp.my) === null ? 0 : num(sp.my);
          if (sp.mode !== undefined) sp.mode = textOf(sp.mode, 20);
        }
      }
      return o;
    },
    s: function (x) {
      var o = plainItem(x);
      if (!o || !okId(o.id) || typeof o.name !== 'string' || o.name.length > 60 || num(o.amt) === null || Math.abs(num(o.amt)) > 1e9 ||
        (o.dir !== 'in' && o.dir !== 'out') || num(o.ts) === null) return null;
      o.amt = num(o.amt); o.ts = num(o.ts);
      return o;
    },
    p: function (x) {
      var o = plainItem(x);
      if (!o || typeof o.name !== 'string' || !o.name.trim() || o.name.length > 60 || o.name in Object.prototype) return null;
      return o;
    },
    m: function (x) { var o = plainItem(x); return o && (o.id === undefined || okId(o.id)) ? o : null; }
  };
  function cleanMain(main) {
    var out = {};
    Object.keys(main).forEach(function (k) {
      if (k in Object.prototype || k.length > 64) return;
      var v = main[k];
      if (Array.isArray(v)) {
        var check = CHECK_ITEM[k] || plainItem;
        out[k] = v.slice(0, MAX_ITEMS).map(check).filter(function (x) { return x; });
      } else {
        var c = plainValue(v, 1);
        if (c !== undefined) out[k] = c;
      }
    });
    return out;
  }
  // Deletion records: { collection: { item key: time } } with real times only.
  function cleanDeleted(d) {
    var out = dict();
    if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
    Object.keys(d).forEach(function (c) {
      var m = d[c];
      if (!m || typeof m !== 'object' || Array.isArray(m) || c.length > 100) return;
      var keep = dict(), n = 0;
      Object.keys(m).forEach(function (k) { var t = num(m[k]); if (t !== null && t > 0 && k.length <= 200 && n++ < MAX_ITEMS) keep[k] = t; });
      if (Object.keys(keep).length) out[c] = keep;
    });
    return out;
  }

  // Bill reminders (reminders.js): only the fields it uses, in the shape it expects.
  var BILL_FREQ = ['monthly', 'bimonthly', 'quarterly', 'yearly'];
  function validBill(x) {
    return !!(x && typeof x === 'object' && typeof x.id === 'string' && /^b_[a-z0-9]{4,40}$/.test(x.id) && typeof x.name === 'string' &&
      (x.day === -1 || (Number.isInteger(x.day) && x.day >= 1 && x.day <= 28)) && BILL_FREQ.indexOf(x.freq) >= 0);
  }
  function cleanBill(x) {
    var amt = num(x.amount), month = num(x.month), remind = num(x.remind), paid = dict();
    if (x.paid && typeof x.paid === 'object' && !Array.isArray(x.paid)) {
      Object.keys(x.paid).slice(-24).forEach(function (k) { var t = num(x.paid[k]); if (/^\d{4}-\d{2}-\d{2}$/.test(k) && t !== null) paid[k] = t; });
    }
    return {
      id: x.id, type: typeof x.type === 'string' && /^[a-z]{1,20}$/.test(x.type) ? x.type : 'other', name: cleanText(x.name, 30) || 'Bill',
      cat: typeof x.cat === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.cat) ? x.cat : 'other', sub: cleanText(x.sub, 20),
      amount: amt !== null && amt >= 0 && amt <= 1e9 ? Math.round(amt * 100) / 100 : null, freq: x.freq, day: x.day,
      month: month !== null && month >= 0 && month <= 11 ? Math.floor(month) : 0, remind: [0, 1, 3, 7].indexOf(remind) >= 0 ? remind : 0,
      paid: paid, createdAt: num(x.createdAt) === null ? 0 : num(x.createdAt)
    };
  }

  function sanitizeData(data) {
    var out = {};
    if (!data || typeof data !== 'object') return out;
    var main = typeof data[DATA_KEY] === 'string' && plainObject(data[DATA_KEY]);
    if (main) out[DATA_KEY] = JSON.stringify(cleanMain(main));
    var cr = typeof data[CREDITS_KEY] === 'string' && plainObject(data[CREDITS_KEY]);
    if (cr) {
      out[CREDITS_KEY] = JSON.stringify({ e: (Array.isArray(cr.e) ? cr.e : []).filter(validCredit).map(function (x) {
        var c = { id: x.id, amount: Math.round(Number(x.amount) * 100) / 100, cat: x.cat, note: cleanText(x.note, 120), ts: Number(x.ts),
          createdAt: isFinite(Number(x.createdAt)) ? Number(x.createdAt) : Number(x.ts) };
        if (payLabel('in', x.pay)) c.pay = x.pay;
        return c;
      }) });
    }
    var pm = typeof data[PAY_KEY] === 'string' && plainObject(data[PAY_KEY]);
    if (pm) {
      out[PAY_KEY] = JSON.stringify({ e: (Array.isArray(pm.e) ? pm.e : []).filter(function (x) {
        return x && okId(x.id) && payLabel('out', x.pay);
      }).slice(0, MAX_ITEMS).map(function (x) { return { id: String(x.id), pay: x.pay }; }) });
    }
    var cats = typeof data[CATS_KEY] === 'string' && plainObject(data[CATS_KEY]);
    if (cats) {
      var clean = function (list) {
        return (Array.isArray(list) ? list : []).filter(validCat).slice(0, 30).map(function (x) { return { id: x.id, label: cleanLabel(x.label), color: x.color }; });
      };
      out[CATS_KEY] = JSON.stringify({ debit: clean(cats.debit), credit: clean(cats.credit) });
    }
    var bl = typeof data[BILLS_KEY] === 'string' && plainObject(data[BILLS_KEY]);
    if (bl) out[BILLS_KEY] = JSON.stringify({ b: (Array.isArray(bl.b) ? bl.b : []).filter(validBill).slice(0, 100).map(cleanBill) });
    var ct = typeof data[CONTACTS_KEY] === 'string' && plainObject(data[CONTACTS_KEY]);
    if (ct) {
      var safe = {};
      Object.keys(ct).forEach(function (name) {
        if (BAD_NAMES.indexOf(name) < 0 && name.length <= 60 && /^\+\d{8,15}$/.test(String(ct[name]))) safe[name] = String(ct[name]);
      });
      out[CONTACTS_KEY] = JSON.stringify(safe);
    }
    return out;
  }

  // ---------- Merge: combine this device with the backup instead of replacing it ----------
  // Lists inside spendlog.v1: e = expenses, s = settle-up payments, p = people, m = checked messages.
  var KEY_FIELD = { e: 'id', s: 'id', m: 'id', p: 'name' };
  var TOMBSTONE_DAYS = 180;          // how long a deletion is remembered, so other devices drop it too
  function parseStore(str) {
    try { var o = JSON.parse(str || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  }
  function itemKey(coll, it) {
    var f = KEY_FIELD[coll] || 'id';
    if (it && typeof it === 'object' && it[f] !== undefined && it[f] !== null && it[f] !== '') return String(it[f]);
    return 'json:' + JSON.stringify(it);
  }
  // Short fingerprint of one item (cyrb53), so the sync record stays small.
  function fp(it) {
    var str = JSON.stringify(it), h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function listOf(store, c) { return Array.isArray(store[c]) ? store[c] : []; }
  function collections(a, b) {
    var out = {};
    [a, b].forEach(function (o) { Object.keys(o).forEach(function (c) { if (Array.isArray(o[c])) out[c] = 1; }); });
    return Object.keys(out);
  }
  function fingerprints(store) {
    var out = dict();
    Object.keys(store).forEach(function (c) {
      if (!Array.isArray(store[c])) return;
      out[c] = dict();
      store[c].forEach(function (it) { out[c][itemKey(c, it)] = fp(it); });
    });
    return out;
  }

  // Three-way merge for one store.
  //   local  = this device, remote = the backup file, base = fingerprints of this device's items
  //   at the last save to that file (tells "deleted here" apart from "new on the other device").
  // Rules: same on both -> keep. Changed on one side only -> take that side.
  // Changed on both -> this device wins. Deleted on a device -> recorded in "deleted" and
  // dropped everywhere, unless it was edited on another device after. Anything missing
  // without a recorded deletion is kept (nothing is ever lost by accident).
  function mergeStores(local, remote, base, deleted, now) {
    now = now || Date.now();
    base = base || {};
    var del = dict();
    Object.keys(deleted || {}).forEach(function (c) { del[c] = copyDict(deleted[c]); });
    var out = {}, newBase = dict();
    Object.keys(remote).forEach(function (k) { if (!Array.isArray(remote[k])) out[k] = remote[k]; });
    Object.keys(local).forEach(function (k) { if (!Array.isArray(local[k])) out[k] = local[k]; });
    collections(local, remote).forEach(function (c) {
      var L = dict(), R = dict(), B = copyDict(base[c]), D = del[c] || (del[c] = dict()), result = [], nb = dict(), seen = dict();
      listOf(local, c).forEach(function (it) { L[itemKey(c, it)] = it; });
      listOf(remote, c).forEach(function (it) { R[itemKey(c, it)] = it; });
      listOf(local, c).forEach(function (it) {
        var k = itemKey(c, it);
        if (seen[k]) return;
        seen[k] = 1;
        var lf = fp(it);
        if (has(R, k)) {
          var rf = fp(R[k]);
          if (rf === lf || B[k] !== lf) result.push(it);   // same, or changed here (this device wins)
          else result.push(R[k]);                           // unchanged here, changed elsewhere
          nb[k] = lf;
          delete D[k];
        } else if (has(D, k)) {
          // Another device recorded deleting it. Keep it only if it was edited here since.
          if (has(B, k) && B[k] !== lf) { result.push(it); nb[k] = lf; delete D[k]; }
        } else {
          // New on this device — or missing from the file without a recorded deletion
          // (e.g. an older app version replaced the file): keep it, never lose it.
          result.push(it); nb[k] = lf;
        }
      });
      listOf(remote, c).forEach(function (it) {
        var k = itemKey(c, it);
        if (seen[k]) return;
        seen[k] = 1;
        if (has(B, k)) { D[k] = now; return; }   // was here at the last save, gone now: deleted here
        if (has(D, k)) return;                     // deleted somewhere else already
        result.push(it);                                     // new from another device
      });
      out[c] = result;
      newBase[c] = nb;
      // Forget old deletions.
      Object.keys(D).forEach(function (k) { if (now - D[k] > TOMBSTONE_DAYS * 86400000) delete D[k]; });
      if (!Object.keys(D).length) delete del[c];
    });
    return { store: out, deleted: del, base: newBase };
  }

  // How many items differ between two stores (added, removed or changed).
  function differences(a, b) {
    var n = 0;
    collections(a, b).forEach(function (c) {
      var A = dict(), B = dict();
      listOf(a, c).forEach(function (it) { A[itemKey(c, it)] = fp(it); });
      listOf(b, c).forEach(function (it) { B[itemKey(c, it)] = fp(it); });
      Object.keys(A).forEach(function (k) { if (A[k] !== B[k]) n++; });
      Object.keys(B).forEach(function (k) { if (!has(A, k)) n++; });
    });
    return n;
  }

  // Stores that are merged item by item. The expenses keep their original names in the
  // sync record and deletion list; the others are prefixed ("spenderrr.credits|e").
  var STORES = [DATA_KEY, CREDITS_KEY, CATS_KEY, BILLS_KEY, PAY_KEY];
  function part(map, key) {
    var out = dict();
    Object.keys(map || {}).forEach(function (n) {
      var i = n.indexOf('|');
      if (key === DATA_KEY ? i < 0 : n.slice(0, i) === key) out[i < 0 ? n : n.slice(i + 1)] = map[n];
    });
    return out;
  }
  function join(into, key, map) {
    Object.keys(map || {}).forEach(function (c) { into[key === DATA_KEY ? c : key + '|' + c] = map[c]; });
  }

  // Merge this device's data with a backup (null when there is no backup file yet).
  function mergeData(local, remote, base) {
    local = sanitizeData(local);
    var rData = sanitizeData((remote && remote.data) || {});
    var data = {}, deleted = dict(), newBase = dict(), updates = 0;
    STORES.forEach(function (key) {
      if (!local[key] && !rData[key]) return;
      var lStore = parseStore(local[key]), rStore = parseStore(rData[key]);
      var m = mergeStores(lStore, rStore, remote ? part(copyDict(base), key) : null, remote ? part(cleanDeleted(remote.deleted), key) : null);
      data[key] = JSON.stringify(m.store);
      join(deleted, key, m.deleted);
      join(newBase, key, m.base);
      updates += differences(lStore, m.store);
    });
    var lc = parseStore(local[CONTACTS_KEY]), rc = parseStore(rData[CONTACTS_KEY]), contacts = {};
    Object.keys(rc).concat(Object.keys(lc)).forEach(function (k) { if (BAD_NAMES.indexOf(k) < 0) contacts[k] = has(lc, k) ? lc[k] : rc[k]; });
    updates += Object.keys(rc).filter(function (k) { return !has(lc, k); }).length;
    if (Object.keys(contacts).length) data[CONTACTS_KEY] = JSON.stringify(contacts);
    return { data: data, deleted: deleted, base: newBase, updates: updates };
  }

  // Several copies of the same backup (duplicates): combine them, newest first wins.
  function combineBackups(list) {
    if (!list.length) return null;
    var acc = { data: Object.assign({}, list[0].data), deleted: cleanDeleted(list[0].deleted), createdAt: list[0].createdAt };
    for (var i = 1; i < list.length; i++) {
      var m = mergeData(acc.data, list[i], {});
      Object.keys(list[i].deleted || {}).forEach(function (c) {
        m.deleted[c] = Object.assign(dict(), cleanDeleted(list[i].deleted)[c], m.deleted[c] || {});
      });
      // drop items that a newer copy deleted
      STORES.forEach(function (key) {
        if (!m.data[key]) return;
        var st = parseStore(m.data[key]), del = part(m.deleted, key);
        Object.keys(del).forEach(function (c) {
          if (Array.isArray(st[c])) st[c] = st[c].filter(function (it) { return !has(del[c], itemKey(c, it)); });
        });
        m.data[key] = JSON.stringify(st);
      });
      acc = { data: m.data, deleted: m.deleted, createdAt: acc.createdAt };
    }
    return acc;
  }

  // Sync record: per backup file ("drive:October_2026", "folder:October_2026").
  function getBases() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; } }
  function baseFor(key) { return getBases()[key] || {}; }
  function setBase(key, b) {
    var all = getBases();
    all[key] = b;
    var keep = [monthFolder(), monthFolder(monthBefore())];
    Object.keys(all).forEach(function (k) { if (keep.indexOf(k.split(':')[1]) < 0) delete all[k]; });
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(all)); } catch (e) { console.warn('Sync record not saved', e); }
  }
  function clearBases() { try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* ignore */ } }

  // ---------- Readable section: expenses grouped by category, sorted by date and time ----------
  // Category ids are what the app saves; labels are what people see.
  // 'transport' is kept as the id so older entries still work; it shows as Travel.
  var CATEGORIES = [
    ['breakfast', 'Breakfast', 'Food'], ['lunch', 'Lunch', 'Food'], ['dinner', 'Dinner', 'Food'], ['snacks', 'Snacks', 'Food'],
    ['grocery', 'Grocery'], ['shopping', 'Shopping'], ['household', 'Household'], ['utilities', 'Utilities'],
    ['transport', 'Travel'], ['emi', 'EMI'], ['insurance', 'Insurance'], ['maid', 'Maid'],
    ['fuel', 'Fuel'], ['lpg', 'LPG'], ['gift', 'Gift'], ['other', 'Other']
  ];
  var CREDIT_CATEGORIES = [['salary', 'Salary', '2E7D32'], ['interest', 'Interest', '00897B'], ['refund', 'Refund', '5C6BC0'],
    ['gift_in', 'Gift', 'D81B60'], ['other_in', 'Other income', '6D4C41']];
  // Categories you created, from the data being saved: { id: {label, color} }
  var yours = {};
  function loadYours(data) {
    yours = {};
    var c = parseStore(data && data[CATS_KEY]);
    ['debit', 'credit'].forEach(function (side) {
      (Array.isArray(c[side]) ? c[side] : []).forEach(function (x) { if (validCat(x)) yours[x.id] = { label: cleanLabel(x.label), color: x.color.slice(1).toUpperCase(), side: side }; });
    });
  }
  function categoryLabel(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i][0] === id) return CATEGORIES[i][1];
    for (var j = 0; j < CREDIT_CATEGORIES.length; j++) if (CREDIT_CATEGORIES[j][0] === id) return CREDIT_CATEGORIES[j][1];
    if (yours[id]) return yours[id].label;
    var s = String(id || 'other');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  // The currency picked in the app's settings. INR uses India's financial year (April to March);
  // USD and EUR use the calendar year (January to December).
  var CUR_KEY = 'spendlog.currency';
  function currencyInfo() {
    var c = ''; try { c = localStorage.getItem(CUR_KEY) || ''; } catch (e) { /* ignore */ }
    if (c === 'INR') return { code: 'INR', sym: '₹', loc: 'en-IN', fyStart: 3 };
    if (c === 'EUR') return { code: 'EUR', sym: '€', loc: 'en-IE', fyStart: 0 };
    return { code: 'USD', sym: '$', loc: 'en-US', fyStart: 0 };
  }
  // Amount as text with the currency sign: ₹1,25,000.00 / $1,250.00 / €1,250.00
  function cur(n) {
    var c = currencyInfo(), v = Math.abs(money(n));
    return (n < 0 ? '-' : '') + c.sym + v.toLocaleString(c.loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Excel number format for amounts, with the currency sign (negative amounts in red when asked).
  function moneyFormat(red) {
    var s = '&quot;' + currencyInfo().sym + '&quot;#,##0.00';
    return red ? s + ';[Red]-' + s : s;
  }
  function localDate(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function localTime(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function byCategory(data) {
    loadYours(data);
    var o;
    try { o = JSON.parse((data && data[DATA_KEY]) || 'null'); } catch (e) { o = null; }
    var entries = (o && Array.isArray(o.e)) ? o.e : [];
    var groups = {};
    entries.forEach(function (x) {
      var id = x && x.cat ? String(x.cat) : 'other';
      (groups[id] = groups[id] || []).push(x);
    });
    // Category order matches the app; any other ids follow, A to Z.
    var order = CATEGORIES.map(function (c) { return c[0]; });
    var extra = Object.keys(groups).filter(function (id) { return order.indexOf(id) < 0; })
      .sort(function (a, b) { return categoryLabel(a).localeCompare(categoryLabel(b)); });
    return order.concat(extra).filter(function (id) { return groups[id]; }).map(function (id) {
      var list = groups[id].slice().sort(function (a, b) {
        return (Number(a.ts) || 0) - (Number(b.ts) || 0) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      });
      var total = 0;
      var rows = list.map(function (x) {
        total += Number(x.amount) || 0;
        var row = { date: localDate(x.ts), time: localTime(x.ts), amount: money(x.amount) };
        if (x.sub) row.sub = x.sub;
        if (x.note) row.note = x.note;
        if (x.split) row.split = true;
        return row;
      });
      var cat = CATEGORIES.filter(function (c) { return c[0] === id; })[0];
      var out = { category: categoryLabel(id) };
      if (cat && cat[2]) out.group = cat[2];
      out.count = rows.length;
      out.total = money(total);
      out.entries = rows;
      return out;
    });
  }

  // Money in, grouped by category, sorted by date and time.
  function creditList(data) { var c = parseStore(data && data[CREDITS_KEY]); return Array.isArray(c.e) ? c.e.filter(validCredit) : []; }
  function creditOrder(data) {
    loadYours(data);
    var list = creditList(data), ids = CREDIT_CATEGORIES.map(function (c) { return c[0]; });
    var extra = list.map(function (x) { return x.cat; })
      .filter(function (id, i, a) { return ids.indexOf(id) < 0 && a.indexOf(id) === i; })
      .sort(function (a, b) { return categoryLabel(a).localeCompare(categoryLabel(b)); });
    return ids.concat(extra).filter(function (id) { return list.some(function (x) { return x.cat === id; }); });
  }
  function byCredit(data) {
    var list = creditList(data);
    return creditOrder(data).map(function (id) {
      var rows = list.filter(function (x) { return x.cat === id; }).sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); });
      var total = 0;
      return {
        category: categoryLabel(id), count: rows.length,
        total: money(rows.reduce(function (t, x) { return t + Number(x.amount); }, 0)),
        entries: rows.map(function (x) {
          total += Number(x.amount);
          var r = { date: localDate(x.ts), time: localTime(x.ts), amount: money(x.amount) };
          if (x.note) r.note = x.note;
          return r;
        })
      };
    });
  }
  // Money out counts your share of split bills, like the app's totals.
  function outTotal(data) {
    var o = parseStore(data && data[DATA_KEY]);
    return money((Array.isArray(o.e) ? o.e : []).reduce(function (t, x) {
      var v = x && x.split && x.split.my !== undefined && x.split.my !== null ? Number(x.split.my) : Number(x && x.amount);
      return t + (isFinite(v) ? v : 0);
    }, 0));
  }
  function totals(data) {
    var i = money(creditList(data).reduce(function (t, x) { return t + Number(x.amount); }, 0)), o = outTotal(data);
    return { moneyIn: i, moneyOut: o, balance: money(i - o) };
  }

  function snapshot(data, deleted) {
    data = data || localData();
    return {
      app: 'Spenderrr',
      format: 2,
      createdAt: new Date().toISOString(),
      origin: location.origin,
      keys: Object.keys(data).length,
      records: countIn(data),
      totals: totals(data),           // all time: money in, money out (your share), balance
      byCategory: byCategory(data),   // money out, for reading only
      moneyIn: byCredit(data),        // money in, for reading only
      deleted: deleted || {},         // recent deletions, so other devices drop them too
      data: data                      // what Restore uses
    };
  }

  // Backup text: readable, with each expense on its own line.
  function backupText(data, deleted) {
    var snap = snapshot(data, deleted), rows = [];
    var text = JSON.stringify(snap, function (key, value) {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'date' in value && 'amount' in value && 'time' in value) {
        rows.push(JSON.stringify(value));
        return '__ROW_' + (rows.length - 1) + '__';
      }
      return value;
    }, 2);
    return text.replace(/"__ROW_(\d+)__"/g, function (m, i) { return rows[Number(i)]; });
  }

  // ---------- Excel copy of the backup, coloured like the app ----------
  // spend-log-backup.xlsx sits next to the .json file. It is for viewing; Restore uses the .json.
  var EXCEL_NAME = 'spend-log-backup.xlsx';
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  // Same colours as the app (light theme). Keys are the saved category ids.
  var CATEGORY_COLORS = {
    breakfast: 'D99A12', lunch: 'E26C24', dinner: 'C2412D', snacks: 'D2588A', grocery: '2F9152',
    shopping: '7552D3', household: '957446', utilities: '2A78CC', transport: '16969A', other: '7A8391',
    emi: '3F51B5', insurance: '8E44AD', maid: '5D8C1F', fuel: '9C6B00', lpg: '0073E6', gift: 'BA68C8'
  };
  var EXTRA_COLOR = '7A8391';
  function tint(hex, keep) {               // mix with white; keep = share of the colour (0..1)
    return [0, 2, 4].map(function (i) {
      var c = parseInt(hex.substr(i, 2), 16);
      var v = Math.round(255 - (255 - c) * keep);
      return (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
    }).join('');
  }
  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  // Excel stores dates as days since 30 Dec 1899; this keeps the phone's local date and time.
  function excelDate(ts) {
    var d = new Date(ts);
    return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000;
  }
  function excelTime(ts) { var d = new Date(ts); return (d.getHours() * 60 + d.getMinutes()) / 1440; }

  function excelWorkbook(data) {
    var o;
    try { o = JSON.parse((data && data[DATA_KEY]) || 'null'); } catch (e) { o = null; }
    var entries = (o && Array.isArray(o.e)) ? o.e : [];
    var groups = byCategory(data);
    // Same grouping and order as the readable JSON section, with the raw times kept for Excel.
    var idsInOrder = CATEGORIES.map(function (c) { return c[0]; });
    var extraIds = entries.map(function (x) { return x && x.cat ? String(x.cat) : 'other'; })
      .filter(function (id, i, a) { return idsInOrder.indexOf(id) < 0 && a.indexOf(id) === i; })
      .sort(function (a, b) { return categoryLabel(a).localeCompare(categoryLabel(b)); });
    var ids = idsInOrder.concat(extraIds).filter(function (id) {
      return entries.some(function (x) { return (x && x.cat ? String(x.cat) : 'other') === id; });
    });

    // Styles: one set per category (header band, light row, amount, date, time).
    var fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    function fill(hex) { fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + hex + '"/><bgColor indexed="64"/></patternFill></fill>'); return fills.length - 1; }
    var xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    function xf(fontId, fillId, numFmt, extra) {
      xfs.push('<xf numFmtId="' + (numFmt || 0) + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + (extra && extra.border ? 1 : 0) +
        '" xfId="0" applyFont="1" applyFill="1"' + (numFmt ? ' applyNumberFormat="1"' : '') + (extra && extra.border ? ' applyBorder="1"' : '') +
        (extra && (extra.align || extra.indent) ? ' applyAlignment="1"><alignment' + (extra.align ? ' horizontal="' + extra.align + '"' : '') +
          (extra.indent ? (extra.align ? '' : ' horizontal="left"') + ' indent="' + extra.indent + '"' : '') + ' vertical="center"/></xf>' : '/>'));
      return xfs.length - 1;
    }
    var titleFill = fill('22356E');
    var S = {
      title: xf(3, 0), sub: xf(4, 0), head: xf(2, titleFill), headRight: xf(2, titleFill, 0, { align: 'right' }),
      plain: xf(0, 0), money: xf(0, 0, 164, { align: 'right' }), bold: xf(1, 0), boldMoney: xf(1, 0, 164, { align: 'right' }),
      headIndent: xf(2, titleFill, 0, { indent: 1 }), boldCenter: xf(1, 0, 0, { align: 'center' })
    };
    var catStyle = {};
    function colorOf(id) {
      if (CATEGORY_COLORS[id]) return CATEGORY_COLORS[id];
      for (var k = 0; k < CREDIT_CATEGORIES.length; k++) if (CREDIT_CATEGORIES[k][0] === id) return CREDIT_CATEGORIES[k][2];
      return yours[id] ? yours[id].color : EXTRA_COLOR;
    }
    var creditIds = creditOrder(data), credits = creditList(data);
    ids.concat(creditIds).forEach(function (id) {
      if (catStyle[id]) return;
      var color = colorOf(id);
      var strong = fill(color), light = fill(tint(color, 0.16)), dot = fill(color);
      catStyle[id] = {
        color: color,
        band: xf(2, strong, 0, { indent: 1 }), bandMoney: xf(2, strong, 164, { align: 'right' }),
        swatch: xf(0, dot), text: xf(0, light, 0, { border: 1, indent: 1 }), money: xf(0, light, 164, { border: 1, align: 'right' }),
        date: xf(0, light, 165, { border: 1, indent: 1 }), time: xf(0, light, 166, { border: 1, align: 'right' }),
        sumName: xf(1, light, 0, { border: 1, indent: 1 }), sumMoney: xf(1, light, 164, { border: 1, align: 'right' }),
        sumCount: xf(0, light, 0, { border: 1, align: 'center' })
      };
    });

    function cell(r, c, v, s) {
      var ref = colName(c) + r;
      if (v === null || v === undefined || v === '') return '<c r="' + ref + '" s="' + s + '"/>';
      if (typeof v === 'number') return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
      return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    }
    function sheet(rows, cols, opts) {
      var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
      x += '<sheetViews><sheetView workbookViewId="0" showGridLines="0">' +
        (opts.freeze ? '<pane ySplit="' + opts.freeze + '" topLeftCell="A' + (opts.freeze + 1) + '" activePane="bottomLeft" state="frozen"/>' : '') +
        '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>';
      cols.forEach(function (w, i) { x += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; });
      x += '</cols><sheetData>';
      rows.forEach(function (r, i) {
        x += '<row r="' + (i + 1) + '"' + (r.height ? ' ht="' + r.height + '" customHeight="1"' : '') + '>' +
          r.cells.map(function (c, j) { return c ? cell(i + 1, j, c[0], c[1]) : ''; }).join('') + '</row>';
      });
      x += '</sheetData>';
      if (opts.merges && opts.merges.length) {
        x += '<mergeCells count="' + opts.merges.length + '">' + opts.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';
      }
      return x + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
        '<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>';
    }

    // Sheet 1: By category — a coloured band per category, its expenses sorted by date and time.
    var created = new Date();
    var rows1 = [
      { height: 26, cells: [['Spenderrr backup', S.title]] },
      { cells: [['Saved ' + localDate(created.getTime()) + ' ' + localTime(created.getTime()) + ' · ' + entries.length + ' expenses · Restore uses ' + FILE_NAME, S.sub]] },
      { cells: [] },
      { height: 20, cells: [['', S.head], ['Date', S.headIndent], ['Time', S.headRight], ['Category', S.headIndent], ['Amount', S.headRight], ['Note', S.headIndent]] }
    ];
    var merges = ['A1:F1', 'A2:F2'];
    var grand = 0;
    ids.forEach(function (id) {
      var st = catStyle[id];
      var list = entries.filter(function (x) { return (x && x.cat ? String(x.cat) : 'other') === id; }).sort(function (a, b) {
        return (Number(a.ts) || 0) - (Number(b.ts) || 0) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      });
      var total = 0;
      list.forEach(function (x) { total += Number(x.amount) || 0; });
      grand += total;
      rows1.push({ height: 22, cells: [['', st.band], [categoryLabel(id) + '  ·  ' + list.length + (list.length === 1 ? ' expense' : ' expenses'), st.band],
        ['', st.band], ['', st.band], [money(total), st.bandMoney], ['', st.band]] });
      merges.push('B' + rows1.length + ':D' + rows1.length);
      list.forEach(function (x) {
        var note = [x.sub, x.note].filter(Boolean).join(' · ') + (x.split ? (x.note || x.sub ? ' · ' : '') + 'split' : '');
        rows1.push({ cells: [['', st.swatch], [excelDate(x.ts), st.date], [excelTime(x.ts), st.time], [categoryLabel(id), st.text],
          [money(x.amount), st.money], [note, st.text]] });
      });
      rows1.push({ cells: [] });
    });
    if (!ids.length) rows1.push({ cells: [null, ['No expenses yet', S.plain]] });
    else rows1.push({ cells: [null, null, null, ['Total', S.bold], [money(grand), S.boldMoney]] });
    var sheet1 = sheet(rows1, [2.5, 19, 11, 15, 13, 42], { freeze: 4, merges: merges });

    // Sheet 2: Summary — one coloured line per category.
    var rows2 = [
      { height: 26, cells: [['Summary by category', S.title]] },
      { cells: [] },
      { height: 20, cells: [['', S.head], ['Category', S.headIndent], ['Expenses', S.headRight], ['Total', S.headRight]] }
    ];
    groups.forEach(function (g, i) {
      var st = catStyle[ids[i]];
      rows2.push({ cells: [['', st.swatch], [g.category, st.sumName], [g.count, st.sumCount], [g.total, st.sumMoney]] });
    });
    rows2.push({ cells: [null, ['Total money out', S.bold], [entries.length, S.boldCenter], [money(grand), S.boldMoney]] });
    var t = totals(data);
    rows2.push({ cells: [] });
    rows2.push({ height: 20, cells: [['', S.head], ['Money in and out', S.headIndent], ['', S.head], ['Amount', S.headRight]] });
    rows2.push({ cells: [null, ['Money in', S.plain], [credits.length, S.boldCenter], [t.moneyIn, S.money]] });
    rows2.push({ cells: [null, ['Money out (your share)', S.plain], null, [t.moneyOut, S.money]] });
    rows2.push({ cells: [null, ['Balance', S.bold], null, [t.balance, S.boldMoney]] });
    var sheet2 = sheet(rows2, [2.5, 22, 11, 14], { merges: ['A1:D1'] });

    // Sheet 3: Money in — same layout as "By category".
    var rows3 = [
      { height: 26, cells: [['Money in', S.title]] },
      { cells: [['Salary, interest, refunds and other money received', S.sub]] },
      { cells: [] },
      { height: 20, cells: [['', S.head], ['Date', S.headIndent], ['Time', S.headRight], ['Category', S.headIndent], ['Amount', S.headRight], ['Note', S.headIndent]] }
    ];
    var merges3 = ['A1:F1', 'A2:F2'], grandIn = 0;
    creditIds.forEach(function (id) {
      var st = catStyle[id];
      var list = credits.filter(function (x) { return x.cat === id; }).sort(function (a, b) { return a.ts - b.ts || (a.createdAt || 0) - (b.createdAt || 0); });
      var total = list.reduce(function (tt, x) { return tt + Number(x.amount); }, 0);
      grandIn += total;
      rows3.push({ height: 22, cells: [['', st.band], [categoryLabel(id) + '  ·  ' + list.length + (list.length === 1 ? ' entry' : ' entries'), st.band],
        ['', st.band], ['', st.band], [money(total), st.bandMoney], ['', st.band]] });
      merges3.push('B' + rows3.length + ':D' + rows3.length);
      list.forEach(function (x) {
        rows3.push({ cells: [['', st.swatch], [excelDate(x.ts), st.date], [excelTime(x.ts), st.time], [categoryLabel(id), st.text],
          [money(x.amount), st.money], [x.note || '', st.text]] });
      });
      rows3.push({ cells: [] });
    });
    if (!creditIds.length) rows3.push({ cells: [null, ['No money in yet', S.plain]] });
    else rows3.push({ cells: [null, null, null, ['Total', S.bold], [money(grandIn), S.boldMoney]] });
    var sheet3 = sheet(rows3, [2.5, 19, 11, 15, 13, 42], { freeze: 4, merges: merges3 });

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="' + moneyFormat(false) + '"/>' +
      '<numFmt numFmtId="165" formatCode="ddd d mmm yyyy"/><numFmt numFmtId="166" formatCode="h:mm AM/PM"/></numFmts>' +
      '<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="16"/><color rgb="FF22356E"/><name val="Calibri"/></font>' +
      '<font><sz val="10"/><color rgb="FF5B6678"/><name val="Calibri"/></font></fonts>' +
      '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFFFFFFF"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    return [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="By category" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Money in" sheetId="3" r:id="rId3"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', styles],
      ['xl/worksheets/sheet1.xml', sheet1],
      ['xl/worksheets/sheet2.xml', sheet2],
      ['xl/worksheets/sheet3.xml', sheet3]
    ];
  }

  // Minimal ZIP writer (files stored, not compressed) — an .xlsx file is a ZIP of XML files.
  var CRC_TABLE = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { var c = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    var d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach(function (f) {
      var name = enc.encode(f[0]), body = enc.encode(f[1]), crc = crc32(body);
      var common = [].concat(u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(body.length), u32(body.length), u16(name.length), u16(0));
      var local = new Uint8Array([].concat([0x50, 0x4B, 0x03, 0x04], common));
      parts.push(local, name, body);
      central.push(new Uint8Array([].concat([0x50, 0x4B, 0x01, 0x02], u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + body.length;
    });
    var size = central.reduce(function (s, p) { return s + p.length; }, 0);
    var end = new Uint8Array([].concat([0x50, 0x4B, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length), u32(size), u32(offset), u16(0)));
    return new Blob(parts.concat(central, [end]), { type: XLSX_MIME });
  }
  function excelBlob(data) { return zip(excelWorkbook(data || localData())); }

  // ---------- Excel report (the Excel button) ----------
  // A colour-coded "Dashboard" sheet in Times New Roman: money in, money out and balance, totals by
  // category, then every expense and money-in entry by date and time, with split details and money in
  // side by side, and week-by-week totals. Periods match the app: weeks start on Monday.
  // When the period covers more than one month, each month that has entries gets its own tab after
  // the Dashboard, newest month first (a month with no entries gets no tab).
  var REPORT_FONT = 'Times New Roman';
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function shortMonth(d) { return MONTH_NAMES[d.getMonth()].slice(0, 3); }
  // "2026-10-05" -> local midnight of that day (null when it isn't a real date)
  function dayFromText(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
  }
  // Financial year that contains a date: INR April–March ("2026-27"), USD/EUR January–December ("2026").
  function fyStartYear(now, c) { return now.getMonth() >= c.fyStart ? now.getFullYear() : now.getFullYear() - 1; }
  function fyName(y, c) { return c.fyStart ? y + '-' + String(y + 1).slice(2) : String(y); }
  // Every period the report offers. opts.from / opts.to ("YYYY-MM-DD", both days included) for custom.
  var REPORT_KEYS = ['week', 'month', 'lastmonth', 'last3', 'last6', 'fy', 'lastfy', 'all', 'custom'];
  function reportPeriod(k, now, opts) {
    now = now || new Date();
    var y = now.getFullYear(), m = now.getMonth(), c = currencyInfo();
    if (k === 'week') {
      var mon = new Date(y, m, now.getDate() - ((now.getDay() + 6) % 7));
      return { start: mon.getTime(), end: new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7).getTime() };
    }
    if (k === 'month') return { start: new Date(y, m, 1).getTime(), end: new Date(y, m + 1, 1).getTime() };
    if (k === 'lastmonth') return { start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime() };
    // Last 3 / 6 months: this month and the months just before it.
    if (k === 'last3') return { start: new Date(y, m - 2, 1).getTime(), end: new Date(y, m + 1, 1).getTime() };
    if (k === 'last6') return { start: new Date(y, m - 5, 1).getTime(), end: new Date(y, m + 1, 1).getTime() };
    if (k === 'fy' || k === 'lastfy') {
      var fy = fyStartYear(now, c) - (k === 'lastfy' ? 1 : 0);
      return { start: new Date(fy, c.fyStart, 1).getTime(), end: new Date(fy + 1, c.fyStart, 1).getTime(), fy: fy };
    }
    if (k === 'custom') {
      var a = dayFromText(opts && opts.from), b = dayFromText(opts && opts.to);
      if (!a || !b || a > b) return null;
      return { start: a.getTime(), end: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).getTime() };
    }
    return { start: -Infinity, end: Infinity };
  }
  // What the picker shows for each period, and the name used in the file name.
  function periodLabel(k, now, opts) {
    now = now || new Date();
    var c = currencyInfo(), fy = fyStartYear(now, c);
    switch (k) {
      case 'week': return 'This week';
      case 'month': return 'This month';
      case 'lastmonth': return 'Last month';
      case 'last3': return 'Last 3 months';
      case 'last6': return 'Last 6 months';
      case 'fy': return c.fyStart ? 'Financial year ' + fyName(fy, c) : 'Year ' + fyName(fy, c);
      case 'lastfy': return c.fyStart ? 'Last financial year ' + fyName(fy - 1, c) : 'Last year ' + fyName(fy - 1, c);
      case 'custom': return opts && opts.from && opts.to ? opts.from + ' to ' + opts.to : 'Custom dates';
      default: return 'All entries';
    }
  }
  // Short range under each choice: "Aug – Oct 2026", "Apr 2026 – Mar 2027", "1 – 7 Sep 2026".
  function rangeText(per) {
    if (!per || !isFinite(per.start) || !isFinite(per.end)) return '';
    var a = new Date(per.start), b = new Date(per.end - 1);
    var whole = a.getDate() === 1 && new Date(per.end).getDate() === 1;
    if (whole) {
      if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return MONTH_NAMES[a.getMonth()] + ' ' + a.getFullYear();
      return a.getFullYear() === b.getFullYear() ? shortMonth(a) + ' – ' + shortMonth(b) + ' ' + b.getFullYear()
        : shortMonth(a) + ' ' + a.getFullYear() + ' – ' + shortMonth(b) + ' ' + b.getFullYear();
    }
    if (a.getFullYear() === b.getFullYear()) {
      return a.getMonth() === b.getMonth() && a.getDate() === b.getDate() ? a.getDate() + ' ' + shortMonth(a) + ' ' + a.getFullYear()
        : a.getDate() + ' ' + (a.getMonth() === b.getMonth() ? '' : shortMonth(a) + ' ') + '– ' + b.getDate() + ' ' + shortMonth(b) + ' ' + b.getFullYear();
    }
    return a.getDate() + ' ' + shortMonth(a) + ' ' + a.getFullYear() + ' – ' + b.getDate() + ' ' + shortMonth(b) + ' ' + b.getFullYear();
  }
  function shareOf(x) {
    var v = x && x.split && x.split.my !== undefined && x.split.my !== null ? Number(x.split.my) : Number(x && x.amount);
    return isFinite(v) ? v : 0;
  }
  function splitText(x) {
    var sp = x && x.split;
    if (!sp || !Array.isArray(sp.parts)) return '';
    var shares = sp.parts.filter(function (pt) { return pt && pt.name; })
      .map(function (pt) { return (pt.name === 'Me' ? 'You' : pt.name) + ' ' + cur(pt.amt); });
    return 'Bill ' + cur(x.amount) + ' paid by ' + (sp.paidBy === 'Me' ? 'you' : String(sp.paidBy)) +
      (shares.length ? ' · ' + shares.join(', ') : '');
  }
  // Expenses and money in from a set of saved data (all dates).
  function reportEntries(data) {
    var store = parseStore(data[DATA_KEY]);
    return {
      outs: (Array.isArray(store.e) ? store.e : []).filter(function (x) { return x && isFinite(Number(x.ts)); }),
      ins: creditList(data).filter(function (x) { return isFinite(Number(x.ts)); })
    };
  }
  // Months (first-of-month times) that have at least one expense or money-in entry in the period, newest first.
  function monthsWithEntries(list, per) {
    var seen = {};
    list.forEach(function (x) {
      var ts = Number(x.ts);
      if (ts < per.start || ts >= per.end) return;
      var d = new Date(ts);
      seen[new Date(d.getFullYear(), d.getMonth(), 1).getTime()] = 1;
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
  }
  // Does the period reach into more than one calendar month? (Weeks never get month tabs.)
  function coversSeveralMonths(k, per, list) {
    if (k === 'week' || k === 'month' || k === 'lastmonth') return false;
    var a = per.start, b = per.end - 1;
    if (!isFinite(a) || !isFinite(b)) {          // all entries: from the first to the last entry
      var times = list.map(function (x) { return Number(x.ts); });
      if (!times.length) return false;
      a = Math.min.apply(null, times); b = Math.max.apply(null, times);
    }
    var da = new Date(a), db = new Date(b);
    return da.getFullYear() !== db.getFullYear() || da.getMonth() !== db.getMonth();
  }

  // "Dashboard" design: four cards on top, where the money went (coloured bars) beside money in and
  // week-by-week totals, then every entry by date and time with filter buttons on its header.
  // k: period key, label: shown top right, opts: {from, to} for custom dates.
  function reportWorkbook(data, k, label, now, opts) {
    now = now || new Date();
    data = data || localData();
    loadYours(data);
    var per = reportPeriod(k, now, opts);
    if (!per) throw new Error('Pick a From date on or before the To date');
    var everything = reportEntries(data);
    var payOf = {};          // expense id -> payment mode
    (parseStore(data[PAY_KEY]).e || []).forEach(function (x) { if (x && payLabel('out', x.pay)) payOf[String(x.id)] = x.pay; });
    function payText(x, side) { return side === 'in' ? payLabel('in', x.pay) : payLabel('out', payOf[String(x.id)]); }

    function colorOf(id, side) {
      if (side === 'in') {
        for (var c = 0; c < CREDIT_CATEGORIES.length; c++) if (CREDIT_CATEGORIES[c][0] === id) return CREDIT_CATEGORIES[c][2];
      } else if (CATEGORY_COLORS[id]) return CATEGORY_COLORS[id];
      return yours[id] ? yours[id].color : EXTRA_COLOR;
    }
    function labelOf(id, side) {
      if (side === 'in') for (var c = 0; c < CREDIT_CATEGORIES.length; c++) if (CREDIT_CATEGORIES[c][0] === id) return CREDIT_CATEGORIES[c][1];
      return categoryLabel(id);
    }
    function catId(x, side) { return String((x && x.cat) || (side === 'in' ? 'other_in' : 'other')); }

    // ---- Style registry (fonts, fills, borders, cell formats), all Times New Roman, shared by every tab ----
    var fonts = [], fontIds = {}, fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'],
      fillIds = {}, borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], borderIds = {}, xfs = [], xfIds = {};
    function font(f) {        // f: {b, i, color, size}
      var key = [f.b, f.i, f.color, f.size].join('|');
      if (fontIds[key] !== undefined) return fontIds[key];
      fonts.push('<font>' + (f.b ? '<b/>' : '') + (f.i ? '<i/>' : '') + '<sz val="' + (f.size || 11) + '"/><color rgb="FF' + (f.color || '162033') +
        '"/><name val="' + REPORT_FONT + '"/><family val="1"/></font>');
      return (fontIds[key] = fonts.length - 1);
    }
    function fillOf(hex) {
      if (!hex) return 0;
      if (fillIds[hex]) return fillIds[hex];
      fills.push('<fill><patternFill patternType="solid"><fgColor rgb="FF' + hex + '"/><bgColor indexed="64"/></patternFill></fill>');
      return (fillIds[hex] = fills.length - 1);
    }
    function borderOf(b) {    // b: {top:[style,hex], bottom, left, right}
      if (!b) return 0;
      var key = JSON.stringify(b);
      if (borderIds[key]) return borderIds[key];
      var side = function (n) { return b[n] ? '<' + n + ' style="' + b[n][0] + '"><color rgb="FF' + b[n][1] + '"/></' + n + '>' : '<' + n + '/>'; };
      borders.push('<border>' + side('left') + side('right') + side('top') + side('bottom') + '<diagonal/></border>');
      return (borderIds[key] = borders.length - 1);
    }
    font({});      // font 0 = normal
    function st(o) {          // o: {font:{…}, fill, fmt, align, border, wrap}
      o = o || {};
      var key = JSON.stringify(o);
      if (xfIds[key] !== undefined) return xfIds[key];
      xfs.push('<xf numFmtId="' + (o.fmt || 0) + '" fontId="' + font(o.font || {}) + '" fillId="' + fillOf(o.fill) + '" borderId="' + borderOf(o.border) +
        '" xfId="0" applyFont="1" applyFill="1" applyBorder="1"' + (o.fmt ? ' applyNumberFormat="1"' : '') + ' applyAlignment="1">' +
        '<alignment horizontal="' + (o.align || 'left') + '" vertical="center"' + (o.align !== 'center' && !o.flush ? ' indent="1"' : '') +
        (o.wrap ? ' wrapText="1"' : '') + '/></xf>');
      return (xfIds[key] = xfs.length - 1);
    }
    st({});      // xf 0 = default
    var NAVY = '22356E', GREEN = '2E7D32', RED = 'C2412D', GREY = '5B6678', LINE = 'DCE1E9', ROWLINE = 'E6E9EE', INK = '162033';
    var MONEY = 164, DATETIME = 165, SHORTDATE = 168;
    function runXml(runs) {
      return runs.map(function (u) {
        return '<r><rPr>' + (u[1].b ? '<b/>' : '') + '<sz val="' + (u[1].size || 11) + '"/><color rgb="FF' + (u[1].color || INK) + '"/><rFont val="' + REPORT_FONT +
          '"/><family val="1"/></rPr><t xml:space="preserve">' + xmlEsc(u[0]) + '</t></r>';
      }).join('');
    }
    function cell(r2, c, v, sx) {
      var ref = colName(c) + r2;
      if (v === null || v === undefined || v === '') return '<c r="' + ref + '" s="' + sx + '"/>';
      if (typeof v === 'number') return '<c r="' + ref + '" s="' + sx + '"><v>' + (isFinite(v) ? v : 0) + '</v></c>';
      if (v && v.runs) return '<c r="' + ref + '" s="' + sx + '" t="inlineStr"><is>' + runXml(v.runs) + '</is></c>';
      return '<c r="' + ref + '" s="' + sx + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    }

    // One Dashboard-style sheet for the entries between p.start and p.end.
    function buildSheet(p, heading, tabLabel) {
      var inPeriod = function (x) { var ts = Number(x && x.ts); return ts >= p.start && ts < p.end; };
      var outs = everything.outs.filter(inPeriod), ins = everything.ins.filter(inPeriod);
      var all = outs.map(function (x) { return { side: 'out', x: x }; }).concat(ins.map(function (x) { return { side: 'in', x: x }; }))
        .sort(function (a, b) { return (Number(a.x.ts) - Number(b.x.ts)) || ((Number(a.x.createdAt) || 0) - (Number(b.x.createdAt) || 0)); });
      var times = all.map(function (r) { return Number(r.x.ts); });
      var from = isFinite(p.start) ? p.start : (times.length ? Math.min.apply(null, times) : now.getTime());
      var to = isFinite(p.end) ? p.end - 1 : (times.length ? Math.max.apply(null, times) : now.getTime());

      var rows = [], merges = [];
      function row(cells, height) { rows.push({ cells: cells, height: height }); return rows.length; }
      function mergeRow(a, b, r) { merges.push(a + r + ':' + b + r); }
      var BLANK = null;

      // Title
      // The label goes in F, the first cell of the F–H merge (a value in G or H would be hidden by Excel).
      var r = row([BLANK, [heading, st({ font: { b: 1, color: NAVY, size: 22 } })], BLANK, BLANK, BLANK,
        ['Spenderrr · ' + tabLabel, st({ font: { i: 1, color: GREY, size: 11 }, align: 'right' })]], 34);
      mergeRow('B', 'E', r); mergeRow('F', 'I', r);
      r = row([BLANK, [localDate(from) + ' to ' + localDate(to) + '  ·  made ' + localDate(now.getTime()) + ' ' + localTime(now.getTime()),
        st({ font: { i: 1, color: GREY, size: 10 }, border: { bottom: ['medium', NAVY] } })]].concat(['C', 'D', 'E', 'F', 'G', 'H', 'I'].map(function () {
        return ['', st({ border: { bottom: ['medium', NAVY] } })];
      })), 20);
      mergeRow('B', 'I', r);
      row([], 10);

      // Cards
      var totalIn = money(ins.reduce(function (t, x) { return t + Number(x.amount); }, 0));
      var totalOut = money(outs.reduce(function (t, x) { return t + shareOf(x); }, 0));
      var bal = money(totalIn - totalOut);
      var outGroups = {}, inGroups = {};
      outs.forEach(function (x) { var id = catId(x, 'out'); (outGroups[id] = outGroups[id] || { n: 0, sum: 0 }); outGroups[id].n++; outGroups[id].sum += shareOf(x); });
      ins.forEach(function (x) { var id = catId(x, 'in'); (inGroups[id] = inGroups[id] || { n: 0, sum: 0 }); inGroups[id].n++; inGroups[id].sum += Number(x.amount); });
      var outIds = Object.keys(outGroups).sort(function (a, b) { return outGroups[b].sum - outGroups[a].sum || labelOf(a, 'out').localeCompare(labelOf(b, 'out')); });
      var inIds = Object.keys(inGroups).sort(function (a, b) { return inGroups[b].sum - inGroups[a].sum || labelOf(a, 'in').localeCompare(labelOf(b, 'in')); });
      var top = outIds[0];
      var cards = [
        { cols: ['B', 'C'], color: GREEN, label: 'MONEY IN', value: totalIn, sub: ins.length + (ins.length === 1 ? ' entry' : ' entries') },
        { cols: ['D', 'E'], color: RED, label: 'MONEY OUT', value: totalOut, sub: outs.length + (outs.length === 1 ? ' expense' : ' expenses') + ' · your share' },
        { cols: ['F'], color: NAVY, label: 'BALANCE', value: bal,
          sub: totalIn > 0 ? (bal >= 0 ? Math.round(bal / totalIn * 100) + '% of money in saved' : 'Spent ' + cur(-bal) + ' more than came in') : 'No money in yet' },
        { cols: ['G', 'H'], color: top ? colorOf(top, 'out') : NAVY, label: 'BIGGEST', value: top ? labelOf(top, 'out') + ' ' + cur(outGroups[top].sum) : '—',
          sub: top && totalOut ? Math.round(outGroups[top].sum / totalOut * 100) + '% of spending' : 'No expenses yet' }
      ];
      var letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      [0, 1, 2].forEach(function (line) {
        var cells = [BLANK];
        cards.forEach(function (c) {
          var first = letters.indexOf(c.cols[0]), last = letters.indexOf(c.cols[c.cols.length - 1]);
          for (var i = first; i <= last; i++) {
            var border = { left: i === first ? ['thin', LINE] : undefined, right: i === last ? ['thin', LINE] : undefined };
            if (line === 0) border.top = ['thick', c.color];
            if (line === 2) border.bottom = ['thin', LINE];
            var v = i !== first ? '' : line === 0 ? c.label : line === 1 ? c.value : c.sub;
            var f = line === 0 ? { color: GREY, size: 10 } : line === 1 ? { b: 1, color: c.color, size: typeof c.value === 'number' ? 20 : 15 } : { color: GREY, size: 10 };
            cells[i] = [v, st({ font: f, border: border, fmt: line === 1 && typeof c.value === 'number' ? MONEY : 0 })];
          }
        });
        var rr = row(cells, line === 1 ? 34 : 20);
        cards.forEach(function (c) { if (c.cols.length > 1) mergeRow(c.cols[0], c.cols[c.cols.length - 1], rr); });
      });
      row([], 14);

      // Where the money went (left, B–E)  |  Money in + week by week (right, F–H)
      function bars(v, max, width) { var n = max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round(v / max * width)) : 0; return new Array(n + 1).join('█'); }
      var left = [], right = [];
      var head = function (text, color, a, b) {
        var cells = {};
        letters.slice(letters.indexOf(a), letters.indexOf(b) + 1).forEach(function (L, i) {
          cells[L] = [i ? '' : text, st({ font: { b: 1, color: color, size: 13 }, border: { bottom: ['medium', color] } })];
        });
        return { cells: cells, merge: [a, b], height: 24 };
      };
      left.push(head('WHERE THE MONEY WENT', RED, 'B', 'E'));
      if (!outIds.length) left.push({ cells: { B: ['No expenses in this period', st({ font: { i: 1, color: GREY } })] } });
      var maxOut = outIds.length ? outGroups[outIds[0]].sum : 0;
      outIds.forEach(function (id) {
        var hex = colorOf(id, 'out');
        left.push({ cells: {
          B: [{ runs: [['■ ', { color: hex, size: 14 }], [labelOf(id, 'out'), { color: INK, size: 12 }]] }, st({ font: { size: 12 } })],
          C: [bars(outGroups[id].sum, maxOut, 18), st({ font: { color: hex, size: 11 }, flush: 1 })],
          E: [money(outGroups[id].sum), st({ font: { b: 1, size: 12 }, fmt: MONEY, align: 'right' })]
        }, merge: ['C', 'D'], height: 22 });
      });
      right.push(head('MONEY IN', GREEN, 'F', 'H'));
      if (!inIds.length) right.push({ cells: { F: ['No money in for this period', st({ font: { i: 1, color: GREY } })] } });
      var maxIn = inIds.length ? inGroups[inIds[0]].sum : 0;
      inIds.forEach(function (id) {
        var hex = colorOf(id, 'in');
        right.push({ cells: {
          F: [{ runs: [['■ ', { color: hex, size: 14 }], [labelOf(id, 'in'), { color: INK, size: 12 }]] }, st({ font: { size: 12 } })],
          G: [bars(inGroups[id].sum, maxIn, 7), st({ font: { color: hex, size: 11 }, flush: 1 })],
          H: [money(inGroups[id].sum), st({ font: { b: 1, size: 12 }, fmt: MONEY, align: 'right' })]
        }, height: 22 });
      });
      if (all.length) {
        // By payment mode: money out and money in for each mode used (and "Not set" for entries without one).
        var modes = {}, order = [];
        all.forEach(function (rw) {
          var name = payText(rw.x, rw.side) || 'Not set';
          if (!modes[name]) { modes[name] = { out: 0, inn: 0 }; order.push(name); }
          if (rw.side === 'out') modes[name].out += shareOf(rw.x); else modes[name].inn += Number(rw.x.amount);
        });
        var rank = PAY_OUT.concat(PAY_IN).map(function (p2) { return p2[1]; });
        order.sort(function (a, b) {
          var ra = a === 'Not set' ? 99 : rank.indexOf(a), rb = b === 'Not set' ? 99 : rank.indexOf(b);
          return ra - rb;
        });
        right.push({ cells: {}, height: 10 });
        right.push(head('BY PAYMENT MODE', NAVY, 'F', 'H'));
        right.push({ cells: {
          F: ['Payment mode', st({ font: { color: GREY, size: 10 } })],
          G: ['Out', st({ font: { color: GREY, size: 10 }, align: 'right' })], H: ['In', st({ font: { color: GREY, size: 10 }, align: 'right' })] } });
        order.forEach(function (name) {
          right.push({ cells: {
            F: [name, st({ font: { size: 12, i: name === 'Not set' ? 1 : 0, color: name === 'Not set' ? GREY : INK } })],
            G: [modes[name].out ? money(modes[name].out) : '', st({ font: { color: RED, size: 12 }, fmt: MONEY, align: 'right' })],
            H: [modes[name].inn ? money(modes[name].inn) : '', st({ font: { color: GREEN, size: 12 }, fmt: MONEY, align: 'right' })] }, height: 20 });
        });
        right.push({ cells: {}, height: 10 });
        right.push(head('WEEK BY WEEK', NAVY, 'F', 'H'));
        right.push({ cells: {
          F: ['Week starting (Mon)', st({ font: { color: GREY, size: 10 } })],
          G: ['Out', st({ font: { color: GREY, size: 10 }, align: 'right' })], H: ['In', st({ font: { color: GREY, size: 10 }, align: 'right' })] } });
        var weeks = {};
        all.forEach(function (rw) {
          var d = new Date(Number(rw.x.ts)), mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
          var w = weeks[mon] || (weeks[mon] = { out: 0, inn: 0 });
          if (rw.side === 'out') w.out += shareOf(rw.x); else w.inn += Number(rw.x.amount);
        });
        Object.keys(weeks).map(Number).sort(function (a, b) { return a - b; }).forEach(function (mon) {
          right.push({ cells: {
            F: [excelDate(mon), st({ font: { size: 12 }, fmt: SHORTDATE })],
            G: [weeks[mon].out ? money(weeks[mon].out) : '', st({ font: { color: RED, size: 12 }, fmt: MONEY, align: 'right' })],
            H: [weeks[mon].inn ? money(weeks[mon].inn) : '', st({ font: { color: GREEN, size: 12 }, fmt: MONEY, align: 'right' })] }, height: 20 });
        });
      }
      for (var i = 0; i < Math.max(left.length, right.length); i++) {
        var L = left[i] || { cells: {} }, R = right[i] || { cells: {} }, cells = [];
        letters.forEach(function (c, j) { cells[j] = L.cells[c] || R.cells[c] || BLANK; });
        var rr2 = row(cells, Math.max(L.height || 18, R.height || 18));
        if (L.merge) mergeRow(L.merge[0], L.merge[1], rr2);
        if (R.merge) mergeRow(R.merge[0], R.merge[1], rr2);
      }
      row([], 16);

      // All entries
      var hr = row([BLANK].concat(['ALL ENTRIES', '', '', '', '', '', '', ''].map(function (t) {
        return [t, st({ font: { b: 1, color: NAVY, size: 13 }, border: { bottom: ['medium', NAVY] } })];
      })), 24);
      mergeRow('B', 'I', hr);
      var headStyle = function (align) { return st({ font: { b: 1, color: GREY, size: 10 }, align: align, border: { bottom: ['thin', NAVY] } }); };
      var headerRow = row([['', headStyle()], ['Date and time', headStyle()], ['Category', headStyle()], ['Note', headStyle()], ['Money out', headStyle('right')],
        ['Split', headStyle()], ['Money in', headStyle('right')], ['Balance', headStyle('right')], ['Payment mode', headStyle()]], 20);
      var running = 0;
      var line = { bottom: ['thin', ROWLINE] };
      if (!all.length) { var er = row([BLANK, ['No entries in this period', st({ font: { i: 1, color: GREY } })]]); mergeRow('B', 'I', er); }
      all.forEach(function (rw) {
        var x = rw.x, side = rw.side, id = catId(x, side), hex = colorOf(id, side);
        var out = side === 'out' ? money(shareOf(x)) : '', inn = side === 'in' ? money(x.amount) : '';
        running = money(running + (inn || 0) - (out || 0));
        row([
          ['', st({ fill: hex, border: line, flush: 1 })],
          [excelDate(x.ts) + excelTime(x.ts), st({ font: { size: 12 }, fmt: DATETIME, border: line })],
          [labelOf(id, side), st({ font: { b: 1, color: hex, size: 12 }, border: line })],
          [[x.sub, x.note].filter(function (v) { return v; }).join(' · '), st({ font: { size: 12 }, border: line, wrap: 1 })],
          [out, st({ font: { size: 12 }, fmt: MONEY, align: 'right', border: line })],
          [side === 'out' ? splitText(x) : '', st({ font: { color: GREY, size: 10 }, border: line, wrap: 1 })],
          [inn, st({ font: { color: GREEN, size: 12 }, fmt: MONEY, align: 'right', border: line })],
          [running, st({ font: { b: 1, color: running < 0 ? RED : INK, size: 12 }, fmt: MONEY, align: 'right', border: line })],
          [payText(x, side), st({ font: { size: 12 }, border: line })]
        ], (splitText(x).length > 46 || String(x.note || '').length > 26) ? 34 : 22);
      });
      var lastEntry = rows.length;
      var tot = { top: ['medium', NAVY] };
      var tr = row([BLANK, ['Total', st({ font: { b: 1, size: 12 }, border: tot })], ['', st({ border: tot })], ['', st({ border: tot })],
        [totalOut, st({ font: { b: 1, color: RED, size: 12 }, fmt: MONEY, align: 'right', border: tot })], ['', st({ border: tot })],
        [totalIn, st({ font: { b: 1, color: GREEN, size: 12 }, fmt: MONEY, align: 'right', border: tot })],
        [bal, st({ font: { b: 1, color: bal < 0 ? RED : NAVY, size: 12 }, fmt: MONEY, align: 'right', border: tot })], ['', st({ border: tot })]], 24);
      mergeRow('B', 'D', tr);

      // ---- Write the sheet ----
      var widths = [1.6, 24, 15, 24, 14, 40, 15, 15, 20];
      var filterRef = 'B' + headerRow + ':I' + Math.max(headerRow, lastEntry);
      var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" showGridLines="0"' + (sheets.length ? '' : ' tabSelected="1"') + '/></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="18"/><cols>' +
        widths.map(function (w, i2) { return '<col min="' + (i2 + 1) + '" max="' + (i2 + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') +
        '</cols><sheetData>' +
        rows.map(function (rw, i2) {
          return '<row r="' + (i2 + 1) + '"' + (rw.height ? ' ht="' + rw.height + '" customHeight="1"' : '') + '>' +
            (rw.cells || []).map(function (c, j) { return c ? cell(i2 + 1, j, c[0], c[1]) : ''; }).join('') + '</row>';
        }).join('') + '</sheetData>' +
        (all.length ? '<autoFilter ref="' + filterRef + '"/>' : '') +
        (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>' : '') +
        '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
        '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
      return { xml: xml, headerRow: headerRow, lastEntry: lastEntry, hasEntries: all.length > 0 };
    }

    // Dashboard for the whole period, then one tab per month with entries, newest month first.
    var sheets = [];
    var pd = new Date(per.start);
    var heading = k === 'month' || k === 'lastmonth' ? MONTH_NAMES[pd.getMonth()] + ' ' + pd.getFullYear()
      : k === 'week' ? 'Week of ' + pd.getDate() + ' ' + shortMonth(pd) + ' ' + pd.getFullYear()
      : k === 'fy' || k === 'lastfy' ? (currencyInfo().fyStart ? 'Financial year ' : 'Year ') + fyName(per.fy, currencyInfo())
      : k === 'all' ? 'All entries' : rangeText(per);
    var dash = buildSheet(per, heading, label);
    dash.name = 'Dashboard';
    sheets.push(dash);
    var both = everything.outs.concat(everything.ins);
    if (coversSeveralMonths(k, per, both)) {
      monthsWithEntries(both, per).forEach(function (ms) {
        var d = new Date(ms), me = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
        var name = MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
        var s = buildSheet({ start: Math.max(ms, per.start), end: Math.min(me, per.end) }, name, label + ' · ' + name);
        s.name = name;
        sheets.push(s);
      });
    }

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="4"><numFmt numFmtId="164" formatCode="' + moneyFormat(true) + '"/>' +
      '<numFmt numFmtId="165" formatCode="ddd d mmm, h:mm AM/PM"/><numFmt numFmtId="167" formatCode="0%"/><numFmt numFmtId="168" formatCode="d mmm"/></numFmts>' +
      '<fonts count="' + fonts.length + '">' + fonts.join('') + '</fonts>' +
      '<fills count="' + fills.length + '">' + fills.join('') + '</fills>' +
      '<borders count="' + borders.length + '">' + borders.join('') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    var defined = '<definedNames>' + sheets.map(function (s, i) {
      var ref = "'" + s.name + "'!";
      return (s.hasEntries ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">' + ref + '$B$' + s.headerRow + ':$I$' + Math.max(s.headerRow, s.lastEntry) + '</definedName>' : '') +
        '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' + ref + '$' + s.headerRow + ':$' + s.headerRow + '</definedName>';
    }).join('') + '</definedNames>';
    var WS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
    return [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="' + WS + '"/>'; }).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
        sheets.map(function (s, i) { return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
        '</sheets>' + defined + '</workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', styles]
    ].concat(sheets.map(function (s, i) { return ['xl/worksheets/sheet' + (i + 1) + '.xml', s.xml]; }));
  }
  function reportBlob(k, label, now, opts, data) { return zip(reportWorkbook(data || localData(), k, label || periodLabel(k, now, opts), now, opts)); }

  // ---------- Which data the report uses ----------
  // This device, merged with the latest backup in the backup folder when the app may already read it
  // (no permission prompt), so entries saved only in the backup are in the report too. Deletions made
  // on this device stay deleted (the folder's sync record says what was there at the last save).
  // A backup file picked in the report sheet is merged in as well.
  async function folderBackupForReport() {
    if (!supportsFolder) return null;
    try {
      var h = await loadHandle();
      if (!h || !(await hasPermission(h, false))) return null;
      var names = [monthFolder(), monthFolder(monthBefore())];
      for (var i = 0; i < names.length; i++) {
        var b = parseBackup(await readFolderFile(h, names[i]));
        if (b) return { backup: b, base: baseFor('folder:' + names[i]) };
      }
    } catch (e) { console.warn('Backup folder not read for the report', e); }
    return null;
  }
  async function reportData(pickedBackup) {
    var data = localData();
    var folder = await folderBackupForReport();
    if (folder) data = mergeData(data, folder.backup, folder.base).data;
    if (pickedBackup) data = mergeData(data, pickedBackup, {}).data;
    return data;
  }

  // ---------- Period picker in the Excel sheet ----------
  // The app's sheet offers 4 periods. Replace that list with every period above, two per row,
  // with From / To dates for custom and an optional backup file to build the report from.
  var picker = { k: null, from: '', to: '', file: null, fileName: '' };
  var PICKER_CSS = '.slr-opts{display:grid!important;grid-template-columns:1fr 1fr;gap:8px}' +
    '.slr-opts .opt{flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:2px;min-width:0;padding:10px 12px}' +
    '.slr-opts .opt span{line-height:1.25}.slr-opts .opt small{font-size:12px;line-height:1.3;overflow-wrap:anywhere}' +
    '.slr-opts .opt[data-k=custom]{grid-column:1/-1}' +
    '.slr-dates{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:8px}.slr-dates[hidden]{display:none}' +
    '.slr-dates label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--muted);min-width:0}' +
    '.slr-dates input{border:1.5px solid var(--line);border-radius:12px;padding:10px;font:inherit;font-size:15px;background:var(--surface);color:var(--ink,inherit);width:100%;min-width:0;box-sizing:border-box}' +
    '.slr-file{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted)}' +
    '.slr-file button{border:0;background:none;color:var(--accent);font-weight:600;padding:4px 0;text-decoration:underline;cursor:pointer;font:inherit;font-size:13px}';
  function todayText(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pickerOpts() { return { from: picker.from, to: picker.to }; }
  function countText(k, entries, now) {
    var per = reportPeriod(k, now, pickerOpts());
    if (!per) return 'Pick dates';
    var inP = function (x) { var ts = Number(x.ts); return ts >= per.start && ts < per.end; };
    var o = entries.outs.filter(inP), n = o.length + entries.ins.filter(inP).length;
    return n + (n === 1 ? ' entry' : ' entries') + ' · ' + cur(o.reduce(function (t, x) { return t + shareOf(x); }, 0));
  }
  function buildPicker(appOpts) {
    var now = new Date(), entries = reportEntries(localData());
    if (!picker.k) {
      var was = appOpts.querySelector('.opt[aria-pressed="true"]');
      picker.k = was && REPORT_KEYS.indexOf(was.getAttribute('data-k')) >= 0 ? was.getAttribute('data-k') : 'month';
    }
    if (!picker.from) { picker.from = todayText(new Date(now.getFullYear(), now.getMonth(), 1)); picker.to = todayText(now); }
    var box = document.createElement('div');
    box.className = 'opts slr-opts';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Report period');
    REPORT_KEYS.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'opt'; b.setAttribute('data-k', k);
      b.setAttribute('aria-pressed', String(k === picker.k));
      var s = document.createElement('span'); s.textContent = periodLabel(k, now, k === 'custom' ? null : pickerOpts()).replace(/(\d)-(\d)/g, '$1\u2011$2');   // keep 2026-27 on one line
      b.appendChild(s);
      var range = k === 'custom' || k === 'all' ? '' : rangeText(reportPeriod(k, now));
      if (range) {
        var r = document.createElement('small'); r.className = 'slr-range'; r.textContent = range; b.appendChild(r);
      }
      var c = document.createElement('small'); c.className = 'num'; c.textContent = countText(k, entries, now); b.appendChild(c);
      box.appendChild(b);
      if (k === 'custom') {
        var dates = document.createElement('div');
        dates.className = 'slr-dates'; dates.hidden = picker.k !== 'custom';
        [['From', 'slr-from', picker.from], ['To', 'slr-to', picker.to]].forEach(function (f) {
          var l = document.createElement('label'), i = document.createElement('input');
          l.textContent = f[0]; i.type = 'date'; i.id = f[1]; i.value = f[2]; i.max = todayText(new Date(now.getFullYear() + 1, 11, 31));
          l.appendChild(i); dates.appendChild(l);
        });
        box.appendChild(dates);
      }
    });
    var file = document.createElement('div');
    file.className = 'slr-file';
    var note = document.createElement('span');
    note.id = 'slr-file-note';
    note.textContent = picker.file ? 'Also using ' + picker.fileName + ' (' + records(countIn(picker.file.data)) + ')' : 'Report uses this device and your backup folder.';
    var pick = document.createElement('button');
    pick.type = 'button'; pick.id = 'slr-file-pick';
    pick.textContent = picker.file ? 'Stop using it' : 'Add a backup file…';
    var input = document.createElement('input');
    input.type = 'file'; input.id = 'slr-file-in'; input.accept = '.json,application/json'; input.hidden = true;
    file.append(note, pick, input);
    box.appendChild(file);
    return box;
  }
  function refreshPicker() {
    var mine = document.querySelector('#sheetRoot .slr-opts');
    if (mine) mine.replaceWith(buildPicker(mine));
  }
  function watchSheet() {
    var root = document.getElementById('sheetRoot');
    if (!root || watchSheet.on) return;
    watchSheet.on = true;
    var style = document.createElement('style'); style.id = 'slr-picker-css'; style.textContent = PICKER_CSS; document.head.appendChild(style);
    var swap = function () {
      if (!document.getElementById('doExport')) { picker.k = null; picker.from = ''; picker.to = ''; picker.file = null; picker.fileName = ''; return; }
      var app = root.querySelector('.opts:not(.slr-opts)');
      if (app && app.querySelector('.opt[data-k="week"]')) app.replaceWith(buildPicker(app));
    };
    new MutationObserver(swap).observe(root, { childList: true, subtree: true });
    swap();
  }
  // Clicks and changes inside the picker are handled here and kept from the app, which would
  // otherwise redraw its own 4-period list.
  function onPickerEvent(e) {
    var box = e.target && e.target.closest && e.target.closest('.slr-opts');
    if (!box) return;
    e.stopImmediatePropagation();
    if (e.type === 'click') {
      var opt = e.target.closest('.opt');
      if (opt) {
        e.preventDefault();
        picker.k = opt.getAttribute('data-k');
        [].forEach.call(box.querySelectorAll('.opt'), function (b) { b.setAttribute('aria-pressed', String(b === opt)); });
        var dates = box.querySelector('.slr-dates');
        if (dates) dates.hidden = picker.k !== 'custom';
        if (picker.k === 'custom') { var f = document.getElementById('slr-from'); if (f) f.focus(); }
        return;
      }
      if (e.target.closest('#slr-file-pick')) {
        e.preventDefault();
        if (picker.file) { picker.file = null; picker.fileName = ''; refreshPicker(); return; }
        var inp = document.getElementById('slr-file-in');
        if (inp) inp.click();
      }
      return;
    }
    if (e.target.id === 'slr-from' || e.target.id === 'slr-to') {
      picker[e.target.id === 'slr-from' ? 'from' : 'to'] = e.target.value;
      var c = box.querySelector('.opt[data-k="custom"] small.num');
      if (c) c.textContent = countText('custom', reportEntries(localData()), new Date());
      return;
    }
    if (e.type === 'change' && e.target.id === 'slr-file-in') {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      file.text().then(function (text) {
        var b = parseBackup(text);
        if (!b) { appToast('That file is not a Spenderrr backup'); return; }
        picker.file = b; picker.fileName = file.name;
        refreshPicker();
      }).catch(function () { appToast('Could not read that file'); });
    }
  }
  ['click', 'input', 'change', 'keydown'].forEach(function (t) {
    window.addEventListener(t, function (e) { if (t !== 'keydown' || e.key === 'Enter') onPickerEvent(e); }, true);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSheet); else watchSheet();

  // Takes over the app's "Download Excel file" button, so the report is this Dashboard workbook.
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function appToast(text) {
    var t = document.getElementById('toast');
    if (!t) { toast(text); return; }
    t.textContent = text; t.hidden = false;
    clearTimeout(appToast.timer);
    appToast.timer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function fileSafe(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '-'); }
  async function downloadReport(e) {
    var btn = e.target && e.target.closest && e.target.closest('#doExport');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var picked = document.querySelector('#sheetRoot .opt[aria-pressed="true"]');
    var k = picked ? picked.getAttribute('data-k') : 'all';
    if (REPORT_KEYS.indexOf(k) < 0) k = 'all';
    var opts = k === 'custom' ? pickerOpts() : null;
    if (k === 'custom' && !reportPeriod(k, new Date(), opts)) {
      appToast(!dayFromText(opts.from) || !dayFromText(opts.to) ? 'Pick both a From and a To date' : 'The From date must be on or before the To date');
      return;
    }
    var label = periodLabel(k, new Date(), opts);
    var name = 'Spend report - ' + fileSafe(label) + ' - ' + localDate(Date.now()) + '.xlsx', blob;
    var file = null;
    try {
      // iPhone has no backup folder, so nothing is awaited there and the share sheet still opens from the tap.
      var data = supportsFolder || picker.file ? await reportData(picker.file) : localData();
      blob = reportBlob(k, label, undefined, opts, data);
    } catch (err) { appToast('Could not make the report: ' + (err && err.message ? err.message : err)); return; }
    try { file = new File([blob], name, { type: XLSX_MIME }); } catch (err) { file = null; }
    if (isIOS() && file && navigator.canShare && navigator.share) {
      try {
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); appToast('Report ready'); return; }
      } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
    appToast('Report downloaded to your Downloads folder');
  }
  window.addEventListener('click', downloadReport, true);    // runs before the app's own handler

  // ---------- Safety: never replace a good backup with an empty or much smaller one ----------
  // 'ok'     -> safe to replace
  // 'empty'  -> this device has nothing, the backup has records (e.g. app was reinstalled)
  // 'shrink' -> this device has less than half the records of the backup (and at least 5 fewer)
  function compareCounts(localN, backupN) {
    if (backupN <= 0) return 'ok';
    if (localN === 0) return 'empty';
    if (localN < backupN * 0.5 && backupN - localN >= 5) return 'shrink';
    return 'ok';
  }
  var lastBlock = null;   // { where, local, backup } when a backup was held back
  function okToReplace(existingText, localN, fromUserTap, where) {
    if (!existingText) return true;
    var ex = parseBackup(existingText);
    if (!ex) return true;
    return okToReplaceCount(countIn(ex.data), localN, fromUserTap, where);
  }
  function okToReplaceCount(exN, localN, fromUserTap, where) {
    var verdict = compareCounts(localN, exN);
    if (verdict === 'ok') return true;
    if (fromUserTap) {
      var msg = verdict === 'empty'
        ? 'This device has no entries, but your ' + where + ' backup has ' + exN + ' records.\n\n' +
          'Replace that backup with an EMPTY one?\nChoose Cancel to keep it (you can restore it).'
        : 'This device has ' + localN + ' records, but your ' + where + ' backup has ' + exN + '.\n\n' +
          'Replace the backup with the smaller one?';
      if (confirm(msg)) return true;
    }
    lastBlock = { where: where, local: localN, backup: exN };
    return false;
  }

  // ---------- Folder handle storage (IndexedDB) ----------
  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var tx = req.result.transaction('kv', mode);
        var out = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { resolve(out && out.result); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }
  function saveHandle(h) { return idb('readwrite', function (s) { return s.put(h, 'dir'); }); }
  function loadHandle() { return idb('readonly', function (s) { return s.get('dir'); }).catch(function () { return null; }); }

  async function hasPermission(handle, ask) {
    var opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (ask && (await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  // ---------- Backup ----------
  function monthBefore(d) { d = d || new Date(); return new Date(d.getFullYear(), d.getMonth() - 1, 1); }

  // File and folder names are matched ignoring upper/lower case and spaces at the ends:
  // "Spend-Expense-Backup/october_2026/Spend-Log-Backup.json" is found like the usual names.
  function sameName(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

  // A file or folder inside dir: the exact name first, then any name that differs only in case.
  // With create, makes it (with the usual name) when there is none.
  async function childOf(dir, name, kind, create) {
    var isDir = kind === 'directory';
    try { return isDir ? await dir.getDirectoryHandle(name) : await dir.getFileHandle(name); } catch (e) { /* look further */ }
    try {
      if (dir.entries) {
        for await (var pair of dir.entries()) if (pair[1].kind === kind && sameName(pair[0], name)) return pair[1];
      }
    } catch (e) { /* folder could not be listed */ }
    if (!create) return null;
    return isDir ? dir.getDirectoryHandle(name, { create: true }) : dir.getFileHandle(name, { create: true });
  }

  // The folder people pick may be the parent (Documents) or spend-expense-backup itself.
  async function rootIn(parent, create) {
    if (sameName(parent.name, ROOT_FOLDER)) return parent;
    try { return await childOf(parent, ROOT_FOLDER, 'directory', create); } catch (e) { return null; }
  }
  async function readFolderFile(parent, monthName) {
    try {
      var root = await rootIn(parent, false);
      var month = root && await childOf(root, monthName, 'directory');
      var file = month && await childOf(month, FILE_NAME, 'file');
      return file ? await (await file.getFile()).text() : null;
    } catch (e) { return null; }
  }
  // Latest backup in a folder: this month, else last month.
  async function readLatestFromFolder(parent) {
    return (await readFolderFile(parent, monthFolder())) || (await readFolderFile(parent, monthFolder(monthBefore())));
  }

  // Merges this device into the month's backup file and writes it back.
  // Returns the merge result, or null when held back by the safety check.
  async function writeToFolder(parent, data, fromUserTap) {
    var monthName = monthFolder(), key = 'folder:' + monthName;
    var existing = parseBackup(await readFolderFile(parent, monthName));
    var merged = mergeData(data, existing, baseFor(key));
    if (existing && !okToReplaceCount(countIn(existing.data), countIn(merged.data), fromUserTap, 'phone')) return null;
    var text = backupText(merged.data, merged.deleted);
    var root = await rootIn(parent, true);
    var month = await childOf(root, monthName, 'directory', true);
    var file = await childOf(month, FILE_NAME, 'file', true);
    var w = await file.createWritable();   // replaces the previous content
    await w.write(text);
    await w.close();
    setBase(key, merged.base);
    try {                                  // Excel copy next to it, also replaced each time
      var xlsx = excelBlob(merged.data);   // build it first, so a problem never leaves an empty file
      var xf = await childOf(month, EXCEL_NAME, 'file', true);
      var xw = await xf.createWritable();
      await xw.write(xlsx);
      await xw.close();
    } catch (e) { console.warn('Excel copy not saved', e); }
    return merged;
  }

  // Every month's backup in a device folder, newest first. "October_2026" and "october_2026" are one month.
  async function listFolderBackups(parent) {
    var root = await rootIn(parent, false), byMonth = {}, out = [];
    if (!root || !root.entries) return out;
    for await (var pair of root.entries()) {
      var name = pair[0], h = pair[1], d = monthDate(name);
      if (h.kind !== 'directory' || !d) continue;
      var file = await childOf(h, FILE_NAME, 'file'), b = null;
      try { b = file && parseBackup(await (await file.getFile()).text()); } catch (e) { b = null; }
      if (b) (byMonth[monthFolder(d)] = byMonth[monthFolder(d)] || []).push(b);
    }
    Object.keys(byMonth).forEach(function (m) {
      var c = byMonth[m].length === 1 ? byMonth[m][0] : combineBackups(byMonth[m]);
      if (c) out.push({ month: m, backup: { data: c.data, deleted: c.deleted, createdAt: c.createdAt }, source: 'This device (' + parent.name + ')' });
    });
    return sortBackups(out);
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadFile(text) {
    downloadBlob(new Blob([text], { type: 'application/json' }), ROOT_FOLDER + '_' + monthFolder() + '.json');
    try { downloadBlob(excelBlob(), ROOT_FOLDER + '_' + monthFolder() + '.xlsx'); } catch (e) { console.warn('Excel copy not saved', e); }
  }

  function backupFile(text) {
    return new File([text], FILE_NAME, { type: 'application/json' });
  }
  function canShareFile() {
    try {
      return !!(navigator.canShare && navigator.share &&
        navigator.canShare({ files: [backupFile('{}')] }));
    } catch (e) { return false; }
  }
  function shareFile(text) {
    var files = [backupFile(text)];
    try {
      var x = new File([excelBlob()], EXCEL_NAME, { type: XLSX_MIME });
      if (navigator.canShare({ files: [files[0], x] })) files.push(x);
    } catch (e) { console.warn('Excel copy not shared', e); }
    return navigator.share({ files: files, title: 'Spenderrr backup ' + todayKey() });
  }

  // ---------- Google Drive (optional) ----------
  // Turned on only when index.html has <meta name="google-client-id" content="...apps.googleusercontent.com">.
  var DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';   // app can only see files it created
  var DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
  var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var CLIENT_ID = (function () {
    var m = document.querySelector('meta[name="google-client-id"]');
    var v = m && m.content ? m.content.trim() : '';
    return /\.apps\.googleusercontent\.com$/.test(v) ? v : '';
  })();
  var driveToken = null, driveTokenExp = 0, tokenClient = null, gisLoading = null;

  function driveConfigured() { return !!CLIENT_ID; }
  function driveOn() { return driveConfigured() && !!getMeta().drive; }
  function tokenValid() { return driveToken && Date.now() < driveTokenExp - 60000; }

  try {
    var saved = JSON.parse(sessionStorage.getItem('__spendlog_drive_tok') || 'null');
    if (saved && saved.exp > Date.now()) { driveToken = saved.t; driveTokenExp = saved.exp; }
  } catch (e) { /* ignore */ }

  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    gisLoading = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.async = true;
      sc.onload = function () { resolve(); };
      sc.onerror = function () { gisLoading = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
      document.head.appendChild(sc);
    });
    return gisLoading;
  }

  // Must be called from a tap: Google opens a sign-in window.
  async function getDriveToken() {
    if (tokenValid()) return driveToken;
    await loadGis();
    return new Promise(function (resolve, reject) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: function (r) {
          if (r.error) { reject(new Error(r.error_description || r.error)); return; }
          driveToken = r.access_token;
          driveTokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          try { sessionStorage.setItem('__spendlog_drive_tok', JSON.stringify({ t: driveToken, exp: driveTokenExp })); } catch (e) { /* ignore */ }
          resolve(driveToken);
        },
        error_callback: function (err) {
          var e = new Error(err && err.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed.');
          if (err && err.type === 'popup_closed') e.name = 'AbortError';
          reject(e);
        }
      });
      tokenClient.requestAccessToken({ prompt: getMeta().driveConsented ? '' : 'consent' });
    });
  }

  async function driveFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + driveToken }, opts.headers || {});
    var r = await fetch(url, opts);
    if (r.status === 401) { driveToken = null; driveTokenExp = 0; throw new Error('Google sign-in expired. Tap again.'); }
    if (!r.ok) throw new Error('Google Drive error ' + r.status);
    return r;
  }
  function q(str) { return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  // All matches (there can be duplicates), newest first unless another order is asked for.
  // Names are compared here, ignoring upper/lower case, rather than in Drive's search,
  // so "Spend-Log-Backup.json" or "october_2026" are found too. The app only sees files it made
  // (drive.file permission), so listing a folder stays small.
  async function driveFindAll(name, parentId, isFolder, orderBy) {
    var query = "trashed=false and '" + q(parentId) + "' in parents" +
      (isFolder ? " and mimeType='" + FOLDER_MIME + "'" : " and mimeType!='" + FOLDER_MIME + "'");
    var out = [], token = '';
    for (var page = 0; page < 10; page++) {
      var r = await driveFetch(DRIVE_API + '?q=' + encodeURIComponent(query) +
        '&orderBy=' + encodeURIComponent(orderBy || 'modifiedTime desc') +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,modifiedTime,createdTime)') + '&pageSize=200&spaces=drive' +
        (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      var j = await r.json();
      (j.files || []).forEach(function (f) { if (!name || sameName(f.name, name)) out.push(f); });
      token = j.nextPageToken;
      if (!token) break;
    }
    return out;
  }
  async function driveFind(name, parentId, isFolder) { return (await driveFindAll(name, parentId, isFolder))[0] || null; }
  async function driveCreateFolder(name, parentId) {
    var r = await driveFetch(DRIVE_API + '?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, mimeType: FOLDER_MIME, parents: [parentId] })
    });
    return (await r.json()).id;
  }
  // Folder ids with this name, oldest first (so every device picks the same one).
  async function driveFolderIds(name, parentId, create) {
    var ids = (await driveFindAll(name, parentId, true, 'createdTime')).map(function (f) { return f.id; });
    if (!ids.length && create) ids = [await driveCreateFolder(name, parentId)];
    return ids;
  }
  // This month's folder(s) — the first is where new files go; duplicates are searched too.
  async function driveMonthFolders(create, d) {
    var name = monthFolder(d);
    var roots = await driveFolderIds(ROOT_FOLDER, 'root', create), months = [];
    for (var i = 0; i < roots.length; i++) months = months.concat(await driveFolderIds(name, roots[i], false));
    if (!months.length && create) months = [await driveCreateFolder(name, roots[0])];
    return months;
  }
  async function driveFilesIn(folderIds, name) {
    var all = [];
    for (var i = 0; i < folderIds.length; i++) all = all.concat(await driveFindAll(name, folderIds[i], false));
    return all.sort(function (a, b) { return String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')); });
  }
  // Duplicates go to Drive's trash (recoverable for 30 days), never deleted outright.
  async function driveTrash(id) {
    await driveFetch(DRIVE_API + '/' + id + '?fields=id', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
    });
  }
  async function driveRead(fileId) {
    var r = await driveFetch(DRIVE_API + '/' + fileId + '?alt=media');
    return r.text();
  }

  // My Drive / spend-expense-backup / October_2026 / spend-log-backup.json
  // Reads the backup (and any duplicates), merges this device in, writes the newest file,
  // and moves duplicates to the trash. Returns the merge result, or null when held back.
  var tidied = 0;
  async function driveSave(data, fromUserTap) {
    var monthIds = await driveMonthFolders(true), key = 'drive:' + monthFolder();
    var files = await driveFilesIn(monthIds, FILE_NAME), copies = [];
    for (var i = 0; i < files.length; i++) {
      var b = parseBackup(await driveRead(files[i].id));
      if (b) copies.push(b);
    }
    var remote = combineBackups(copies);
    var merged = mergeData(data, remote, baseFor(key));
    if (remote && !okToReplaceCount(countIn(remote.data), countIn(merged.data), fromUserTap, 'Google Drive')) return null;
    var text = backupText(merged.data, merged.deleted);
    var monthId = monthIds[0];
    if (files.length) {
      await driveFetch(DRIVE_UPLOAD + '/' + files[0].id + '?uploadType=media', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text
      });
      for (var j = 1; j < files.length; j++) { await driveTrash(files[j].id); tidied++; }
    } else {
      var boundary = 'spendlog' + Date.now();
      var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: FILE_NAME, parents: [monthId], mimeType: 'application/json' }) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + text + '\r\n--' + boundary + '--';
      await driveFetch(DRIVE_UPLOAD + '?uploadType=multipart&fields=id', {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
      });
    }
    setBase(key, merged.base);
    try { await driveSaveExcel(monthIds, merged.data); } catch (e) { console.warn('Excel copy not saved to Drive', e); }
    return merged;
  }

  // Excel copy in the same Drive folder: create it once, then replace its contents.
  async function driveSaveExcel(monthIds, data) {
    var xlsx = excelBlob(data);
    var files = await driveFilesIn(monthIds, EXCEL_NAME);
    var id = files[0] && files[0].id;
    for (var j = 1; j < files.length; j++) await driveTrash(files[j].id);
    var monthId = monthIds[0];
    if (!id) {
      var r = await driveFetch(DRIVE_API + '?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: EXCEL_NAME, parents: [monthId], mimeType: XLSX_MIME })
      });
      id = (await r.json()).id;
    }
    await driveFetch(DRIVE_UPLOAD + '/' + id + '?uploadType=media', {
      method: 'PATCH', headers: { 'Content-Type': XLSX_MIME }, body: xlsx
    });
  }

  // Every month's backup in Google Drive (duplicates combined), newest first.
  async function listDriveBackups() {
    var roots = await driveFolderIds(ROOT_FOLDER, 'root', false), byMonth = {};
    for (var i = 0; i < roots.length; i++) {
      var months = await driveFindAll(null, roots[i], true, 'name');
      months.forEach(function (f) {                 // "october_2026" and "October_2026" are the same month
        var d = monthDate(f.name);
        if (d) (byMonth[monthFolder(d)] = byMonth[monthFolder(d)] || []).push(f.id);
      });
    }
    var names = Object.keys(byMonth).sort(function (a, b) { return monthDate(b) - monthDate(a); }).slice(0, 24), out = [];
    for (var n = 0; n < names.length; n++) {
      var files = await driveFilesIn(byMonth[names[n]], FILE_NAME), copies = [];
      for (var k = 0; k < files.length; k++) { var b = parseBackup(await driveRead(files[k].id)); if (b) copies.push(b); }
      var c = combineBackups(copies);
      if (c) out.push({ month: names[n], backup: { data: c.data, deleted: c.deleted, createdAt: c.createdAt }, source: 'Google Drive' });
    }
    return sortBackups(out);
  }
  // "October_2026" -> Date, or null for other folder names.
  function monthDate(name) {
    var m = /^([a-z]+)_(\d{4})$/i.exec(String(name || '').trim());
    var i = -1;
    if (m) MONTHS.forEach(function (x, k) { if (sameName(x, m[1])) i = k; });
    return i < 0 ? null : new Date(Number(m[2]), i, 1);
  }
  function sortBackups(list) {
    return list.sort(function (a, b) {
      return (monthDate(b.month) - monthDate(a.month)) || String(b.backup.createdAt || '').localeCompare(String(a.backup.createdAt || ''));
    });
  }

  // Which Google account Drive is connected to. Uses the same drive.file permission —
  // no extra sign-in screen. Saved only on this device (not in backups).
  var accountCheckedFor = null;
  var switchNotice = '';           // shown with the next backup message so it isn't missed
  async function driveAccount() {
    if (accountCheckedFor && accountCheckedFor === driveToken) return getMeta().driveAccount || null;
    try {
      var r = await driveFetch(DRIVE_API.replace('/files', '/about') + '?fields=user(displayName,emailAddress)');
      var u = ((await r.json()) || {}).user || {};
      var acct = { name: String(u.displayName || '').trim(), email: String(u.emailAddress || '').trim() };
      if (!acct.name && !acct.email) return getMeta().driveAccount || null;
      var m = getMeta(), before = m.driveAccount;
      m.driveAccount = acct; setMeta(m);
      accountCheckedFor = driveToken;
      if (before && before.email && acct.email && before.email.toLowerCase() !== acct.email.toLowerCase()) {
        switchNotice = 'Google Drive is now ' + accountLabel(acct) + ' (was ' + before.email + ')';
        toast(switchNotice);
      }
      renderDriveButtons();
      refreshStatus();
      return acct;
    } catch (e) {
      console.warn('Could not read the Google account name', e);
      return getMeta().driveAccount || null;
    }
  }
  function accountLabel(a) {
    if (!a) return '';
    if (a.name && a.email) return a.name + ' (' + a.email + ')';
    return a.name || a.email;
  }

  async function connectDrive() {
    try {
      await getDriveToken();
      var m = getMeta(); m.drive = true; m.driveConsented = true; setMeta(m);
      var acct = await driveAccount();
      toast(acct ? 'Google Drive connected: ' + (acct.email || acct.name) : 'Google Drive connected');
      refreshStatus();
      renderDriveButtons();
      await runBackup(true);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message);
    }
  }
  function disconnectDrive() {
    if (!confirm('Stop backing up to Google Drive?\nFiles already in your Drive are kept.')) return;
    try { if (driveToken && window.google) google.accounts.oauth2.revoke(driveToken, function () {}); } catch (e) { /* ignore */ }
    driveToken = null; driveTokenExp = 0;
    try { sessionStorage.removeItem('__spendlog_drive_tok'); } catch (e) { /* ignore */ }
    var m = getMeta(), was = m.driveAccount;
    m.drive = false; m.driveConsented = false; m.driveLastAt = null; m.driveAccount = null; setMeta(m);
    accountCheckedFor = null;
    toast('Google Drive disconnected' + (was && was.email ? ' (' + was.email + ')' : ''));
    refreshStatus();
    renderDriveButtons();
  }

  // ---------- Run a backup to every destination that is set up ----------
  // mode: 'tap'    — you tapped (may ask to sign in / choose a folder / confirm)
  //       'auto'   — the daily check (shows a reminder when a tap is needed)
  //       'change' — right after you add, edit or delete something (silent; only where no tap is needed)
  var running = false, rerun = false;
  async function runBackup(mode) {
    if (mode === true) mode = 'tap';
    if (mode === false || mode === undefined) mode = 'auto';
    var tap = mode === 'tap', change = mode === 'change';
    if (running) { if (change) rerun = true; return; }
    var data = localData(), localN = countIn(data);
    // Nothing on this device: no automatic backup. Offer a restore instead.
    if (localN === 0 && !tap) { if (!change) showEmptyBanner(); return; }
    running = true;
    lastBlock = null;
    var needsTap = [], saved = [], held = [], waiting = [], merges = [];
    try {
      var useDrive = driveOn();

      // 1) Phone folder (Android Chrome/Edge, desktop)
      if (supportsFolder) {
        var handle = await loadHandle();
        if (!handle && tap && !useDrive) handle = await chooseFolder();
        if (!handle) {
          if (!useDrive && !change) needsTap.push('choose a backup folder');
        } else if (!(await hasPermission(handle, tap))) {
          if (change) waiting.push('phone'); else needsTap.push('allow the backup folder');
        } else {
          var fm = await writeToFolder(handle, data, tap);
          if (fm) { saved.push('phone'); merges.push(fm); } else held.push('phone');
        }
      } else if (!useDrive) {
        // 2) iPhone / Firefox without Drive: share sheet or download — always needs a tap.
        //    The old file can't be read here, so compare with the size of the last backup.
        if (change) waiting.push('phone');
        else if (!tap) needsTap.push(canShareFile() ? 'save to Files' : 'save the backup');
        else if (okToReplaceCount(getMeta().lastRecords || 0, localN, true, 'last')) {
          var text = backupText(data);
          if (canShareFile()) await shareFile(text); else downloadFile(text);
          saved.push('phone');
        } else held.push('phone');
      }

      // 3) Google Drive (merged with your other devices)
      if (useDrive) {
        if (!tokenValid() && !tap) {
          if (change) waiting.push('Google Drive'); else needsTap.push('back up to Google Drive');
        } else {
          await getDriveToken();
          await driveAccount();
          var dm = await driveSave(data, tap);
          if (dm) {
            var da = getMeta().driveAccount;
            saved.push('Google Drive' + (da && (da.email || da.name) ? ' (' + (da.email || da.name) + ')' : ''));
            merges.push(dm);
            var md = getMeta(); md.driveLastAt = new Date().toISOString(); setMeta(md);
          } else held.push('Google Drive');
        }
      }

      var updates = merges.filter(function (m) { return m.updates > 0; })[0];
      if (held.length && lastBlock) {
        showBanner('Backup paused: this device has ' + lastBlock.local + ' records but your ' +
          (lastBlock.where === 'last' ? 'last' : lastBlock.where) + ' backup has ' + lastBlock.backup +
          '. Tap to restore it', restore);
      } else if (needsTap.length) {
        showBanner('Tap to ' + needsTap.join(' and ') + ' for today\'s backup', function () { runBackup('tap'); });
      } else if (updates) {
        offerUpdates(updates);
      } else if (saved.length && !emptyBannerShown) {
        hideBanner();
      }
      var m = getMeta();
      if (saved.length && !held.length && !needsTap.length && !waiting.length) {
        m.last = todayKey(); m.lastAt = new Date().toISOString(); m.pending = false;
      } else if (saved.length && change) {
        m.lastAt = new Date().toISOString();
      }
      if (saved.length) m.lastRecords = localN;
      setMeta(m);
      if (saved.length && !change) {
        toast((switchNotice ? switchNotice + '. ' : '') + 'Backup saved to ' + saved.join(' and ') + ' · ' + monthFolder() +
          (tidied ? ' · ' + tidied + ' duplicate ' + (tidied === 1 ? 'file' : 'files') + ' moved to Drive trash' : ''));
        switchNotice = ''; tidied = 0;
      } else if (held.length && tap) toast('Kept your existing backup');
      refreshStatus();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error('Backup failed', e);
      if (!change) {
        toast('Backup failed: ' + (e && e.message ? e.message : e));
        showBanner('Backup did not finish. Tap to try again', function () { runBackup('tap'); });
      }
    } finally {
      running = false;
      if (rerun) { rerun = false; scheduleChangeBackup(); }
    }
  }

  // ---------- Changes from your other devices ----------
  var pendingUpdate = null;
  function offerUpdates(merged) {
    pendingUpdate = merged;
    showBanner('Your backup has ' + merged.updates + (merged.updates === 1 ? ' change' : ' changes') +
      ' not on this device (from your other devices). Tap to load', applyUpdates);
  }
  // Load the merged data into this device. Re-merges first so anything added since is kept.
  function applyUpdates() {
    var m = pendingUpdate;
    if (!m) return;
    var fresh = mergeData(localData(), { data: m.data, deleted: m.deleted }, m.base);
    var n = fresh.updates;
    applying = true;
    try {
      ALLOWED_KEYS.forEach(function (k) { if (fresh.data[k]) localStorage.setItem(k, fresh.data[k]); });
      var fps = {};
      STORES.forEach(function (k) { if (fresh.data[k]) join(fps, k, fingerprints(parseStore(fresh.data[k]))); });
      ['drive:', 'folder:'].forEach(function (p) { if (getBases()[p + monthFolder()]) setBase(p + monthFolder(), fps); });
      var meta = getMeta(); meta.lastRecords = countIn(fresh.data); setMeta(meta);
    } finally { applying = false; }
    pendingUpdate = null;
    hideBanner();
    toast('Loaded ' + n + (n === 1 ? ' change' : ' changes') + '. Reloading…');
    setTimeout(function () { location.reload(); }, 600);
  }

  // ---------- Back up after every change ----------
  var applying = false, changeTimer = null;
  function scheduleChangeBackup() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function () { runBackup('change'); }, CHANGE_DELAY);
  }
  function dataChanged() {
    var m = getMeta();
    if (!m.pending) { m.pending = true; m.pendingSince = new Date().toISOString(); setMeta(m); }
    scheduleChangeBackup();
    refreshStatus();
  }
  // The app saves to localStorage once per add / edit / delete; notice those saves.
  function watchChanges() {
    var proto = Storage.prototype, set = proto.setItem, remove = proto.removeItem;
    function mine(store, k) { return !applying && store === window.localStorage && ALLOWED_KEYS.indexOf(k) >= 0; }
    proto.setItem = function (k, v) {
      var r = set.apply(this, arguments);
      try { if (mine(this, k)) dataChanged(); } catch (e) { /* ignore */ }
      return r;
    };
    proto.removeItem = function (k) {
      var r = remove.apply(this, arguments);
      try { if (mine(this, k)) dataChanged(); } catch (e) { /* ignore */ }
      return r;
    };
  }

  async function chooseFolder() {
    try {
      var h = await window.showDirectoryPicker({ id: 'spendlog-backup', mode: 'readwrite', startIn: 'documents' });
      await saveHandle(h);
      hideBanner();
      toast('Backups will go to ' + h.name + '/' + ROOT_FOLDER);
      refreshStatus();
      return h;
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Could not use that folder: ' + e.message);
      return null;
    }
  }

  // Due when it's past 6 PM and today's backup hasn't run,
  // or when a whole earlier day was missed (catch up on next open).
  function isDue() {
    var now = new Date(), m = getMeta();
    var last = m.last;
    if (m.pending && now.getHours() >= BACKUP_HOUR) return true;   // changes still waiting this evening
    if (last === todayKey(now)) return false;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    var missedYesterday = !last || last < todayKey(y);
    return now.getHours() >= BACKUP_HOUR || missedYesterday;
  }
  // When the device has no entries (new phone, reinstalled app, cleared data),
  // offer to restore instead of making a backup.
  var emptyBannerShown = false;
  function showEmptyBanner() {
    if (pendingUpdate) { offerUpdates(pendingUpdate); return; }   // a ready-to-load backup beats "nothing here"
    emptyBannerShown = true;
    showBanner('No entries on this device yet. Have a backup? Tap to restore it', restore);
  }
  // Test links (spenderrr-staging, deploy-preview-N--…) are for trying new features:
  // no restore prompt and no automatic backups there.
  var isTestLink = location.hostname.indexOf('--') > 0 || location.hostname.indexOf('spenderrr-staging.') === 0;
  function check() {
    if (isTestLink) return;
    if (localRecords() === 0) { showEmptyBanner(); return; }
    if (emptyBannerShown) { emptyBannerShown = false; hideBanner(); }
    if (isDue()) runBackup('auto');
  }

  // ---------- Restore ----------
  function restoreFromText(text, metaPatch) {
    var b = parseBackup(text);
    if (!b) { toast('That file is not a Spenderrr backup.'); return false; }
    var when = b.createdAt ? new Date(b.createdAt).toLocaleString() : 'unknown date';
    var n = countIn(b.data), here = localRecords();
    if (!confirm('Restore the backup from ' + when + ' (' + records(n) + ')?\n\n' +
      'This replaces the ' + records(here) + ' on this device.')) return false;
    var meta = getMeta();
    Object.keys(metaPatch || {}).forEach(function (k) { meta[k] = metaPatch[k]; });
    meta.lastRecords = n;
    meta.pending = false;
    applying = true;
    try {
      localStorage.clear();                // also clears the sync record: next save merges afresh
      var clean = sanitizeData(b.data);         // only Spenderrr's own data, checked
      Object.keys(clean).forEach(function (k) { localStorage.setItem(k, clean[k]); });
      localStorage.setItem(META_KEY, JSON.stringify(meta));
    } finally { applying = false; }
    alert('Restored ' + records(n) + '. The app will reload now.');
    location.reload();
    return true;
  }

  // Restore list: every backup found, newest month first.
  async function findBackups(kind) {
    if (kind === 'drive') {
      await getDriveToken();
      await driveAccount();
      return listDriveBackups();
    }
    var h = await loadHandle();
    if (!h || !(await hasPermission(h, true))) {
      h = await window.showDirectoryPicker({ id: 'spendlog-backup', mode: 'readwrite', startIn: 'documents' });
      await saveHandle(h);
    }
    return listFolderBackups(h);
  }
  function monthLabel(name) { var d = monthDate(name); return d ? MONTHS[d.getMonth()] + ' ' + d.getFullYear() : name; }
  async function showBackupList(kind, box) {
    var list = box.querySelector('#slb-list');
    list.textContent = 'Looking for backups…';
    try {
      var items = await findBackups(kind);
      list.textContent = '';
      if (!items.length) {
        var acct = kind === 'drive' && getMeta().driveAccount;
        list.textContent = 'No backups found' + (kind === 'drive' ? ' in Google Drive' + (acct ? ' (' + (acct.email || acct.name) + ')' : '') : ' in this folder') + '.';
        return;
      }
      items.forEach(function (it) {
        var b = it.backup, when = b.createdAt ? new Date(b.createdAt).toLocaleString() : 'date unknown';
        var btn = el('button', { type: 'button', class: 'slb-item' });
        btn.appendChild(el('b', {}, monthLabel(it.month)));
        btn.appendChild(el('span', {}, records(countIn(b.data)) + ' · saved ' + when + ' · ' + it.source));
        btn.onclick = function () {
          closeChooser();
          var text = JSON.stringify({ app: 'Spenderrr', createdAt: b.createdAt, data: b.data, deleted: b.deleted || {} });
          restoreFromText(text, kind === 'drive' ? { drive: true, driveConsented: true, driveAccount: getMeta().driveAccount || null } : null);
        };
        list.appendChild(btn);
      });
    } catch (e) {
      list.textContent = e && e.name === 'AbortError' ? '' : 'Could not look for backups: ' + (e && e.message ? e.message : e);
    }
  }

  function restoreFromFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (file) file.text().then(function (t) { restoreFromText(t); });
    };
    input.click();
  }

  // Let the person pick where to restore from.
  function restore() {
    closeChooser();
    var wrap = el('div', { id: 'slb-modal', role: 'dialog', 'aria-label': 'Restore from backup' });
    var box = el('div', { class: 'box' });
    box.append(el('div', { style: 'font-weight:700;margin-bottom:4px' }, 'Restore from backup'),
      el('div', { id: 'slb-modal-note' }, 'This device has ' + records(localRecords()) + '. Pick where your backups are, then choose one:'));
    function add(label, fn, keepOpen) {
      var b = el('button', { type: 'button' }, label);
      b.onclick = function () { if (!keepOpen) closeChooser(); fn(); };
      box.appendChild(b);
    }
    if (driveConfigured()) add('Google Drive', function () { showBackupList('drive', box); }, true);
    if (supportsFolder) add('Backup folder on this device', function () { showBackupList('folder', box); }, true);
    add('Choose a file (Files app, Downloads)', restoreFromFile);
    box.appendChild(el('div', { id: 'slb-list', 'aria-live': 'polite' }));
    var cancel = el('button', { type: 'button', class: 'ghost' }, 'Cancel');
    cancel.onclick = closeChooser;
    box.appendChild(cancel);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeChooser(); });
    document.body.appendChild(wrap);
  }
  function closeChooser() { var m = document.getElementById('slb-modal'); if (m) m.remove(); }

  // ---------- UI ----------
  // Release version: read from <meta name="app-version"> in index.html (bump it on every release).
  var VERSION = (function () {
    var m = document.querySelector('meta[name="app-version"]');
    return (m && m.content) || 'unknown';
  })();

  var css = '' +
    '#slb-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}' +
    '#slb-actions .fab{position:static;height:40px;padding:0 16px 0 12px;font-size:14px;box-shadow:none;z-index:auto}' +
    '#slb-actions .fab svg{width:18px;height:18px}' +
    '#slb-fab{height:40px;border:0;border-radius:999px;padding:0 16px;background:#2e7d32;color:#fff;' +
    'font:700 14px var(--f-body,system-ui,sans-serif);display:inline-flex;align-items:center;gap:6px;cursor:pointer}' +
    '#slb-fab.floating{position:fixed;right:16px;top:16px;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
    '#slb-panel{position:fixed;right:16px;top:80px;z-index:99999;width:min(300px,calc(100vw - 32px));' +
    'background:#fff;color:#222;border-radius:12px;padding:14px;box-shadow:0 4px 20px rgba(0,0,0,.25);' +
    'font:14px var(--f-body,system-ui,sans-serif);display:none}' +
    '#slb-panel button{display:block;width:100%;margin-top:8px;padding:10px;border-radius:8px;border:1px solid #2e7d32;' +
    'background:#fff;color:#2e7d32;font:600 14px var(--f-body,system-ui,sans-serif)}' +
    '#slb-panel button.primary{background:#2e7d32;color:#fff}' +
    '#slb-status{font-size:12px;color:#555;line-height:1.4}' +
    '#slb-account{margin-top:10px;padding:10px 12px;border-radius:10px;background:#e8f5e9;border:1px solid #c8e6c9;font-size:13px;line-height:1.35;overflow-wrap:anywhere}' +
    '#slb-account .k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#2e7d32;margin-bottom:2px}' +
    '#slb-account .n{font-weight:700}#slb-account .e{color:#555}' +
    '@media (prefers-color-scheme:dark){#slb-account{background:#1f2e22;border-color:#2e4a33}#slb-account .k{color:#81c784}#slb-account .e{color:#aaa}}' +
    '#slb-version{font-size:11px;color:#777;margin-top:10px;text-align:center}' +
    '#slb-modal{position:fixed;inset:0;z-index:100000;background:rgba(10,15,25,.45);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '#slb-modal .box{width:min(340px,100%);background:#fff;color:#222;border-radius:14px;padding:16px;font:14px var(--f-body,system-ui,sans-serif);box-shadow:0 8px 30px rgba(0,0,0,.3)}' +
    '#slb-modal-note{font-size:13px;color:#555;margin-bottom:4px}' +
    '#slb-modal button{display:block;width:100%;margin-top:8px;padding:12px;border-radius:10px;border:1px solid #2e7d32;background:#2e7d32;color:#fff;font:600 14px var(--f-body,system-ui,sans-serif)}' +
    '#slb-modal button.ghost{background:transparent;color:#555;border-color:#ccc}' +
    '#slb-modal .box{max-height:86vh;overflow:auto}' +
    '#slb-list{margin-top:6px;font-size:13px;color:#555}' +
    '#slb-modal button.slb-item{background:#e8f5e9;color:#1b3d1f;border-color:#c8e6c9;text-align:left;font-weight:400}' +
    '#slb-modal button.slb-item b{display:block;font-weight:700}' +
    '#slb-modal button.slb-item span{display:block;font-size:12px;color:#4a5a4c;margin-top:2px}' +
    '@media (prefers-color-scheme:dark){#slb-modal .box{background:#1e1e1e;color:#eee}#slb-modal-note{color:#aaa}#slb-modal button.ghost{color:#bbb;border-color:#444}}' +
    '#slb-banner{background:#fff3e0;color:#5d4037;' +
    'border:1px solid #ffb74d;border-radius:10px;padding:12px;font:600 14px var(--f-body,system-ui,sans-serif);display:none;cursor:pointer}' +
    '#slb-banner.floating{position:fixed;left:16px;right:16px;top:12px;z-index:99999}' +
    '#slb-toast{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;background:#333;color:#fff;' +
    'padding:8px 14px;border-radius:8px;font:13px var(--f-body,system-ui,sans-serif);display:none;max-width:90vw}' +
    '@media (prefers-color-scheme:dark){#slb-panel{background:#1e1e1e;color:#eee}#slb-status,#slb-version{color:#aaa}' +
    '#slb-panel button{background:#1e1e1e;color:#81c784;border-color:#81c784}#slb-panel button.primary{background:#2e7d32;color:#fff}}';

  var bannerAction = null, toastTimer = null;

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  function placePanel(btn, panel) {
    var r = btn.getBoundingClientRect();
    panel.style.top = Math.round(r.bottom + 8) + 'px';
  }

  function buildUI() {
    var style = el('style'); style.textContent = css; document.head.appendChild(style);

    var fab = el('button', { id: 'slb-fab', type: 'button', 'aria-label': 'Backup and restore' }, 'Backup');
    var panel = el('div', { id: 'slb-panel' });
    var title = el('div', { style: 'font-weight:700;margin-bottom:6px' }, 'Auto backup');
    var status = el('div', { id: 'slb-status' });
    var bNow = el('button', { type: 'button', class: 'primary' }, 'Back up now');
    var bFolder = el('button', { type: 'button' }, 'Change backup folder');
    var bRestore = el('button', { type: 'button' }, 'Restore from backup');
    var ver = el('div', { id: 'slb-version' }, 'Version ' + VERSION);
    var driveBox = el('div', { id: 'slb-drive' });

    panel.append(title, status, bNow);
    if (supportsFolder) panel.append(bFolder);
    if (driveConfigured()) panel.append(driveBox);
    panel.append(bRestore, ver);

    // Put the Add button and the Backup button in a row under the Excel button,
    // so nothing sits at the bottom of the screen.
    var exportBtn = document.getElementById('exportBtn');
    var brand = exportBtn && exportBtn.closest('.brand');
    if (brand) {
      var row = el('div', { id: 'slb-actions' });
      var addBtn = document.getElementById('fab');
      if (addBtn) row.appendChild(addBtn);           // moves it; its click handler stays attached
      row.appendChild(fab);
      brand.insertAdjacentElement('afterend', row);
    } else {
      fab.classList.add('floating');
      document.body.appendChild(fab);
    }

    fab.onclick = function (e) {
      e.stopPropagation();
      var open = panel.style.display === 'block';
      if (!open) placePanel(fab, panel);
      panel.style.display = open ? 'none' : 'block';
      refreshStatus();
    };
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { panel.style.display = 'none'; });
    bNow.onclick = function () { runBackup(true); };
    bFolder.onclick = function () { chooseFolder(); };
    bRestore.onclick = function () { restore(); };

    var banner = el('div', { id: 'slb-banner', role: 'button' });
    banner.onclick = function () { if (bannerAction) bannerAction(); };
    // Show the banner inside the page, under the buttons, so it never covers the header.
    var actionsRow = document.getElementById('slb-actions');
    if (actionsRow) actionsRow.insertAdjacentElement('afterend', banner);
    else banner.classList.add('floating');
    var t = el('div', { id: 'slb-toast', role: 'status' });

    // Version in the footer too
    var foot = document.querySelector('footer.copy');
    if (foot) foot.appendChild(document.createTextNode(' · Version ' + VERSION));

    document.body.append(panel, t);
    renderDriveButtons();
    if (!banner.parentNode) document.body.appendChild(banner);
    refreshStatus();
  }

  function renderDriveButtons() {
    var box = document.getElementById('slb-drive');
    if (!box) return;
    box.textContent = '';
    if (driveOn()) {
      var a = getMeta().driveAccount;
      var card = el('div', { id: 'slb-account' });
      card.appendChild(el('div', { class: 'k' }, 'Google Drive account'));
      if (a && (a.name || a.email)) {
        if (a.name) card.appendChild(el('div', { class: 'n', id: 'slb-account-name' }, a.name));
        if (a.email) card.appendChild(el('div', { class: 'e', id: 'slb-account-email' }, a.email));
      } else {
        card.appendChild(el('div', { class: 'e', id: 'slb-account-email' }, 'Connected — account name shows after the next Drive backup'));
      }
      box.appendChild(card);
    }
    var b = el('button', { type: 'button' }, driveOn() ? 'Disconnect Google Drive' : 'Back up to Google Drive');
    b.onclick = driveOn() ? disconnectDrive : connectDrive;
    box.appendChild(b);
  }

  async function refreshStatus() {
    var s = document.getElementById('slb-status');
    if (!s) return;
    var m = getMeta();
    var where;
    if (supportsFolder) {
      var h = await loadHandle();
      where = h ? h.name + '/' + ROOT_FOLDER + '/' + monthFolder() + '/' + FILE_NAME : 'No folder chosen yet';
    } else if (canShareFile()) {
      where = 'Files app (tap Save to Files, open ' + ROOT_FOLDER + '/' + monthFolder() + ', then Replace)';
    } else {
      where = 'Downloads/' + ROOT_FOLDER + '_' + monthFolder() + '.json';
    }
    if (driveOn()) {
      var phonePart = supportsFolder && where !== 'No folder chosen yet' ? where + ' and ' : '';
      var acc = m.driveAccount && (m.driveAccount.email || m.driveAccount.name);
      where = phonePart + 'Google Drive' + (acc ? ' (' + acc + ')' : '') + '/' + ROOT_FOLDER + '/' + monthFolder();
    }
    var auto = driveOn() ? 'Backs up after each change while signed in to Google (about an hour after a tap), ' :
      supportsFolder ? 'Backs up after each change, ' : '';
    var how = 'This device: ' + records(localRecords()) + '. ' + auto +
      (auto ? 'and checks daily after ' : 'Reminds you daily after ');
    s.textContent = how + (BACKUP_HOUR > 12 ? BACKUP_HOUR - 12 + ' PM' : BACKUP_HOUR + ' AM') +
      '. Last backup: ' + (m.lastAt ? new Date(m.lastAt).toLocaleString() : 'never') + '.' +
      (m.pending ? ' Changes waiting — tap Back up now.' : '') + ' Saves to: ' + where;
  }

  function showBanner(text, action) {
    var b = document.getElementById('slb-banner'); if (!b) return;
    b.textContent = text; bannerAction = action; b.style.display = 'block';
    var panel = document.getElementById('slb-panel');      // don't let the panel cover the message
    if (panel) panel.style.display = 'none';
  }
  function hideBanner() { var b = document.getElementById('slb-banner'); if (b) b.style.display = 'none'; bannerAction = null; }
  function toast(msg) {
    var t = document.getElementById('slb-toast'); if (!t) return;
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }

  // ---------- Start ----------
  // When a new version of the offline file (sw.js) takes over, reload once so the
  // page, Android, iPhone and desktop all show the same latest release.
  function watchForUpdates() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    function ask() {
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update(); }).catch(function () {});
    }
    ask();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
  }

  // Show the app's display name everywhere on screen, including text the app builds later (e.g. Settings).
  var APP_NAME = 'Spenderrr';
  var OLD_NAMES = /Daily Spend Log|Spearmint Trackr/g;
  function renameIn(node) {
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var t;
    while ((t = walker.nextNode())) {
      if (OLD_NAMES.test(t.nodeValue)) { OLD_NAMES.lastIndex = 0; t.nodeValue = t.nodeValue.replace(OLD_NAMES, APP_NAME); }
      OLD_NAMES.lastIndex = 0;
    }
  }
  function watchAppName() {
    renameIn(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) renameIn(n);
          else if (n.nodeType === 3 && OLD_NAMES.test(n.nodeValue)) { OLD_NAMES.lastIndex = 0; n.nodeValue = n.nodeValue.replace(OLD_NAMES, APP_NAME); }
          OLD_NAMES.lastIndex = 0;
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Ask the browser not to clear this app's data when the device is low on space.
  function askToKeepData() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* ignore */ }
  }

  // ---------- Daily check-in ----------
  // Once a day the app asks the site for a tiny empty file, so the developer can count how many devices
  // use Spenderrr (/t/active) and how many back up to Google Drive (/t/drive-active) in Netlify's logs.
  // Nothing about you or your expenses is sent: no ids, no cookies, no query string.
  var CHECKIN_KEY = 'spenderrr.checkin';
  function dailyCheckIn() {
    if (typeof fetch !== 'function' || (navigator && navigator.onLine === false)) return;
    var d = new Date(), today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(), last = null;
    try { last = localStorage.getItem(CHECKIN_KEY); } catch (e) { return; }
    if (last === today) return;
    var ping = function (path) { return fetch(path, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); };
    ping('/t/active').then(function (r) {
      if (!r.ok) return;
      try { localStorage.setItem(CHECKIN_KEY, today); } catch (e) { /* ignore */ }
      if (driveOn()) ping('/t/drive-active').catch(function () { /* ignore */ });
    }).catch(function () { /* offline: try again next time */ });
  }

  function start() {
    dailyCheckIn();
    document.addEventListener('visibilitychange', function () { if (!document.hidden) dailyCheckIn(); });
    watchChanges();
    askToKeepData();
    watchForUpdates();
    watchAppName();
    buildUI();
    check();
    setInterval(check, 60 * 1000);                       // checks every minute while open
    setInterval(function () {                            // hide the restore offer as soon as entries exist
      if (emptyBannerShown && localRecords() > 0) { emptyBannerShown = false; hideBanner(); check(); }
    }, 3000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // Expose for debugging from the console
  window.SpendLogBackup = {
    version: VERSION, backupNow: function () { return runBackup('tap'); }, runAuto: function () { return runBackup('auto'); },
    runChange: function () { return runBackup('change'); }, mergeData: mergeData, mergeStores: mergeStores,
    fingerprints: fingerprints, parseBackup: parseBackup, reportBlob: reportBlob,
    reportPeriod: reportPeriod, periodLabel: periodLabel, reportData: reportData,
    backupText: backupText, excelBlob: excelBlob,
    restore: restore, isDue: isDue, check: check, records: localRecords, compareCounts: compareCounts, monthFolder: monthFolder
  };
})();

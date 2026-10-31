/*
 * Spenderrr – phone app bridge (Android / iPhone app only)
 * ---------------------------------------------------------
 * This file is added to the app bundle by build_app.py. It is NOT part of the website:
 * on the web (no Capacitor) it does nothing at all.
 *
 * Inside the installed app the page runs in the phone's built-in web view, which lacks a few
 * browser features the app uses. This file supplies them with native code, so index.html,
 * backup.js, ledger.js, reminders.js and whatsapp.js run unchanged:
 *
 *  - Folder backup: the browser folder picker becomes the phone's Documents folder, so backups go
 *    to Documents/spend-expense-backup/<Month_Year>/ exactly like on desktop Chrome.
 *  - Downloads (Excel reports, backup files, calendar files): saved to Documents/Spenderrr and
 *    offered in the share sheet (save to Drive, send on WhatsApp, open in Calendar…).
 *  - Share sheet: navigator.share / canShare backed by the native share sheet (with files).
 *  - WhatsApp, email, Google Calendar links: opened in the right app.
 *  - Bill reminders: real phone notifications, scheduled from the bills in Spenderrr.
 *  - Offline service worker: not needed (every file is inside the app), so it is switched off.
 *
 * Everything stays on the phone. Nothing here talks to a server.
 */
(function () {
  'use strict';

  var C = window.Capacitor;
  var isNative = !!(C && (typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : C.platform && C.platform !== 'web'));
  if (!isNative) return;

  var PLATFORM = typeof C.getPlatform === 'function' ? C.getPlatform() : (C.platform || 'android');
  var DOCS = 'DOCUMENTS', CACHE = 'CACHE', DATA = 'DATA';
  var DIR_KEY = 'spenderrr.native.backupDir';        // where folder backups go: DOCUMENTS, or DATA if Documents can't be written
  var NOTIF_KEY = 'spenderrr.native.notifications';  // ids of the bill notifications this app has scheduled
  var SAVE_FOLDER = 'Spenderrr';                     // Documents/Spenderrr: reports and files the app "downloads"
  var NOTIFY_HOUR = 9;                               // bill reminders arrive at 9 AM on the reminder day
  var PER_BILL = 3;                                  // schedule this many upcoming due dates per bill

  // ---------- Calling native plugins ----------
  function call(plugin, method, options) {
    var P = C.Plugins && C.Plugins[plugin];
    if (P && typeof P[method] === 'function') return P[method](options || {});
    if (typeof C.nativePromise === 'function') return C.nativePromise(plugin, method, options || {});
    return Promise.reject(new Error(plugin + '.' + method + ' is not available'));
  }
  var fs = function (method, options) { return call('Filesystem', method, options); };

  function domError(name, message) {
    try { return new DOMException(message, name); } catch (e) { var err = new Error(message); err.name = name; return err; }
  }
  function join(a, b) { return a ? a + '/' + b : b; }
  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '-').replace(/^\.+/, '').slice(0, 120) || 'file';
  }

  // ---------- Bytes <-> base64 ----------
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function base64ToBytes(b64) {
    var bin = atob(String(b64 || '').replace(/\s+/g, '')), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBlob(data, type) {
    if (data instanceof Blob) return data;
    if (data && typeof data === 'object' && data.type === 'write') return toBlob(data.data, type);
    return new Blob([data == null ? '' : data], { type: type || '' });
  }
  var MIME = {
    json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ics: 'text/calendar', csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png'
  };
  function mimeOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'; }

  // ---------- Small toast ----------
  function toast(text) {
    var t = document.getElementById('spx-native-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'spx-native-toast';
      t.setAttribute('role', 'status');
      t.style.cssText = 'position:fixed;left:50%;bottom:calc(88px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);' +
        'max-width:86vw;background:#162033;color:#fff;font:500 14px/1.35 "Plus Jakarta Sans",system-ui,sans-serif;' +
        'padding:10px 16px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:2147483646;text-align:center';
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  // ---------- Folder backup: the browser folder API on top of the phone's files ----------
  // backup.js asks for a folder with showDirectoryPicker() and then uses getDirectoryHandle,
  // getFileHandle, entries(), getFile() and createWritable(). These classes provide exactly that.
  function backupDir() { try { return localStorage.getItem(DIR_KEY) === DATA ? DATA : DOCS; } catch (e) { return DOCS; } }

  function stat(dir, path) { return fs('stat', { directory: dir, path: path }).catch(function () { return null; }); }

  function DirHandle(dir, path, name) {
    this.kind = 'directory';
    this.name = name;
    this.__spxNative = 1;     // plain data only, so the handle can be kept in IndexedDB like a real one
    this.__dir = dir;
    this.__path = path;
  }
  function FileHandle(dir, path, name) {
    this.kind = 'file';
    this.name = name;
    this.__spxNative = 1;
    this.__dir = dir;
    this.__path = path;
  }

  DirHandle.prototype.queryPermission = function () { return Promise.resolve('granted'); };
  DirHandle.prototype.requestPermission = function () { return Promise.resolve('granted'); };
  DirHandle.prototype.isSameEntry = function (o) { return Promise.resolve(!!o && o.__dir === this.__dir && o.__path === this.__path); };
  DirHandle.prototype.getDirectoryHandle = async function (name, opts) {
    var p = join(this.__path, name), s = await stat(this.__dir, p);
    if (s && s.type === 'directory') return new DirHandle(this.__dir, p, name);
    if (s) throw domError('TypeMismatchError', name + ' is a file');
    if (!opts || !opts.create) throw domError('NotFoundError', name + ' not found');
    await fs('mkdir', { directory: this.__dir, path: p, recursive: true });
    return new DirHandle(this.__dir, p, name);
  };
  DirHandle.prototype.getFileHandle = async function (name, opts) {
    var p = join(this.__path, name), s = await stat(this.__dir, p);
    if (s && s.type === 'file') return new FileHandle(this.__dir, p, name);
    if (s) throw domError('TypeMismatchError', name + ' is a folder');
    if (!opts || !opts.create) throw domError('NotFoundError', name + ' not found');
    await fs('writeFile', { directory: this.__dir, path: p, data: '', encoding: 'utf8', recursive: true });
    return new FileHandle(this.__dir, p, name);
  };
  DirHandle.prototype.removeEntry = async function (name, opts) {
    var p = join(this.__path, name), s = await stat(this.__dir, p);
    if (!s) throw domError('NotFoundError', name + ' not found');
    if (s.type === 'directory') await fs('rmdir', { directory: this.__dir, path: p, recursive: !!(opts && opts.recursive) });
    else await fs('deleteFile', { directory: this.__dir, path: p });
  };
  DirHandle.prototype.entries = function () {
    var self = this, list = null, i = 0;
    return {
      next: async function () {
        if (!list) {
          try { list = ((await fs('readdir', { directory: self.__dir, path: self.__path })) || {}).files || []; } catch (e) { list = []; }
        }
        while (i < list.length) {
          var f = list[i++], name = typeof f === 'string' ? f : f.name;
          if (!name) continue;
          var p = join(self.__path, name), type = typeof f === 'string' ? ((await stat(self.__dir, p)) || {}).type : f.type;
          return { done: false, value: [name, type === 'directory' ? new DirHandle(self.__dir, p, name) : new FileHandle(self.__dir, p, name)] };
        }
        return { done: true, value: undefined };
      },
      return: function () { return Promise.resolve({ done: true, value: undefined }); },
      [Symbol.asyncIterator]: function () { return this; }
    };
  };
  DirHandle.prototype.values = function () {
    var it = this.entries();
    return { next: async function () { var r = await it.next(); return r.done ? r : { done: false, value: r.value[1] }; },
      [Symbol.asyncIterator]: function () { return this; } };
  };
  DirHandle.prototype.keys = function () {
    var it = this.entries();
    return { next: async function () { var r = await it.next(); return r.done ? r : { done: false, value: r.value[0] }; },
      [Symbol.asyncIterator]: function () { return this; } };
  };
  DirHandle.prototype[Symbol.asyncIterator] = DirHandle.prototype.entries;

  FileHandle.prototype.queryPermission = DirHandle.prototype.queryPermission;
  FileHandle.prototype.requestPermission = DirHandle.prototype.requestPermission;
  FileHandle.prototype.isSameEntry = DirHandle.prototype.isSameEntry;
  FileHandle.prototype.getFile = async function () {
    var r = await fs('readFile', { directory: this.__dir, path: this.__path });
    var s = (await stat(this.__dir, this.__path)) || {};
    var bytes = base64ToBytes(r && r.data);
    return new File([bytes], this.name, { type: mimeOf(this.name), lastModified: Number(s.mtime) || Date.now() });
  };
  FileHandle.prototype.createWritable = async function () {
    var self = this, parts = [];
    return {
      write: async function (data) {
        if (data && typeof data === 'object' && data.type === 'truncate') { parts = []; return; }
        parts.push(toBlob(data));
      },
      truncate: async function () { parts = []; },
      close: async function () {
        var b64 = await blobToBase64(new Blob(parts));
        await fs('writeFile', { directory: self.__dir, path: self.__path, data: b64, recursive: true });
      },
      abort: async function () { parts = []; }
    };
  };

  function revive(h) {
    if (!h || !h.__spxNative) return h;
    return h.kind === 'file' ? new FileHandle(h.__dir, h.__path, h.name) : new DirHandle(h.__dir, h.__path, h.name);
  }

  // Can we write to the phone's Documents folder? Older Android needs the storage permission;
  // if Documents can't be used at all, backups go to the app's own storage instead.
  async function chooseBackupDir() {
    try { await fs('requestPermissions'); } catch (e) { /* not needed on newer phones */ }
    try {
      await fs('mkdir', { directory: DOCS, path: 'spend-expense-backup', recursive: true });
    } catch (e) {
      var exists = await stat(DOCS, 'spend-expense-backup');
      if (!exists) {
        try { localStorage.setItem(DIR_KEY, DATA); } catch (e2) { /* ignore */ }
        return DATA;
      }
    }
    try { localStorage.setItem(DIR_KEY, DOCS); } catch (e3) { /* ignore */ }
    return DOCS;
  }

  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true, writable: true,
    value: async function () {
      var dir = await chooseBackupDir();
      if (dir === DOCS) toast('Backups go to Documents › spend-expense-backup on this phone');
      else toast('Backups are kept in Spenderrr\'s own storage on this phone');
      return new DirHandle(dir, '', dir === DOCS ? 'Documents' : 'Spenderrr');
    }
  });
  // No "save as" dialog in the app: the app falls back to its download path, handled below.
  try { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: undefined }); } catch (e) { /* ignore */ }

  // backup.js remembers the chosen folder in IndexedDB. Our handles are stored as plain data, so give
  // the methods back when it is read again (the same thing a phone browser does with a real folder).
  (function reviveStoredHandles() {
    if (typeof IDBObjectStore === 'undefined' || typeof IDBRequest === 'undefined') return;
    var get = IDBObjectStore.prototype.get;
    var resultOf = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
    if (!resultOf || !resultOf.get) return;
    IDBObjectStore.prototype.get = function () {
      var req = get.apply(this, arguments);
      try {
        Object.defineProperty(req, 'result', { configurable: true, get: function () { return revive(resultOf.get.call(req)); } });
      } catch (e) { /* leave as is */ }
      return req;
    };
  })();

  // ---------- Saving "downloads" and the share sheet ----------
  async function writeFile(dir, path, blob) {
    var r = await fs('writeFile', { directory: dir, path: path, data: await blobToBase64(blob), recursive: true });
    return (r && r.uri) || ((await fs('getUri', { directory: dir, path: path })) || {}).uri;
  }
  // A copy in the app's cache is what the share sheet hands to other apps.
  function cacheCopy(name, blob) { return writeFile(CACHE, 'share/' + Date.now().toString(36) + '/' + safeName(name), blob); }

  function shareCancelled(err) {
    var m = String((err && (err.message || err.errorMessage)) || err || '').toLowerCase();
    return m.indexOf('cancel') >= 0 || m.indexOf('abort') >= 0 || m.indexOf('dismiss') >= 0;
  }
  async function nativeShare(data) {
    data = data || {};
    var files = [];
    for (var i = 0; i < (data.files || []).length; i++) {
      var f = data.files[i];
      files.push(await cacheCopy(f.name || 'file', f));
    }
    var opts = { dialogTitle: data.title || 'Share' };
    if (data.title) opts.title = data.title;
    if (data.text) opts.text = data.text;
    if (data.url) opts.url = data.url;
    if (files.length) opts.files = files;
    try {
      await call('Share', 'share', opts);
    } catch (err) {
      if (shareCancelled(err)) throw domError('AbortError', 'Share cancelled');
      throw err;
    }
  }
  try {
    Object.defineProperty(navigator, 'share', { configurable: true, writable: true, value: nativeShare });
    Object.defineProperty(navigator, 'canShare', { configurable: true, writable: true, value: function (d) { return !!d; } });
  } catch (e) { /* ignore */ }

  // A file the app would download: keep it in Documents/Spenderrr and open the share sheet with it.
  async function saveDownload(href, name) {
    name = safeName(name);
    var blob = await (await fetch(href)).blob();     // read right away: the app frees the link soon after
    var saved = false;
    try { await writeFile(DOCS, SAVE_FOLDER + '/' + name, blob); saved = true; } catch (e) { /* Documents not available */ }
    toast(saved ? 'Saved to Documents › ' + SAVE_FOLDER : 'Ready to share');
    try {
      await nativeShare({ title: name, files: [new File([blob], name, { type: blob.type || mimeOf(name) })] });
    } catch (err) {
      if (!err || err.name !== 'AbortError') toast('Could not open the share menu');
    }
  }

  // ---------- Opening other apps (WhatsApp, email, Google Calendar, web links) ----------
  function externalUrl(url) {
    if (!url) return null;
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return null; }
    if (/^(mailto|tel|sms|whatsapp|intent|geo|market):$/i.test(u.protocol)) return u.href;
    if (/^https?:$/i.test(u.protocol) && u.host !== location.host) return u.href;
    return null;
  }
  function openExternal(url) {
    return call('AppLauncher', 'openUrl', { url: url }).catch(function () {
      try { location.href = url; } catch (e) { /* ignore */ }
    });
  }

  var nativeOpen = window.open;
  window.open = function (url) {
    var ext = externalUrl(url);
    if (ext) { openExternal(ext); return null; }
    return nativeOpen.apply(window, arguments);
  };

  function handleAnchor(a) {
    if (!a || !a.getAttribute) return false;
    var href = a.getAttribute('href') || '';
    if (a.hasAttribute('download') && /^(blob:|data:)/i.test(a.href || href)) {
      saveDownload(a.href, a.getAttribute('download') || 'file').catch(function () { toast('Could not save the file'); });
      return true;
    }
    var ext = externalUrl(a.href || href);
    if (ext) { openExternal(ext); return true; }
    return false;
  }
  var nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (handleAnchor(this)) return;
    return nativeClick.apply(this, arguments);
  };
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (a && handleAnchor(a)) e.preventDefault();
  }, true);

  // ---------- No offline service worker inside the app ----------
  // Every file ships inside the app, so the website's offline cache would only risk showing an old
  // version after an app update. Registering becomes a no-op and any old registration is removed.
  (function noServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var fakeRegistration = {
      installing: null, waiting: null, active: null, scope: location.origin + '/',
      update: function () { return Promise.resolve(); },
      unregister: function () { return Promise.resolve(true); },
      addEventListener: function () {}, removeEventListener: function () {}
    };
    try {
      var container = navigator.serviceWorker;
      Object.defineProperty(container, 'register', { configurable: true, value: function () { return Promise.resolve(fakeRegistration); } });
      container.getRegistrations().then(function (list) { list.forEach(function (r) { r.unregister(); }); }).catch(function () {});
    } catch (e) { /* ignore */ }
  })();

  // ---------- Bill reminders as phone notifications ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function notificationId(billId, due) {
    var s = billId + '|' + ymd(due), h = 7;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (Math.abs(h) % 2000000000) + 1;
  }
  var EMOJI = { electricity: '💡', water: '🚰', gas: '🔥', internet: '🌐', phone: '📱', rent: '🏠', emi: '🏦', insurance: '🛡️', other: '📌' };
  function amountText(amount) {
    if (amount === null || amount === undefined || !isFinite(Number(amount)) || Number(amount) <= 0) return '';
    // Same currency setting and formatting as the app (reminders.js): INR, EUR, otherwise USD.
    var code = '';
    try { code = localStorage.getItem('spendlog.currency') || ''; } catch (e) { /* ignore */ }
    var c = code === 'INR' ? { sym: '₹', loc: 'en-IN' } : code === 'EUR' ? { sym: '€', loc: 'en-IE' } : { sym: '$', loc: 'en-US' };
    return c.sym + Number(amount).toLocaleString(c.loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function whenText(due, at) {
    var days = Math.round((dayStart(due) - dayStart(at)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === 7) return 'in a week';
    return 'in ' + days + ' days';
  }

  // The notifications Spenderrr should have scheduled right now, from the bills and their paid state.
  function plannedNotifications(now) {
    var R = window.SpenderrrReminders;
    if (!R || typeof R.bills !== 'function' || typeof R.status !== 'function' || typeof R.dueAround !== 'function') return [];
    now = now || new Date();
    var out = [];
    R.bills().forEach(function (bill) {
      var remind = [0, 1, 3, 7].indexOf(Number(bill.remind)) >= 0 ? Number(bill.remind) : 0;
      var st = null, paid = bill.paid && typeof bill.paid === 'object' ? bill.paid : {};
      try { st = R.status(bill, now); } catch (e) { st = null; }
      // Not overdue: the app's own status already knows the next unpaid due date (it counts early payments).
      // Overdue: the overdue one is shown in the app; remind about the coming ones that aren't marked paid.
      var due = st && st.due && st.due >= dayStart(now) ? st.due : R.dueAround(bill, now).next;
      for (var guard = 0; due && paid[ymd(due)] && guard < 24; guard++) due = R.dueAround(bill, due).next;
      for (var k = 0; k < PER_BILL && due; k++) {
        var at = new Date(due.getFullYear(), due.getMonth(), due.getDate() - remind, NOTIFY_HOUR, 0, 0);
        // Reminder day already gone (bill added late, or phone was off)? Remind on the due day instead.
        if (at <= now) at = new Date(due.getFullYear(), due.getMonth(), due.getDate(), NOTIFY_HOUR, 0, 0);
        if (at > now && !paid[ymd(due)]) {
          var amount = amountText(bill.amount);
          out.push({
            id: notificationId(bill.id, due),
            title: (EMOJI[bill.type] || '📌') + ' ' + bill.name + ' bill due ' + whenText(due, at),
            body: 'Due ' + due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
              (amount ? ' · about ' + amount : '') + '. Open Spenderrr to mark it paid.',
            schedule: { at: at.toISOString() },
            extra: { bill: bill.id, due: ymd(due) }
          });
        }
        due = R.dueAround(bill, due).next;
      }
    });
    return out;
  }

  var scheduling = Promise.resolve();
  function scheduleBillNotifications() {
    scheduling = scheduling.then(async function () {
      var wanted = plannedNotifications(new Date());
      var old = [];
      try { old = JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); } catch (e) { old = []; }
      if (!Array.isArray(old)) old = [];
      var wantedIds = wanted.map(function (n) { return n.id; }).sort().join(',');
      if (wantedIds === old.slice().sort().join(',') && localStorage.getItem(NOTIF_KEY + '.day') === ymd(new Date())) return;
      if (old.length) await call('LocalNotifications', 'cancel', { notifications: old.map(function (id) { return { id: id }; }) }).catch(function () {});
      var scheduled = [];
      if (wanted.length) {
        var perm = await call('LocalNotifications', 'checkPermissions').catch(function () { return {}; });
        if (perm.display !== 'granted' && perm.display !== 'denied') perm = await call('LocalNotifications', 'requestPermissions').catch(function () { return {}; });
        if (perm.display === 'granted') {
          await call('LocalNotifications', 'schedule', { notifications: wanted });
          scheduled = wanted.map(function (n) { return n.id; });
        }
      }
      try {
        localStorage.setItem(NOTIF_KEY, JSON.stringify(scheduled));
        localStorage.setItem(NOTIF_KEY + '.day', ymd(new Date()));
      } catch (e) { /* ignore */ }
    }).catch(function (e) { console.warn('Bill notifications not scheduled', e); });
    return scheduling;
  }

  // Reschedule when bills or expenses change (paying a bill moves its next reminder) and on reopen.
  var changeTimer = null;
  function soon() { clearTimeout(changeTimer); changeTimer = setTimeout(scheduleBillNotifications, 1500); }
  (function watchStorage() {
    var proto = Storage.prototype, setItem = proto.setItem, removeItem = proto.removeItem;
    var watched = ['spenderrr.bills', 'spendlog.v1'];
    proto.setItem = function (k) { var r = setItem.apply(this, arguments); if (this === window.localStorage && watched.indexOf(k) >= 0) soon(); return r; };
    proto.removeItem = function (k) { var r = removeItem.apply(this, arguments); if (this === window.localStorage && watched.indexOf(k) >= 0) soon(); return r; };
  })();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) soon(); });
  window.addEventListener('load', function () { setTimeout(scheduleBillNotifications, 800); });

  // ---------- For the app and the tests ----------
  window.SpenderrrNative = {
    platform: PLATFORM,
    backupDir: backupDir,
    folder: revive,
    plannedNotifications: plannedNotifications,
    scheduleBillNotifications: scheduleBillNotifications,
    share: nativeShare,
    openExternal: openExternal
  };
  document.documentElement.classList.add('spx-native', 'spx-' + PLATFORM);
})();

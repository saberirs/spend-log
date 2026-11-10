#!/usr/bin/env python3
"""
Spenderrr – security and privacy tests
======================================

What is covered:
  - Settings > Restore: a backup file is checked before the app adds anything from it.
    Code hidden in notes, names or amounts never runs or turns into page elements, broken entries are
    dropped, built-in names such as "__proto__" cannot change how the app works, and a bad currency is ignored.
  - A normal backup still restores completely (expenses, splits, friends, settle-ups, currency).
  - Files that are not backups are refused and change nothing.
  - Security headers: every page and file is served with the full set, with safe values
    (no inline or eval scripts, no wildcards, no embedding in other sites, HTTPS only, tight referrer).
  - Project files (tests, docs, build script, package lists) are not served by the website.
  - Customer data never leaves the device: with normal use (adding, viewing, Excel report, folder backup,
    report card) no request carries an amount, note or friend name, nothing goes to another site,
    no cookies are set, the daily check-in sends nothing, and nothing private is written to the console.
  - Google Drive backup: data goes only to Google Drive with the user's sign-in; the sign-in token and
    the Google account name/email are never kept in permanent storage or written into a backup file.

Run:
    python testCase/test_security.py
    python testCase/test_security.py restore      # only tests whose name contains "restore"
"""
import json
import os
import re
import sys
import time
import traceback
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_args = sys.argv[1:]
sys.argv = [sys.argv[0]]
import run_tests as T                    # noqa: E402
sys.argv += _args

from playwright.sync_api import sync_playwright   # noqa: E402

HEADED = '--headed' in sys.argv
FILTERS = [a for a in _args if not a.startswith('--')]
TESTS = []

SECRET_NOTE = 'Rent-for-flat-7781'
SECRET_FRIEND = 'Zelda Quill'
SECRET_AMOUNT = '4321.09'


def test(fn):
    TESTS.append(fn)
    return fn


def stored(d):
    return json.loads(d.ev("localStorage.getItem('spendlog.v1') || '{}'"))


def open_settings_restore(d):
    d.page.click('#settingsBtn')
    d.page.wait_for_selector('#restoreIn', state='attached')


def restore_app_file(d, payload, name='Spend Log backup 2026-11-10.json'):
    """Pick a file in Settings > Restore, the way a person does."""
    body = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
    if isinstance(body, str):
        body = body.encode('utf-8')
    open_settings_restore(d)
    d.page.set_input_files('#restoreIn', files=[{'name': name, 'mimeType': 'application/json', 'buffer': body}])
    d.page.wait_for_timeout(700)


def last_toast(d):
    return d.ev("""() => [...document.querySelectorAll('.toast, #slb-toast')].map(t => t.textContent).join(' | ')""")


def now_ms(d):
    return d.ev('Date.now()')


# ---------------------------------------------------------------------------
# Settings > Restore
# ---------------------------------------------------------------------------
@test
def restore_file_is_checked_before_the_app_adds_it(b, srv):
    d = T.Device(b, srv).open()
    d.seed(1)
    t = now_ms(d)
    evil = (
        '{"expenses": ['
        '{"id": "ok1", "amount": 12.5, "cat": "lunch", "note": "<img src=x onerror=\\"window.__pwn=1\\">Lunch at work",'
        ' "ts": %(t)d, "source": "manual", "split": null},'
        '{"id": "__proto__", "amount": 5, "ts": %(t)d},'
        '{"id": "toString", "amount": 5, "ts": %(t)d},'
        '{"id": "bad-amount", "amount": "<b>9</b>", "ts": %(t)d},'
        '{"id": "negative", "amount": -4, "ts": %(t)d},'
        '{"id": "no-time", "amount": 3},'
        '{"id": "huge", "amount": 1e12, "ts": %(t)d},'
        '{"id": "split1", "amount": 30, "cat": "dinner", "ts": %(t)d,'
        ' "split": {"paidBy": "<svg onload=window.__pwn=3>", "mode": "equal", "my": "<i>x</i>", "parts": "not a list"}},'
        '{"id": "cat1", "amount": 7, "cat": "\\"><script>window.__pwn=4</script>", "ts": %(t)d,'
        ' "__proto__": {"polluted": true}, "extra": {"constructor": {"prototype": {"polluted": true}}}}'
        '],'
        ' "messages": [{"id": "m1", "text": "<img src=x onerror=window.__pwn=2>", "ts": %(t)d}, {"text": "no id"}],'
        ' "people": [{"name": "<b>Bob</b>"}, {"name": "constructor"}, {"name": "%(long)s"}],'
        ' "settlements": [{"id": "s1", "name": "Bob", "amt": "x", "dir": "in", "ts": %(t)d}],'
        ' "currency": "<script>",'
        ' "__proto__": {"polluted": true},'
        ' "unknownKey": "junk"}'
    ) % {'t': t, 'long': 'A' * 80}
    restore_app_file(d, evil)

    data = stored(d)
    ids = sorted(x['id'] for x in data.get('e', []))
    assert ids == ['cat1', 'ok1', 'seed0', 'split1'], 'Only the valid entries may be added: %s' % ids
    by = {x['id']: x for x in data['e']}
    assert by['cat1']['cat'] == 'other', 'An unknown category must become Other: %r' % by['cat1']['cat']
    assert '__proto__' not in json.dumps(by['cat1']) and 'constructor' not in json.dumps(by['cat1']), by['cat1']
    sp = by['split1']['split']
    assert isinstance(sp['parts'], list) and sp['my'] == 0, 'A broken split must be repaired: %s' % sp
    assert [m['id'] for m in data.get('m', [])] == ['m1'], data.get('m')
    names = [p['name'] for p in data.get('p', [])]
    assert 'constructor' not in names and all(len(n) <= 30 for n in names), names
    assert not data.get('s'), 'A settle-up with a broken amount must be dropped: %s' % data.get('s')
    assert 'unknownKey' not in json.dumps(data), 'Unknown fields must not be stored'

    assert d.ev("localStorage.getItem('spendlog.currency') || 'USD'") in ('USD', 'INR', 'EUR'), 'Bad currency was saved'
    assert d.ev('({}).polluted') is None and d.ev('Object.prototype.polluted') is None, 'Object prototype was changed'

    # Every screen draws the restored data as plain text: nothing runs, no element is created from it
    d.page.click('#closeSheet') if d.page.query_selector('#closeSheet') else None
    for view in ['recent', 'week', 'month', 'split', 'messages']:
        if d.page.query_selector('button[data-view=%s]' % view):
            d.page.click('button[data-view=%s]' % view)
            d.page.wait_for_timeout(200)
            assert not d.ev('window.__pwn'), 'Code from the backup ran on the %s screen' % view
            found = d.ev("""() => [...document.querySelectorAll('img[src="x"], svg[onload], #main script, b, i')]
                .filter(e => e.tagName === 'IMG' || e.tagName === 'svg' || e.tagName === 'SCRIPT' ||
                             (e.tagName === 'B' && e.textContent === 'Bob') || (e.tagName === 'I' && e.textContent === 'x'))
                .map(e => e.outerHTML.slice(0, 120))""")
            assert not found, \
                'An element from the backup file was created on the %s screen: %s' % (view, found)
    d.page.click('button[data-view=recent]')
    d.page.wait_for_timeout(200)
    assert '<img src=x' in d.ev('document.body.innerText'), 'The note should show as plain text'
    d.close()   # no page errors, no blocked scripts


@test
def restore_of_a_normal_backup_still_brings_everything_back(b, srv):
    d = T.Device(b, srv).open()
    t = now_ms(d)
    good = {
        'version': 1,
        'expenses': [
            {'id': 'a1', 'amount': 20, 'cat': 'lunch', 'sub': None, 'note': 'Team lunch', 'ts': t - 3600000,
             'source': 'manual', 'createdAt': t - 3600000, 'split': None},
            {'id': 'a2', 'amount': 90, 'cat': 'dinner', 'sub': None, 'note': 'Pizza night', 'ts': t - 7200000,
             'source': 'manual', 'createdAt': t - 7200000,
             'split': {'paidBy': 'Me', 'mode': 'equal', 'my': 30, 'parts': [{'name': 'Me', 'amt': 30}, {'name': 'Ana', 'amt': 30},
                                                                           {'name': 'Raj', 'amt': 30}]}},
            {'id': 'a3', 'amount': 145.5, 'cat': 'utilities', 'sub': 'Electricity', 'note': '', 'ts': t - 86400000,
             'source': 'manual', 'createdAt': t - 86400000, 'split': None},
        ],
        'messages': [],
        'people': [{'name': 'Ana', 'addedAt': t - 900000000}, {'name': 'Raj', 'addedAt': t - 800000000}],
        'settlements': [{'id': 'st1', 'name': 'Ana', 'amt': 10, 'dir': 'in', 'ts': t - 1000}],
        'currency': 'INR',
    }
    restore_app_file(d, good)
    data = stored(d)
    assert sorted(x['id'] for x in data['e']) == ['a1', 'a2', 'a3'], data['e']
    a2 = next(x for x in data['e'] if x['id'] == 'a2')
    assert a2['split']['parts'] == good['expenses'][1]['split']['parts'] and a2['split']['my'] == 30, a2['split']
    assert next(x for x in data['e'] if x['id'] == 'a3')['sub'] == 'Electricity'
    assert sorted(p['name'] for p in data['p']) == ['Ana', 'Raj'], data['p']
    assert [s['id'] for s in data['s']] == ['st1'], data['s']
    assert d.ev("localStorage.getItem('spendlog.currency')") == 'INR'
    assert 'Restored 3 expenses' in last_toast(d), last_toast(d)
    # Restoring the same file again adds nothing twice, and picking the same file again still works
    restore_app_file(d, good)
    assert len(stored(d)['e']) == 3 and 'Nothing new' in last_toast(d), last_toast(d)
    d.close()


@test
def restore_refuses_files_that_are_not_backups(b, srv):
    d = T.Device(b, srv).open()
    d.seed(2)
    before = json.dumps(stored(d), sort_keys=True)
    for body in [b'this is not json', b'{"data": "x"}', b'[]', b'{"expenses": "nope"}', b'\xff\xfe\x00garbage']:
        restore_app_file(d, body, name='notes.txt')
        assert "isn't a Spend Log backup" in last_toast(d), (body, last_toast(d))
        if d.page.query_selector('#closeSheet'):
            d.page.click('#closeSheet')
    assert json.dumps(stored(d), sort_keys=True) == before, 'A refused file must not change anything'
    too_big = d.ev("SpendLogBackup.cleanAppBackup('{\"expenses\":[]}' + ' '.repeat(21 * 1024 * 1024))")
    assert too_big is None, 'A file over 20 MB must be refused'
    d.close()


# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------
REQUIRED = {
    'X-Content-Type-Options': lambda v: v == 'nosniff',
    'X-Frame-Options': lambda v: v == 'DENY',
    'Referrer-Policy': lambda v: v in ('no-referrer', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin'),
    'Strict-Transport-Security': lambda v: int(re.search(r'max-age=(\d+)', v).group(1)) >= 31536000 and 'includeSubDomains' in v,
    'Cross-Origin-Opener-Policy': lambda v: v in ('same-origin', 'same-origin-allow-popups'),
    'Cross-Origin-Resource-Policy': lambda v: v == 'same-origin',
    'X-Permitted-Cross-Domain-Policies': lambda v: v == 'none',
    'Permissions-Policy': lambda v: all(f + '=()' in v for f in ('camera', 'microphone', 'geolocation', 'payment', 'usb', 'browsing-topics')),
}


def check_csp(csp):
    d = {}
    for part in csp.split(';'):
        bits = part.split()
        if bits:
            d[bits[0]] = bits[1:]
    for k, want in [('default-src', ["'self'"]), ('object-src', ["'none'"]), ('base-uri', ["'none'"]),
                    ('form-action', ["'none'"]), ('frame-ancestors', ["'none'"])]:
        assert d.get(k) == want, '%s must be %s, is %s' % (k, want, d.get(k))
    for k, vals in d.items():
        for v in vals:
            assert v not in ('*', 'http:', 'https:', 'data:') or (k == 'img-src' and v == 'data:'), \
                'CSP %s allows too much: %s' % (k, v)
            assert not v.startswith('http://'), 'CSP %s allows an insecure address: %s' % (k, v)
    assert "'unsafe-inline'" not in d['script-src'] and "'unsafe-eval'" not in d['script-src'], d['script-src']
    hosts = [v for k in ('script-src', 'connect-src', 'frame-src', 'style-src') for v in d.get(k, []) if v.startswith('https://')]
    assert all(urlparse(h).hostname in ('accounts.google.com', 'www.googleapis.com') for h in hosts), \
        'Only Google sign-in and Google Drive may be reached: %s' % hosts


@test
def security_headers_are_complete_on_every_file(b, srv):
    d = T.Device(b, srv).open()
    paths = ['/', '/index.html', '/privacy.html', '/backup.js', '/ledger.js', '/reminders.js', '/whatsapp.js',
             '/sw.js', '/manifest.webmanifest', '/xlsx.full.min.js', '/t/active', '/404.html',
             '/fonts/plus-jakarta-sans-latin-400-normal.woff2']
    for p in paths:
        r = d.page.request.get(srv.url + p)
        assert r.status == 200, '%s answered %d' % (p, r.status)
        h = r.headers
        for name, ok in REQUIRED.items():
            v = h.get(name.lower())
            assert v is not None, '%s is missing on %s' % (name, p)
            assert ok(v), '%s has an unsafe value on %s: %s' % (name, p, v)
        check_csp(h['content-security-policy'])
        assert h.get('access-control-allow-origin') is None, 'Other sites must not be allowed to read %s' % p
        assert 'set-cookie' not in h, 'No cookies: %s' % p
    t = d.page.request.get(srv.url + '/t/active').headers
    assert t.get('cache-control') == 'no-store' and 'text/plain' in t.get('content-type', ''), t
    assert d.page.request.get(srv.url + '/sw.js').headers.get('cache-control') == 'no-cache'
    d.close()


@test
def project_files_are_not_served(b, srv):
    d = T.Device(b, srv).open()
    for p in ['/testCase/run_tests.py', '/testCase/test_security.py', '/tests/update_script_hashes.py', '/docs/RELEASE.md',
              '/docs/v2-architecture.md', '/build.py', '/package.json', '/README.md', '/.github/workflows/release-backups.yml',
              '/.gitignore', '/_headers', '/_redirects']:
        r = d.page.request.get(srv.url + p)
        assert r.status == 404, '%s must not be served (got %d)' % (p, r.status)
        assert 'Page not found' in r.text() and 'def ' not in r.text(), p
        assert r.headers.get('x-frame-options') == 'DENY', 'The not-found page needs the security headers too'
    for p in ['/', '/privacy.html', '/backup.js', '/sw.js', '/manifest.webmanifest', '/t/active', '/t/drive-active']:
        assert d.page.request.get(srv.url + p).status == 200, p + ' must still work'
    d.close()


# ---------------------------------------------------------------------------
# Customer data stays on the device
# ---------------------------------------------------------------------------
def watch(d):
    log = {'requests': [], 'console': []}
    d.ctx.on('request', lambda r: log['requests'].append(r))
    d.page.on('console', lambda m: log['console'].append(m.text))
    return log


def put_private_entries(d):
    t = now_ms(d)
    d.ev("""([t, note, friend, amt]) => {
      const e = [
        { id: 'p1', amount: Number(amt), cat: 'household', sub: null, note: note, ts: t - 60000, source: 'manual', createdAt: t, split: null },
        { id: 'p2', amount: 60, cat: 'dinner', sub: null, note: 'Dinner with ' + friend, ts: t - 120000, source: 'manual', createdAt: t,
          split: { paidBy: 'Me', mode: 'equal', my: 30, parts: [{ name: 'Me', amt: 30 }, { name: friend, amt: 30 }] } } ];
      localStorage.setItem('spendlog.v1', JSON.stringify({ e: e, m: [], p: [{ name: friend, addedAt: t }], s: [] }));
    }""", [t, SECRET_NOTE, SECRET_FRIEND, SECRET_AMOUNT])
    d.reload()


def leaks(text):
    return [s for s in (SECRET_NOTE, SECRET_FRIEND, SECRET_AMOUNT, '4,321.09') if s in (text or '')]


@test
def customer_data_never_leaves_the_device(b, srv):
    d = T.Device(b, srv, clock=T.OCT_EVENING).open()
    d.ev("localStorage.removeItem('spenderrr.checkin')")
    log = watch(d)
    put_private_entries(d)
    for view in ['recent', 'week', 'month', 'split']:
        d.page.click('button[data-view=%s]' % view)
        d.page.wait_for_timeout(150)
    d.add_expense(9.99, 'Snacks')
    d.ev("async () => { await SpendLogBackup.reportBlob('all', 'All entries'); }")
    d.backup_now()                                          # folder backup on the device
    d.ev("window.SpenderrrBills && SpenderrrBills.openReport && SpenderrrBills.openReport('week')")
    d.page.wait_for_timeout(300)
    origin = urlparse(srv.url).netloc
    seen = []
    for r in log['requests']:
        u = urlparse(r.url)
        if u.scheme in ('data', 'blob'):
            continue
        seen.append(r.url)
        assert u.netloc == origin, 'Request to another site without the user asking: %s' % r.url
        assert r.method == 'GET', 'The app must not send data to the website (%s %s)' % (r.method, r.url)
        assert not r.post_data, 'Request carried a body: %s' % r.url
        assert not leaks(r.url), 'Private data in a web address: %s' % r.url
        if u.path.startswith('/t/'):
            assert not u.query, 'The daily check-in must not carry anything: %s' % r.url
            assert 'cookie' not in r.headers, 'The daily check-in must not send cookies'
    assert any('/t/active' in u for u in seen), 'The daily check-in should run (and is checked above)'
    assert d.ctx.cookies() == [], 'The app must not set cookies: %s' % d.ctx.cookies()
    bad = [m for m in log['console'] if leaks(m)]
    assert not bad, 'Private data written to the browser console: %s' % bad
    d.close()


@test
def drive_backup_keeps_sign_in_and_account_private(b, srv):
    d = T.Device(b, srv, kind='iphone', clock=T.OCT_EVENING).open()
    log = watch(d)
    put_private_entries(d)
    T.connect_drive(d)
    d.backup_now()
    assert d.drive.tree(), 'The backup should be on Google Drive'
    origin = urlparse(srv.url).netloc
    for r in log['requests']:
        u = urlparse(r.url)
        if u.scheme in ('data', 'blob') or u.netloc == origin:
            if u.netloc == origin:
                assert not r.post_data and not leaks(r.url), 'Private data sent to the website: %s' % r.url
            continue
        assert u.hostname in ('www.googleapis.com', 'accounts.google.com'), 'Data sent somewhere other than Google: %s' % r.url
        body = (r.post_data_buffer or b'').decode('utf-8', 'ignore')
        if leaks(body):
            assert u.hostname == 'www.googleapis.com' and r.headers.get('authorization', '').startswith('Bearer '), \
                'Backup data may only go to the signed-in Google Drive: %s' % r.url
    local = d.ev('JSON.stringify(Object.assign({}, localStorage))')
    assert 'test-token' not in local, 'The Google sign-in token must not be kept in permanent storage'
    for name, body in d.drive.tree().items():
        if name.endswith('.json'):
            assert 'test-token' not in body, 'Sign-in token written into the backup file'
            assert T.TEST_ACCOUNT['emailAddress'] not in body and T.TEST_ACCOUNT['displayName'] not in body, \
                'The Google account name/email must not be written into the backup file (%s)' % name
    folder = json.dumps(d.folder() or {})
    assert T.TEST_ACCOUNT['emailAddress'] not in folder and 'test-token' not in folder, 'Account details in the folder backup'
    d.close()


# ---------------------------------------------------------------------------
def main():
    chosen = [t for t in TESTS if not FILTERS or any(f in t.__name__ for f in FILTERS)]
    passed, failed = [], []
    srv = T.AppServer(T.APP_DIR)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED)
        print('Spenderrr security tests — %d to run against %s\n' % (len(chosen), T.APP_DIR))
        for t in chosen:
            name = t.__name__.replace('_', ' ')
            start = time.time()
            try:
                t(browser, srv)
                passed.append(name)
                print('  PASS  %s  (%.1fs)' % (name, time.time() - start))
            except Exception as e:
                failed.append((name, e))
                print('  FAIL  %s\n        %s' % (name, str(e).strip().splitlines()[0] if str(e).strip() else repr(e)))
                if '--verbose' in sys.argv:
                    traceback.print_exc()
        browser.close()
    srv.stop()
    print('\n%d passed, %d failed' % (len(passed), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

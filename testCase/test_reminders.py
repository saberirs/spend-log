#!/usr/bin/env python3
"""
Spenderrr – tests for bill reminders and weekly / monthly report cards (reminders.js)
====================================================================================

Runs on Android, iPhone and desktop screen sizes (Chromium), with the clock fixed so
due dates and report days are always the same.

Run:
    python testCase/test_reminders.py                 # all tests
    python testCase/test_reminders.py calendar        # only tests whose name contains "calendar"
    python testCase/test_reminders.py --headed        # watch the browser
"""
import json
import os
import re
import sys
import threading
import time
import traceback
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
HEADED = '--headed' in sys.argv
FILTERS = [a for a in sys.argv[1:] if not a.startswith('--')]

DEVICES = {
    'android': dict(viewport={'width': 412, 'height': 915}, device_scale_factor=2.6, is_mobile=True, has_touch=True,
                    user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'),
    'iphone': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                   user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'small': dict(viewport={'width': 320, 'height': 640}, is_mobile=True, has_touch=True),
    'desktop': dict(viewport={'width': 1280, 'height': 800}),
}
MON_NOV_2 = datetime(2026, 11, 2, 10, 0)      # Monday and the 2nd: both report cards show
THU_OCT_15 = datetime(2026, 10, 15, 10, 0)    # neither report card shows


def ts(y, m, d, h=12):
    return int(datetime(y, m, d, h).timestamp() * 1000)


def expense(i, amount, cat, y, m, d, sub=None, note='', split_my=None):
    e = {'id': i, 'amount': amount, 'cat': cat, 'note': note, 'ts': ts(y, m, d), 'createdAt': ts(y, m, d)}
    if sub:
        e['sub'] = sub
    if split_my is not None:
        e['split'] = {'paidBy': 'Me', 'parts': [{'name': 'Me', 'amt': split_my}], 'my': split_my}
    return e


def bill(i, name, cat='utilities', sub=None, freq='monthly', day=3, month=0, remind=3, amount=None, typ=None, paid=None, created=(2026, 8, 1)):
    return {'id': i, 'type': typ or name.lower(), 'name': name, 'cat': cat, 'sub': sub if sub is not None else name,
            'amount': amount, 'freq': freq, 'day': day, 'month': month, 'remind': remind, 'paid': paid or {},
            'createdAt': ts(*created)}


# ---------- Test harness ----------
class Server:
    def __init__(self):
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        handler = partial(Quiet, directory=APP_DIR)
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.url = 'http://127.0.0.1:%d/' % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


class Device:
    def __init__(self, browser, srv, kind='android', clock=MON_NOV_2):
        self.ctx = browser.new_context(accept_downloads=True, **DEVICES[kind])
        self.page = self.ctx.new_page()
        self.page.clock.install(time=clock)
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.on('console', lambda m: self.errors.append(m.text) if m.type == 'error' else None)
        self.srv = srv

    def open(self, data=None, bills=None, extra=None):
        self.page.goto(self.srv.url)
        self.page.wait_for_selector('#main')
        store = {}
        if data is not None:
            store['spendlog.v1'] = json.dumps({'e': data, 'm': [], 'p': [], 's': []})
        if bills is not None:
            store['spenderrr.bills'] = json.dumps({'b': bills})
        store.update(extra or {})
        if store:
            self.page.evaluate('s => Object.keys(s).forEach(k => localStorage.setItem(k, s[k]))', store)
            self.page.reload()
        self.page.wait_for_function('() => window.SpenderrrReminders && document.querySelector("#main .item, #main .empty, #main section")')
        self.page.wait_for_timeout(400)
        return self

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def cards(self):
        return self.js("[...document.querySelectorAll('#main > section[id^=spx-]')].map(s => s.id).filter(i => i !== 'spx-summary')")

    def text(self, sel):
        return self.page.inner_text(sel)

    def close(self):
        assert not self.errors, 'Errors on the page: %s' % self.errors[:3]
        self.ctx.close()


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


# ---------- Bills ----------
@test
def add_bill_from_settings_on_every_device(b, srv):
    for kind in ['android', 'iphone', 'desktop']:
        d = Device(b, srv, kind=kind).open()
        d.page.click('#settingsBtn')
        d.page.wait_for_selector('#spxRemSection')
        d.page.click('#spxManageBills')
        d.page.click('#spxAddBill')
        d.page.locator('#spxBillType button', has_text='Internet').click()
        assert d.page.input_value('#spxBillName') == 'Internet', 'Choosing a type fills in the name'
        d.page.fill('#spxBillAmt', '60')
        d.page.select_option('#spxBillDay', '4')
        d.page.locator('#spxBillRemind button', has_text='3 days before').click()
        d.page.click('#spxSaveBill')
        assert d.page.locator('#spx-cal').count() == 1, 'Calendar choice opens after adding a bill'
        d.page.locator('#spx-cal .x').click()
        d.page.locator('#spx-bills-sheet .x').click()
        saved = d.js("SpenderrrReminders.bills()")
        assert len(saved) == 1 and saved[0]['cat'] == 'utilities' and saved[0]['sub'] == 'Internet' and saved[0]['day'] == 4, saved
        card = d.text('#spx-bills')
        assert 'Internet' in card and 'Due in 2 days' in card, card
        assert "It's time for your internet bill" in card, 'No history yet: simple reminder'
        d.close()


@test
def bill_form_checks_name_and_amount(b, srv):
    d = Device(b, srv).open()
    d.js('SpenderrrReminders.openBillForm(null)')
    d.page.locator('#spxBillType button', has_text='Other').click()
    d.page.fill('#spxBillName', '')
    d.page.click('#spxSaveBill')
    assert 'name' in d.text('#spx-bill-form .spx-err').lower()
    d.page.fill('#spxBillName', 'Gym <b>')
    d.page.fill('#spxBillAmt', 'abc')
    d.page.click('#spxSaveBill')
    assert 'number' in d.text('#spx-bill-form .spx-err').lower()
    d.page.fill('#spxBillAmt', '')
    d.page.click('#spxSaveBill')
    saved = d.js('SpenderrrReminders.bills()')
    assert saved[0]['name'] == 'Gym b' and saved[0]['amount'] is None, saved
    d.close()


@test
def due_dates_for_every_repeat_option(b, srv):
    d = Device(b, srv).open()
    cases = [
        (bill('b_mon00001', 'Electricity', day=3), '2026-11-03'),
        (bill('b_two00001', 'Water', freq='bimonthly', day=4, month=0), '2026-11-04'),   # Jan, Mar, May, Jul, Sep, Nov
        (bill('b_two00002', 'Gas', freq='bimonthly', day=1, month=11), '2026-12-01'),    # Dec, Feb, Apr…
        (bill('b_qtr00001', 'Phone', freq='quarterly', day=-1, month=1), '2026-11-30'),  # Feb, May, Aug, Nov, last day
        (bill('b_yr000001', 'Insurance', cat='insurance', sub='', freq='yearly', day=15, month=5), '2027-06-15'),
    ]
    for bl, want in cases:
        got = d.js("b => { const a = SpenderrrReminders.dueAround(b, new Date()); const x = a.next; return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }", bl)
        assert got == want, '%s %s: expected %s, got %s' % (bl['name'], bl['freq'], want, got)
    # Last day of the month in February
    feb = d.js("b => SpenderrrReminders.dueAround(b, new Date(2027, 1, 10)).next.getDate()", bill('b_last0001', 'Rent', cat='household', sub='', day=-1))
    assert feb == 28, feb
    d.close()


@test
def last_months_bill_and_first_time_message(b, srv):
    d = Device(b, srv).open(
        data=[expense('e1', 92.4, 'utilities', 2026, 10, 3, sub='Electricity')],
        bills=[bill('b_elec0001', 'Electricity', day=3), bill('b_watr0001', 'Water', freq='bimonthly', day=4, month=10)])
    card = d.text('#spx-bills')
    assert "Last month's bill: $92.40 · paid Oct 3" in card, card
    assert 'Due tomorrow · Nov 3' in card, card
    assert "It's time for your water bill" in card, card
    d.page.click('#spxAllBills')
    sheet = d.text('#spx-bills-sheet')
    assert 'Every 2 months' in sheet and 'No payment logged yet' in sheet, sheet
    d.close()


@test
def mark_paid_fills_the_app_form_and_saves(b, srv):
    d = Device(b, srv).open(
        data=[expense('e1', 92.4, 'utilities', 2026, 10, 3, sub='Electricity')],
        bills=[bill('b_elec0001', 'Electricity', day=3)])
    d.page.click('.spx-bill[data-bill=b_elec0001] .spx-pay')
    d.page.wait_for_selector('#fAmt')
    d.page.wait_for_timeout(200)
    assert d.page.input_value('#fAmt') == '92.4', 'Last bill amount is filled in'
    assert d.page.input_value('#fNote') == 'Electricity bill'
    pressed = d.js("[...document.querySelectorAll('#sheetRoot .chip[aria-pressed=true]')].map(c => c.textContent.trim())")
    assert pressed == ['Utilities', 'Electricity'], pressed
    d.page.fill('#fAmt', '101.15')
    d.page.locator('#sheetRoot button', has_text='Add expense').click()
    d.page.wait_for_timeout(800)
    saved = [e for e in d.js("JSON.parse(localStorage['spendlog.v1']).e") if e.get('note') == 'Electricity bill']
    assert len(saved) == 1 and saved[0]['amount'] == 101.15 and saved[0]['sub'] == 'Electricity', saved
    assert '2026-11-03' in d.js('SpenderrrReminders.bills()[0].paid'), 'Bill is marked paid'
    card = d.text('#spx-bills')
    assert 'Next: Electricity' in card and 'Dec 3' in card, card
    d.close()


@test
def closing_the_form_does_not_mark_paid(b, srv):
    d = Device(b, srv).open(bills=[bill('b_elec0001', 'Electricity', day=3, amount=80)])
    d.page.click('.spx-bill[data-bill=b_elec0001] .spx-pay')
    d.page.wait_for_selector('#fAmt')
    assert d.page.input_value('#fAmt') == '80', 'Usual amount used when there is no history'
    d.page.click('#closeSheet')
    d.page.wait_for_timeout(600)
    assert d.js('SpenderrrReminders.bills()[0].paid') == {}, 'Not paid'
    assert 'Mark paid' in d.text('#spx-bills')
    d.close()


@test
def already_paid_and_expense_logged_the_normal_way(b, srv):
    d = Device(b, srv).open(bills=[bill('b_elec0001', 'Electricity', day=3, created=(2026, 10, 20)), bill('b_rent0001', 'Rent', cat='household', sub='', day=1, typ='rent')])
    assert 'Overdue 1 day' in d.text('#spx-bills'), 'Rent was due Nov 1'
    d.page.locator('.spx-bill[data-bill=b_rent0001] .spx-already').click()
    d.page.wait_for_timeout(300)
    assert d.page.locator('.spx-bill[data-bill=b_rent0001]').count() == 0, 'Rent leaves the card'
    # Electricity added with the normal Add button (Utilities → Electricity) counts as paid
    d.page.click('#fab')
    d.page.fill('#fAmt', '75')
    d.page.locator('#sheetRoot button.chip', has_text='Utilities').first.click()
    d.page.locator('#sheetRoot button.chip', has_text='Electricity').first.click()
    d.page.locator('#sheetRoot button', has_text='Add expense').click()
    d.page.wait_for_timeout(800)
    assert d.page.locator('.spx-bill[data-bill=b_elec0001]').count() == 0, 'Electricity counts as paid'
    assert 'Next:' in d.text('#spx-bills')
    # A late payment settles the overdue bill, and the next one is still due
    late = d.js('''() => { const b = {id: 'b_gas00001', type: 'gas', name: 'Gas', cat: 'utilities', sub: 'Gas', amount: null, freq: 'monthly',
        day: 25, month: 0, remind: 3, paid: {}, createdAt: new Date(2026, 7, 1).getTime()};
      const before = SpenderrrReminders.status(b).state;
      const s = JSON.parse(localStorage['spendlog.v1']); s.e.push({id: 'g1', amount: 30, cat: 'utilities', sub: 'Gas', note: '', ts: Date.now(), createdAt: Date.now()});
      localStorage.setItem('spendlog.v1', JSON.stringify(s));
      const after = SpenderrrReminders.status(b); return [before, after.state, after.due.getDate()]; }''')
    assert late == ['overdue', 'later', 25], late
    d.close()


@test
def calendar_file_and_google_link(b, srv):
    d = Device(b, srv, kind='iphone').open(bills=[bill('b_elec0001', 'Electricity', day=3, amount=85, remind=3),
                                                  bill('b_watr0001', 'Water', freq='bimonthly', day=4, remind=1),
                                                  bill('b_last0001', 'Rent', cat='household', sub='', day=-1, remind=0, typ='rent'),
                                                  bill('b_yr000001', 'Insurance', cat='insurance', sub='', freq='yearly', day=15, month=5, remind=7, typ='insurance')])
    d.js("SpenderrrReminders.openBillForm(SpenderrrReminders.bills()[0])")
    d.page.click('#spxBillCal')
    with d.page.expect_download() as dl:
        d.page.click('#spxIcs')
    path = dl.value.path()
    ics = open(path, encoding='utf-8', newline='').read()
    assert dl.value.suggested_filename == 'Electricity-reminder.ics', dl.value.suggested_filename
    assert '\r\n' in ics and ics.startswith('BEGIN:VCALENDAR') and ics.strip().endswith('END:VCALENDAR')
    for line in ['DTSTART;VALUE=DATE:20261103', 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=3', 'TRIGGER:PT9H', 'TRIGGER:-P2DT15H',
                 'SUMMARY:💡 Electricity bill due ($85.00)']:
        assert line in ics, 'Missing %s' % line
    rules = d.js("SpenderrrReminders.bills().map(b => SpenderrrReminders.ics(b).match(/RRULE:[^\\r]+/)[0] + ' ' + (SpenderrrReminders.ics(b).match(/TRIGGER:[^\\r]+/g) || []).join(','))")
    assert rules[1] == 'RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=4 TRIGGER:PT9H,TRIGGER:-PT15H', rules[1]
    assert rules[2] == 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1 TRIGGER:PT9H', rules[2]
    assert rules[3] == 'RRULE:FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15 TRIGGER:PT9H,TRIGGER:-P6DT15H', rules[3]
    g = d.js("SpenderrrReminders.googleLink(SpenderrrReminders.bills()[0])")
    assert g.startswith('https://calendar.google.com/calendar/render?action=TEMPLATE') and 'dates=20261103/20261104' in g and 'RRULE%3AFREQ%3DMONTHLY' in g, g
    d.close()


@test
def bills_card_only_on_recent_and_can_be_turned_off(b, srv):
    d = Device(b, srv).open(bills=[bill('b_elec0001', 'Electricity', day=3)])
    assert 'spx-bills' in d.cards()
    for view in ['week', 'month', 'split', 'messages']:
        d.page.click('nav.tabs button[data-view=%s]' % view)
        d.page.wait_for_timeout(200)
        assert not d.cards(), '%s tab has no reminder cards' % view
    d.page.click('nav.tabs button[data-view=recent]')
    d.page.wait_for_timeout(200)
    d.page.click('#settingsBtn')
    d.page.click('#spxTgBills')
    d.page.click('#closeSheet')
    d.page.wait_for_timeout(200)
    assert 'spx-bills' not in d.cards()
    d.page.reload()
    d.page.wait_for_timeout(800)
    assert 'spx-bills' not in d.cards(), 'Setting is kept'
    d.close()


@test
def delete_bill_needs_two_taps(b, srv):
    d = Device(b, srv).open(bills=[bill('b_elec0001', 'Electricity', day=3)])
    d.js("SpenderrrReminders.openBillForm(SpenderrrReminders.bills()[0])")
    d.page.click('#spxDelBill')
    assert len(d.js('SpenderrrReminders.bills()')) == 1
    d.page.click('#spxDelBill')
    assert d.js('SpenderrrReminders.bills()') == [] and 'spx-bills' not in d.cards()
    d.close()


# ---------- Reports ----------
WEEK_DATA = [
    expense('a1', 40, 'grocery', 2026, 10, 27), expense('a2', 12.5, 'lunch', 2026, 10, 29),
    expense('a3', 85, 'utilities', 2026, 10, 10, sub='Electricity'), expense('a4', 30, 'shopping', 2026, 10, 21),
    expense('a5', 100, 'grocery', 2026, 9, 15), expense('a6', 60, 'dinner', 2026, 11, 1, split_my=20),
]


@test
def report_cards_show_on_the_right_days(b, srv):
    d = Device(b, srv, clock=MON_NOV_2).open(data=WEEK_DATA)
    assert d.cards() == ['spx-report-month', 'spx-report-week'], d.cards()
    d.close()
    d = Device(b, srv, clock=THU_OCT_15).open(data=WEEK_DATA)
    assert not d.cards(), 'No report cards mid-month on a Thursday'
    d.close()


@test
def report_totals_match_the_data(b, srv):
    d = Device(b, srv).open(data=WEEK_DATA)
    week = d.text('#spx-report-week')
    # Oct 26 – Nov 1: 40 + 12.50 + your 20 share of the 60 dinner
    assert 'Week of Oct 26 – Nov 1' in week.replace('\n', ' ') or 'WEEK OF OCT 26 – NOV 1' in week, week
    assert '$72.50' in week and '3 entries' in week, week
    month = d.text('#spx-report-month')
    assert '$167.50' in month and '4 entries' in month and '68%' in month and 'Utilities' in month, month
    text = d.js("SpenderrrReminders.reportText(SpenderrrReminders.report('month'))")
    assert text.startswith('📊 Spenderrr · Monthly report\nOctober 2026') and '💡 Utilities — $85.00 (51%)' in text, text
    d.close()


@test
def report_dismiss_is_remembered(b, srv):
    d = Device(b, srv).open(data=WEEK_DATA)
    d.page.locator('#spx-report-week .spx-x').click()
    d.page.reload()
    d.page.wait_for_timeout(800)
    assert d.cards() == ['spx-report-month'], d.cards()
    d.page.click('#settingsBtn')
    d.page.click('#spxTgMonthly')
    d.page.click('#closeSheet')
    d.page.wait_for_timeout(200)
    assert not d.cards()
    d.close()


@test
def report_share_buttons(b, srv):
    d = Device(b, srv).open(data=WEEK_DATA)
    d.js("() => { window.__opened = []; window.open = function (u) { window.__opened.push(u); return null; }; }")
    d.page.locator('#spx-report-week button[data-share=whatsapp]').click()
    url = d.js('window.__opened[0]')
    assert url.startswith('https://wa.me/?text=') and 'Weekly%20report' in url, url
    text = d.js("SpenderrrReminders.reportText(SpenderrrReminders.report('week'))")
    assert 'Spent: $72.50 (3 entries)' in text and text.endswith('Sent from Spenderrr'), text
    d.page.click('#settingsBtn')
    d.page.click('#spxReportMonth')
    assert 'October 2026' in d.text('#spx-report-sheet')
    d.close()


# ---------- Data safety and layout ----------
@test
def broken_saved_bills_are_ignored(b, srv):
    d = Device(b, srv).open(extra={'spenderrr.bills': '{"b":[{"id":"x"},null,5,{"id":"b_evil0001","name":"<img src=x onerror=alert(1)>","cat":"utilities","sub":"Electricity","freq":"monthly","day":3,"amount":5,"paid":{},"createdAt":1}]}'})
    html = d.js("document.getElementById('spx-bills').innerHTML")
    assert '<img' not in html and '&lt;img' in html, 'Names are shown as text'
    d.js("localStorage.setItem('spenderrr.bills', 'not json')")
    d.page.reload()
    d.page.wait_for_timeout(800)
    assert 'spx-bills' not in d.cards()
    d.close()


@test
def bills_are_in_backups_and_checked(b, srv):
    d = Device(b, srv).open(bills=[bill('b_elec0001', 'Electricity', day=3, paid={'2026-10-03': 1})])
    text = d.js("(async () => { const t = await SpendLogBackup.backupText(); return typeof t === 'string' ? t : JSON.stringify(t); })()")
    data = json.loads(json.loads(text)['data']['spenderrr.bills'])
    assert data['b'][0]['id'] == 'b_elec0001' and data['b'][0]['paid'] == {'2026-10-03': 1}, data
    # Merge keeps a bill added on another phone
    merged = d.js("""() => { const mine = {'spenderrr.bills': localStorage.getItem('spenderrr.bills')};
        const other = {'spenderrr.bills': JSON.stringify({b: [{id: 'b_other001', type: 'water', name: 'Water', cat: 'utilities', sub: 'Water', amount: null, freq: 'bimonthly', day: 4, month: 0, remind: 1, paid: {}, createdAt: 1}]})};
        const m = SpendLogBackup.mergeData(mine, {data: other, deleted: {}}, {});
        return JSON.parse(m.data['spenderrr.bills']).b.map(x => x.id).sort(); }""")
    assert merged == ['b_elec0001', 'b_other001'], merged
    d.close()


@test
def currency_follows_the_app_setting(b, srv):
    d = Device(b, srv).open(data=[expense('e1', 1250, 'utilities', 2026, 10, 3, sub='Electricity')],
                             bills=[bill('b_elec0001', 'Electricity', day=3)], extra={'spendlog.currency': 'INR'})
    assert '₹1,250.00' in d.text('#spx-bills'), d.text('#spx-bills')
    d.close()


@test
def cards_fit_small_phones(b, srv):
    d = Device(b, srv, kind='small').open(data=WEEK_DATA, bills=[bill('b_elec0001', 'Electricity Board Payment', day=3, amount=123456.78)])
    over = d.js("""[...document.querySelectorAll('#main > section[id^=spx-] *')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.className || e.tagName)""")
    assert not over, 'Wider than the screen: %s' % over[:5]
    assert d.js('document.documentElement.scrollWidth <= innerWidth'), 'No sideways scrolling'
    d.close()


@test
def release_lists_the_new_file(b, srv):
    sw = open(os.path.join(APP_DIR, 'sw.js'), encoding='utf-8').read()
    html = open(os.path.join(APP_DIR, 'index.html'), encoding='utf-8').read()
    ver = re.search(r'<meta name="app-version" content="([^"]+)"', html).group(1)
    assert "'/reminders.js'" in sw, 'reminders.js is saved for offline use'
    assert 'reminders.js?v=%s' % ver in html, 'reminders.js is loaded with the current version'
    assert "spendlog-%s" % ver in sw, 'Offline cache name matches the version'


# ---------- Daily check-in (backup.js) ----------
@test
def daily_check_in_once_a_day(b, srv):
    d = Device(b, srv, clock=MON_NOV_2)
    hits = []
    d.page.on('request', lambda r: hits.append(r.url.split('/', 3)[-1]) if '/t/' in r.url else None)
    d.open()
    d.page.wait_for_timeout(500)
    assert hits == ['t/active'], hits
    d.page.reload()
    d.page.wait_for_timeout(500)
    assert hits == ['t/active'], 'Only once a day: %s' % hits
    d.page.clock.fast_forward('24:00:00')
    d.js("() => document.dispatchEvent(new Event('visibilitychange'))")
    d.page.wait_for_timeout(500)
    assert hits == ['t/active', 't/active'], 'Again the next day: %s' % hits
    d.close()


@test
def daily_check_in_counts_drive_and_sends_nothing_else(b, srv):
    d = Device(b, srv)
    seen = []
    d.page.on('request', lambda r: seen.append(r) if '/t/' in r.url else None)
    d.page.goto(srv.url)
    d.js("() => localStorage.setItem('__spendlog_backup_meta', JSON.stringify({drive: true, driveConsented: true}))")
    d.js("() => localStorage.removeItem('spenderrr.checkin')")
    seen.clear()
    d.page.reload()
    d.page.wait_for_timeout(800)
    paths = [r.url.split('/', 3)[-1] for r in seen]
    if 'google-client-id' in open(os.path.join(APP_DIR, 'index.html'), encoding='utf-8').read():
        assert paths == ['t/active', 't/drive-active'], paths
    for r in seen:
        assert '?' not in r.url and r.method == 'GET' and not r.post_data, r.url
        assert 'cookie' not in {k.lower() for k in r.headers}, 'No cookies'
    d.close()


@test
def check_in_files_and_rules_are_in_the_release(b, srv):
    for f in ['t/active', 't/drive-active', 'robots.txt']:
        assert os.path.isfile(os.path.join(APP_DIR, f)), 'Missing %s' % f
    headers = open(os.path.join(APP_DIR, '_headers'), encoding='utf-8').read()
    assert re.search(r'/t/\*\n\s+Cache-Control: no-store', headers), 'Check-in files are never cached'
    sw = open(os.path.join(APP_DIR, 'sw.js'), encoding='utf-8').read()
    assert "indexOf('/t/') === 0) return;" in sw, 'Offline copy never answers a check-in'
    privacy = open(os.path.join(APP_DIR, 'privacy.html'), encoding='utf-8').read()
    assert 'Daily check-in' in privacy and 'no tracking' not in privacy, 'Privacy page explains the check-in'


def main():
    chosen = [t for t in TESTS if not FILTERS or any(f in t.__name__ for f in FILTERS)]
    print('Reminder tests — %d to run against %s\n' % (len(chosen), APP_DIR))
    srv = Server()
    passed = failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED)
        for t in chosen:
            name = t.__name__.replace('_', ' ')
            start = time.time()
            try:
                t(browser, srv)
                passed += 1
                print('  PASS  %s  (%.1fs)' % (name, time.time() - start))
            except Exception as e:
                failed += 1
                print('  FAIL  %s\n        %s' % (name, str(e).splitlines()[0] if str(e) else type(e).__name__))
                if '--verbose' in sys.argv:
                    traceback.print_exc()
        browser.close()
    print('\n%d passed, %d failed' % (passed, failed))
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Spenderrr – tests for the payment mode of each entry (ledger.js + backup.js)
===========================================================================

What is covered:
  - Money out offers Credit card, UPI, Cash, Food card / Sodexo; money in offers Cash, Debit card / Account
  - New and edited expenses save their mode (it survives the app redrawing the form), new entries
    start with the mode used last time, and "Not set" clears it
  - Money in saves its mode on the entry
  - Modes are in the backup, come back on restore and merge between phones; bad values are dropped
  - Excel report: a "Payment mode" column inside the filter, and money out / in per payment mode
  - The field fits on Android, iPhone, a small phone and desktop

Run:
    python testCase/test_payment_mode.py
    python testCase/test_payment_mode.py excel        # only tests whose name contains "excel"
"""
import json
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_args = sys.argv[1:]
sys.argv = [sys.argv[0]]
import run_tests as T                    # noqa: E402
import test_reports as R                 # noqa: E402
sys.argv += _args

from playwright.sync_api import sync_playwright   # noqa: E402

HEADED = '--headed' in sys.argv
FILTERS = [a for a in _args if not a.startswith('--')]
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


def modes(d):
    s = json.loads(d.ev("localStorage.getItem('spenderrr.paymodes') || '{}'"))
    return {x['id']: x['pay'] for x in s.get('e', [])}


def expenses(d):
    return json.loads(d.ev("localStorage.getItem('spendlog.v1') || '{}'")).get('e', [])


def credits(d):
    return json.loads(d.ev("localStorage.getItem('spenderrr.credits') || '{}'")).get('e', [])


def new_expense(d, amount, category, mode=None):
    d.page.click('#fab')
    d.page.wait_for_selector('#spxPay')
    d.page.fill('#fAmt', str(amount))
    if mode is not None:
        d.page.select_option('#spxPay', mode)
    d.page.click('#sheetRoot button.chip:has-text("%s")' % category)
    d.page.click('#sheetRoot button[type=submit]')
    d.page.wait_for_timeout(300)


def edit_item(d, amount_text):
    d.page.click('#main button.item:has-text("%s")' % amount_text)
    d.page.wait_for_selector('#spxPay')


def options(d, sel):
    return d.ev("(s) => [...document.querySelectorAll(s + ' option')].map(o => [o.value, o.textContent])", sel)


@test
def payment_choices_for_money_out_and_money_in(b, srv):
    d = R.device(b, srv, 'INR')
    d.page.click('#fab')
    d.page.wait_for_selector('#spxPay')
    assert options(d, '#spxPay') == [['', 'Not set'], ['credit_card', 'Credit card'], ['upi', 'UPI'], ['cash', 'Cash'],
                                     ['food_card', 'Food card / Sodexo']], options(d, '#spxPay')
    assert d.page.input_value('#spxPay') == '', 'Nothing picked before the first use'
    lab = d.ev("document.getElementById('spxPay').closest('label').querySelector('.lab').textContent")
    assert lab == 'Payment mode', lab
    # It sits right under the amount
    assert d.ev("document.querySelector('#sheetRoot .amtfield').nextElementSibling.classList.contains('spx-pay')")
    d.page.click('#spxSideIn')                      # switch to money in
    d.page.wait_for_selector('#spxPayIn')
    assert options(d, '#spxPayIn') == [['', 'Not set'], ['cash', 'Cash'], ['debit', 'Debit card / Account']], options(d, '#spxPayIn')
    d.close()


@test
def new_expense_saves_its_mode(b, srv):
    d = R.device(b, srv, 'INR')
    d.page.click('#fab')
    d.page.wait_for_selector('#spxPay')
    d.page.fill('#fAmt', '240')
    d.page.select_option('#spxPay', 'food_card')
    d.page.click('#sheetRoot button.chip:has-text("Lunch")')      # the app redraws the form here
    assert d.page.input_value('#spxPay') == 'food_card', 'Choice kept when the form is redrawn'
    d.page.click('#sheetRoot button[type=submit]')
    d.page.wait_for_timeout(300)
    e = expenses(d)
    assert len(e) == 1 and modes(d) == {e[0]['id']: 'food_card'}, (e, modes(d))
    new_expense(d, 60, 'Snacks', 'upi')
    new_expense(d, 900, 'Fuel', '')
    by_amount = {x['amount']: x['id'] for x in expenses(d)}
    assert modes(d) == {by_amount[240]: 'food_card', by_amount[60]: 'upi'}, 'Not set saves nothing: %s' % modes(d)
    d.close()


@test
def new_expense_starts_with_the_last_mode_used(b, srv):
    d = R.device(b, srv, 'INR')
    new_expense(d, 100, 'Lunch', 'credit_card')
    d.page.click('#fab')
    d.page.wait_for_selector('#spxPay')
    assert d.page.input_value('#spxPay') == 'credit_card'
    d.page.click('#closeSheet')
    d.reload()                                       # remembered after the app reopens too
    d.page.click('#fab')
    d.page.wait_for_selector('#spxPay')
    assert d.page.input_value('#spxPay') == 'credit_card'
    d.close()


@test
def editing_an_expense_shows_and_changes_its_mode(b, srv):
    d = R.device(b, srv, 'INR')
    new_expense(d, 100, 'Lunch', 'cash')
    new_expense(d, 50, 'Snacks', 'upi')
    edit_item(d, '₹50.00')
    assert d.page.inner_text('#sheetRoot .sheet-h h3') == 'Edit expense'
    assert d.page.input_value('#spxPay') == 'upi', d.page.input_value('#spxPay')
    d.page.select_option('#spxPay', 'credit_card')
    d.page.fill('#fAmt', '55')
    d.page.click('#sheetRoot button[type=submit]')
    d.page.wait_for_timeout(300)
    by_amount = {x['amount']: x['id'] for x in expenses(d)}
    assert modes(d) == {by_amount[100]: 'cash', by_amount[55]: 'credit_card'}, modes(d)
    edit_item(d, '₹55.00')
    d.page.select_option('#spxPay', '')
    d.page.click('#sheetRoot button[type=submit]')
    d.page.wait_for_timeout(300)
    assert modes(d) == {by_amount[100]: 'cash'}, 'Not set clears it: %s' % modes(d)
    # Opening an expense and closing it changes nothing
    edit_item(d, '₹100.00')
    assert d.page.input_value('#spxPay') == 'cash'
    d.page.click('#closeSheet')
    new_expense(d, 70, 'Dinner', 'cash')
    assert len(modes(d)) == 2, modes(d)
    d.close()


@test
def money_in_saves_its_mode(b, srv):
    d = R.device(b, srv, 'INR')
    d.page.click('#spxAddIn')
    d.page.wait_for_selector('#spxPayIn')
    d.page.fill('#spxAmt', '85000')
    d.page.select_option('#spxPayIn', 'debit')
    d.page.click('#spxCreditCats button.chip:has-text("Salary")')
    d.page.click('#spxSave')
    d.page.wait_for_timeout(300)
    c = credits(d)
    assert len(c) == 1 and c[0]['pay'] == 'debit', c
    d.page.click('#spxAddIn')
    d.page.wait_for_selector('#spxPayIn')
    assert d.page.input_value('#spxPayIn') == 'debit', 'Starts with the last mode used'
    d.page.fill('#spxAmt', '500')
    d.page.select_option('#spxPayIn', '')
    d.page.click('#spxCreditCats button.chip:has-text("Refund")')
    d.page.click('#spxSave')
    d.page.wait_for_timeout(300)
    assert [x.get('pay') for x in credits(d)] == ['debit', None], credits(d)
    d.close()


@test
def payment_modes_are_backed_up_and_restored(b, srv):
    d = R.device(b, srv, 'INR', clock=T.OCT_EVENING)
    new_expense(d, 100, 'Lunch', 'upi')
    T.add_credit(d, 1000, 'Salary')
    before_modes, before_credit = modes(d), credits(d)
    d.backup_now()
    backup = json.loads(d.folder()[T.MONTH_FILE])
    assert json.loads(backup['data']['spenderrr.paymodes']) == {'e': [{'id': list(before_modes)[0], 'pay': 'upi'}]}, backup['data'].keys()
    d.wipe_app_data()
    d.page.click('#slb-banner')
    d.page.click('#slb-modal button:has-text("Backup folder")')
    d.page.wait_for_selector('#slb-modal .slb-item')
    d.page.locator('#slb-modal .slb-item').first.click()
    d.page.wait_for_timeout(800)
    d.reload()
    assert modes(d) == before_modes, modes(d)
    assert credits(d)[0].get('pay') == before_credit[0].get('pay'), credits(d)
    d.close()


@test
def payment_modes_merge_between_phones_and_bad_values_are_dropped(b, srv):
    d = R.device(b, srv, 'INR')
    res = d.ev("""() => {
      const local = { 'spenderrr.paymodes': JSON.stringify({ e: [{ id: 'a', pay: 'upi' }, { id: 'b', pay: 'cash' }] }) };
      const remote = { data: { 'spenderrr.paymodes': JSON.stringify({ e: [{ id: 'c', pay: 'food_card' }, { id: 'x', pay: 'bitcoin' }, { id: 'b', pay: 'cash' }] }),
                               'spenderrr.credits': JSON.stringify({ e: [{ id: 'cr1', amount: 5, cat: 'salary', ts: 1, pay: 'cheque' },
                                                                         { id: 'cr2', amount: 5, cat: 'salary', ts: 2, pay: 'cash' }] }) } };
      const m = SpendLogBackup.mergeData(local, remote, {});
      return { pay: JSON.parse(m.data['spenderrr.paymodes']).e, credits: JSON.parse(m.data['spenderrr.credits']).e };
    }""")
    assert sorted((x['id'], x['pay']) for x in res['pay']) == [('a', 'upi'), ('b', 'cash'), ('c', 'food_card')], res['pay']
    assert [x.get('pay') for x in res['credits']] == [None, 'cash'], res['credits']
    d.close()


@test
def excel_report_has_a_payment_mode_column_and_totals(b, srv):
    d = R.device(b, srv, 'INR')
    T.set_entries(d, [('lunch', 200, '2026-10-05 13:00', 'Canteen'), ('grocery', 1500, '2026-10-06 18:00', 'Big shop'),
                      ('fuel', 2000, '2026-10-07 09:00', 'Petrol'), ('snacks', 40, '2026-10-08 16:00', 'Tea')])
    d.ev("""() => localStorage.setItem('spenderrr.paymodes', JSON.stringify({ e: [
      { id: 't0', pay: 'food_card' }, { id: 't1', pay: 'upi' }, { id: 't2', pay: 'credit_card' }] }))""")
    R.set_credits(d, [('salary', 85000, '2026-10-01 09:00', 'Pay')])
    d.ev("""() => { const c = JSON.parse(localStorage.getItem('spenderrr.credits')); c.e[0].pay = 'debit';
      localStorage.setItem('spenderrr.credits', JSON.stringify(c)); }""")
    for k in ['month', 'last3']:
        wb = R.workbook(d, k)
        ws = wb['Dashboard'] if k == 'month' else wb['October 2026']
        head = R.find(ws, 'Split').row
        assert [c.value for c in ws[head]][1:9] == ['Date and time', 'Category', 'Note', 'Money out', 'Split', 'Money in', 'Balance', 'Payment mode'], [c.value for c in ws[head]]
        rows = [[ws.cell(r, c).value for c in (4, 9)] for r in range(head + 1, head + 6)]
        assert rows == [['Pay', 'Debit card / Account'], ['Canteen', 'Food card / Sodexo'], ['Big shop', 'UPI'],
                        ['Petrol', 'Credit card'], ['Tea', None]], rows
        assert ws.auto_filter.ref == 'B%d:I%d' % (head, head + 5), ws.auto_filter.ref
        top = R.find(ws, 'BY PAYMENT MODE')
        block = [[ws.cell(r, c).value for c in (6, 7, 8)] for r in range(top.row + 2, top.row + 7)]
        assert block == [['Credit card', 2000, None], ['UPI', 1500, None], ['Food card / Sodexo', 200, None],
                         ['Debit card / Account', None, 85000], ['Not set', 40, None]], block
        assert R.find(ws, 'WEEK BY WEEK').row > top.row, 'Payment modes come before week by week'
    d.close()


@test
def payment_field_fits_on_every_screen(b, srv):
    for kind, size in [('android', None), ('iphone', None), ('android', {'width': 320, 'height': 640}), ('desktop', None)]:
        d = R.device(b, srv, 'INR', kind=kind)
        if size:
            d.page.set_viewport_size(size)
        for opener, sel in [('#fab', '#spxPay'), ('#spxAddIn', '#spxPayIn')]:
            d.page.click(opener)
            d.page.wait_for_selector(sel)
            box = d.ev("""(s) => { const e = document.querySelector(s), sh = e.closest('.sheet');
              const r = e.getBoundingClientRect(), o = sh.getBoundingClientRect();
              return { inside: r.left >= o.left - 1 && r.right <= o.right + 1, h: r.height, scroll: sh.scrollWidth > sh.clientWidth + 1 }; }""", sel)
            assert box['inside'] and not box['scroll'] and box['h'] >= 44, (kind, size, sel, box)
            d.page.keyboard.press('Escape')
            if d.page.is_visible('#closeSheet'):
                d.page.click('#closeSheet')
            elif d.page.is_visible('.spx-scrim .x'):
                d.page.click('.spx-scrim .x')
        d.close()


def main():
    chosen = [t for t in TESTS if not FILTERS or any(f in t.__name__ for f in FILTERS)]
    passed, failed = [], []
    srv = T.AppServer(T.APP_DIR)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not HEADED)
        print('Spenderrr payment mode tests — %d to run against %s\n' % (len(chosen), T.APP_DIR))
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

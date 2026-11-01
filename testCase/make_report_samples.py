#!/usr/bin/env python3
"""
Spenderrr – make sample Excel reports for every period (for checking the layout by eye)
======================================================================================

Fills a test browser with about 18 months of made-up entries (April 2025 – October 2026,
with no entries at all in February 2026, and a payment mode on most entries), then saves one report per period:
  INR: this week, this month, last month, last 3 months, last 6 months,
       financial year 2026-27, last financial year 2025-26, custom dates, all entries
  USD: year 2026, last year 2025, last 3 months

Run:
    python testCase/make_report_samples.py                  # writes to ./report-samples
    python testCase/make_report_samples.py --out ~/Desktop/samples
"""
import base64
import os
import random
import sys
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_args = sys.argv[1:]
sys.argv = [sys.argv[0]]
import run_tests as T                     # noqa: E402
from playwright.sync_api import sync_playwright   # noqa: E402

OUT = os.path.abspath(_args[_args.index('--out') + 1]) if '--out' in _args else os.path.join(os.getcwd(), 'report-samples')
NOW = datetime(2026, 10, 31, 19, 0)

ITEMS = [  # (category, note, low, high, times a month)
    ('breakfast', 'Idli & coffee', 60, 180, 6), ('lunch', 'Office canteen', 90, 260, 10), ('dinner', 'Dinner out', 300, 1400, 3),
    ('snacks', 'Tea & samosa', 20, 90, 6), ('grocery', 'Supermarket', 600, 3200, 3), ('shopping', 'Clothes', 800, 4500, 1),
    ('household', 'Cleaning supplies', 150, 700, 1), ('utilities', 'Electricity bill', 900, 2600, 1), ('transport', 'Metro & auto', 40, 300, 5),
    ('fuel', 'Petrol', 1500, 3000, 1), ('maid', 'Maid salary', 3000, 3000, 1), ('lpg', 'Gas cylinder', 950, 950, 1),
]


PAY_BY_CAT = {'breakfast': 'food_card', 'lunch': 'food_card', 'snacks': 'cash', 'dinner': 'credit_card', 'grocery': 'upi',
              'shopping': 'credit_card', 'household': 'upi', 'utilities': 'upi', 'transport': 'upi', 'fuel': 'credit_card', 'maid': 'cash'}


def make_data():
    rnd = random.Random(7)
    entries, credits, n, modes = [], [], 0, []
    month = datetime(2025, 4, 1)
    while month <= NOW:
        if not (month.year == 2026 and month.month == 2):        # February 2026: nothing, so it gets no tab
            days = ((month.replace(day=28) + timedelta(days=4)).replace(day=1) - month).days
            for cat, note, lo, hi, times in ITEMS:
                for _ in range(times):
                    t = month + timedelta(days=rnd.randrange(days), hours=rnd.randrange(8, 22), minutes=rnd.randrange(60))
                    if t > NOW:
                        continue
                    amt = round(rnd.uniform(lo, hi) / 10) * 10
                    e = {'id': 's%d' % n, 'amount': amt, 'cat': cat, 'sub': None, 'note': note,
                         'ts': int(t.timestamp() * 1000), 'source': 'manual', 'createdAt': int(t.timestamp() * 1000), 'split': None}
                    if cat == 'dinner' and n % 4 == 0:
                        e['note'] = 'Dinner with Ravi'
                        e['split'] = {'paidBy': 'Me', 'parts': [{'name': 'Me', 'amt': amt / 2}, {'name': 'Ravi', 'amt': amt / 2}], 'my': amt / 2}
                    entries.append(e)
                    if cat in PAY_BY_CAT:              # LPG left without a mode, to show "Not set"
                        modes.append({'id': e['id'], 'pay': PAY_BY_CAT[cat]})
                    n += 1
            pay = month.replace(day=1, hour=9)
            if pay <= NOW:
                credits.append({'id': 'pay%d' % len(credits), 'amount': 85000, 'cat': 'salary', 'note': 'Monthly salary',
                                'ts': int(pay.timestamp() * 1000), 'createdAt': int(pay.timestamp() * 1000), 'pay': 'debit'})
            if month.month in (3, 9):
                t = month.replace(day=28, hour=10)
                credits.append({'id': 'int%d' % len(credits), 'amount': 2350, 'cat': 'interest', 'note': 'Savings interest',
                                'ts': int(t.timestamp() * 1000), 'createdAt': int(t.timestamp() * 1000), 'pay': 'debit'})
        month = (month + timedelta(days=32)).replace(day=1)
    return entries, credits, modes


def main():
    os.makedirs(OUT, exist_ok=True)
    entries, credits, modes = make_data()
    srv = T.AppServer(T.APP_DIR)
    plan = [('INR', k, None) for k in ['week', 'month', 'lastmonth', 'last3', 'last6', 'fy', 'lastfy', 'all']] + \
           [('INR', 'custom', {'from': '2026-01-01', 'to': '2026-03-31'})] + \
           [('USD', k, None) for k in ['fy', 'lastfy', 'last3']]
    with sync_playwright() as p:
        b = p.chromium.launch()
        d = T.Device(b, srv, kind='desktop', clock=NOW).open()
        d.ev("""(a) => { localStorage.setItem('spendlog.v1', JSON.stringify({ e: a.e, m: [], p: [], s: [] }));
          localStorage.setItem('spenderrr.credits', JSON.stringify({ e: a.c }));
          localStorage.setItem('spenderrr.paymodes', JSON.stringify({ e: a.m })); }""", {'e': entries, 'c': credits, 'm': modes})
        d.reload()
        for currency, k, opts in plan:
            d.ev("(c) => localStorage.setItem('spendlog.currency', c)", currency)
            res = d.ev("""async (a) => {
              const label = SpendLogBackup.periodLabel(a.k, new Date(), a.opts);
              const u = new Uint8Array(await SpendLogBackup.reportBlob(a.k, label, undefined, a.opts).arrayBuffer()); let s = '';
              for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
              return { label: label, b64: btoa(s) }; }""", {'k': k, 'opts': opts})
            name = '%s - %s.xlsx' % (currency, res['label'])
            open(os.path.join(OUT, name), 'wb').write(base64.b64decode(res['b64']))
            print('  wrote', name)
        b.close()
    srv.stop()
    print('\n%d sample reports in %s' % (len(plan), OUT))


if __name__ == '__main__':
    main()

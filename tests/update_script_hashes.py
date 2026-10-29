#!/usr/bin/env python3
"""Recompute the sha256 fingerprints of the scripts inside index.html and write them into _headers.
Run after changing any <script> block in index.html:  python3 tests/update_script_hashes.py"""
import base64, hashlib, os, re, sys
app = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
html = open(os.path.join(app, 'index.html'), encoding='utf-8').read()
hashes = ["'sha256-%s'" % base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode()
          for s in re.findall(r'<script(?:\s+id="[^"]*")?>([\s\S]*?)</script>', html)]
path = os.path.join(app, '_headers')
headers = open(path, encoding='utf-8').read()
new = re.sub(r"script-src 'self'( 'sha256-[^']+')*", "script-src 'self' " + ' '.join(hashes), headers, count=1)
open(path, 'w', encoding='utf-8').write(new)
print('Updated _headers with %d script fingerprints' % len(hashes))

#!/usr/bin/env python3
"""Build the protected Spend Log deploy folder.

Usage:  python3 build.py [--hosts your-site.netlify.app,www.example.com] [--out DIR]

- Minifies the HTML and CSS
- Obfuscates the app script and service worker
- Optionally locks the app to the listed hostnames (domain lock)
  For a listed *.netlify.app host, its Netlify test links (branch deploys such as
  develop--your-site.netlify.app and deploy previews) are allowed too.
- Adds LICENSE.txt and Netlify security headers (_headers)
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
_local = os.path.join(HERE, "node_modules", ".bin")
TOOLS = os.environ.get("SPENDLOG_TOOLS") or (_local if os.path.isdir(_local) else "/tmp/claude-0/-home-claude/00a295bf-5cb0-5e1a-9f2a-eca5688c2112/scratchpad/minify/node_modules/.bin")
if os.name == "nt":  # Windows: npm installs .cmd launchers
    _cmd = lambda n: os.path.join(TOOLS, n + ".cmd")
else:
    _cmd = lambda n: os.path.join(TOOLS, n)

ap = argparse.ArgumentParser()
ap.add_argument("--hosts", default="", help="comma-separated hostnames the app may run on")
ap.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "spendlog-deploy"))
a = ap.parse_args()
hosts = [h.strip().lower() for h in a.hosts.split(",") if h.strip()]

src = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
scripts = list(re.finditer(r"<script>(.*?)</script>", src, re.S))
app = scripts[-1]
code = app.group(1)

lock = ""
if hosts:
    lock = ("var __h=location.hostname.toLowerCase(),__ok=%s;"
            "if(__ok.indexOf(__h)<0"
            "&&!__ok.some(function(o){return /\\.netlify\\.app$/.test(o)&&__h.slice(-o.length-2)==='--'+o;})"
            "&&!/^(localhost|127\\.0\\.0\\.1)$/.test(__h)){"
            "document.body.innerHTML='<div style=\"font:16px system-ui,sans-serif;padding:48px 24px;text-align:center;color:#162033\">"
            "<b style=\"font-size:20px\">This copy of Spend Log isn\\'t authorized.</b><p>Please use the official link.</p></div>';return;}"
            % json.dumps(hosts))
assert '"use strict";' in code[:60]
code = code.replace('"use strict";', '"use strict";' + lock, 1)

OBF = ["--compact", "true", "--control-flow-flattening", "true", "--control-flow-flattening-threshold", "0.5",
       "--string-array", "true", "--string-array-encoding", "base64", "--string-array-threshold", "0.8",
       "--split-strings", "true", "--split-strings-chunk-length", "8", "--identifier-names-generator", "hexadecimal",
       "--rename-globals", "false", "--self-defending", "true", "--numbers-to-expressions", "true",
       "--transform-object-keys", "false", "--unicode-escape-sequence", "false", "--seed", "20261025"]

def obfuscate(js):
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, "in.js"), os.path.join(d, "out.js")
        open(i, "w", encoding="utf-8").write(js)
        subprocess.run([_cmd("javascript-obfuscator"), i, "--output", o] + OBF, check=True, capture_output=True)
        return open(o, encoding="utf-8").read()

ob = obfuscate(code)

shell = src[:app.start()] + "<script>__APP__</script>" + src[app.end():]
with tempfile.TemporaryDirectory() as d:
    i, o = os.path.join(d, "in.html"), os.path.join(d, "out.html")
    open(i, "w", encoding="utf-8").write(shell)
    subprocess.run([_cmd("html-minifier-terser"), "--collapse-whitespace", "--conservative-collapse",
                    "--remove-comments", "--minify-css", "true", "--minify-js", "true", "-o", o, i], check=True)
    html = open(o, encoding="utf-8").read()
assert "<script>__APP__</script>" in html
html = html.replace("<script>__APP__</script>", "<script>" + ob + "</script>")

if os.path.exists(a.out):
    shutil.rmtree(a.out)
os.makedirs(a.out)
open(os.path.join(a.out, "index.html"), "w", encoding="utf-8").write(html)
open(os.path.join(a.out, "sw.js"), "w", encoding="utf-8").write(obfuscate(open(os.path.join(HERE, "sw.js"), encoding="utf-8").read()))
for f in ["xlsx.full.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "LICENSE.txt", "_headers"]:
    shutil.copy(os.path.join(HERE, f), a.out)
print("Built", a.out, "| domain lock:", ", ".join(hosts) if hosts else "off")

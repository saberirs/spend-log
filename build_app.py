#!/usr/bin/env python3
"""Make the phone app bundle (www/) from the website files.

Usage:  python3 build_app.py [--protect]      then  npx cap sync android

The website files stay exactly as they are. The app bundle is a copy of them with:
  - native.js added as the first script (phone features: device-folder backups, share sheet,
    downloads, WhatsApp/email links, bill notifications; it does nothing on the website)
  - the Google Drive client id removed, so "Back up to Google Drive" is hidden in the app
    (Google blocks its web sign-in inside apps; device-folder backup and share sheet replace it)
  - no service worker, Netlify headers or daily check-in files (every file is inside the app)

With --protect (use it for the Play Store release, not for day-to-day debugging):
  - the authored scripts are obfuscated with the same settings the website build uses (build.py):
    native.js, backup.js, ledger.js, reminders.js, whatsapp.js. The main app script inside
    index.html is already obfuscated in the repo, so it is left as is; xlsx.full.min.js
    (third-party, already minified) and the fonts are copied unchanged.
  - Global names are kept (--rename-globals false) so the scripts still find each other at runtime
    (SpendLogBackup, SpenderrrReminders, SpenderrrLedger, SpenderrrWhatsApp, SpenderrrNative).
Plain builds stay readable so tests run against real code and debugging is easy.

It also sets the Android app version from <meta name="app-version"> in index.html:
  versionName 2026.10.28  ->  versionCode 202610028   (YYYY*100000 + MM*1000 + N)
"""
import argparse, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "www")

# Authored scripts (our code) — obfuscated in a protected build.
CODE_FILES = ["native.js", "backup.js", "whatsapp.js", "ledger.js", "reminders.js"]
# Third-party / assets — always copied unchanged.
ASSET_FILES = [
    "xlsx.full.min.js", "manifest.webmanifest", "privacy.html", "LICENSE.txt",
    "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
]
NATIVE_TAG = '<script src="native.js"></script>'

# Same obfuscation settings as the website build (build.py). --rename-globals false keeps the
# cross-file globals (SpendLogBackup, SpenderrrReminders, SpenderrrNative, ...) working.
OBF = ["--compact", "true", "--control-flow-flattening", "true", "--control-flow-flattening-threshold", "0.5",
       "--string-array", "true", "--string-array-encoding", "base64", "--string-array-threshold", "0.8",
       "--split-strings", "true", "--split-strings-chunk-length", "8", "--identifier-names-generator", "hexadecimal",
       "--rename-globals", "false", "--self-defending", "true", "--numbers-to-expressions", "true",
       "--transform-object-keys", "false", "--unicode-escape-sequence", "false", "--seed", "20261025"]

_local = os.path.join(HERE, "node_modules", ".bin")
TOOLS = os.environ.get("SPENDLOG_TOOLS") or _local
_obf = os.path.join(TOOLS, "javascript-obfuscator" + (".cmd" if os.name == "nt" else ""))


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def obfuscate(js):
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, "in.js"), os.path.join(d, "out.js")
        with open(i, "w", encoding="utf-8") as f:
            f.write(js)
        subprocess.run([_obf, i, "--output", o] + OBF, check=True, capture_output=True)
        return open(o, encoding="utf-8").read()


def app_html(html):
    """index.html for the app: native.js first, no Google Drive client id (same in both modes)."""
    m = re.search(r'<meta charset="utf-8">', html, re.I)
    if not m:
        sys.exit("build_app.py: <meta charset=\"utf-8\"> not found in index.html")
    if NATIVE_TAG in html:
        sys.exit("build_app.py: index.html already loads native.js; it should only be added to the app bundle")
    html = html[:m.end()] + " " + NATIVE_TAG + html[m.end():]
    html, n = re.subn(r'\s*<meta name="google-client-id" content="[^"]*">', "", html)
    if n != 1:
        sys.exit("build_app.py: expected one google-client-id meta tag, found %d" % n)
    return html


def app_version(html):
    m = re.search(r'<meta name="app-version" content="(\d{4})\.(\d{1,2})\.(\d{1,3})">', html)
    if not m:
        sys.exit("build_app.py: <meta name=\"app-version\" content=\"YYYY.MM.N\"> not found in index.html")
    y, mo, n = (int(x) for x in m.groups())
    return "%d.%d.%d" % (y, mo, n), y * 100000 + mo * 1000 + n


def set_android_version(name, code):
    gradle = os.path.join(HERE, "android", "app", "build.gradle")
    if not os.path.exists(gradle):
        return False
    with open(gradle, encoding="utf-8") as f:
        text = f.read()
    text = re.sub(r"versionCode \d+", "versionCode %d" % code, text, count=1)
    text = re.sub(r'versionName "[^"]*"', 'versionName "%s"' % name, text, count=1)
    with open(gradle, "w", encoding="utf-8") as f:
        f.write(text)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--protect", action="store_true",
                    help="obfuscate the authored scripts (for the Play Store release)")
    ap.add_argument("--out", default=OUT,
                    help="output folder for the bundle (default: www/; npx cap sync expects www/)")
    args = ap.parse_args()

    if args.protect and not os.path.exists(_obf):
        sys.exit("build_app.py --protect needs javascript-obfuscator. Run `npm install` first (dev dependency).")

    out_dir = os.path.abspath(args.out)
    html = read("index.html")
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)

    for name in ASSET_FILES:
        shutil.copy(os.path.join(HERE, name), out_dir)
    shutil.copytree(os.path.join(HERE, "fonts"), os.path.join(out_dir, "fonts"))
    for name in CODE_FILES:
        out = os.path.join(out_dir, name)
        if args.protect:
            with open(out, "w", encoding="utf-8") as f:
                f.write(obfuscate(read(name)))
        else:
            shutil.copy(os.path.join(HERE, name), out)
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(app_html(html))

    name, code = app_version(html)
    # The Android version only tracks the real bundle in www/, not a one-off --out build.
    is_www = os.path.normcase(out_dir) == os.path.normcase(os.path.abspath(OUT))
    android = set_android_version(name, code) if is_www else False
    print("Built %s for the app | version %s (code %d) | scripts %s%s" % (
        os.path.relpath(out_dir, HERE), name, code,
        "protected (obfuscated)" if args.protect else "readable (debug)",
        " | Android version set" if android else ""))


if __name__ == "__main__":
    main()

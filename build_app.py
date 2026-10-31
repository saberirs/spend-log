#!/usr/bin/env python3
"""Make the phone app bundle (www/) from the website files.

Usage:  python3 build_app.py            then  npx cap sync android

The website files stay exactly as they are. The app bundle is a copy of them with:
  - native.js added as the first script (phone features: device-folder backups, share sheet,
    downloads, WhatsApp/email links, bill notifications; it does nothing on the website)
  - the Google Drive client id removed, so "Back up to Google Drive" is hidden in the app
    (Google blocks its web sign-in inside apps; device-folder backup and share sheet replace it)
  - no service worker, Netlify headers or daily check-in files (every file is inside the app)

It also sets the Android app version from <meta name="app-version"> in index.html:
  versionName 2026.10.28  ->  versionCode 202610028   (YYYY*100000 + MM*1000 + N)
"""
import os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "www")

FILES = [
    "index.html", "native.js", "backup.js", "whatsapp.js", "ledger.js", "reminders.js",
    "xlsx.full.min.js", "manifest.webmanifest", "privacy.html", "LICENSE.txt",
    "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
]
NATIVE_TAG = '<script src="native.js"></script>'


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def app_html(html):
    """index.html for the app: native.js first, no Google Drive client id."""
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
    html = read("index.html")
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for name in FILES:
        if name == "index.html":
            continue
        shutil.copy(os.path.join(HERE, name), OUT)
    shutil.copytree(os.path.join(HERE, "fonts"), os.path.join(OUT, "fonts"))
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
        f.write(app_html(html))
    name, code = app_version(html)
    android = set_android_version(name, code)
    print("Built www/ for the app | version %s (code %d)%s" % (name, code, " | Android version set" if android else ""))


if __name__ == "__main__":
    main()

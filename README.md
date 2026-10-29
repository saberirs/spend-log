# Daily Spend Log — source code

Copyright (c) 2026 Saberi. All rights reserved. This folder is the readable
original. Keep it private: on your computer, an external drive, or a private
GitHub repository. Never upload it to the public website.

Live app: https://spend-log-v1.netlify.app/

## What's in this folder

| File | Purpose |
| --- | --- |
| index.html | The whole app: layout, styles and code (readable) |
| sw.js | Offline support. Raise `spendlog-vN` by one on every release |
| manifest.webmanifest | Lets phones install it as an app |
| *.png | App icons |
| xlsx.full.min.js | SheetJS library for Excel reports (Apache 2.0) |
| LICENSE.txt | Your copyright and no-copying terms |
| _headers | Netlify security headers |
| build.py | Makes the protected (obfuscated, domain-locked) deploy folder |
| package.json | The build tools to install |

## Run it locally

```bash
python3 -m http.server 8080
```

Open http://localhost:8080 in a browser. Local addresses are always allowed,
even in the protected build.

## Build the protected version

One-time setup (needs Node.js 18+ and Python 3):

```bash
npm install
```

Each release:

1. Edit `index.html` and raise the version in `sw.js` (for example `spendlog-v4` → `spendlog-v5`).
2. Run `python3 build.py --hosts spend-log-v1.netlify.app` (or `npm run build`).
3. The protected app is written to `../spendlog-deploy`.
4. On Netlify, open the spend-log-v1 project and drag that folder onto **Production deploys**.

If you change your site address or add a custom domain, list every address:
`python3 build.py --hosts spend-log-v1.netlify.app,www.yourdomain.com`

## Keep a backup of this source

- Copy this folder (or the zip it came in) to a second place, such as an external drive or cloud storage.
- Or use a private GitHub repository: create it with visibility **Private**, then `git init`, `git add .`, `git commit -m "Spend Log source"`, `git remote add origin <repo url>`, `git push -u origin main`.
- `node_modules` is recreated by `npm install`, so you don't need to back it up.

## Features

Quick expense entry with colored categories (Food: Breakfast, Lunch, Dinner,
Snacks; Grocery, Shopping, Household, Utilities, Transport, Other), weekly and
monthly views, Splitwise-style splitting, payment-message parsing, Excel reports,
currency choice (US Dollar, Indian Rupee, Euro), and backup and restore to a
folder you choose. All data stays on each user's own device.

# Daily Spend Log (standalone)

A phone app for tracking daily expenses. No account or Claude login needed.
Works on iPhone and Android, installs to the Home Screen with its own icon,
and works offline after the first visit.

## Put it online (free, GitHub Pages)

1. Create a new public repository on GitHub, for example `spend-log`.
2. Upload all files in this folder (Add file → Upload files), then Commit.
3. Go to Settings → Pages. Under "Build and deployment", choose
   Source: Deploy from a branch, Branch: `main`, folder: `/ (root)`. Save.
4. After about a minute, your link is shown at the top of that page:
   `https://<your-username>.github.io/spend-log/`
5. Share that link.

## Install on a phone

- iPhone (Safari): open the link → Share → Add to Home Screen → Add.
- Android (Chrome): open the link → menu (⋮) → Install app (or Add to Home screen).

## Where data is stored

Each person's expenses stay on their own phone, in that browser.
Nobody else, including you, can see them.
Use Excel → Save backup now and then. Restore loads a backup on a new phone.
Deleting the app or clearing browser data erases entries that weren't backed up.

## Updating the app

Replace `index.html` in the repository. To make sure phones pick up the
new version, also change `spendlog-v1` to `spendlog-v2` (and so on) in `sw.js`.

# Releasing Spenderrr

## Branches

| Branch | What it is |
| --- | --- |
| `feature/*`, `fix/*`, `docs/*` | One change each, opened as a pull request |
| `staging` | Test link on Netlify — try a change on real phones before release |
| `develop` | **Production** — every merge deploys https://spend-log-v1.netlify.app |
| `backup/develop-YYYY-MM-DD` | The production version from just before a deploy (made automatically) |

## Version

Versions are `YYYY.MM.N` (for example `2026.10.29`), raised on every release. The same
version must appear in:

- `index.html` — `<meta name="app-version">` and the `?v=` on every script tag
- `sw.js` — the header comment and `CACHE = 'spendlog-<version>'`
- `_headers` — the header comment

`testCase/run_tests.py` fails if they differ.

If a `<script>` block inside `index.html` changes, recompute the Content-Security-Policy
fingerprints: `python3 tests/update_script_hashes.py`.

## Checklist

1. Branch from `develop`, make the change, raise the version.
2. Run every test suite (see the README) — all must pass.
3. Open a pull request into `staging`, check it on the test link on Android, iPhone and desktop.
4. Merge into `develop`; Netlify deploys it. Phones pick it up the next time the app opens online.

## Automatic backups and clean-up

`.github/workflows/release-backups.yml` runs on GitHub:

- **Every deploy** (push to `develop`): the version that was live just before is saved as
  `backup/develop-YYYY-MM-DD`.
- **Going back fast:** in Netlify, open the spend-log-v1 project → **Deploys**, pick the previous deploy and
  choose **Publish deploy** (live in seconds). Then fix forward, or revert the release's merge commit on a new
  branch (`git revert -m 1 <merge sha>`) and merge it into `develop`; the backup branch shows exactly what was live.
- **Every day (~9 AM Eastern)**: backups older than 2 days are deleted (the newest one is always kept),
  and finished `feature/`, `fix/`, `docs/`, `chore/`, `release/`, `sync/` branches whose commits are all
  in `develop` are deleted 2 days after their last commit. `develop`, `staging`, `main` and unfinished
  branches are never touched.
- It can be run by hand: **Actions → Release backups → Run workflow**.

## Protected build (optional)

`build.py` makes a minified, obfuscated copy that only runs on the listed sites
(local addresses always work):

```bash
npm install                                            # once: Node.js 18+ and Python 3
python3 build.py --hosts spend-log-v1.netlify.app       # or: npm run build
```

The result is written to `../spendlog-deploy`, which can be dragged onto **Production deploys**
in the Netlify project. With a custom domain, list every address:
`python3 build.py --hosts spend-log-v1.netlify.app,www.yourdomain.com`

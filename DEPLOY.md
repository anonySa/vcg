# Deploying VCG

VCG is a static site. The browser only ever reads a pre-built `data.json`
snapshot — **the TMDB token never ships to the client.** A GitHub Action
rebuilds `data.json` once a day.

```
vcg/
├─ index.html                     ← the app (no token inside)
├─ data.json                      ← daily snapshot, committed by CI
├─ scripts/fetch-data.mjs         ← builds data.json (needs TMDB_TOKEN)
└─ .github/workflows/update-data.yml
```

## ⚠️ First: rotate the TMDB token

The old token was previously hard-coded in the HTML, so treat it as burned.

1. Go to https://www.themoviedb.org/settings/api → **API Read Access Token**.
2. Regenerate it (or create a new one).
3. You'll store the **new** token only as a GitHub secret (below) — never in the repo.

## One-time setup (GitHub Pages)

1. **Create a repo** and push this folder.
   ```bash
   cd vcg
   git init && git add . && git commit -m "VCG"
   git branch -M main
   git remote add origin https://github.com/<you>/vcg.git
   git push -u origin main
   ```
   `data.json` is already committed, so the site has data on day one.

2. **Add the token secret:** repo → **Settings → Secrets and variables → Actions
   → New repository secret**
   - Name: `TMDB_TOKEN`
   - Value: your new TMDB read access token

3. **Enable Pages:** repo → **Settings → Pages** → Source = **Deploy from a branch**,
   Branch = **main**, folder = **/ (root)**. Save.
   Your site goes live at `https://<you>.github.io/vcg/` within a minute.

4. **Test the daily job now:** repo → **Actions → "Update data.json" → Run workflow.**
   It fetches fresh data, commits `data.json`, and Pages redeploys automatically.
   After that it runs every day at 04:17 UTC on its own.

> Public repo = free Pages + free Actions. It's safe to be public: the token
> lives in Actions secrets, and `data.json` is just public movie metadata.

## Run the snapshot locally (optional)

```bash
TMDB_TOKEN=your_token node scripts/fetch-data.mjs   # writes data.json
npx serve .                                          # preview at localhost:3000
```

## Alternative host: Cloudflare Pages

Same model. Connect the repo in the Cloudflare dashboard (build command: none,
output dir: `/`). For the daily rebuild either keep the GitHub Action (simplest)
or use a Cloudflare Worker Cron — both just need `TMDB_TOKEN` as a secret.

## Self-hosting on the Ugreen NAS instead

If you'd rather serve from the NAS: drop `index.html` + `data.json` in a folder
served by UGOS (or an `nginx`/`caddy` Docker container), and expose it with a
**Cloudflare Tunnel (`cloudflared`)** — *not* router port-forwarding. Run the
snapshot as a NAS cron job: `TMDB_TOKEN=... node /path/scripts/fetch-data.mjs`,
with the token in an env file kept **outside** the served folder.
Never expose the UGOS admin panel, SMB, or SSH to the internet; use a strong
admin password + 2FA and keep UGOS updated.

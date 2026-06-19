# VCG — Kinostart Kalender

A fast, single-file cinema release calendar for the **DACH region, the UK, and the US**.
VCG shows what's hitting theaters over the next ~6 months, pulling theatrical
release dates, age ratings, directors, and posters from
[The Movie Database (TMDB)](https://www.themoviedb.org/).

No build step, no framework, no backend at runtime — just static `index.html`
+ a daily-refreshed `data.json`.

---

## Features

- 🎬 **Most Anticipated carousel** — auto-advancing hero of the highest-popularity upcoming films
- 🗓️ **Grouped by month** with a "Just Started" section for films currently in cinemas
- 🌍 **Release-region switch** — **DACH** (🇩🇪🇦🇹🇨🇭), **UK** (🇬🇧), or **USA** (🇺🇸)
  - DACH shows per-country dates side by side, grouped so countries sharing a date cluster together
  - Age ratings adapt to the region: **FSK** / **BBFC** / **MPAA**
- 🔍 **Search** by title or director, plus genre filtering
- 🃏 **Two view modes** — compact **Overview** and rich **Detailed** cards; click any card to expand it
- 🌗 **Dark / light theme**, responsive down to mobile
- 🚫 Filters out non-relevant South-Asian-language titles
- ⚡ Loads instantly from a pre-built snapshot — one ~70 KB file instead of hundreds of API calls

---

## How it works

The browser **never calls TMDB directly** and **never sees an API token**. A
scheduled job builds a static snapshot that the site simply reads:

```
        ┌─────────────────────────┐         ┌──────────────┐
        │  GitHub Action (daily)  │         │   index.html │
        │  scripts/fetch-data.mjs │──────▶  │  fetch(      │
        │  TMDB_TOKEN (secret)    │ writes  │   data.json) │
        └─────────────────────────┘  data  └──────────────┘
                    │                .json         │
                    ▼                              ▼
              TMDB API                       your visitors
```

- `scripts/fetch-data.mjs` queries TMDB across DE/AT/CH/GB/US, dedupes, enriches
  each film with release dates + certs + director + genres, and writes `data.json`.
- A GitHub Action runs it once a day (and on demand), committing the result.
- Because GitHub Pages serves the repo, committing `data.json` updates the live site.

This keeps the token server-side, makes the page load instantly, and means TMDB
sees one refresh per day instead of one per visitor.

---

## Project structure

```
vcg/
├─ index.html                     # the entire app (HTML + CSS + JS, no token)
├─ data.json                      # daily snapshot, committed by CI
├─ scripts/fetch-data.mjs         # builds data.json (needs TMDB_TOKEN)
├─ .github/workflows/update-data.yml
└─ DEPLOY.md                      # full hosting instructions
```

---

## Local development

```bash
# preview the site (uses the committed data.json)
npx serve .            # → http://localhost:3000

# rebuild the snapshot yourself (optional)
TMDB_TOKEN=your_tmdb_read_token node scripts/fetch-data.mjs
```

Node 18+ is required for the snapshot script (it uses the global `fetch`).

---

## Deployment

The recommended setup is **GitHub Pages + the daily Action**. Full step-by-step
instructions — including the required `TMDB_TOKEN` secret, Cloudflare Pages, and
self-hosting on a NAS via Cloudflare Tunnel — are in **[DEPLOY.md](DEPLOY.md)**.

> **Security note:** Never commit a TMDB token. It belongs only in the
> `TMDB_TOKEN` GitHub Actions secret. `data.json` contains nothing but public
> movie metadata, so the repository is safe to make public.

---

## Tech

Vanilla HTML/CSS/JS in a single file — no dependencies. Fonts: *Fraunces* +
*Hanken Grotesk*. Data and images courtesy of TMDB.

## Attribution

This product uses the TMDB API but is **not endorsed or certified by TMDB**.
Movie data and images © The Movie Database. Release dates are sourced from TMDB
and may differ from final theatrical schedules.

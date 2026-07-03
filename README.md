# VCG — Kinostart Kalender

A single-file cinema release calendar for the **DACH region, the UK, and the US**.
It shows what's hitting theaters over the next ~6 months — release dates, age
ratings, directors, and posters — with data from
[The Movie Database (TMDB)](https://www.themoviedb.org/).

## How it works

The browser never calls TMDB and never sees an API token. A daily GitHub Action
runs `scripts/fetch-data.mjs`, which builds a static `data.json`; the site
(`index.html`) just reads that file. Setup steps live in the header comment of
that script.

## Attribution

This product uses the TMDB API but is **not endorsed or certified by TMDB**.
Movie data and images © The Movie Database. Release dates may differ from final
theatrical schedules.

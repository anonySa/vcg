#!/usr/bin/env node
/**
 * VCG snapshot builder.
 *
 * Fetches DACH + UK + US theatrical release dates from TMDB and writes
 * a static data.json that the site loads. The TMDB token is read from
 * the TMDB_TOKEN environment variable and NEVER ends up in the output —
 * so data.json is safe to publish.
 *
 * Run locally:   TMDB_TOKEN=xxxx node scripts/fetch-data.mjs
 * In CI:         token comes from a GitHub Actions secret.
 *
 * Node 18+ required (uses global fetch).
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TMDB_TOKEN = process.env.TMDB_TOKEN;
if (!TMDB_TOKEN) {
  console.error('ERROR: TMDB_TOKEN environment variable is not set.');
  process.exit(1);
}

const TMDB_BASE    = 'https://api.themoviedb.org/3';
const MAX_PAGES    = 5;                       // top ~100 by popularity per region
const REGION_CODES = ['DE', 'AT', 'CH', 'GB', 'US'];
const EXCL_LANG    = new Set(['hi','te','ta','ml','kn','bn','mr','pa']); // South-Asian
const OUT_PATH     = join(dirname(fileURLToPath(import.meta.url)), '..', 'data.json');

async function tmdbGet(path, params) {
  let url = TMDB_BASE + path;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + TMDB_TOKEN, Accept: 'application/json' },
    });
    if (r.ok) return r.json();
    if (r.status === 429) {                   // rate limited → back off and retry
      const wait = (Number(r.headers.get('retry-after')) || attempt) * 1000;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    throw new Error('TMDB ' + r.status + ' ' + path);
  }
  throw new Error('TMDB rate-limited (gave up): ' + path);
}

function windowDates() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now); end.setDate(end.getDate() + 182);
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

async function runBatched(items, n, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...await Promise.all(items.slice(i, i + n).map(worker)));
    process.stdout.write(`\r  detail ${Math.min(i + n, items.length)}/${items.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function build() {
  const { start, end } = windowDates();
  console.log(`Window: ${start} → ${end}`);

  // 1. Genre map
  const gdata = await tmdbGet('/genre/movie/list', { language: 'en-US' });
  const genreMap = {};
  (gdata.genres || []).forEach(g => { genreMap[g.id] = g.name; });

  // 2. Discover across all tracked regions, deduplicated by id
  const discover = [];
  const seen = new Set();
  for (const region of REGION_CODES) {
    let page = 1;
    while (page <= MAX_PAGES) {
      const data = await tmdbGet('/discover/movie', {
        region,
        'release_date.gte': start,
        'release_date.lte': end,
        with_release_type:  '2|3',
        sort_by:            'popularity.desc',
        language:           'en-US',
        page:               String(page),
      });
      const results = data.results || [];
      if (!results.length) break;
      for (const m of results) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          discover.push({
            id:            m.id,
            genre_ids:     m.genre_ids || [],
            poster_path:   m.poster_path || '',
            backdrop_path: m.backdrop_path || '',
            popularity:    m.popularity || 0,
          });
        }
      }
      if (page >= (data.total_pages || 1)) break;
      page++;
    }
    console.log(`  discovered ${region}: ${discover.length} unique so far`);
  }

  // 3. Per-movie detail (theatrical dates + certs + director + genres)
  const enriched = await runBatched(discover, 8, async ({ id, genre_ids, poster_path, backdrop_path, popularity }) => {
    try {
      const d = await tmdbGet('/movie/' + id, {
        append_to_response: 'release_dates,credits',
        language:           'en-US',
      });
      if (EXCL_LANG.has(d.original_language)) return null;

      const countries = (d.release_dates && d.release_dates.results) || [];
      const pickDate = entry => {
        if (!entry) return { date: null, cert: '' };
        const rd = (entry.release_dates || []).find(x => x.type === 2 || x.type === 3);
        return rd && rd.release_date
          ? { date: rd.release_date.slice(0, 10), cert: rd.certification || '' }
          : { date: null, cert: '' };
      };
      const picks = {};
      REGION_CODES.forEach(rc => { picks[rc] = pickDate(countries.find(c => c.iso_3166_1 === rc)); });

      const anyInWindow = REGION_CODES.some(rc => {
        const dt = picks[rc].date;
        return dt && dt >= start && dt <= end;
      });
      if (!anyInWindow) return null;

      const crew = (d.credits && d.credits.crew) || [];
      const dir  = crew.find(c => c.job === 'Director');

      let genres = genre_ids.map(gid => genreMap[gid]).filter(Boolean);
      if (!genres.length) genres = (d.genres || []).map(g => g.name);

      const dates = {}, certs = {};
      REGION_CODES.forEach(rc => { dates[rc] = picks[rc].date; certs[rc] = picks[rc].cert; });

      return {
        id:         'tmdb' + id,
        dates,
        certs,
        title:      d.title || '',
        genre:      genres,
        director:   dir ? dir.name : '',
        runtime:    d.runtime ? String(d.runtime) : '',
        poster:     poster_path || d.poster_path || '',
        backdrop:   backdrop_path || d.backdrop_path || '',
        popularity,
      };
    } catch {
      return null;
    }
  });

  const releases = enriched.filter(Boolean).sort((a, b) => {
    const ad = a.dates.DE || a.dates.AT || a.dates.CH || a.dates.GB || a.dates.US || '';
    const bd = b.dates.DE || b.dates.AT || b.dates.CH || b.dates.GB || b.dates.US || '';
    return ad.localeCompare(bd);
  });

  const out = {
    generated_at: new Date().toISOString(),
    fetched_at:   Date.now(),
    window:       { start, end },
    count:        releases.length,
    releases,
  };
  await writeFile(OUT_PATH, JSON.stringify(out));
  console.log(`Wrote ${releases.length} releases → ${OUT_PATH}`);
}

build().catch(err => { console.error(err); process.exit(1); });

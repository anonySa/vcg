/**
 * 31mm ratings worker — community 5-star votes (half-star steps) stored in
 * Cloudflare KV. One vote per IP per film; voting again updates the old vote.
 * IPs are never stored — only a salted SHA-256 hash.
 *
 * Also serves "Calendar sync": each visitor's saved films as a subscribable
 * calendar feed. Stored per list: random id, a hash of its write key, region,
 * language and the saved films. No names, emails or IPs.
 *
 * API
 *   GET  /ratings        → { "tmdb123": { "avg": 3.5, "count": 12 }, … }
 *   POST /vote           body { "id": "tmdb123", "stars": 3.5 }
 *                        → { "id", "avg", "count", "yours" }
 *   POST /list           body { id?, key?, region, lang, ids: [...], films: [{ id, date, title, director, runtime }] }
 *                        → { "id", "key" }   (no id → creates a new list)
 *   GET  /cal/<id>.ics   → the list as an iCalendar feed (calendar apps poll this)
 *
 * ── Deploy (Cloudflare dashboard, no CLI needed) ──────────────────────
 * 1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *    (name it e.g. `vcg-ratings`), paste this file, Deploy.
 * 2. Storage & Databases → KV → Create namespace, name e.g. `vcg-ratings-kv`.
 * 3. Worker → Settings → Bindings → Add → KV namespace:
 *      Variable name: RATINGS   Namespace: vcg-ratings-kv
 * 4. (Optional) Settings → Variables → add secret VOTE_SALT with any
 *    random string, so IP hashes can't be recomputed from the public code.
 * 5. Copy the worker URL (https://vcg-ratings.<account>.workers.dev) into
 *    RATING_API in index.html.
 */

const ALLOWED_ORIGINS = [
  'https://anonysa.github.io',
];

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Calendar sync ─────────────────────────────────────────────────── */
const DATA_URL     = 'https://anonysa.github.io/vcg/data.json';   // fresh dates + titles
const SITE_NAME    = 'https://anonysa.github.io/vcg/';   // until a real domain exists
const REGION_CODES = { dach: ['DE', 'AT', 'CH'], gb: ['GB'], us: ['US'] };
const CAL_TEXT = {
  en: { name: '31mm · Saved films', summary: t => `${t} – in cinemas`, dir: d => `Director: ${d}`, len: m => `Runtime: ${m} min` },
  de: { name: '31mm · Gemerkte Filme', summary: t => `${t} – Kinostart`, dir: d => `Regie: ${d}`, len: m => `Länge: ${m} Min.` },
};
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const str = (v, max) => String(v || '').slice(0, max);

// iCalendar text: escape, then fold lines at 74 bytes without splitting a UTF-8 character
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/[;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
function icsFold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const day     = iso => iso.replace(/-/g, '');
const nextDay = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return day(d.toISOString().slice(0, 10)); };

async function buildFeed(list) {
  // fresh snapshot (cached at the edge for an hour); films that dropped out of it keep their stored copy
  let fresh = {};
  try {
    const r = await fetch(DATA_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (r.ok) for (const f of (await r.json()).releases || []) fresh[f.id] = f;
  } catch {}
  const tx = CAL_TEXT[list.lang] || CAL_TEXT.en;
  const codes = REGION_CODES[list.region] || REGION_CODES.us;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//31mm//Calendar sync//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc(tx.name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const saved of list.films || []) {
    const f = fresh[saved.id];
    const date  = f ? codes.map(c => f.dates && f.dates[c]).find(Boolean) : saved.date;
    if (!date) continue;
    const title = f ? (list.lang === 'de' && f.title_de ? f.title_de : f.title) : saved.title;
    const dir   = f ? f.director : saved.director;
    const run   = f ? f.runtime : saved.runtime;
    const desc  = [dir ? tx.dir(dir) : '', run ? tx.len(run) : '', SITE_NAME].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${saved.id}@31mm.info`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${nextDay(date)}`,
      `SUMMARY:${icsEsc(tx.summary(title))}`, `DESCRIPTION:${icsEsc(desc)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

export default {
  async fetch(req, env) {
    const headers = corsHeaders(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const { pathname } = new URL(req.url);

    // All aggregates live in one small KV blob → the site loads them in one GET.
    if (pathname === '/ratings' && req.method === 'GET') {
      const agg = (await env.RATINGS.get('aggregates', 'json')) || {};
      const out = {};
      for (const [id, a] of Object.entries(agg)) {
        if (a.count > 0) out[id] = { avg: a.sum / a.count, count: a.count };
      }
      return new Response(JSON.stringify(out), { headers });
    }

    if (pathname === '/vote' && req.method === 'POST') {
      const body  = await req.json().catch(() => null);
      const id    = body ? String(body.id || '') : '';
      const stars = body ? Number(body.stars) : NaN;
      const valid = /^tmdb\d+$/.test(id) && stars >= 0.5 && stars <= 5 && (stars * 2) % 1 === 0;
      if (!valid) {
        return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers });
      }

      const ip      = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
      const ipHash  = (await sha256hex((env.VOTE_SALT || 'vcg') + ip)).slice(0, 24);
      const voteKey = `vote:${id}:${ipHash}`;
      const prev    = await env.RATINGS.get(voteKey);   // one vote per IP: re-vote replaces

      await env.RATINGS.put(voteKey, String(stars));

      const agg = (await env.RATINGS.get('aggregates', 'json')) || {};
      const a   = agg[id] || { sum: 0, count: 0 };
      if (prev !== null) a.sum += stars - Number(prev);
      else { a.sum += stars; a.count += 1; }
      agg[id] = a;
      await env.RATINGS.put('aggregates', JSON.stringify(agg));

      return new Response(
        JSON.stringify({ id, avg: a.sum / a.count, count: a.count, yours: stars }),
        { headers },
      );
    }

    // Create or update a saved list. The id is public (it is in the feed URL); the key is only known to the browser.
    if (pathname === '/list' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      if (!body) return new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers });
      let id  = /^[a-f0-9]{32}$/.test(body.id || '') ? body.id : null;
      let key = /^[a-f0-9]{32}$/.test(body.key || '') ? body.key : null;
      const prev = id ? await env.RATINGS.get('list:' + id, 'json') : null;
      if (prev && (!key || prev.keyHash !== await sha256hex(key))) {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers });
      }
      if (!id || !key) { id = randomHex(); key = randomHex(); }

      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(x => /^tmdb\d+$/.test(x)).slice(0, 500);
      const sent = {};
      for (const f of Array.isArray(body.films) ? body.films : []) {
        if (f && /^tmdb\d+$/.test(f.id) && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) {
          sent[f.id] = { id: f.id, date: f.date, title: str(f.title, 200), director: str(f.director, 120), runtime: str(f.runtime, 4) };
        }
      }
      const old = {};
      for (const f of (prev && prev.films) || []) old[f.id] = f;
      const record = {
        keyHash: await sha256hex(key),
        region:  REGION_CODES[body.region] ? body.region : 'us',
        lang:    body.lang === 'de' ? 'de' : 'en',
        films:   ids.map(x => sent[x] || old[x]).filter(Boolean),   // keep the stored copy of films the site no longer lists
        updated: Date.now(),
      };
      await env.RATINGS.put('list:' + id, JSON.stringify(record));
      return new Response(JSON.stringify({ id, key }), { headers });
    }

    const cal = pathname.match(/^\/cal\/([a-f0-9]{32})\.ics$/);
    if (cal && req.method === 'GET') {
      const list = await env.RATINGS.get('list:' + cal[1], 'json');
      if (!list) return new Response('not found', { status: 404 });
      return new Response(await buildFeed(list), {
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=900' },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
  },
};

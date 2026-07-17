/**
 * VCG ratings worker — community 5-star votes (half-star steps) stored in
 * Cloudflare KV. One vote per IP per film; voting again updates the old vote.
 * IPs are never stored — only a salted SHA-256 hash.
 *
 * API
 *   GET  /ratings        → { "tmdb123": { "avg": 3.5, "count": 12 }, … }
 *   POST /vote           body { "id": "tmdb123", "stars": 3.5 }
 *                        → { "id", "avg", "count", "yours" }
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

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
  },
};

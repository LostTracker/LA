/**
 * LostTracker API — Cloudflare Worker
 *
 * Single-user by design. There are no accounts and no OAuth: every request
 * carries a shared key, checked against the APP_KEY secret. That is the whole
 * access model, and it is only adequate because this serves exactly one person.
 *
 * Routes:
 *   GET  /api/state    the tracker state (null before the first save)
 *   PUT  /api/state    replace it
 *   GET  /api/roster   import a roster from lostark.bible
 *
 * Bindings: DB (D1). Vars: APP_ORIGIN. Secrets: APP_KEY.
 */

const STATE_ID = 'me';
const KEY_HEADER = 'X-LostTracker-Key';
const BIBLE = 'https://lostark.bible';
// lostark.bible 403s requests that don't look like a browser.
const UA = 'Mozilla/5.0 (compatible; LostTracker/1.0; +https://github.com/LostTracker/LA)';

const now = () => Math.floor(Date.now() / 1000);

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ' + KEY_HEADER,
    Vary: 'Origin',
  };

  // APP_ORIGIN is a comma-separated allowlist. "null" is the origin a page
  // opened straight off disk (file://) sends — such pages do send an Origin
  // header, they just send the literal string "null" — so it has to be listed
  // explicitly for the app to work without being served over HTTP.
  const allowed = (env.APP_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(body, status, env, request) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(env, request),
    },
  });
}

// Compares in constant time so a wrong key can't be recovered by timing.
function keyMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  if (supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) {
    diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- roster import ---------- */

/**
 * Pulls characters out of lostark.bible's server-rendered roster page.
 *
 * The page is plain SSR HTML on an anonymous request, so no auth and no
 * dependence on their hashed /_app/remote/<id> endpoints, which change on every
 * deploy of their site. It is still HTML parsing, so it can break if they
 * restructure the markup — hence the explicit "found nothing" error below
 * rather than silently importing an empty roster.
 *
 * Class is deliberately not extracted: the roster listing renders it as an
 * unlabeled inline SVG. Class doesn't change anyway, so it's set by hand once.
 */
/**
 * Lifts the class icon out of a roster entry.
 *
 * lostark.bible draws it as an inline SVG with no name or sprite reference, so
 * the markup itself is the only way to get it. That markup is third-party, so
 * it is reduced to a known-safe subset here and the client renders it through
 * an <img> data URI, where scripts cannot run even if something slipped past.
 */
const SVG_TAGS = new Set([
  "svg", "path", "g", "circle", "ellipse", "rect", "polygon", "polyline", "line",
]);
const SVG_ATTRS = new Set([
  "viewbox", "width", "height", "d", "fill", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "transform", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1",
  "x2", "y2", "points", "fill-rule", "clip-rule", "opacity",
]);
// Attributes whose canonical spelling is not all-lowercase.
const ATTR_CASE = { viewbox: "viewBox" };

function sanitiseSvg(markup) {
  if (!markup) return null;
  // Drop anything that can execute or pull in remote content outright.
  if (/<\s*(script|foreignobject|image|use|style|animate)/i.test(markup)) return null;

  let ok = true;
  const cleaned = markup.replace(/<\s*(\/?)([a-zA-Z][\w-]*)([^>]*)>/g, (all, slash, tag, attrs) => {
    const name = tag.toLowerCase();
    if (!SVG_TAGS.has(name)) { ok = false; return ""; }
    if (slash) return "</" + name + ">";

    const kept = [];
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(attrs)) !== null) {
      const key = m[1].toLowerCase();
      let value = m[2];
      if (!SVG_ATTRS.has(key)) continue;
      if (/url\s*\(|javascript:/i.test(value)) continue;
      // currentColor has nothing to inherit from inside an <img>, so the icon
      // would render invisible. Pin it to a concrete colour.
      if (/^currentcolor$/i.test(value)) value = "#cfd6e6";
      // SVG attribute names are case-sensitive: viewBox lowercased is ignored
      // by the renderer and the icon loses its scaling.
      kept.push(ATTR_CASE[key] || key);
      kept[kept.length - 1] += '="' + value.replace(/"/g, "&quot;") + '"';
    }
    if (name === "svg") kept.unshift('xmlns="http://www.w3.org/2000/svg"');
    return "<" + name + (kept.length ? " " + kept.join(" ") : "") + ">";
  });

  if (!ok || !/^<svg/i.test(cleaned) || cleaned.length > 20000) return null;
  return cleaned;
}

function parseRoster(html, region) {
  const out = [];
  const seen = new Set();
  const anchor = new RegExp('<a[^>]+href="/character/' + region + '/([^"/?#]+)"[^>]*>([\\s\\S]*?)</a>', 'gi');
  let match;
  while ((match = anchor.exec(html)) !== null) {
    let name;
    try {
      name = decodeURIComponent(match[1]);
    } catch (err) {
      name = match[1];
    }
    const text = match[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Navigation and guild links share the same href shape but carry no item level.
    const ilvl = text.match(/\b(\d{3,4}(?:\.\d+)?)\b/);
    if (!ilvl) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // The class icon is the last SVG inside the entry.
    const svgs = match[2].match(/<svg[\s\S]*?<\/svg>/gi);
    const classIcon = svgs ? sanitiseSvg(svgs[svgs.length - 1]) : null;

    out.push({ name, ilvl: Number(ilvl[1]), classIcon });
  }
  return out;
}

async function handleRoster(request, env) {
  const url = new URL(request.url);
  const name = (url.searchParams.get('name') || '').trim();
  const region = (url.searchParams.get('region') || '').trim().toUpperCase();

  if (!name || name.length > 32 || /[/?#]/.test(name)) {
    return json({ error: 'Give a character name.' }, 400, env, request);
  }
  if (region !== 'CE' && region !== 'NA') {
    return json({ error: 'Region must be CE or NA.' }, 400, env, request);
  }

  const target = BIBLE + '/character/' + region + '/' + encodeURIComponent(name) + '/roster';
  let res;
  try {
    res = await fetch(target, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA },
      // Cache briefly so a refresh loop doesn't hammer their site.
      cf: { cacheTtl: 300, cacheEverything: false },
    });
  } catch (err) {
    return json({ error: 'Could not reach lostark.bible.' }, 502, env, request);
  }

  if (res.status === 404) {
    return json({ error: 'No such character on ' + region + '.' }, 404, env, request);
  }
  if (!res.ok) {
    return json({ error: 'lostark.bible returned HTTP ' + res.status + '.' }, 502, env, request);
  }

  const characters = parseRoster(await res.text(), region);
  if (!characters.length) {
    return json(
      { error: 'Found the page but no characters in it — lostark.bible may have changed its markup.' },
      502,
      env,
      request
    );
  }
  return json({ characters, source: target }, 200, env, request);
}

/* ---------- state ---------- */

async function handleGetState(request, env) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM state WHERE id = ?')
    .bind(STATE_ID)
    .first();
  if (!row) return json({ data: null, updated_at: null }, 200, env, request);

  let parsed = null;
  try {
    parsed = JSON.parse(row.data);
  } catch (err) {
    parsed = null;
  }
  return json({ data: parsed, updated_at: row.updated_at }, 200, env, request);
}

async function handlePutState(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'Body must be JSON.' }, 400, env, request);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Body must be a JSON object.' }, 400, env, request);
  }

  const timestamp = now();
  await env.DB.prepare(
    'INSERT INTO state (id, data, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  )
    .bind(STATE_ID, JSON.stringify(body), timestamp)
    .run();

  return json({ ok: true, updated_at: timestamp }, 200, env, request);
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    if (path === '/') return json({ service: 'losttracker-api', ok: true }, 200, env, request);

    if (!env.APP_KEY) {
      return json({ error: 'APP_KEY is not configured on the Worker.' }, 500, env, request);
    }
    if (!keyMatches(request.headers.get(KEY_HEADER) || '', env.APP_KEY)) {
      return json({ error: 'Bad or missing key.' }, 401, env, request);
    }

    if (path === '/api/roster' && request.method === 'GET') return handleRoster(request, env);

    if (path === '/api/state') {
      if (request.method === 'GET') return handleGetState(request, env);
      if (request.method === 'PUT') return handlePutState(request, env);
      return json({ error: 'Method not allowed.' }, 405, env, request);
    }

    return json({ error: 'Not found.' }, 404, env, request);
  },
};

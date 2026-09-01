/**
 * LostTracker API — Cloudflare Worker
 *
 * Discord OAuth + per-user state persistence, backed by D1 (losttracker-db).
 *
 * Routes:
 *   GET    /auth/discord   redirect to Discord's consent screen (alias: /auth/login)
 *   GET    /auth/callback  exchange the code, open a session, bounce to the app
 *   POST   /auth/logout    drop the session
 *   GET    /api/me         the signed-in user, or 401
 *   GET    /api/state      this user's saved tracker state
 *   PUT    /api/state      replace it
 *
 * Bindings: DB (D1). Vars: APP_ORIGIN, DISCORD_CLIENT_ID.
 * Secrets:  DISCORD_CLIENT_SECRET (wrangler secret put — never commit it).
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = 'lt_session';
const OAUTH_STATE_COOKIE = 'lt_oauth_state';
const DISCORD_API = 'https://discord.com/api/v10';

/* ---------- small helpers ---------- */

const now = () => Math.floor(Date.now() / 1000);

function corsHeaders(env, request) {
  // Credentialed requests cannot use a wildcard origin, so echo the one we allow.
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
  if (origin && env.APP_ORIGIN && origin === env.APP_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(body, init, env, request) {
  return new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(env, request),
      ...((init && init.headers) || {}),
    },
  });
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The app and the API sit on different origins (Pages vs workers.dev), so the
// session cookie has to be SameSite=None — which browsers only accept with Secure.
function setCookie(name, value, maxAge) {
  return [
    name + '=' + value,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Max-Age=' + maxAge,
  ].join('; ');
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

// Only the hash goes in the database, so a leaked D1 dump can't be replayed as a session.
async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

function redirectUri(request) {
  return new URL('/auth/callback', new URL(request.url).origin).toString();
}

/* ---------- auth ---------- */

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const hashed = await hashToken(token);
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.avatar, s.expires_at' +
      '  FROM sessions s' +
      '  JOIN users u ON u.id = s.user_id' +
      ' WHERE s.token = ?'
  )
    .bind(hashed)
    .first();

  if (!row) return null;
  if (row.expires_at <= now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(hashed).run();
    return null;
  }
  return { id: row.id, username: row.username, avatar: row.avatar };
}

async function handleLogin(request, env) {
  if (!env.DISCORD_CLIENT_ID) {
    return new Response('DISCORD_CLIENT_ID is not configured', { status: 500 });
  }
  const state = randomToken();
  const authorize = new URL(DISCORD_API + '/oauth2/authorize');
  authorize.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri(request));
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'identify');
  authorize.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      // Short-lived: it only has to survive the round trip to Discord.
      'Set-Cookie': setCookie(OAUTH_STATE_COOKIE, state, 600),
    },
  });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = readCookie(request, OAUTH_STATE_COOKIE);

  if (!code) return new Response('Missing code', { status: 400 });
  // Guards against a forged callback signing you into someone else's account.
  if (!state || !expectedState || state !== expectedState) {
    return new Response('Invalid OAuth state', { status: 400 });
  }
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return new Response('Discord credentials are not configured', { status: 500 });
  }

  const tokenRes = await fetch(DISCORD_API + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(request),
    }),
  });
  if (!tokenRes.ok) {
    return new Response('Discord token exchange failed (' + tokenRes.status + ')', { status: 502 });
  }
  const tokenBody = await tokenRes.json();

  const userRes = await fetch(DISCORD_API + '/users/@me', {
    headers: { Authorization: 'Bearer ' + tokenBody.access_token },
  });
  if (!userRes.ok) {
    return new Response('Discord user lookup failed (' + userRes.status + ')', { status: 502 });
  }
  const discordUser = await userRes.json();

  // Username and avatar can change on Discord's side, so refresh them each sign-in.
  await env.DB.prepare(
    'INSERT INTO users (id, username, avatar, created_at) VALUES (?, ?, ?, ?)' +
      ' ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar'
  )
    .bind(discordUser.id, discordUser.username, discordUser.avatar || null, now())
    .run();

  const sessionToken = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hashToken(sessionToken), discordUser.id, now() + SESSION_TTL_SECONDS)
    .run();

  // Opportunistic sweep; there is no cron trigger on this Worker.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()).run();

  const headers = new Headers({ Location: env.APP_ORIGIN || '/' });
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, sessionToken, SESSION_TTL_SECONDS));
  headers.append('Set-Cookie', setCookie(OAUTH_STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run();
  }
  return json(
    { ok: true },
    { headers: { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) } },
    env,
    request
  );
}

/* ---------- state ---------- */

async function handleGetState(request, env, user) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM app_state WHERE user_id = ?')
    .bind(user.id)
    .first();

  // Someone who has never saved gets null rather than a 404 — the client reads
  // that as "start fresh".
  if (!row) return json({ data: null, updated_at: null }, null, env, request);

  let parsed = null;
  try {
    parsed = JSON.parse(row.data);
  } catch (err) {
    parsed = null;
  }
  return json({ data: parsed, updated_at: row.updated_at }, null, env, request);
}

async function handlePutState(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'Body must be JSON' }, { status: 400 }, env, request);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Body must be a JSON object' }, { status: 400 }, env, request);
  }

  const timestamp = now();
  await env.DB.prepare(
    'INSERT INTO app_state (user_id, data, updated_at) VALUES (?, ?, ?)' +
      ' ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  )
    .bind(user.id, JSON.stringify(body), timestamp)
    .run();

  return json({ ok: true, updated_at: timestamp }, null, env, request);
}

/* ---------- router ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    // /auth/discord mirrors lostark.bible's route; /auth/login is kept as an alias.
    if ((path === '/auth/discord' || path === '/auth/login') && request.method === 'GET') {
      return handleLogin(request, env);
    }
    if (path === '/auth/callback' && request.method === 'GET') return handleCallback(request, env);
    if (path === '/auth/logout' && request.method === 'POST') return handleLogout(request, env);

    if (path === '/api/me' || path === '/api/state') {
      const user = await currentUser(request, env);
      if (!user) return json({ error: 'Not signed in' }, { status: 401 }, env, request);

      if (path === '/api/me') return json({ user }, null, env, request);
      if (request.method === 'GET') return handleGetState(request, env, user);
      if (request.method === 'PUT') return handlePutState(request, env, user);
      return json({ error: 'Method not allowed' }, { status: 405 }, env, request);
    }

    if (path === '/') return json({ service: 'losttracker-api', ok: true }, null, env, request);

    return json({ error: 'Not found' }, { status: 404 }, env, request);
  },
};

// Squarespace OAuth helper. Sign in once in the browser, then other code calls
// squarespaceFetch() and the access token is refreshed automatically.
//
//   node scripts/squarespace-oauth.mjs          start the local sign-in page (http://localhost:3000)
//   node scripts/squarespace-oauth.mjs --check  make one read-only API call and print the status
//
// Needs SQUARESPACE_CLIENT_ID and SQUARESPACE_CLIENT_SECRET in .env (from the developer app).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const TOKEN_FILE = path.join(ROOT, 'squarespace-tokens.json');

const AUTHORIZE_URL = 'https://login.squarespace.com/api/1/login/oauth/provider/authorize';
const TOKEN_URL = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens';
const API_BASE = 'https://api.squarespace.com';
const USER_AGENT = 'VHF Website (Squarespace OAuth client)';

// Read-only by default. Add write scopes (e.g. website.orders) via SQUARESPACE_SCOPES in .env.
const DEFAULT_SCOPES = [
  'website.orders.read',
  'website.products.read',
  'website.inventory.read',
  'website.contacts.read',
  'website.transactions.read',
];

const ACCESS_TOKEN_LIFETIME_MS = 30 * 60 * 1000; // Squarespace access tokens last 30 minutes
const REFRESH_MARGIN_MS = 5 * 60 * 1000;         // refresh when 5 minutes or less remain
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

let refreshing = null; // one refresh at a time: refresh tokens are single-use

function parseEnvFile() {
  const vars = {};
  if (!fs.existsSync(ENV_FILE)) return vars;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function config() {
  const env = { ...parseEnvFile(), ...process.env };
  if (!env.SQUARESPACE_CLIENT_ID || !env.SQUARESPACE_CLIENT_SECRET) {
    throw new Error('Set SQUARESPACE_CLIENT_ID and SQUARESPACE_CLIENT_SECRET in .env first.');
  }
  return {
    clientId: env.SQUARESPACE_CLIENT_ID,
    clientSecret: env.SQUARESPACE_CLIENT_SECRET,
    redirectUri: env.SQUARESPACE_REDIRECT_URI || 'http://localhost:3000/callback',
    scopes: env.SQUARESPACE_SCOPES
      ? env.SQUARESPACE_SCOPES.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_SCOPES,
  };
}

function basicAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
}

async function postToken(cfg, params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Token request failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Token response had no access_token');
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    issued_at: Date.now(),
  };
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function getAccessToken() {
  const tokens = readTokens();
  if (!tokens?.refresh_token) {
    throw new Error('Not connected yet. Run: node scripts/squarespace-oauth.mjs, then open http://localhost:3000');
  }
  const fresh = Date.now() - tokens.issued_at < ACCESS_TOKEN_LIFETIME_MS - REFRESH_MARGIN_MS;
  if (tokens.access_token && fresh) return tokens.access_token;

  refreshing ??= (async () => {
    const next = await postToken(config(), {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    writeTokens(next);
    return next;
  })().finally(() => {
    refreshing = null;
  });
  return (await refreshing).access_token;
}

// Use for every Squarespace API call. Pass a path like '/1.0/commerce/orders' or a full URL.
export async function squarespaceFetch(pathOrUrl, init = {}) {
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API_BASE + pathOrUrl;
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
  });
}

function page(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2em">${body}</body>`);
}

function startSignInServer(cfg, port) {
  const pending = new Map(); // state -> time issued (this run only)

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/') {
      const state = crypto.randomBytes(16).toString('hex');
      pending.set(state, Date.now());
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        scope: cfg.scopes.join(','),
        state,
        access_type: 'offline',
      });
      return page(res, 200, `<a href="${AUTHORIZE_URL}?${params}">Connect Squarespace</a>`);
    }

    if (url.pathname === '/callback') {
      if (url.searchParams.get('error')) return page(res, 400, 'Squarespace did not grant access.');

      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const issued = pending.get(state);
      if (!code || !issued || Date.now() - issued > SIGN_IN_TIMEOUT_MS) {
        return page(res, 400, 'Sign-in expired or invalid. Start again from <a href="/">the home page</a>.');
      }
      pending.delete(state);

      try {
        writeTokens(await postToken(cfg, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: cfg.redirectUri,
        }));
        console.log('Connected to Squarespace. Tokens saved. You can stop this server (Ctrl+C).');
        return page(res, 200, 'Connected to Squarespace. You can close this tab.');
      } catch (err) {
        console.error(err.message);
        return page(res, 500, 'Token exchange failed. See the terminal for details.');
      }
    }

    page(res, 404, 'Not found.');
  });
}

async function check() {
  const res = await squarespaceFetch('/1.0/commerce/orders?maxResults=1');
  console.log(`Orders check: HTTP ${res.status}`);
  process.exitCode = res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = config();
  if (process.argv.includes('--check')) {
    await check();
  } else {
    const port = Number(new URL(cfg.redirectUri).port || 80);
    startSignInServer(cfg, port).listen(port, 'localhost', () => {
      console.log(`Open http://localhost:${port} and click Connect Squarespace. Press Ctrl+C when done.`);
    });
  }
}

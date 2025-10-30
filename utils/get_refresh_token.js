// One-time helper to obtain a Spotify refresh token and store it in Upstash (REST API).
// It reads config from .env in repo root or from environment variables.

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const qs = require('querystring');

let axios;
try {
  axios = require('axios');
} catch (e) {
  console.error('Missing dependency: axios. Run `npm install axios` and try again.');
  process.exit(1);
}

try {
  require('dotenv').config();
} catch (e) { }

function getEnv(name) {
  return process.env[name] || null;
}

const SPOTIFY_CLIENT_ID = getEnv('SPOTIFY_CLIENT_ID');
const SPOTIFY_CLIENT_SECRET = getEnv('SPOTIFY_CLIENT_SECRET');
const PORT = 3001;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://127.0.0.1:${PORT}${CALLBACK_PATH}`;
const SCOPE = getEnv('SPOTIFY_SCOPE') || 'user-read-currently-playing user-read-playback-state';

// Upstash REST API variables from .env (as you listed)
const UPSTASH_REST_API_URL = getEnv('middleware_KV_REST_API_URL');
const UPSTASH_REST_API_TOKEN = getEnv('middleware_KV_REST_API_TOKEN');
// optional read-only token
const UPSTASH_READ_ONLY = getEnv('middleware_KV_REST_API_READ_ONLY_TOKEN');

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env or environment.');
  process.exit(1);
}
if (!UPSTASH_REST_API_URL || !UPSTASH_REST_API_TOKEN) {
  console.error('Upstash REST API variables missing. Set middleware_KV_REST_API_URL and middleware_KV_REST_API_TOKEN in .env.');
  process.exit(1);
}

const AUTHORIZE_URL = buildAuthorizeUrl();

startServer();

function buildAuthorizeUrl() {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = qs.stringify({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
  });
  return url.toString();
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) {
        console.error('Authorization error:', error);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>No code</h1>');
        server.close();
        return;
      }

      // Exchange code for tokens
      try {
        const tokens = await exchangeCodeForTokens(code);
        if (!tokens.refresh_token) {
          console.warn('No refresh_token returned by Spotify. If you used PKCE or implicit flows, refresh_token may not be present.');
        }

        // store refresh token in Upstash
        if (tokens.refresh_token) {
          await upstashSet('spotify:refresh_token', tokens.refresh_token);
          // Print a copy-pastable line to add to .env if the user wants to keep a local fallback
          const safe = tokens.refresh_token.includes(' ') ? `"${tokens.refresh_token.replace(/"/g, '\\"')}"` : tokens.refresh_token;
          console.log('\nAdd this line to your .env (optional local fallback):');
          console.log(`SPOTIFY_REFRESH_TOKEN="${safe}"\n`);

        }
        // Optionally store access token + expiry (useful for immediate calls)
        if (tokens.access_token && tokens.expires_in) {
          const expiresAt = Date.now() + tokens.expires_in * 1000;
          await upstashSet('spotify:access_token', tokens.access_token);
          await upstashSet('spotify:access_expires_at', String(expiresAt));
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success</h1><p>Refresh token stored to Upstash. You can close this tab.</p>');

        console.log('\nStored refresh token to Upstash key: spotify:refresh_token');
      } catch (e) {
        console.error('Failed to exchange/store tokens:', e && e.response ? e.response.data : e.message || e);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Token exchange failed</h1><pre>' + String(e && e.message || e) + '</pre>');
      } finally {
        server.close();
      }

    } catch (err) {
      console.error('Unexpected error in callback handler:', err);
      res.writeHead(500);
      res.end('Server error');
      server.close();
    }
  });

  server.listen(PORT, () => {
    console.log(`Listening for callback at ${REDIRECT_URI}`);
    console.log('\nOpen this URL in your browser to authorize the app:');
    console.log(AUTHORIZE_URL + '\n');
  });
}

async function exchangeCodeForTokens(code) {
  const tokenUrl = 'https://accounts.spotify.com/api/token';
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const body = qs.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const resp = await axios.post(tokenUrl, body, {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 15000,
  });
  return resp.data;
}

async function upstashSet(key, value) {
  // Upstash REST "set" endpoint: POST {url}/set/{key}/{value}
  const url = `${UPSTASH_REST_API_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`;
  const resp = await axios.post(url, null, {
    headers: { Authorization: `Bearer ${UPSTASH_REST_API_TOKEN}` },
    timeout: 10000,
    validateStatus: () => true,
  });
  if (resp.status >= 400) {
    throw new Error(`Upstash set failed ${resp.status}: ${JSON.stringify(resp.data)}`);
  }
  return resp.data;
}

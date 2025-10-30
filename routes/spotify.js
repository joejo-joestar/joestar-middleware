var express = require('express');
var axios = require('axios');
var router = express.Router();

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';

// Spotify client from env
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || null;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || null;
// optional fallback refresh token (one-time use if Upstash isn't seeded)
const FALLBACK_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN || null;

const UPSTASH_URL = process.env.middleware_KV_REST_API_URL || null;
const UPSTASH_TOKEN = process.env.middleware_KV_REST_API_TOKEN || null;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in env');
}

// in-memory token cache (per-process invocation)
let tokenCache = {
  accessToken: null,
  expiresAt: 0, // ms epoch
};

// single-flight refresh promise
let inFlightRefresh = null;

const TOKEN_EXPIRY_BUFFER_MS = 10 * 1000; // refresh 10s before expiry
const AXIOS_TIMEOUT_MS = 7000;

// Upstash helpers (REST)
async function upstashGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      timeout: AXIOS_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (resp.status !== 200) return null;
    return resp.data && resp.data.result !== undefined ? resp.data.result : null;
  } catch (err) {
    console.error('Upstash get error:', err && err.message || err);
    return null;
  }
}

async function upstashSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash not configured');
  const url = `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`;
  const resp = await axios.post(url, null, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    timeout: AXIOS_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (resp.status >= 400) {
    throw new Error(`Upstash set failed ${resp.status}: ${JSON.stringify(resp.data)}`);
  }
  return resp.data;
}

// Helper to get stored refresh token (Upstash first, fallback to env)
async function getStoredRefreshToken() {
  const key = 'spotify:refresh_token';
  const stored = await upstashGet(key);
  if (stored) return stored;
  if (FALLBACK_REFRESH_TOKEN) return FALLBACK_REFRESH_TOKEN;
  return null;
}

// Perform token refresh using stored refresh token and persist results
async function doRefreshTokenRequest(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET || !refreshToken) {
    const e = new Error('Missing Spotify credentials/refresh token');
    e.status = 500;
    throw e;
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString();

  const resp = await axios.post(TOKEN_ENDPOINT, params, {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: AXIOS_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    const msg = resp.data && resp.data.error_description ? resp.data.error_description : resp.data || resp.statusText;
    const e = new Error(`Failed to refresh token: ${msg}`);
    e.status = resp.status;
    throw e;
  }

  const body = resp.data || {};
  if (!body.access_token) {
    const e = new Error('Token response missing access_token');
    e.status = 502;
    throw e;
  }

  // persist access_token and expiry to Upstash (good to reduce repeated refreshes)
  try {
    const expiresIn = body.expires_in || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;
    await upstashSet('spotify:access_token', body.access_token);
    await upstashSet('spotify:access_expires_at', String(expiresAt));
    // store rotated refresh token if present
    if (body.refresh_token) {
      await upstashSet('spotify:refresh_token', body.refresh_token);
    }
  } catch (e) {
    console.warn('Failed to persist tokens to Upstash:', e && e.message || e);
    // not fatal — we still return tokens
  }

  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in || 3600,
    refreshToken: body.refresh_token || null,
  };
}

// The main fetchAccessToken function used by handlers
async function fetchAccessToken() {
  // return cached if still valid
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return tokenCache.accessToken;
  }

  // check Upstash for cached access token
  try {
    const storedAccess = await upstashGet('spotify:access_token');
    const storedExpires = await upstashGet('spotify:access_expires_at');
    if (storedAccess && storedExpires) {
      const expiresAt = Number(storedExpires);
      if (!Number.isNaN(expiresAt) && Date.now() < expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
        tokenCache.accessToken = storedAccess;
        tokenCache.expiresAt = expiresAt;
        return tokenCache.accessToken;
      }
    }
  } catch (e) {
    // ignore and proceed to refresh
    console.warn('Upstash read error (will attempt refresh):', e && e.message || e);
  }

  // If a refresh is already in progress, wait for it
  if (inFlightRefresh) {
    try {
      await inFlightRefresh;
      if (tokenCache.accessToken) return tokenCache.accessToken;
    } catch (e) {
      // continue to attempt new refresh
      inFlightRefresh = null;
    }
  }

  // Start refresh and set single-flight promise
  inFlightRefresh = (async () => {
    try {
      const refreshToken = await getStoredRefreshToken();
      if (!refreshToken) {
        const e = new Error('No refresh token available (seed Upstash or set SPOTIFY_REFRESH_TOKEN env)');
        e.status = 500;
        throw e;
      }
      const result = await doRefreshTokenRequest(refreshToken);
      tokenCache.accessToken = result.accessToken;
      tokenCache.expiresAt = Date.now() + (result.expiresIn || 3600) * 1000;
      return tokenCache.accessToken;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return await inFlightRefresh;
}

function simplifyNowPlaying(payload) {
  if (!payload || !payload.item) return null;
  const song = payload.item;
  const albumImageUrl = song.album && song.album.images && song.album.images[0] ? song.album.images[0].url : null;
  const artist = song.artists ? song.artists.map((a) => a.name).join(', ') : null;
  const isPlaying = payload.is_playing || false;
  const songUrl = song.external_urls ? song.external_urls.spotify : null;
  const title = song.name || null;
  const timePlayed = payload.progress_ms || 0;
  const timeTotal = song.duration_ms || 0;
  const artistUrl = song.artists && song.artists[0] && song.artists[0].external_urls ? song.artists[0].external_urls.spotify : null;
  const albumUrl = song.album && song.album.external_urls ? song.album.external_urls.spotify : null;

  return {
    albumImageUrl,
    artist,
    isPlaying,
    songUrl,
    albumUrl,
    title,
    timePlayed,
    timeTotal,
    artistUrl,
  };
}

// Helper to call IPv4-resilient GET with timeout and headers
async function callNowPlaying(accessToken) {
  return axios.get(NOW_PLAYING_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: AXIOS_TIMEOUT_MS,
    validateStatus: () => true,
  });
}

// GET /spotify/now-playing
router.get('/now-playing', async function (req, res) {
  try {
    let accessToken;
    try {
      accessToken = await fetchAccessToken();
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ error: err.message });
    }

    let resp = await callNowPlaying(accessToken);

    // 401 -> try refresh once
    if (resp.status === 401) {
      tokenCache.accessToken = null;
      try {
        const fresh = await fetchAccessToken();
        resp = await callNowPlaying(fresh);
      } catch (retryErr) {
        return res.status(retryErr.status || 500).json({ error: retryErr.message });
      }
    }

    // 204 -> no current playback
    if (resp.status === 204) {
      return res.status(200).json({ meta: { authenticated: true }, nowPlaying: null, message: 'Not currently playing' });
    }

    // 429 -> rate limited
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers['retry-after'] || '0', 10);
      const message = retryAfter ? `Rate limited; retry after ${retryAfter} seconds` : 'Rate limited';
      return res.status(429).json({ error: message });
    }

    if (resp.status >= 400) {
      const errBody = resp.data && typeof resp.data === 'object' ? resp.data : { statusText: resp.statusText };
      return res.status(resp.status).json({ error: errBody });
    }

    const simplified = simplifyNowPlaying(resp.data);
    return res.json({ meta: { authenticated: true }, nowPlaying: simplified });
  } catch (err) {
    console.error('Unexpected /spotify/now-playing error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
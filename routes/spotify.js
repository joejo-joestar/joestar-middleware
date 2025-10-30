var express = require('express');
var axios = require('axios');
var router = express.Router();

// Server-side Spotify helper
// GET /spotify/now-playing -> returns simplified now-playing info

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_ENDPOINT = 'https://api.spotify.com/v1/me/player/currently-playing';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || null;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || null;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN || null;

// in-memory token cache
let tokenCache = {
    accessToken: null,
    expiresAt: 0, // ms epoch
};

const TOKEN_EXPIRY_BUFFER_MS = 10 * 1000; // refresh 10s before expiry

async function fetchAccessToken() {
    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
        throw new Error('Missing Spotify credentials (set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN)');
    }

    // return cached if still valid
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
        return tokenCache.accessToken;
    }

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN,
    }).toString();

    const response = await axios.post(TOKEN_ENDPOINT, params, {
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        const msg = response.data && response.data.error_description ? response.data.error_description : response.data || response.statusText;
        const e = new Error(`Failed to fetch access token: ${msg}`);
        e.status = response.status;
        throw e;
    }

    const { access_token, expires_in } = response.data;
    tokenCache.accessToken = access_token;
    tokenCache.expiresAt = Date.now() + (expires_in || 3600) * 1000;

    return access_token;
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

// MARK: Now Playing Endpoint
// GET /spotify/now-playing
// Returns { meta: { authenticated }, nowPlaying: {...} }
router.get('/now-playing', async function (req, res) {
    try {
        let accessToken;
        try {
            accessToken = await fetchAccessToken();
        } catch (err) {
            // propagate token fetch errors as 500 unless they include a status
            const status = err.status || 500;
            return res.status(status).json({ error: err.message });
        }

        const resp = await axios.get(NOW_PLAYING_ENDPOINT, {
            headers: { Authorization: `Bearer ${accessToken}` },
            validateStatus: () => true,
        });

        // handle common statuses
        if (resp.status === 204) {
            return res.status(200).json({ meta: { authenticated: true }, nowPlaying: null, message: 'Not currently playing' });
        }

        if (resp.status === 401) {
            // token might be invalid; clear cache and retry once
            tokenCache.accessToken = null;
            try {
                const freshToken = await fetchAccessToken();
                const retry = await axios.get(NOW_PLAYING_ENDPOINT, {
                    headers: { Authorization: `Bearer ${freshToken}` },
                    validateStatus: () => true,
                });
                if (retry.status >= 400) {
                    return res.status(retry.status).json({ error: retry.data || retry.statusText });
                }
                const simplified = simplifyNowPlaying(retry.data);
                return res.json({ meta: { authenticated: true }, nowPlaying: simplified });
            } catch (retryErr) {
                return res.status(500).json({ error: retryErr.message });
            }
        }

        if (resp.status >= 400) {
            return res.status(resp.status).json({ error: resp.data || resp.statusText });
        }

        const simplified = simplifyNowPlaying(resp.data);
        return res.json({ meta: { authenticated: true }, nowPlaying: simplified });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;

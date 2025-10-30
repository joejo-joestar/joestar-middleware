var express = require('express');
var axios = require('axios');
var router = express.Router();

// Server-side Unsplash proxy
// GET /unsplash/collections -> lists collections for user name string in .env
// GET /unsplash/collections/:id/photos -> lists photos for a collection

const UNSPLASH_ROOT = 'https://api.unsplash.com';
const UNSPLASH_USER = process.env.UNSPLASH_USERNAME;
const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_CLIENT_ID || null;

const CACHE_TTL_MS = 120 * 1000; // 120s
let cache = {
    collections: { data: null, expiresAt: 0 },
    photos: {}, // keyed by collection id
};

function cachedGetCollections() {
    if (cache.collections.data && Date.now() < cache.collections.expiresAt) return cache.collections.data;
    return null;
}

function setCollectionsCache(data) {
    cache.collections.data = data;
    cache.collections.expiresAt = Date.now() + CACHE_TTL_MS;
}

function cachedGetPhotos(collectionID) {
    const entry = cache.photos[collectionID];
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
}

function setPhotosCache(collectionID, data) {
    cache.photos[collectionID] = { data, expiresAt: Date.now() + CACHE_TTL_MS };
}

async function fetchFromUnsplash(path, params = {}) {
    if (!ACCESS_KEY) {
        const e = new Error('Missing Unsplash access key (set UNSPLASH_ACCESS_KEY or UNSPLASH_CLIENT_ID)');
        e.status = 500;
        throw e;
    }

    const url = `${UNSPLASH_ROOT}${path}`;
    const response = await axios.get(url, {
        headers: { Authorization: `Client-ID ${ACCESS_KEY}` },
        params,
        validateStatus: () => true,
    });

    if (response.status >= 400) {
        const err = new Error(response.data && response.data.errors ? response.data.errors.join(', ') : response.statusText);
        err.status = response.status;
        throw err;
    }

    return response.data;
}

// GET /unsplash/collections
router.get('/collections', async function (req, res) {
    try {
        const noCache = req.query.no_cache === '1';

        if (!noCache) {
            const cached = cachedGetCollections();
            if (cached) return res.json({ meta: { source: 'unsplash', cached: true }, collections: cached });
        }

        const data = await fetchFromUnsplash(`/users/${UNSPLASH_USER}/collections`);
        setCollectionsCache(data);
        return res.json({ meta: { source: 'unsplash', cached: false }, collections: data });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ error: err.message });
    }
});

// MARK: Photos Endpoint
// GET /unsplash/collections/:id/photos
router.get('/collections/:id/photos', async function (req, res) {
    try {
        const collectionID = req.params.id;
        const noCache = req.query.no_cache === '1';
        const per_page = req.query.per_page || 30;

        if (!noCache) {
            const cached = cachedGetPhotos(collectionID);
            if (cached) return res.json({ meta: { source: 'unsplash', cached: true }, photos: cached });
        }

        const data = await fetchFromUnsplash(`/collections/${collectionID}/photos`, { per_page });
        setPhotosCache(collectionID, data);
        return res.json({ meta: { source: 'unsplash', cached: false }, photos: data });
    } catch (err) {
        const status = err.status || 500;
        return res.status(status).json({ error: err.message });
    }
});

module.exports = router;

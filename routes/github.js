var express = require("express");
var axios = require("axios");
var router = express.Router();

// Server-side GitHub proxy
// GET /github/repos -> returns the user's repos, filters a local blacklist, caches for a short TTL
// GET /github/:repo/readme -> returns the README.md content for a given repo

const GITHUB_ROOT = "https://api.github.com";
const USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_ACCESS_TOKEN || null;

// simple in-memory cache
let cache = {
  data: null,
  expiresAt: 0,
};

const CACHE_TTL_MS = 60 * 1000; // 60s

const repoBlacklist = [
  { id: 870897038 },
  { id: 732342842 },
  { id: 1047632816 },
  { id: 689259000 },
  { id: 1063993915 },
];

function filterBlacklist(repos) {
  const blocked = new Set(repoBlacklist.map((r) => r.id));
  return repos.filter((r) => !blocked.has(r.id));
}

// MARK: Repos Endpoint
// GET /github/repos
router.get("/repos", async function (req, res, _next) {
  try {
    // allow bypassing cache with ?no_cache=1
    const noCache = req.query.no_cache === "1";

    if (!noCache && cache.data && Date.now() < cache.expiresAt) {
      return res.json(cache.data);
    }

    const url = `${GITHUB_ROOT}/users/${USERNAME}/repos?sort=pushed&type=all`;

    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

    const response = await axios.get(url, { headers });

    let repos = response.data;
    if (!Array.isArray(repos)) repos = [];

    const filtered = filterBlacklist(repos);

    // cache result
    cache.data = filtered;
    cache.expiresAt = Date.now() + CACHE_TTL_MS;

    // surface a small hint about auth/rate limiting
    const meta = {
      source: "github",
      authenticated: !!GITHUB_TOKEN,
    };

    return res.json({ meta, repos: filtered });
  } catch (err) {
    // forward useful info but avoid leaking tokens
    const status =
      err.response && err.response.status ? err.response.status : 500;
    const message =
      err.response && err.response.data
        ? err.response.data
        : { message: err.message };
    return res.status(status).json({ error: message });
  }
});

// MARK: README Endpoint
// GET /github/:repo/readme
router.get("/:repo/readme", async function (req, res, _next) {
  try {
    const repo = req.params.repo;

    const url = `${GITHUB_ROOT}/repos/${USERNAME}/${repo}/contents/README.md`;

    // fetch raw content (since its only the readmes and they arent that large (usually))
    const headers = {
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
    const response = await axios.get(url, { headers });

    return res.send(response.data);
  } catch (err) {
    const status =
      err.response && err.response.status ? err.response.status : 500;
    const message =
      err.response && err.response.data
        ? err.response.data
        : { message: err.message };
    return res.status(status).json({ error: message });
  }
});

module.exports = router;

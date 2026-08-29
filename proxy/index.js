/**
 * headlines-proxy — a narrow Cloud Run function that sits between the daily
 * Cowork agent task and the Guardian / GNews APIs.
 *
 * The Cowork task has no secret storage of its own, and prompts/agent-prompt.md
 * lives in a public repo — so nothing sensitive can live in the prompt text.
 * This function holds the real Guardian/GNews keys and PROXY_TOKEN as Secret
 * Manager references, and the destination email as a plain env var (see
 * README.md for why the split), and exposes two routes instead:
 *
 *   GET /headlines?lang=en|es|sv&topic=<optional>&q=<optional>
 *     -> merged, normalized headlines from whichever upstream(s) support
 *        that language.
 *
 *   GET /config
 *     -> { "recipientEmail": "..." } — the one non-secret "variable" the
 *        prompt used to hardcode.
 *
 * Every request must carry the PROXY_TOKEN, either as `Authorization: Bearer
 * <PROXY_TOKEN>` or as a `?token=<PROXY_TOKEN>` query parameter. The query
 * form exists because the daily agent calls this with a web fetch/browsing
 * tool that can't attach a custom request header (the same reason the
 * pre-proxy prompt passed vendor keys as query params). That token is the
 * ONE credential that still has to live in the live Cowork prompt (never in
 * the committed template) — but it's a token we mint ourselves, scoped to
 * nothing but this endpoint. If it leaks, the blast radius is "someone can
 * fetch public headlines through my quota", not "someone has my
 * Guardian/GNews vendor credentials". Rotating it is a redeploy, not a trip
 * to a vendor dashboard.
 *
 * Deploy with `gcloud run deploy` — see README.md in this folder.
 */

'use strict';

const crypto = require('crypto');

const GUARDIAN_API_KEY = process.env.GUARDIAN_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const PROXY_TOKEN = process.env.PROXY_TOKEN;
const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL;

const ALLOWED_LANGS = new Set(['en', 'es', 'sv']);

// Per-instance only — Cloud Run functions can scale to multiple instances, so
// this is best-effort, not a hard global cap. It's enough to stop a single
// runaway loop or a retry storm from re-hitting the upstream vendors within
// one warm instance; it is NOT a substitute for keeping PROXY_TOKEN secret.
// If you ever need a hard global limit, move this state to Firestore or
// Memorystore — see the note in README.md.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const cache = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20; // this only runs a handful of times/day; this is a ceiling, not a target
const rateLimitHits = [];

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// The token can arrive two ways. `Authorization: Bearer <token>` is preferred
// (nothing that can send a header should use the query form). But the daily
// agent's web fetch/browsing tool can't set request headers, so it passes
// `?token=<token>` instead. That does land the token in Cloud Run's request
// logs — acceptable here: it authorizes nothing but "call this endpoint
// through my Guardian/GNews quota" and rotates with a redeploy (see the
// PROXY_TOKEN rotation note in README.md).
function extractToken(req) {
  const header = req.get('Authorization') || '';
  const [scheme, headerToken] = header.split(' ');
  if (scheme === 'Bearer' && headerToken) return headerToken;
  if (req.query.token) return String(req.query.token);
  return '';
}

function checkAuth(req) {
  const token = extractToken(req);
  return Boolean(token) && timingSafeEqual(token, PROXY_TOKEN);
}

function checkRateLimit() {
  const now = Date.now();
  while (rateLimitHits.length && now - rateLimitHits[0] > RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.shift();
  }
  if (rateLimitHits.length >= RATE_LIMIT_MAX) return false;
  rateLimitHits.push(now);
  return true;
}

// Guardian's page-size defaults to 10 but goes up to 200 for a standard key.
// It isn't vendor-throttled the way GNews is below, so we ask for more by
// default -- more raw candidates for the prompt's own dedup/selection step.
const GUARDIAN_DEFAULT_COUNT = 20;
const GUARDIAN_MAX_COUNT = 50;

// GNews hard-caps `max` at 10 on the free plan -- requesting more just errors,
// so this ceiling isn't a design choice, it's the vendor's.
const GNEWS_DEFAULT_COUNT = 10;
const GNEWS_MAX_COUNT = 10;

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

// This feeds an LLM prompt, not a page render, so excerpts are capped
// rather than shipped in full -- Guardian's bodyText alone can run to
// several thousand words per article, and with up to ~50 articles in one
// response that would balloon the payload for no real benefit to a 2-4
// sentence summary.
const EXCERPT_MAX_CHARS = 800;

function truncate(text, maxChars) {
  const clean = (text || '').trim();
  if (clean.length <= maxChars) return clean;
  // Cut at the last word boundary before the limit rather than mid-word.
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : maxChars)}…`;
}

// GNews's free-plan `content` field ends with a "[+123 chars]" marker where
// it truncated the article -- noise for an LLM prompt, so strip it.
function stripGNewsContentSuffix(text) {
  return (text || '').replace(/\s*\[\+\d+\s*chars?\]\s*$/i, '');
}

function clampCount(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

async function fetchGuardian(topic, q, count) {
  const params = new URLSearchParams({
    'api-key': GUARDIAN_API_KEY,
    'order-by': 'newest',
    'page-size': String(count),
    // trailText is the short dek Guardian shows under a headline; bodyText
    // is the full plain-text article, truncated below into `excerpt` for
    // real substance without shipping the whole piece.
    'show-fields': 'trailText,bodyText',
  });
  if (topic) params.set('section', topic);
  if (q) params.set('q', q);

  const resp = await fetch(`https://content.guardianapis.com/search?${params}`);
  if (!resp.ok) throw new Error(`guardian upstream error: ${resp.status}`);
  const data = await resp.json();
  return (data.response?.results || []).map((r) => ({
    source: 'guardian',
    title: r.webTitle,
    summary: stripHtml(r.fields?.trailText),
    excerpt: truncate(stripHtml(r.fields?.bodyText), EXCERPT_MAX_CHARS),
    url: r.webUrl,
    publishedAt: r.webPublicationDate,
  }));
}

async function fetchGNews(lang, topic, q, count) {
  const params = new URLSearchParams({ token: GNEWS_API_KEY, lang, max: String(count) });
  if (topic) params.set('topic', topic);
  if (q) params.set('q', q);

  const endpoint = q ? 'search' : 'top-headlines';
  const resp = await fetch(`https://gnews.io/api/v4/${endpoint}?${params}`);
  if (!resp.ok) throw new Error(`gnews upstream error: ${resp.status}`);
  const data = await resp.json();
  return (data.articles || []).map((a) => ({
    source: 'gnews',
    title: a.title,
    // `description` is a short summary on every plan. `content` is longer
    // -- on the free plan it's still capped at ~200 chars (with a
    // "[+N chars]" marker where GNews cut it), but that's more than
    // `description` alone, and paid plans get the full article here.
    summary: a.description || '',
    excerpt: truncate(stripGNewsContentSuffix(a.content), EXCERPT_MAX_CHARS),
    url: a.url,
    publishedAt: a.publishedAt,
  }));
}

async function handleHeadlines(req, res) {
  const lang = String(req.query.lang || '').toLowerCase();
  const topic = req.query.topic ? String(req.query.topic) : undefined;
  const q = req.query.q ? String(req.query.q) : undefined;

  if (!ALLOWED_LANGS.has(lang)) {
    res.status(400).json({ error: `lang must be one of: ${[...ALLOWED_LANGS].join(', ')}` });
    return;
  }

  const cacheKey = `${lang}:${topic || ''}:${q || ''}:${req.query.max || ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.set('X-Cache', 'HIT');
    res.json(cached.body);
    return;
  }

  // Guardian is an English-language archive; only call it for lang=en.
  // GNews covers en/es/sv, so it's always called. `max` (if given) requests
  // the same count from both, each clamped to what that vendor allows.
  const gnewsCount = clampCount(req.query.max, GNEWS_DEFAULT_COUNT, GNEWS_MAX_COUNT);
  const guardianCount = clampCount(req.query.max, GUARDIAN_DEFAULT_COUNT, GUARDIAN_MAX_COUNT);
  const calls = [fetchGNews(lang, topic, q, gnewsCount)];
  if (lang === 'en') calls.push(fetchGuardian(topic, q, guardianCount));

  const results = await Promise.allSettled(calls);
  const articles = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

  if (articles.length === 0 && errors.length > 0) {
    res.status(502).json({ error: 'upstream_failure', detail: errors });
    return;
  }

  const body = { lang, topic: topic || null, count: articles.length, articles, errors };
  cache.set(cacheKey, { at: Date.now(), body });
  res.set('X-Cache', 'MISS');
  res.json(body);
}

function handleConfig(req, res) {
  res.json({ recipientEmail: RECIPIENT_EMAIL });
}

exports.headlinesProxy = async (req, res) => {
  if (!PROXY_TOKEN || !GUARDIAN_API_KEY || !GNEWS_API_KEY || !RECIPIENT_EMAIL) {
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  if (!checkAuth(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!checkRateLimit()) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const path = req.path.replace(/\/+$/, '') || '/';
  try {
    if (path === '/headlines' || path === '') {
      await handleHeadlines(req, res);
    } else if (path === '/config') {
      handleConfig(req, res);
    } else {
      res.status(404).json({ error: 'not_found' });
    }
  } catch (err) {
    res.status(502).json({ error: 'upstream_failure', detail: err.message });
  }
};

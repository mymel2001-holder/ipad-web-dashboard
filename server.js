#!/usr/bin/env node
/**
 * iPad Web Dashboard — zero-dependency Node.js server.
 *
 * Endpoints:
 *   GET /              -> dashboard (public/)
 *   GET /api/news      -> RSS headlines filtered to "good news" by a local Ollama model
 *   GET /api/weather   -> current weather + today's high/low (Open-Meteo proxy)
 *   GET /api/health    -> server + Ollama reachability
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (err) {
    console.warn(`[config] Could not read config.json (${err.message}); using defaults.`);
  }

  const env = (v) => (v === undefined || v === '' ? undefined : v);

  return {
    port: Number(env(process.env.PORT) || file.port || 3000),
    host: env(process.env.HOST) || file.host || '0.0.0.0',
    ollama: {
      baseUrl: String(
        env(process.env.OLLAMA_URL) ||
          (file.ollama && file.ollama.baseUrl) ||
          'http://100.118.11.83:11434'
      ).replace(/\/+$/, ''),
      model: env(process.env.OLLAMA_MODEL) || (file.ollama && file.ollama.model) || 'ministral-3:3b',
    },
    weather: {
      latitude: Number(env(process.env.WEATHER_LAT) || (file.weather && file.weather.latitude) || 41.8781),
      longitude: Number(env(process.env.WEATHER_LON) || (file.weather && file.weather.longitude) || -87.6298),
      city: (file.weather && file.weather.city) || 'Chicago',
    },
    news: {
      feeds:
        (file.news && Array.isArray(file.news.feeds) && file.news.feeds) || [
          'https://feeds.bbci.co.uk/news/world/rss.xml',
          'https://www.theguardian.com/world/rss',
          'https://feeds.npr.org/1001/rss.xml',
          'https://www.goodnewsnetwork.org/feed/',
        ],
      maxItems: Number((file.news && file.news.maxItems) || 18),
      classifyPool: Number((file.news && file.news.classifyPool) || 36),
      batchSize: Number((file.news && file.news.batchSize) || 12),
      cacheTtlMinutes: Number((file.news && file.news.cacheTtlMinutes) || 30),
      rssTimeoutMs: 15000,
      ollamaTimeoutMs: 180000,
      weatherTtlMs: 10 * 60 * 1000,
    },
  };
}

const CONFIG = loadConfig();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function decodeOnce(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'|'/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&');
}

// Some feeds double-encode entities (e.g. "&apos;"); decode until stable.
function decodeEntities(str) {
  let out = String(str);
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTags(str) {
  return String(str)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* RSS parsing (RSS 2.0 <item> + Atom <entry>, CDATA aware)            */
/* ------------------------------------------------------------------ */

function stripCdata(raw) {
  const s = String(raw).trim();
  if (/^<!\[CDATA\[/i.test(s) && /\]\]>$/i.test(s)) {
    return s.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '');
  }
  return s;
}

function extractField(block, tags) {
  for (const tag of tags) {
    // Self-closing <link href="..."> (Atom)
    if (tag === 'link') {
      const href = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
      const withText = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
      if (withText && stripCdata(withText[1])) return decodeEntities(stripCdata(withText[1]).trim());
      if (href) return decodeEntities(href[1].trim());
      continue;
    }
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    if (m) {
      const val = stripCdata(m[1]).trim();
      if (val) return decodeEntities(val);
    }
  }
  return '';
}

function parseFeed(xml, sourceName) {
  const items = [];
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ];
  for (const { 0: block } of blocks) {
    const title = extractField(block, ['title']);
    if (!title) continue;
    const rawDate =
      extractField(block, ['pubDate', 'published', 'updated', 'dc:date']) || '';
    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    items.push({
      title: decodeEntities(title).trim(),
      link: extractField(block, ['link']),
      summary: truncate(stripTags(extractField(block, ['description', 'summary', 'content'])), 220),
      publishedAt: rawDate,
      timestamp: Number.isNaN(parsed) ? Date.now() : parsed,
      source: sourceName,
    });
  }
  return items;
}

const SOURCE_NAMES = {
  bbci: 'BBC',
  bbc: 'BBC',
  npr: 'NPR',
  theguardian: 'The Guardian',
  guardian: 'The Guardian',
  goodnewsnetwork: 'Good News Network',
  cnn: 'CNN',
  apnews: 'AP News',
  reuters: 'Reuters',
  nytimes: 'NY Times',
  wsj: 'WSJ',
  aljazeera: 'Al Jazeera',
  axios: 'Axios',
  nbcnews: 'NBC News',
  cbsnews: 'CBS News',
  abcnews: 'ABC News',
};

function sourceNameFromUrl(feedUrl) {
  try {
    const host = new URL(feedUrl)
      .hostname
      .replace(/^www\./i, '')
      .replace(/^feeds?\./i, '')
      .replace(/^rss\./i, '');
    const label = host.split('.')[0].toLowerCase();
    return SOURCE_NAMES[label] || label.toUpperCase();
  } catch {
    return feedUrl;
  }
}

/* ------------------------------------------------------------------ */
/* Ollama "good news" classifier                                       */
/* ------------------------------------------------------------------ */

const CLASSIFY_SYSTEM = 'You are a JSON-only API. You always respond with a single valid JSON object and nothing else.';

function classificationPrompt(headlines) {
  const list = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
  return [
    'Classify each numbered news headline below as "good" or "bad" for a morning dashboard that only shows positive, uplifting stories.',
    '',
    'Rules:',
    '- "good" = clearly positive, uplifting, heartwarming, hopeful, or about progress, achievements, kindness, science breakthroughs, rescues, or good humor.',
    '- "bad" = crime, war, disasters, deaths, illness, conflict, court cases, lawsuits, politics, scandals, business/earnings, and neutral/mundane reporting.',
    '- Celebrity gossip, sports results, and company/CEO news are NOT "good" unless the story is genuinely heartwarming.',
    '- Only mark "good" if the story itself would make most readers feel good. When unsure, answer "bad".',
    '',
    'Headlines:',
    list,
    '',
    'Respond with JSON exactly in this shape, one entry per headline:',
    '{"verdicts":{"1":"good","2":"bad"}}',
  ].join('\n');
}

function parseVerdicts(content, count) {
  const verdicts = new Array(count).fill(false); // default: not good
  let map = null;
  try {
    const parsed = JSON.parse(content);
    map = parsed && typeof parsed === 'object' ? (parsed.verdicts || parsed) : null;
  } catch {
    // Fall back to extracting the JSON object from a noisy response.
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        map = parsed && typeof parsed === 'object' ? parsed.verdicts || parsed : null;
      } catch {
        /* ignore */
      }
    }
  }
  if (map && typeof map === 'object') {
    for (let i = 0; i < count; i++) {
      const v = String(map[String(i + 1)] ?? '').toLowerCase();
      verdicts[i] = v === 'good' || v === 'yes' || v === 'true';
    }
  }
  return verdicts;
}

async function classifyBatch(headlines) {
  const res = await fetchWithTimeout(
    `${CONFIG.ollama.baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.ollama.model,
        messages: [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: classificationPrompt(headlines) },
        ],
        stream: false,
        format: 'json',
        keep_alive: '15m',
        options: { temperature: 0 },
      }),
    },
    CONFIG.news.ollamaTimeoutMs
  );
  if (!res.ok) {
    throw new Error(`Ollama HTTP ${res.status}: ${truncate(await res.text(), 200)}`);
  }
  const data = await res.json();
  const content = (data.message && data.message.content) || '';
  return parseVerdicts(content, headlines.length);
}

/* ------------------------------------------------------------------ */
/* News pipeline (fetch feeds -> classify -> filter)                   */
/* ------------------------------------------------------------------ */

let newsCache = null; // { data, fetchedAt }
let newsRefreshPromise = null;

async function refreshNews() {
  const started = Date.now();

  // 1. Fetch all feeds in parallel.
  const settled = await Promise.allSettled(
    CONFIG.news.feeds.map(async (feedUrl) => {
      const res = await fetchWithTimeout(
        feedUrl,
        { headers: { 'user-agent': 'ipad-dashboard/1.0', accept: 'application/rss+xml, application/xml, text/xml' } },
        CONFIG.news.rssTimeoutMs
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseFeed(await res.text(), sourceNameFromUrl(feedUrl));
    })
  );

  let items = [];
  const feedErrors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else feedErrors.push(`${sourceNameFromUrl(CONFIG.news.feeds[i])}: ${r.reason.message}`);
  });

  if (items.length === 0) {
    throw new Error(`No RSS items fetched${feedErrors.length ? ` (${feedErrors.join('; ')})` : ''}`);
  }

  // 2. Dedupe by title, newest first, trim to classification pool.
  const seen = new Set();
  items = items
    .filter((it) => {
      const key = it.title.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, CONFIG.news.classifyPool);

  // 3. Classify with Ollama in batches. If Ollama fails, fall back to
  //    serving the raw feed clearly marked as unfiltered.
  let filterActive = true;
  let filterError = null;
  try {
    const keep = new Array(items.length).fill(true);
    for (let i = 0; i < items.length; i += CONFIG.news.batchSize) {
      const batch = items.slice(i, i + CONFIG.news.batchSize);
      const verdicts = await classifyBatch(batch.map((it) => `${it.title}${it.source ? ` (${it.source})` : ''}`));
      batch.forEach((_, j) => {
        if (!verdicts[j]) keep[i + j] = false;
      });
    }
    items = items.filter((_, j) => keep[j]);
  } catch (err) {
    filterActive = false;
    filterError = err.message;
    console.error(`[news] Ollama filtering failed, serving unfiltered: ${err.message}`);
  }

  items = items.slice(0, CONFIG.news.maxItems);

  const data = {
    items,
    filterActive,
    filterError,
    feedErrors,
    updatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  };
  newsCache = { data, fetchedAt: Date.now() };
  console.log(
    `[news] refreshed: ${items.length} good items (filter ${filterActive ? 'active' : 'OFF'}) in ${data.elapsedMs}ms`
  );
  return data;
}

async function getNews() {
  const ttl = CONFIG.news.cacheTtlMinutes * 60 * 1000;
  if (newsCache && Date.now() - newsCache.fetchedAt < ttl) return newsCache.data;

  if (!newsCache) {
    // First request after startup: wait for fresh data.
    await refreshNews();
    return newsCache.data;
  }

  // Stale cache: serve it immediately and refresh in the background.
  newsRefreshPromise =
    newsRefreshPromise ||
    refreshNews().catch((err) => {
      console.error(`[news] background refresh failed: ${err.message}`);
    }).finally(() => {
      newsRefreshPromise = null;
    });
  return { ...newsCache.data, stale: true };
}

/* ------------------------------------------------------------------ */
/* Weather (Open-Meteo proxy, no API key needed)                       */
/* ------------------------------------------------------------------ */

const WEATHER_CODES = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '❄️'],
  80: ['Light showers', '🌦️'],
  81: ['Showers', '🌧️'],
  82: ['Heavy showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm, hail', '⛈️'],
  99: ['Thunderstorm, hail', '⛈️'],
};

function describeWeatherCode(code) {
  return WEATHER_CODES[code] || ['Unknown', '🌡️'];
}

let weatherCache = null; // { data, fetchedAt }

async function getWeather() {
  const ttl = CONFIG.news.weatherTtlMs;
  if (weatherCache && Date.now() - weatherCache.fetchedAt < ttl) return weatherCache.data;

  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${CONFIG.weather.latitude}&longitude=${CONFIG.weather.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1';

  const res = await fetchWithTimeout(url, {}, 15000);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const raw = await res.json();

  const [desc, icon] = describeWeatherCode(raw.current.weather_code);
  const [dailyDesc] = describeWeatherCode(raw.daily.weather_code[0]);

  const data = {
    city: CONFIG.weather.city,
    temperature: Math.round(raw.current.temperature_2m),
    feelsLike: Math.round(raw.current.apparent_temperature),
    humidity: Math.round(raw.current.relative_humidity_2m),
    windMph: Math.round(raw.current.wind_speed_10m),
    isDay: raw.current.is_day === 1,
    description: desc,
    icon: raw.current.is_day === 1 ? icon : icon === '☀️' ? '🌙' : icon,
    high: Math.round(raw.daily.temperature_2m_max[0]),
    low: Math.round(raw.daily.temperature_2m_min[0]),
    dailyDescription: dailyDesc,
    updatedAt: new Date().toISOString(),
  };
  weatherCache = { data, fetchedAt: Date.now() };
  return data;
}

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.mp4' ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const pathname = (() => {
    try {
      return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return '/';
    }
  })();

  try {
    if (pathname === '/api/health') {
      let ollamaOk = false;
      try {
        const r = await fetchWithTimeout(`${CONFIG.ollama.baseUrl}/api/tags`, {}, 4000);
        ollamaOk = r.ok;
      } catch {
        /* not reachable */
      }
      return sendJson(res, 200, {
        ok: true,
        ollama: ollamaOk,
        ollamaUrl: CONFIG.ollama.baseUrl,
        model: CONFIG.ollama.model,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (pathname === '/api/news') {
      try {
        return sendJson(res, 200, await getNews());
      } catch (err) {
        console.error(`[news] error: ${err.message}`);
        return sendJson(res, 502, { error: err.message, items: [], filterActive: false });
      }
    }

    if (pathname === '/api/weather') {
      try {
        return sendJson(res, 200, await getWeather());
      } catch (err) {
        console.error(`[weather] error: ${err.message}`);
        return sendJson(res, 502, { error: err.message });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405, { allow: 'GET, HEAD' }).end();
  } catch (err) {
    console.error(`[server] ${err.stack || err}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`iPad dashboard running at http://localhost:${CONFIG.port}`);
  console.log(`  Weather location : ${CONFIG.weather.city} (${CONFIG.weather.latitude}, ${CONFIG.weather.longitude})`);
  console.log(`  Ollama           : ${CONFIG.ollama.baseUrl} (model: ${CONFIG.ollama.model})`);
  console.log(`  RSS feeds        : ${CONFIG.news.feeds.length}`);
});

// Warm the caches shortly after boot so the first page load is fast.
setTimeout(() => {
  getWeather().catch((e) => console.error(`[weather] warmup failed: ${e.message}`));
  getNews().catch((e) => console.error(`[news] warmup failed: ${e.message}`));
}, 500);
# iPad Web Dashboard

A zero-dependency web dashboard designed for an iPad kiosk/standby display:

- 🕐 **Clock & date** — 12-hour US format `hh:mm:ss AM/PM` + `mm/dd/yyyy`
- 🌤️ **Weather** — current conditions, high/low, wind, humidity (Open-Meteo, no API key)
- ☀️ **Good news** — RSS headlines filtered to only "good news" by a local Ollama LLM
- 🌙 **Light/dark mode** — toggle button, remembers your choice, follows system preference initially
- 🔋 **Screen keepalive** — looping 2×2px 5-second black MP4 that keeps the iPad awake

## Requirements

- Node.js 18+ (uses built-in `fetch`, **no npm install needed**)
- ffmpeg (only to regenerate the keepalive video — `public/keepalive.mp4` is pre-built)
- An Ollama instance reachable over the network (Tailscale works great)

## Run

```bash
node server.js
```

Then open `http://<your-mac-ip>:3000` in Safari on the iPad.

### iPad setup tips

1. **Add to Home Screen** (Share → Add to Home Screen) for a fullscreen, chrome-less app.
2. **Guided Access** (Settings → Accessibility → Guided Access) locks the iPad to the dashboard and prevents sleep — enable it and triple-click the side button when mounting the iPad.
3. Alternatively, Settings → Display → Auto-Lock → **Never**.

## Configuration

Edit [`config.json`](config.json):

| Key | What it does |
|---|---|
| `port` | HTTP port (default `3000`) |
| `ollama.baseUrl` | Your Ollama server (default `http://100.118.11.83:11434`) |
| `ollama.model` | Model used for good/bad classification (default `ministral-3:3b` — pick a small, fast local model) |
| `weather.latitude/longitude/city` | Weather location (defaults to Chicago) |
| `news.feeds` | RSS feed URLs |
| `news.maxItems` | Headlines shown (default `18`) |
| `news.classifyPool` | How many newest items get classified per refresh (default `36`) |
| `news.batchSize` | Headlines per Ollama request (default `12`) |
| `news.cacheTtlMinutes` | News cache lifetime (default `30`) |

All values can also be overridden with env vars: `PORT`, `OLLAMA_URL`, `OLLAMA_MODEL`, `WEATHER_LAT`, `WEATHER_LON`.

## How good-news filtering works

1. The server fetches all configured RSS feeds in parallel (RSS 2.0 + Atom supported).
2. Headlines are deduped, newest-first, trimmed to `classifyPool`.
3. They're sent to Ollama in batches with a strict JSON prompt: *"would this headline make most readers feel good?"* — unsure → excluded.
4. Only "good" verdicts survive (up to `maxItems`).
5. Result is cached server-side for 30 minutes; the next refresh happens in the background.

**Failure handling:** if Ollama is unreachable or errors, the dashboard still renders headlines, clearly labeled *"unfiltered (AI offline)"* — never blank.

## API

| Endpoint | Description |
|---|---|
| `GET /api/news` | Filtered news: `{ items, filterActive, filterError, updatedAt, elapsedMs }` |
| `GET /api/weather` | Current + daily weather (10-min cache) |
| `GET /api/health` | Server status + Ollama reachability |

## Keepalive video

`public/keepalive.mp4` is a 2×2px, 5-second, fully black H.264 video, played `<video autoplay muted loop playsinline>` with retry logic for Safari's autoplay rules. To regenerate:

```bash
ffmpeg -y -f lavfi -i "color=black:size=2x2:rate=5:duration=5" \
  -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p \
  -movflags +faststart public/keepalive.mp4
```

## Files

```
server.js           Node HTTP server: RSS→Ollama pipeline, weather proxy, static files
config.json         Ports, Ollama URL/model, location, feeds
public/index.html   Dashboard markup
public/style.css    Light/dark theme, responsive iPad layout
public/app.js       Clock, theme toggle, data fetching, keepalive
public/keepalive.mp4  2×2px black 5s loop video
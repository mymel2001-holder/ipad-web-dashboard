/* iPad Web Dashboard — frontend logic */
'use strict';

/* ---------------- Light/Dark mode ---------------- */

(function initTheme() {
  const root = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  const KEY = 'dashboard-theme';

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }

  if (!saved) {
    // Follow the system preference initially.
    saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  apply(saved);

  toggle.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  });
})();

/* ---------------- Clock: hh:mm:ss AM/PM, mm/dd/yyyy ---------------- */

(function initClock() {
  const timeEl = document.getElementById('clockTime');
  const meridiemEl = document.getElementById('clockMeridiem');
  const dateEl = document.getElementById('clockDate');

  function tick() {
    const now = new Date();
    let hours = now.getHours();
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;

    const hh = String(hours).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = now.getFullYear();

    timeEl.textContent = `${hh}:${mm}:${ss}`;
    meridiemEl.textContent = meridiem;
    dateEl.textContent = `${mo}/${dd}/${yyyy}`;
  }

  tick();
  setInterval(tick, 1000);
})();

/* ---------------- Weather ---------------- */

async function loadWeather() {
  const body = document.getElementById('weatherBody');
  const iconEl = document.getElementById('weatherIcon');
  const tempEl = document.getElementById('weatherTemp');
  const descEl = document.getElementById('weatherDesc');
  const metaEl = document.getElementById('weatherMeta');

  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const w = await res.json();

    iconEl.textContent = w.icon || '🌡️';
    tempEl.textContent = `${w.temperature}°`;
    descEl.textContent = `${w.description} · ${w.city}`;
    metaEl.innerHTML =
      `<span class="hi">H ${w.high}°</span> · L ${w.low}°` +
      `<span class="sep">|</span>Feels ${w.feelsLike}°` +
      `<span class="sep">|</span>💧 ${w.humidity}%` +
      `<span class="sep">|</span>🌬️ ${w.windMph} mph`;
    body.classList.remove('loading');
  } catch (err) {
    body.classList.remove('loading');
    iconEl.textContent = '⚠️';
    tempEl.textContent = '--°';
    descEl.textContent = 'Weather unavailable';
    metaEl.textContent = 'Will retry automatically';
    setTimeout(loadWeather, 60000);
  }
}

/* ---------------- Good news ---------------- */

const NEWS_REFRESH_MS = 10 * 60 * 1000; // refetch (server cache is 30 min)

function formatNewsStatus(data) {
  if (data.filterActive === false) {
    const el = document.getElementById('newsStatus');
    el.textContent = 'unfiltered (AI offline)';
    el.classList.add('off');
    return;
  }
  document.getElementById('newsStatus').classList.remove('off');
  const t = new Date(data.updatedAt);
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  document.getElementById('newsStatus').textContent = `updated ${time}`;
}

function renderNews(data) {
  const list = document.getElementById('newsList');
  list.innerHTML = '';

  if (!data.items || data.items.length === 0) {
    const li = document.createElement('li');
    li.className = 'news-empty';
    li.textContent = data.filterActive === false
      ? 'No headlines available right now.'
      : 'No good news found in the latest headlines — will check again soon. 😊';
    list.appendChild(li);
  } else {
    for (const item of data.items) {
      const li = document.createElement('li');
      li.className = 'news-item';

      const a = document.createElement('a');
      a.href = item.link || '#';
      if (item.link) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.textContent = item.title;
      li.appendChild(a);

      const src = document.createElement('span');
      src.className = 'source';
      const when = new Date(item.timestamp);
      const whenStr = Number.isNaN(when.getTime())
        ? ''
        : when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      src.textContent = [item.source, whenStr].filter(Boolean).join(' · ');
      li.appendChild(src);

      list.appendChild(li);
    }
  }
  formatNewsStatus(data);
}

async function loadNews() {
  try {
    const res = await fetch('/api/news');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderNews(data);
  } catch (err) {
    const list = document.getElementById('newsList');
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'news-empty';
    li.textContent = `News unavailable (${err.message}) — retrying…`;
    list.appendChild(li);
    setTimeout(loadNews, 60000);
  }
}

/* ---------------- Keepalive video (2x2px black loop) ---------------- */

(function initKeepalive() {
  const video = document.getElementById('keepalive');

  function ensurePlaying() {
    if (video.paused) {
      video.play().catch(() => { /* retry on next visibility/user event */ });
    }
  }

  // Autoplay can be blocked until a user gesture; also re-kick when returning
  // to the tab (Safari suspends media in background tabs).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensurePlaying();
  });
  document.addEventListener('touchstart', ensurePlaying, { passive: true });
  document.addEventListener('click', ensurePlaying);
  setInterval(ensurePlaying, 15000);
  ensurePlaying();
})();

/* ---------------- Kick things off ---------------- */

loadWeather();
loadNews();
setInterval(loadNews, NEWS_REFRESH_MS);
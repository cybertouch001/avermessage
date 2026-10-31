// AverChat — look & feel chosen by the admin (name, logo, colours, font, layout, intro + background video,
// screenshot policy). Loaded from /api/config (public), cached so the next start is instant.
import { App, S, LS, $, $$, esc, plug, isApp } from './util.js';

const DEF = { app_name: 'AverChat', tagline: 'Chat. Call. Connect.', logo: null, preset: 'purple', accent: '#7c3aed', accent2: '#d946ef', bg: '#0c0718', panel: '#1a1130', text: '#f3eefe', bubble_out: '#6d28d9', bubble_in: '#241a3d', font: 'system', layout: 'glass', bubble: 'round', theme: 'dark', intro_enabled: true, intro_video: 'default:intro', bg_video: 'default:aurora', bg_dim: 0.55, screenshots: true, v: 0 };
const FONTS = {
  system: { css: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari",sans-serif' },
  poppins: { css: 'Poppins,system-ui,sans-serif', gf: 'Poppins:wght@400;500;600;700' },
  inter: { css: 'Inter,system-ui,sans-serif', gf: 'Inter:wght@400;500;600;700' },
  nunito: { css: 'Nunito,system-ui,sans-serif', gf: 'Nunito:wght@400;600;700;800' },
  baloo: { css: '"Baloo 2",system-ui,sans-serif', gf: 'Baloo+2:wght@400;500;600;700' },
  serif: { css: 'Georgia,"Noto Serif","Noto Serif Devanagari",serif' },
  mono: { css: 'ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace' },
};
export const brand = () => ({ ...DEF, ...((S.config && S.config.brand) || LS.get('brand', {})) });
App.brand = brand;
export const videoUrl = (v) => (!v || v === 'none' ? null : v.startsWith('default:') ? `/media/${v.slice(8)}.mp4` : v.startsWith('file:') ? `/api/brand/${v.slice(5)}` : null);
const posterUrl = (v) => (v && v.startsWith('default:') ? `/media/${v.slice(8)}.jpg` : '');
App.videoUrl = videoUrl;
App.logoUrl = (b = brand()) => (b.logo ? `/api/brand/${b.logo}` : '/icons/icon-192.png');

let cfgFetch = null;
async function fetchConfig() {
  const r = await fetch('/api/config', { credentials: 'same-origin' }); if (!r.ok) throw new Error('config ' + r.status);
  const c = await r.json(); S.config = c; LS.set('config', c); LS.set('brand', c.brand || {}); return c;
}
App.loadConfig = async (force) => {
  const cached = LS.get('config', null);
  if (!force && cached && !cfgFetch) {
    S.config = cached;
    cfgFetch = fetchConfig().then((c) => { if (c.brand && c.brand.v !== (cached.brand || {}).v) { App.applyTheme && App.applyTheme(); App.refreshBrand(); } }).catch(() => {}).finally(() => (cfgFetch = null));
    return S.config;
  }
  try { return await fetchConfig(); } catch { S.config = cached || { brand: DEF }; return S.config; }
};

// ---- colours ----
const hex2 = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (h, a) => { const [r, g, b] = hex2(h); return `rgba(${r},${g},${b},${a})`; };
const mix = (a, b, t) => { const x = hex2(a), y = hex2(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const lum = (h) => { const [r, g, b] = hex2(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ink = (h) => (lum(h) > 0.45 ? '#16122a' : '#ffffff');
let fontLink = null;
App.applyBrand = (dark) => {
  const b = brand(); const R = document.documentElement; const st = R.style;
  const adminLight = b.theme === 'light';
  let bg, panel, text, bin, bout;
  if (dark ? !adminLight : adminLight) { bg = b.bg; panel = b.panel; text = b.text; bin = b.bubble_in; bout = b.bubble_out; }
  else if (dark) { bg = '#0f0b1d'; panel = '#1a1530'; text = '#f1edfb'; bin = '#251e3f'; bout = mix(b.accent, '#000000', 0.25); }
  else { bg = '#f5f3fb'; panel = '#ffffff'; text = '#1b1630'; bin = '#ffffff'; bout = mix(b.accent, '#ffffff', 0.82); }
  const isDark = lum(bg) < 0.25;
  R.dataset.theme = isDark ? 'dark' : 'light';
  const vid = bgVideoOn(b);
  const glass = b.layout === 'glass';
  const set = (k, v) => st.setProperty(k, v);
  set('--p', b.accent); set('--p2', b.accent2); set('--pd', mix(b.accent, '#000000', 0.2));
  set('--bg', bg); set('--text', text); set('--muted', mix(text, bg, 0.42)); set('--line', rgba(text, isDark ? 0.10 : 0.12));
  set('--panel-solid', panel); set('--panel2', mix(panel, text, 0.05)); set('--hover', rgba(text, 0.06));
  set('--panel', glass && vid ? rgba(panel, isDark ? 0.62 : 0.78) : glass ? rgba(panel, 0.9) : panel);
  set('--in', glass && vid ? rgba(bin, 0.92) : bin); set('--out', bout); set('--in-ink', ink(bin)); set('--out-ink', ink(bout));
  set('--chatbg', vid ? 'transparent' : mix(bg, text, 0.03));
  set('--grad', `linear-gradient(135deg, ${b.accent}, ${b.accent2})`);
  set('--bgdim', String(b.bg_dim));
  // the default videos are violet; turn them toward the admin's primary colour (custom videos stay as uploaded)
  const hueOf = (h) => { const [r, g, bb] = hex2(h).map((v) => v / 255); const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb); if (mx === mn) return null; const d = mx - mn; let hh = mx === r ? ((g - bb) / d) % 6 : mx === g ? (bb - r) / d + 2 : (r - g) / d + 4; return (hh * 60 + 360) % 360; };
  const ha = hueOf(b.accent); const def = String(b.bg_video || '').startsWith('default:');
  set('--vfilter', def && ha !== null && Math.abs(((ha - 262 + 540) % 360) - 180) > 12 ? `hue-rotate(${Math.round(((ha - 262 + 540) % 360) - 180)}deg)` : def && ha === null ? 'grayscale(1)' : 'none');
  R.dataset.layout = b.layout; R.dataset.bubble = b.bubble; R.dataset.vid = vid ? '1' : '0';
  const f = FONTS[b.font] || FONTS.system; set('--font', f.css);
  if (f.gf) { const href = `https://fonts.googleapis.com/css2?family=${f.gf}&display=swap`; if (!fontLink) { fontLink = document.createElement('link'); fontLink.rel = 'stylesheet'; document.head.appendChild(fontLink); } if (fontLink.href !== href) fontLink.href = href; }
  document.title = b.app_name;
  setBgVideo(b);
  secure(b);
  return isDark ? mix(bg, '#000000', 0.1) : b.accent;
};
App.refreshBrand = () => {
  const b = brand();
  $$('.brand-name').forEach((x) => (x.textContent = b.app_name)); $$('.brand-tag').forEach((x) => (x.textContent = b.tagline || ''));
  $$('.brand-logo').forEach((x) => (x.src = App.logoUrl(b)));
};

// ---- screenshots: the Android app sets FLAG_SECURE when the admin turns screenshots off ----
function secure(b) { const p = plug('AvmSecure'); if (p) p.set({ secure: b.screenshots === false }).catch(() => {}); }

// ---- background video ----
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
export function bgVideoOn(b = brand()) { return !!videoUrl(b.bg_video) && LS.get('bgvideo', true) !== false; }
App.bgVideoOn = bgVideoOn;
let bgEl = null;
function setBgVideo(b) {
  const src = bgVideoOn(b) ? videoUrl(b.bg_video) : null;
  if (!src) { if (bgEl) { bgEl.remove(); bgEl = null; } return; }
  if (!bgEl) { bgEl = document.createElement('div'); bgEl.id = 'bgv'; bgEl.innerHTML = '<video muted loop playsinline autoplay preload="auto" disablepictureinpicture></video><i class="bgv-dim"></i>'; document.body.prepend(bgEl); }
  const v = bgEl.querySelector('video'); const poster = posterUrl(b.bg_video);
  if (reduce.matches) { v.removeAttribute('src'); v.poster = poster; v.style.display = poster ? '' : 'none'; return; }
  if (v.dataset.src !== src) { v.dataset.src = src; v.poster = poster; v.src = src; v.muted = true; v.play().catch(() => {}); }
}
document.addEventListener('visibilitychange', () => { const v = bgEl && bgEl.querySelector('video'); if (!v || !v.src) return; if (document.hidden) v.pause(); else v.play().catch(() => {}); });
App.setBgVideoPref = (on) => { LS.set('bgvideo', !!on); App.applyTheme && App.applyTheme(); };

// ---- intro video (once per app start) ----
App.playIntro = () => new Promise((resolve) => {
  const b = brand(); const src = videoUrl(b.intro_video);
  let done = false; const finish = () => { if (done) return; done = true; const o = $('#intro'); if (o) { o.classList.add('out'); setTimeout(() => o.remove(), 300); } resolve(); };
  if (!b.intro_enabled || !src || sessionStorage.getItem('introShown') || reduce.matches || LS.get('intro', true) === false) return resolve();
  sessionStorage.setItem('introShown', '1');
  const o = document.createElement('div'); o.id = 'intro';
  o.innerHTML = `<video muted playsinline autoplay preload="auto" src="${esc(src)}"></video><div class="intro-c"><img class="brand-logo" src="${esc(App.logoUrl(b))}" alt=""><h1>${esc(b.app_name)}</h1><p>${esc(b.tagline || '')}</p></div><button class="intro-skip">Skip ›</button>`;
  document.body.appendChild(o);
  const v = o.querySelector('video');
  v.addEventListener('ended', finish); v.addEventListener('error', finish);
  v.play().catch(() => setTimeout(finish, 1200));
  o.querySelector('.intro-skip').onclick = finish;
  setTimeout(finish, 7000); // never hold the app longer than 7 s
});

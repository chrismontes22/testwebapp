/* Planet Pulse — live Earth dashboard.
 * Every source used here is public domain or permissively licensed for commercial use.
 * See README.md for details and required attributions. */

const d3 = window.d3;
const topojson = window.topojson;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API = {
  quakes: (feed) => `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`,
  events: "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=45",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  worldBank: (iso3, indicator) =>
    `https://api.worldbank.org/v2/country/${iso3}/indicator/${indicator}?format=json&mrnev=1`,
  fxHosts: ["https://api.frankfurter.dev/v1", "https://api.frankfurter.app"],
};

const REFRESH_MS = 5 * 60 * 1000; // live feeds
const FX_REFRESH_MS = 60 * 60 * 1000; // ECB rates change once per working day
const IDLE_BEFORE_ROTATE_MS = 6000;
const QUAKE_FEEDS = ["2.5_day", "all_day", "4.5_week", "2.5_week", "significant_month"];
const ZOOM_MIN = 0.7, ZOOM_MAX = 12;

const INDICATORS = [
  { id: "SP.POP.TOTL", label: "Population", fmt: (v) => fmtCompact(v) },
  { id: "NY.GDP.PCAP.CD", label: "GDP per person", fmt: (v) => "$" + fmtCompact(v) },
  { id: "NY.GDP.MKTP.CD", label: "Economy size (GDP)", fmt: (v) => "$" + fmtCompact(v) },
  { id: "SP.DYN.LE00.IN", label: "Life expectancy", fmt: (v) => v.toFixed(1) + " yrs" },
  { id: "IT.NET.USER.ZS", label: "Online", fmt: (v) => v.toFixed(0) + "% of people" },
  { id: "EG.FEC.RNEW.ZS", label: "Renewable energy", fmt: (v) => v.toFixed(1) + "% of use" },
];

// Natural-event categories: fixed hue order (validated for CVD on the dark surface)
// and a distinct glyph per category, so identity never relies on color alone.
const EVENT_CATS = [
  { key: "severeStorms", label: "Storms", color: "#3987e5", symbol: d3.symbolDiamond },
  { key: "wildfires", label: "Wildfires", color: "#d95926", symbol: d3.symbolTriangle },
  { key: "seaLakeIce", label: "Sea & lake ice", color: "#199e70", symbol: d3.symbolSquare },
  { key: "volcanoes", label: "Volcanoes", color: "#c98500", symbol: d3.symbolStar },
  { key: "other", label: "Other", color: "#d55181", symbol: d3.symbolCircle },
];
const catFor = (id) => EVENT_CATS.find((c) => c.key === id) ?? EVENT_CATS[EVENT_CATS.length - 1];

// Kp levels → reserved status colors, always shown with a text label.
const KP_LEVELS = [
  { min: 0, label: "Quiet", color: "#0ca30c" },
  { min: 4, label: "Active", color: "#fab219" },
  { min: 5, label: "Storm G1–G2", color: "#ec835a" },
  { min: 7, label: "Severe G3+", color: "#d03b3b" },
];
const kpLevel = (kp) => [...KP_LEVELS].reverse().find((l) => kp >= l.min) ?? KP_LEVELS[0];
const kpOutlook = (kp) =>
  kp >= 7 ? "Auroras possible far from the poles"
  : kp >= 5 ? "Auroras likely at mid-latitudes"
  : kp >= 4 ? "Auroras possible at high latitudes"
  : "Calm magnetic field";

// Earthquakes: one-hue sequential ramp by magnitude (+ size).
const quakeColor = d3.scaleSequential(d3.interpolateRgb("#f7c6bd", "#e0302a")).domain([1, 7]).clamp(true);
const quakeRadius = (m, z) => Math.max(2.2, Math.pow(1.62, Math.max(m, 0)) * 0.85) * Math.sqrt(z);
// Plain-language magnitude classes (USGS / Richter descriptors).
const quakeClass = (m) =>
  m >= 8 ? "Great" : m >= 7 ? "Major" : m >= 6 ? "Strong" : m >= 5 ? "Moderate" : m >= 4 ? "Light" : m >= 3 ? "Minor" : "Micro";

// Countries offered as one-click suggestions in the empty country panel.
const TRY_COUNTRIES = [["JPN", "JP"], ["ISL", "IS"], ["CHL", "CL"], ["IDN", "ID"], ["ITA", "IT"], ["NZL", "NZ"]];
// Common alternative names → ISO alpha-3, for search.
const ALIASES = {
  usa: "USA", us: "USA", america: "USA", "united states of america": "USA", uk: "GBR", britain: "GBR",
  "great britain": "GBR", england: "GBR", scotland: "GBR", wales: "GBR", holland: "NLD", burma: "MMR",
  "ivory coast": "CIV", swaziland: "SWZ", "czech republic": "CZE", czech: "CZE", russia: "RUS", korea: "KOR",
  drc: "COD", "east timor": "TLS", "cape verde": "CPV", persia: "IRN", turkey: "TUR", turkiye: "TUR",
};

// ---------------------------------------------------------------------------
// Preferences (remembered between visits; storage may be unavailable)
// ---------------------------------------------------------------------------
const PREFS_KEY = "planet-pulse:prefs:v1";
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
})();
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Face the visitor's part of the world on first load, estimated from their time zone.
const homeLon = Math.max(-180, Math.min(180, (-new Date().getTimezoneOffset() / 60) * 15));
const DEFAULT_TILT = -20;
const defaultRotate = (proj) => [-homeLon, proj === "globe" ? DEFAULT_TILT : 0, 0];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  proj: prefs.proj === "flat" ? "flat" : "globe",
  rotate: null,
  zoom: 1,
  panY: 0,
  quakeFeed: QUAKE_FEEDS.includes(prefs.quakeFeed) ? prefs.quakeFeed : "2.5_day",
  quakeSort: prefs.quakeSort === "mag" ? "mag" : "time",
  quakes: [],
  quakesLoaded: false,
  events: [],
  kp: [],
  kpLoaded: false,
  layers: { quakes: true, events: true, night: true, ...(prefs.layers || {}) },
  hiddenCats: new Set(Array.isArray(prefs.hiddenCats) ? prefs.hiddenCats : []),
  autoRotate: typeof prefs.autoRotate === "boolean" ? prefs.autoRotate : !reduceMotion,
  introDismissed: !!prefs.introDismissed,
  lastInteract: 0,
  moving: false,
  selected: null, // country feature
  hovered: null, // country feature
  hoverMarker: null,
  pinned: null, // { kind: "quake" | "event", id }
  pointerInside: false,
  fx: { rates: null, names: {}, date: null },
  fxPref: { from: "USD", to: "EUR", amount: "100", ...(prefs.fx || {}) },
  geo: null,
  codes: {},
  wbCache: new Map(),
  lastRefresh: null,
  failed: new Set(),
};
state.rotate = defaultRotate(state.proj);

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      proj: state.proj,
      quakeFeed: state.quakeFeed,
      quakeSort: state.quakeSort,
      layers: state.layers,
      hiddenCats: [...state.hiddenCats],
      autoRotate: state.autoRotate,
      introDismissed: state.introDismissed,
      fx: state.fxPref,
    }));
  } catch { /* private mode or storage blocked: preferences just won't persist */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "ic") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const nf = new Intl.NumberFormat();
const fmtCompact = (v) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
const fmtRate = (v) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(v);
const fmtDateTime = (t) =>
  new Date(t).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(t) {
  const s = (t - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
const timeTag = (t) => `<time datetime="${new Date(t).toISOString()}" title="${esc(fmtDateTime(t))}">${ago(t)}</time>`;
const regionNames = (() => {
  try { return new Intl.DisplayNames(undefined, { type: "region" }); } catch { return null; }
})();
const flagEmoji = (a2) =>
  a2 && /^[A-Z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🏳️";
const norm = (s) => String(s).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const singleColumn = () => window.matchMedia("(max-width: 1100px)").matches;
const smoothScroll = reduceMotion ? "auto" : "smooth";
function inView(el, fraction = 0.4) {
  const r = el.getBoundingClientRect();
  const visible = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return visible >= Math.min(r.height, innerHeight) * fraction;
}

async function getJSON(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("timed out");
    if (err instanceof TypeError) throw new Error(navigator.onLine === false ? "you're offline" : "network error");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function toast(msg, { tone = "ok", ms = 2800 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.innerHTML = `${icon(tone === "ok" ? "check" : "alert")}<span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, ms);
}

const errorBox = (msg, retry) =>
  `<div class="error-box">${icon("alert")}<span>${esc(msg)}</span>` +
  `<button type="button" class="btn sm" data-retry="${retry}">${icon("refresh")}Try again</button></div>`;

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const wrap = $("#map-wrap");
const canvas = $("#map");
const ctx = canvas.getContext("2d");
const base = document.createElement("canvas"); // cached static layer
const bctx = base.getContext("2d");
let W = 0, H = 0, DPR = 1, baseDirty = true;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = wrap.clientWidth, h = wrap.clientHeight;
  // Assigning canvas.width clears it, so only do it when the size really changed,
  // and repaint straight away instead of flashing an empty frame.
  if (w === W && h === H && dpr === DPR) return;
  DPR = dpr; W = w; H = h;
  for (const c of [canvas, base]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  baseDirty = true;
  if (W && H) render(performance.now());
}

function makeProjection({ rotate, zoom, panY }) {
  if (state.proj === "globe") {
    const r = Math.min(W, H) / 2 - 18;
    return d3.geoOrthographic().rotate(rotate).scale(r * zoom).translate([W / 2, H / 2]).clipAngle(90).precision(0.6);
  }
  const p = d3.geoNaturalEarth1().rotate([rotate[0], 0, 0]).fitExtent([[12, 12], [W - 12, H - 12]], { type: "Sphere" });
  p.scale(p.scale() * zoom).translate([W / 2, H / 2 + panY]);
  return p;
}
const projection = () => makeProjection(state);
const clampPanY = (y, zoom = state.zoom) => Math.max(-H * zoom * 0.4, Math.min(H * zoom * 0.4, y));

// Subsolar point (lon, lat) — accurate to well under a degree, plenty for a terminator.
function subsolar(date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / rad;
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  let lon = ra - gmst * 15;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return [lon, dec];
}

function drawBase(proj) {
  const g = state.geo;
  const c = bctx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, H);
  const path = d3.geoPath(proj, c);
  const globe = state.proj === "globe";
  const [cx, cy] = proj.translate();
  const R = proj.scale();

  if (globe) {
    // atmosphere glow
    const glow = c.createRadialGradient(cx, cy, R * 0.96, cx, cy, R * 1.2);
    glow.addColorStop(0, "rgba(106,168,255,0.38)");
    glow.addColorStop(0.4, "rgba(106,168,255,0.12)");
    glow.addColorStop(1, "rgba(106,168,255,0)");
    c.fillStyle = glow;
    c.beginPath(); c.arc(cx, cy, R * 1.2, 0, 2 * Math.PI); c.fill();
  }

  // ocean
  c.beginPath(); path({ type: "Sphere" });
  let ocean;
  if (globe) {
    ocean = c.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.05, cx, cy, R * 1.02);
    ocean.addColorStop(0, "#1b3a6e");
    ocean.addColorStop(0.55, "#10244b");
    ocean.addColorStop(1, "#071129");
  } else {
    ocean = c.createLinearGradient(0, 0, 0, H);
    ocean.addColorStop(0, "#132a55");
    ocean.addColorStop(0.5, "#0f2247");
    ocean.addColorStop(1, "#0a1733");
  }
  c.fillStyle = ocean; c.fill();

  // graticule
  c.beginPath(); path(d3.geoGraticule10());
  c.strokeStyle = "rgba(150,180,240,0.08)"; c.lineWidth = 0.6; c.stroke();

  if (g) {
    const hi = !state.moving; // high-res when still
    const land = hi ? g.land50 : g.land110;
    c.beginPath(); path(land);
    c.fillStyle = "#2b4c80"; c.fill();
    c.strokeStyle = "rgba(150,195,255,0.45)"; c.lineWidth = 0.7; c.stroke();

    if (state.hovered && state.hovered !== state.selected) {
      c.beginPath(); path(state.hovered); c.fillStyle = "#3a64a6"; c.fill();
    }
    if (state.selected) {
      c.beginPath(); path(state.selected); c.fillStyle = "#4f86e0"; c.fill();
    }
    c.beginPath(); path(hi ? g.borders50 : g.borders110);
    c.strokeStyle = "rgba(200,220,255,0.30)"; c.lineWidth = 0.5; c.stroke();
  }

  if (globe) {
    // spherical shading: soft highlight top-left, darker limb
    const shade = c.createRadialGradient(cx - R * 0.4, cy - R * 0.45, 0, cx, cy, R);
    shade.addColorStop(0, "rgba(255,255,255,0.09)");
    shade.addColorStop(0.5, "rgba(255,255,255,0)");
    shade.addColorStop(1, "rgba(2,6,20,0.38)");
    c.beginPath(); path({ type: "Sphere" });
    c.fillStyle = shade; c.fill();
  }

  if (state.layers.night) {
    const [lon, lat] = subsolar();
    const anti = [lon + 180, -lat];
    for (const [r, a] of [[96, 0.12], [93, 0.13], [90, 0.15], [87, 0.14], [84, 0.14]]) {
      c.beginPath(); path(d3.geoCircle().center(anti).radius(r)());
      c.fillStyle = `rgba(2,5,14,${a})`; c.fill();
    }
  }

  if (g && state.selected) {
    // drawn after the night shading so the selection stays visible on the dark side
    c.beginPath(); path(state.selected);
    c.fillStyle = "rgba(120,170,255,0.18)"; c.fill();
    c.strokeStyle = "#dce9ff"; c.lineWidth = 1.5; c.stroke();
  }

  // rim
  c.beginPath(); path({ type: "Sphere" });
  c.strokeStyle = "rgba(168,203,255,0.38)"; c.lineWidth = 1; c.stroke();
  baseDirty = false;
}

function visible(proj, lonlat) {
  if (state.proj !== "globe") return true;
  const r = proj.rotate();
  return d3.geoDistance(lonlat, [-r[0], -r[1]]) < Math.PI / 2 - 0.02;
}

const isPinned = (kind, d) => state.pinned?.kind === kind && state.pinned.id === d.id;

let markers = []; // screen-space hit list
function drawMarkers(proj, t) {
  const c = ctx;
  markers = [];
  const z = Math.min(state.zoom, 3);
  let pinnedAt = null;

  if (state.layers.events) {
    for (const ev of state.events) {
      if (state.hiddenCats.has(ev.cat.key) || !visible(proj, ev.coord)) continue;
      const p = proj(ev.coord);
      if (!p) continue;
      const size = 95 * z;
      const hot = state.hoverMarker === ev || isPinned("event", ev);
      c.save();
      c.translate(p[0], p[1]);
      c.beginPath();
      d3.symbol(ev.cat.symbol, hot ? size * 1.35 : size).context(c)();
      c.fillStyle = ev.cat.color;
      c.strokeStyle = "#0b1222"; c.lineWidth = 2;
      c.stroke(); c.fill();
      if (hot) { c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke(); }
      c.restore();
      const r = Math.sqrt(size) / 1.4 + 4;
      if (isPinned("event", ev)) pinnedAt = { x: p[0], y: p[1], r };
      markers.push({ kind: "event", d: ev, x: p[0], y: p[1], r });
    }
  }

  if (state.layers.quakes) {
    // drawn biggest first so small ones stay clickable on top
    for (const q of state.quakes) {
      if (!visible(proj, q.coord)) continue;
      const p = proj(q.coord);
      if (!p) continue;
      const r = quakeRadius(q.mag, z);
      const col = quakeColor(q.mag);
      const age = Date.now() - q.time;
      if (age < 3600e3 && !reduceMotion) {
        // pulse for quakes within the last hour
        const ph = ((t / 1600) + q.phase) % 1;
        c.beginPath(); c.arc(p[0], p[1], r + ph * 22, 0, 2 * Math.PI);
        c.strokeStyle = d3.color(col).copy({ opacity: 1 - ph }).toString(); c.lineWidth = 1.5; c.stroke();
      }
      const hot = state.hoverMarker === q || isPinned("quake", q);
      c.beginPath(); c.arc(p[0], p[1], r, 0, 2 * Math.PI);
      c.fillStyle = d3.color(col).copy({ opacity: hot ? 0.85 : 0.55 }).toString(); c.fill();
      c.strokeStyle = hot ? "#fff" : col;
      c.lineWidth = hot ? 2 : 1.2;
      c.stroke();
      if (isPinned("quake", q)) pinnedAt = { x: p[0], y: p[1], r };
      markers.push({ kind: "quake", d: q, x: p[0], y: p[1], r: Math.max(r + 3, 8) });
    }
  }

  if (pinnedAt) {
    // selection ring with a gentle breathing pulse
    const k = reduceMotion ? 0.5 : (Math.sin(t / 380) + 1) / 2;
    c.beginPath(); c.arc(pinnedAt.x, pinnedAt.y, pinnedAt.r + 6 + k * 3, 0, 2 * Math.PI);
    c.strokeStyle = "rgba(255,255,255,0.9)"; c.lineWidth = 2; c.stroke();
    c.beginPath(); c.arc(pinnedAt.x, pinnedAt.y, pinnedAt.r + 11 + k * 5, 0, 2 * Math.PI);
    c.strokeStyle = `rgba(255,255,255,${0.25 - k * 0.15})`; c.lineWidth = 1.5; c.stroke();
  }
}

let lastT = 0;
let lastDetailT = 0;
function frame(t) {
  const dt = Math.min(64, t - (lastT || t));
  lastT = t;
  const idle = performance.now() - state.lastInteract > IDLE_BEFORE_ROTATE_MS;
  const shouldRotate = state.autoRotate && state.proj === "globe" && idle && !dragging && !flying &&
    !state.pinned && !state.selected && !state.pointerInside && !document.hidden;
  if (shouldRotate) {
    state.rotate[0] = (state.rotate[0] + dt * 0.0045) % 360;
    state.moving = true;
    baseDirty = true;
    lastDetailT = t;
  } else if (state.moving && !dragging && !flying && t - lastDetailT > 180) {
    state.moving = false; // settle → redraw in high resolution
    baseDirty = true;
  }
  render(t);
  requestAnimationFrame(frame);
}

function render(t) {
  const proj = projection();
  if (baseDirty) drawBase(proj);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawMarkers(proj, t);
}

function markMoving() {
  state.moving = true;
  baseDirty = true;
  lastDetailT = performance.now();
}

// --- animated camera ---------------------------------------------------------
let flying = false, animToken = null;
function animateView(target, ms = 1000) {
  const from = { rotate: [...state.rotate], zoom: state.zoom, panY: state.panY };
  const toRotate = [...(target.rotate ?? from.rotate)];
  // take the short way round
  toRotate[0] = from.rotate[0] + ((((toRotate[0] - from.rotate[0]) % 360) + 540) % 360) - 180;
  const toZoom = target.zoom ?? from.zoom;
  const toPan = target.panY ?? from.panY;
  const ir = d3.interpolate(from.rotate, toRotate);
  const dur = reduceMotion ? 1 : ms;
  const t0 = performance.now();
  const token = (animToken = {});
  flying = true;
  (function step(now) {
    if (animToken !== token) return;
    const k = d3.easeCubicInOut(Math.min(1, (now - t0) / dur));
    state.rotate = ir(k);
    state.zoom = from.zoom * Math.pow(toZoom / from.zoom, k); // geometric: feels uniform
    state.panY = from.panY + (toPan - from.panY) * k;
    state.lastInteract = performance.now();
    markMoving();
    if (k < 1) requestAnimationFrame(step);
    else { flying = false; animToken = null; }
  })(t0);
}
function stopAnim() { animToken = null; flying = false; }

function flyTo(lonlat, zoom) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom ?? Math.max(state.zoom, 1.6)));
  if (state.proj === "globe") {
    animateView({ rotate: [-lonlat[0], -lonlat[1], 0], zoom: z }, 1100);
  } else {
    // flat map: centre longitude by rotation, latitude by vertical pan
    const rot = [-lonlat[0], 0, 0];
    const p = makeProjection({ rotate: rot, zoom: z, panY: 0 })(lonlat);
    animateView({ rotate: rot, zoom: z, panY: p ? clampPanY(H / 2 - p[1], z) : 0 }, 1100);
  }
}

const zoomBy = (f) => animateView({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom * f)) }, 280);
function resetView() {
  animateView({ rotate: defaultRotate(state.proj), zoom: 1, panY: 0 }, 900);
}

// --- interaction: drag / pinch / wheel / hover / click -----------------------
let dragging = false, downAt = null, moved = 0;
const pointers = new Map();
let pinchStart = null;
const onOverlay = (e) => e.target.closest?.(".map-controls, .map-info, .map-notice");

wrap.addEventListener("pointerdown", (e) => {
  if (onOverlay(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
  wrap.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
  }
  stopAnim();
  dragging = true; moved = 0;
  downAt = { x: e.clientX, y: e.clientY };
  state.lastInteract = performance.now();
  wrap.classList.add("dragging");
});

wrap.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") state.pointerInside = true;
  const prev = pointers.get(e.pointerId);
  if (!prev) {
    if (onOverlay(e)) { hideTooltip(); return; }
    return hover(e);
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist));
    moved += 10;
    return;
  }
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  moved += Math.abs(dx) + Math.abs(dy);
  if (moved > 4) fadeHint();
  const proj = projection();
  if (state.proj === "globe") {
    const k = 57.3 / proj.scale();
    state.rotate[0] += dx * k;
    state.rotate[1] = Math.max(-89, Math.min(89, state.rotate[1] - dy * k));
  } else {
    state.rotate[0] += dx * (360 / (proj.scale() * 2 * Math.PI));
    state.panY = clampPanY(state.panY + dy);
  }
  state.lastInteract = performance.now();
  hideTooltip();
  markMoving();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    dragging = false;
    wrap.classList.remove("dragging");
    if (moved < 6 && downAt && e.type === "pointerup") click(e);
  }
}
wrap.addEventListener("pointerup", endPointer);
wrap.addEventListener("pointercancel", endPointer);
wrap.addEventListener("pointerleave", () => {
  state.pointerInside = false;
  if (!dragging) { hideTooltip(); setHovered(null); state.hoverMarker = null; }
});

// Cooperative scrolling: a plain mouse wheel scrolls the page; Ctrl/⌘ + wheel (and trackpad
// pinch, which browsers report as ctrl+wheel) zooms the map. In full screen the wheel always zooms.
let noticeTimer;
wrap.addEventListener("wheel", (e) => {
  const zoomGesture = e.ctrlKey || e.metaKey || document.fullscreenElement === $("#map-card");
  if (!zoomGesture) {
    showNotice(`Hold ${isMac ? "⌘" : "Ctrl"} while scrolling to zoom, or use the + / − buttons`);
    return;
  }
  e.preventDefault();
  stopAnim();
  setZoom(state.zoom * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0015)));
  state.lastInteract = performance.now();
  fadeHint();
}, { passive: false });

function showNotice(text) {
  let n = $("#map-notice");
  if (!n) {
    n = document.createElement("div");
    n.id = "map-notice";
    n.className = "map-notice";
    wrap.append(n);
  }
  n.textContent = text;
  n.classList.add("show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => n.classList.remove("show"), 1400);
}

function setZoom(z) {
  state.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  markMoving();
}

// keyboard control when the map has focus
wrap.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const step = 12 / Math.sqrt(state.zoom);
  const keys = {
    ArrowLeft: () => (state.rotate[0] += step),
    ArrowRight: () => (state.rotate[0] -= step),
    ArrowUp: () => state.proj === "globe"
      ? (state.rotate[1] = Math.max(-89, state.rotate[1] - step))
      : (state.panY = clampPanY(state.panY + 40)),
    ArrowDown: () => state.proj === "globe"
      ? (state.rotate[1] = Math.min(89, state.rotate[1] + step))
      : (state.panY = clampPanY(state.panY - 40)),
  };
  if (!keys[e.key]) return;
  e.preventDefault();
  stopAnim();
  keys[e.key]();
  state.lastInteract = performance.now();
  fadeHint();
  markMoving();
});

function localPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function hitMarker(x, y) {
  let best = null, bd = Infinity;
  for (const m of markers) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d <= m.r && d < bd) { best = m; bd = d; }
  }
  return best;
}

function inCountry(f, ll) {
  const [[x0, y0], [x1, y1]] = f.bbox;
  const inBox = x0 <= x1 ? ll[0] >= x0 && ll[0] <= x1 : ll[0] >= x0 || ll[0] <= x1;
  return inBox && ll[1] >= y0 && ll[1] <= y1 && d3.geoContains(f, ll);
}

function countryAt(x, y) {
  if (!state.geo) return null;
  const proj = projection();
  const ll = proj.invert([x, y]);
  if (!ll || isNaN(ll[0])) return null;
  if (state.proj === "globe" && !visible(proj, ll)) return null;
  // also reject clicks outside the sphere on the flat map
  const back = proj(ll);
  if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) return null;
  return state.geo.countries.find((f) => inCountry(f, ll)) ?? null;
}

let hoverRaf = 0;
function hover(e) {
  const [x, y] = localPoint(e);
  cancelAnimationFrame(hoverRaf);
  hoverRaf = requestAnimationFrame(() => {
    const m = hitMarker(x, y);
    state.hoverMarker = m?.d ?? null;
    if (m) {
      setHovered(null);
      showTooltip(x, y, m.kind === "quake" ? quakeTip(m.d) : eventTip(m.d));
      wrap.style.cursor = "pointer";
      return;
    }
    const c = countryAt(x, y);
    setHovered(c);
    wrap.style.cursor = c ? "pointer" : "";
    if (c) showTooltip(x, y, `<strong>${flagEmoji(c.a2)} ${esc(c.name)}</strong><span class="muted">${c === state.selected ? "Selected" : "Click for country details"}</span>`);
    else hideTooltip();
  });
}

function setHovered(f) {
  if (state.hovered !== f) { state.hovered = f; baseDirty = true; }
}

function click(e) {
  const [x, y] = localPoint(e);
  const m = hitMarker(x, y);
  hideTooltip();
  if (m) { pin(m.kind, m.d); return; }
  const c = countryAt(x, y);
  if (c) {
    state.pinned = null;
    clearListSelection();
    selectCountry(c);
  } else if (state.pinned) {
    unpin();
  }
}

const tooltip = $("#tooltip");
function showTooltip(x, y, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let tx = x + 14, ty = y + 14;
  if (tx + tw > W - 8) tx = x - tw - 14;
  if (ty + th > H - 8) ty = y - th - 14;
  tooltip.style.left = Math.max(8, tx) + "px";
  tooltip.style.top = Math.max(8, ty) + "px";
}
function hideTooltip() { tooltip.hidden = true; }

const quakeTip = (q) =>
  `<strong>M${q.mag.toFixed(1)} · ${esc(q.place)}</strong>` +
  `<span class="muted">${quakeClass(q.mag)} · ${ago(q.time)} · ${q.depth.toFixed(0)} km deep${q.tsunami ? " · tsunami flag" : ""}</span>`;
const eventTip = (ev) =>
  `<strong>${esc(ev.title)}</strong><span class="muted">${esc(ev.catTitle)} · updated ${ago(ev.date)}</span>`;

let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  $("#map-hint").style.opacity = "0";
}

// --- map control buttons -----------------------------------------------------
$("#zoom-in").addEventListener("click", () => zoomBy(1.5));
$("#zoom-out").addEventListener("click", () => zoomBy(1 / 1.5));
$("#reset-view").addEventListener("click", resetView);
$("#rotate-btn").addEventListener("click", () => toggleRotate());

function toggleRotate(on = !state.autoRotate) {
  state.autoRotate = on;
  if (on) state.lastInteract = 0; // start straight away
  renderRotateBtn();
  savePrefs();
  if (on && (state.pinned || state.selected)) toast("Rotation resumes when nothing is selected", { tone: "ok" });
}
function renderRotateBtn() {
  const b = $("#rotate-btn");
  b.setAttribute("aria-pressed", String(state.autoRotate));
  b.title = state.autoRotate ? "Pause rotation (P)" : "Resume rotation (P)";
  b.innerHTML = icon(state.autoRotate ? "pause" : "play");
  b.hidden = state.proj !== "globe";
}

const mapCard = $("#map-card");
const fsBtn = $("#fullscreen-btn");
if (document.fullscreenEnabled) fsBtn.hidden = false;
fsBtn.addEventListener("click", toggleFullscreen);
function toggleFullscreen() {
  if (!document.fullscreenEnabled) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else mapCard.requestFullscreen().catch(() => toast("Full screen isn't available here", { tone: "warn" }));
}
document.addEventListener("fullscreenchange", () => {
  const on = document.fullscreenElement === mapCard;
  fsBtn.title = on ? "Exit full screen (F)" : "Full screen (F)";
  fsBtn.setAttribute("aria-label", on ? "Exit full screen" : "Full screen map");
  requestAnimationFrame(resize);
});

// ---------------------------------------------------------------------------
// Pinned markers + on-map detail card
// ---------------------------------------------------------------------------
const findItem = (kind, id) => (kind === "quake" ? state.quakes : state.events).find((d) => d.id === id);

function pin(kind, item, { fly = false } = {}) {
  state.pinned = { kind, id: item.id };
  state.hoverMarker = null;
  switchTab(kind === "quake" ? "quakes" : "events");
  selectInList(kind, item.id);
  if (fly) flyTo(item.coord, Math.max(state.zoom, 2.2));
  renderMapInfo();
  fadeHint();
}

function unpin() {
  state.pinned = null;
  clearListSelection();
  renderMapInfo();
}

function clearListSelection() {
  $$(".feed-item.selected").forEach((n) => n.classList.remove("selected"));
}

function selectInList(kind, id) {
  clearListSelection();
  const li = document.querySelector(`.feed-item[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.classList.add("selected");
  // scroll inside the panel only, never the page
  const box = li.closest(".tab-panel");
  if (box && !box.hidden) {
    const top = li.offsetTop - box.clientHeight / 2 + li.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: smoothScroll });
  }
}

function renderMapInfo() {
  const box = $("#map-info");
  const p = state.pinned;
  const item = p && findItem(p.kind, p.id);
  let html = "", kind = "";
  if (item && p.kind === "quake") {
    kind = "quake";
    const q = item;
    html = `<span class="mag" style="--c:${quakeColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <div><h3>${esc(q.place)}</h3>
        <div class="info-meta"><span>${quakeClass(q.mag)} quake</span>${timeTag(q.time)}<span>${q.depth.toFixed(0)} km deep</span>${quakeBadges(q)}</div>
        <div class="info-actions"><a class="btn sm" href="${esc(q.url)}" target="_blank" rel="noopener">Details on USGS ${icon("external")}</a></div>
      </div>
      <button type="button" class="btn icon ghost close" data-action="unpin" aria-label="Close details" title="Close (Esc)">${icon("x")}</button>`;
  } else if (item && p.kind === "event") {
    kind = "event";
    const ev = item;
    html = `<span class="ev-icon">${symbolSVG(ev.cat.symbol, ev.cat.color, 120, 20)}</span>
      <div><h3>${esc(ev.title)}</h3>
        <div class="info-meta"><span>${esc(ev.catTitle)}</span><span>updated ${timeTag(ev.date)}</span>${ev.magnitude ? `<span>${esc(ev.magnitude)}</span>` : ""}</div>
        ${ev.link ? `<div class="info-actions"><a class="btn sm" href="${esc(ev.link)}" target="_blank" rel="noopener">Source ${icon("external")}</a></div>` : ""}
      </div>
      <button type="button" class="btn icon ghost close" data-action="unpin" aria-label="Close details" title="Close (Esc)">${icon("x")}</button>`;
  } else if (state.selected) {
    // Only visible on narrow layouts, where the country panel is below the map.
    kind = "country";
    const f = state.selected;
    html = `<span class="flag">${flagEmoji(f.a2)}</span>
      <div><h3>${esc(f.name)}</h3>
        <div class="info-meta"><span>${esc(f.a3 ?? "")}</span>${f.currency ? `<span>${esc(f.currency)}</span>` : ""}</div>
        <div class="info-actions"><button type="button" class="btn sm primary" data-action="country-details">See country details ${icon("down")}</button></div>
      </div>
      <button type="button" class="btn icon ghost close" data-action="clear-country" aria-label="Clear selection" title="Clear (Esc)">${icon("x")}</button>`;
  }
  box.hidden = !html;
  box.dataset.kind = kind;
  box.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Legend + event filters
// ---------------------------------------------------------------------------
function symbolSVG(symbol, color, size = 70, px = 14) {
  const d = d3.symbol(symbol, size)();
  return `<svg width="${px}" height="${px}" viewBox="-7 -7 14 14" aria-hidden="true" style="overflow:visible"><path d="${d}" fill="${color}" stroke="#0b1222" stroke-width="1"/></svg>`;
}
function renderLegend() {
  const qs = [3, 5, 7].map((m) => {
    const r = Math.min(quakeRadius(m, 1), 11);
    return `<span class="legend-item"><svg width="${2 * r + 4}" height="${2 * r + 4}" aria-hidden="true"><circle cx="${r + 2}" cy="${r + 2}" r="${r}" fill="${quakeColor(m)}" fill-opacity=".55" stroke="${quakeColor(m)}"/></svg>M${m}</span>`;
  });
  qs.push(`<span class="legend-item" title="Earthquakes in the last hour pulse on the map"><svg width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="3.5" fill="#e0302a" fill-opacity=".7"/><circle cx="9" cy="9" r="7.5" fill="none" stroke="#e0302a" stroke-opacity=".6" stroke-dasharray="2 2"/></svg>Last hour</span>`);
  const evs = EVENT_CATS.map(
    (c) => `<button type="button" class="legend-item" data-cat="${c.key}" aria-pressed="${!state.hiddenCats.has(c.key)}" title="Show or hide ${c.label.toLowerCase()}">${symbolSVG(c.symbol, c.color)}${c.label} <span class="count" data-count="${c.key}"></span></button>`,
  );
  $("#legend").innerHTML =
    `<span class="legend-group"><span class="legend-title">Quakes</span>${qs.join("")}</span><span class="legend-sep" aria-hidden="true"></span>` +
    `<span class="legend-group"><span class="legend-title">Events</span>${evs.join("")}</span>`;
}

function renderEventFilters() {
  $("#event-filters").innerHTML = EVENT_CATS.map(
    (c) => `<button type="button" class="filter-chip" data-cat="${c.key}" aria-pressed="${!state.hiddenCats.has(c.key)}">${symbolSVG(c.symbol, c.color, 60, 12)}${c.label} <span class="count" data-count="${c.key}"></span></button>`,
  ).join("");
}

function toggleCat(k) {
  state.hiddenCats.has(k) ? state.hiddenCats.delete(k) : state.hiddenCats.add(k);
  $$(`[data-cat="${k}"]`).forEach((b) => b.setAttribute("aria-pressed", String(!state.hiddenCats.has(k))));
  renderEventList();
  savePrefs();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cat]");
  if (b) toggleCat(b.dataset.cat);
});

// ---------------------------------------------------------------------------
// Data: geography
// ---------------------------------------------------------------------------
function mainPolygon(f) {
  // the largest polygon of a country (e.g. mainland France, not French Guiana)
  if (f.geometry.type !== "MultiPolygon") return f;
  let best = null, bestA = -1;
  for (const coords of f.geometry.coordinates) {
    const poly = { type: "Polygon", coordinates: coords };
    const a = d3.geoArea(poly);
    if (a > bestA) { bestA = a; best = poly; }
  }
  return best;
}

function countryFocus(f) {
  if (f.focus) return f.focus;
  const poly = mainPolygon(f);
  const center = d3.geoCentroid(poly);
  const [[x0, y0], [x1, y1]] = d3.geoBounds(poly);
  const lonSpan = ((x1 - x0) + 360) % 360 || 360;
  const extent = Math.max(lonSpan * Math.cos((center[1] * Math.PI) / 180), y1 - y0, 0.5);
  f.focus = { center, zoom: Math.max(1.3, Math.min(7, 46 / extent)) };
  return f.focus;
}

async function loadGeo() {
  const [t50, t110, codes] = await Promise.all([
    getJSON("data/countries-50m.json"),
    getJSON("data/countries-110m.json"),
    getJSON("data/country-codes.json"),
  ]);
  state.codes = codes;
  const countries = topojson.feature(t50, t50.objects.countries).features.map((f) => {
    const c = codes[f.id] ?? {};
    f.a2 = c.a2; f.a3 = c.a3; f.currency = c.currency;
    f.name = (c.a2 && regionNames?.of(c.a2)) || f.properties.name;
    f.search = norm(f.name);
    f.bbox = d3.geoBounds(f);
    return f;
  });
  state.geo = {
    countries,
    land50: topojson.feature(t50, t50.objects.land),
    land110: topojson.feature(t110, t110.objects.land),
    borders50: topojson.mesh(t50, t50.objects.countries, (a, b) => a !== b),
    borders110: topojson.mesh(t110, t110.objects.countries, (a, b) => a !== b),
  };
  baseDirty = true;
}

const countryByA3 = (a3) => state.geo?.countries.find((c) => c.a3 === a3);

// ---------------------------------------------------------------------------
// Country search
// ---------------------------------------------------------------------------
const searchInput = $("#search-input");
const searchList = $("#search-results");
let searchHits = [], searchActive = 0;

function searchCountries(q) {
  const n = norm(q.trim());
  if (!n || !state.geo) return [];
  const seen = new Set();
  const scored = [];
  const alias = ALIASES[n] && countryByA3(ALIASES[n]);
  if (alias) { scored.push({ f: alias, s: -1 }); seen.add(alias.name); }
  for (const f of state.geo.countries) {
    if (seen.has(f.name)) continue;
    const name = f.search;
    let s = -1;
    if (name.startsWith(n)) s = 0;
    else if (f.a3?.toLowerCase() === n || f.a2?.toLowerCase() === n) s = 0.5;
    else if (name.split(/[\s\-’'(]+/).some((w) => w.startsWith(n))) s = 1;
    else if (name.includes(n)) s = 2;
    if (s >= 0) { scored.push({ f, s }); seen.add(f.name); }
  }
  return scored.sort((a, b) => a.s - b.s || a.f.name.localeCompare(b.f.name)).slice(0, 8).map((x) => x.f);
}

function highlight(name, q) {
  const n = norm(q.trim());
  const i = norm(name).indexOf(n);
  if (i < 0 || !n || norm(name.slice(i, i + n.length)) !== n) return esc(name);
  return esc(name.slice(0, i)) + "<mark>" + esc(name.slice(i, i + n.length)) + "</mark>" + esc(name.slice(i + n.length));
}

function renderSearch() {
  const q = searchInput.value;
  if (!q.trim()) return closeSearch();
  searchHits = searchCountries(q);
  searchActive = Math.min(searchActive, Math.max(0, searchHits.length - 1));
  searchList.innerHTML = !state.geo
    ? `<li class="empty">Map data is still loading…</li>`
    : searchHits.length
      ? searchHits.map((f, i) =>
        `<li role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === searchActive}"><span class="flag-sm">${flagEmoji(f.a2)}</span><span>${highlight(f.name, q)}</span><span class="code">${esc(f.a3 ?? "")}</span></li>`).join("")
      : `<li class="empty">No country matches “${esc(q.trim())}”</li>`;
  searchList.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  if (searchHits.length) searchInput.setAttribute("aria-activedescendant", `sr-${searchActive}`);
  else searchInput.removeAttribute("aria-activedescendant");
}

function closeSearch() {
  searchList.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

function chooseSearch(i) {
  const f = searchHits[i];
  if (!f) return;
  searchInput.value = "";
  closeSearch();
  searchInput.blur();
  state.pinned = null;
  clearListSelection();
  selectCountry(f);
  if (!inView(wrap, 0.5)) wrap.scrollIntoView({ behavior: smoothScroll, block: "center" });
}

searchInput.addEventListener("input", () => { searchActive = 0; renderSearch(); });
searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) renderSearch(); });
searchInput.addEventListener("blur", () => setTimeout(closeSearch, 120));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!searchHits.length) return;
    searchActive = (searchActive + (e.key === "ArrowDown" ? 1 : -1) + searchHits.length) % searchHits.length;
    renderSearch();
    $(`#sr-${searchActive}`)?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseSearch(searchActive);
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (searchInput.value) { searchInput.value = ""; closeSearch(); } else searchInput.blur();
  }
});
searchList.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
searchList.addEventListener("click", (e) => {
  const li = e.target.closest("[data-i]");
  if (li) chooseSearch(+li.dataset.i);
});

// ---------------------------------------------------------------------------
// Data: earthquakes (USGS — public domain)
// ---------------------------------------------------------------------------
async function loadQuakes() {
  try {
    const data = await getJSON(API.quakes(state.quakeFeed));
    state.quakes = (data.features ?? [])
      .filter((f) => f.geometry?.coordinates && f.properties?.mag != null)
      .map((f) => ({
        id: f.id,
        mag: +f.properties.mag,
        place: f.properties.place || f.properties.title || "Unknown location",
        time: f.properties.time,
        url: f.properties.url,
        tsunami: !!f.properties.tsunami,
        alert: f.properties.alert,
        felt: f.properties.felt,
        coord: [f.geometry.coordinates[0], f.geometry.coordinates[1]],
        depth: +f.geometry.coordinates[2] || 0,
        phase: Math.random(),
      }))
      .sort((a, b) => b.mag - a.mag); // big first → small drawn on top
    state.quakesLoaded = true;
    state.failed.delete("quakes");
    renderQuakeKPIs();
    renderQuakeList();
    if (state.pinned?.kind === "quake") renderMapInfo();
    if (state.selected) renderCountryLocalStats(state.selected);
  } catch (err) {
    state.failed.add("quakes");
    $("#kpi-quakes").textContent = state.quakesLoaded ? $("#kpi-quakes").textContent : "—";
    $("#kpi-quakes-sub").innerHTML = `<span class="error-note">USGS feed unavailable (${esc(err.message)})</span>`;
    if (!state.quakesLoaded) {
      $("#quake-list").innerHTML = `<li class="empty">${errorBox("We couldn't reach the USGS earthquake feed.", "quakes")}</li>`;
      $("#kpi-strongest").textContent = "—";
    }
  }
}

function renderQuakeKPIs() {
  const q = state.quakes;
  $("#kpi-quakes").textContent = nf.format(q.length);
  $("#kpi-quakes-sub").textContent = $("#quake-feed").selectedOptions[0].textContent;
  $("#count-quakes").textContent = q.length ? nf.format(q.length) : "";
  const top = q[0];
  if (top) {
    $("#kpi-strongest").textContent = "M" + top.mag.toFixed(1);
    $("#kpi-strongest-sub").textContent = `${quakeClass(top.mag)} · ${top.place} · ${ago(top.time)}`;
    $("#kpi-strongest-sub").title = top.place;
  } else {
    $("#kpi-strongest").textContent = "—";
    $("#kpi-strongest-sub").textContent = "None in this feed";
  }
}

const quakeBadges = (q) =>
  (Date.now() - q.time < 3600e3 ? '<span class="badge new">New</span>' : "") +
  (q.tsunami ? '<span class="badge tsunami" title="USGS flags this event for possible tsunami evaluation. Check official warnings.">Tsunami flag</span>' : "") +
  (q.alert ? `<span class="badge alert-${esc(q.alert)}" title="USGS PAGER alert: estimated impact level">PAGER ${esc(q.alert)}</span>` : "");

const LIST_LIMIT = 150;
function renderQuakeList() {
  const sorted = [...state.quakes].sort(state.quakeSort === "mag" ? (a, b) => b.mag - a.mag || b.time - a.time : (a, b) => b.time - a.time);
  const list = sorted.slice(0, LIST_LIMIT);
  $("#quake-list-note").textContent = state.quakes.length > LIST_LIMIT
    ? `Top ${LIST_LIMIT} of ${nf.format(state.quakes.length)}`
    : `${nf.format(state.quakes.length)} in feed`;
  $("#quake-list").innerHTML = list.length
    ? list.map((q) => `<li class="feed-item${isPinned("quake", q) ? " selected" : ""}" tabindex="0" data-kind="quake" data-id="${esc(q.id)}" aria-label="Magnitude ${q.mag.toFixed(1)}, ${esc(q.place)}, ${ago(q.time)}">
      <span class="mag" style="--c:${quakeColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <span class="feed-body">
        <span class="feed-title" title="${esc(q.place)}">${esc(q.place)}</span>
        <span class="feed-meta">${timeTag(q.time)}<span>${q.depth.toFixed(0)} km deep</span>${quakeBadges(q)}</span>
      </span>
      <a class="feed-link" href="${esc(q.url)}" target="_blank" rel="noopener" title="Open on USGS" aria-label="Open on USGS">${icon("external")}</a></li>`).join("")
    : `<li class="empty">No earthquakes in this feed right now. Try a longer time range.</li>`;
}

$$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
  state.quakeSort = b.dataset.sort;
  $$("[data-sort]").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
  renderQuakeList();
  $("#panel-quakes").scrollTop = 0;
  savePrefs();
}));

// ---------------------------------------------------------------------------
// Data: natural events (NASA EONET — public domain)
// ---------------------------------------------------------------------------
function eventCoord(geom) {
  if (!geom) return null;
  if (geom.type === "Point") return geom.coordinates;
  if (geom.type === "Polygon") return d3.geoCentroid({ type: "Polygon", coordinates: geom.coordinates });
  return null;
}

async function loadEvents() {
  try {
    const data = await getJSON(API.events, { timeout: 25000 });
    state.events = (data.events ?? [])
      .map((ev) => {
        const geoms = (ev.geometry ?? []).filter((g) => g.coordinates);
        const last = geoms[geoms.length - 1];
        const coord = eventCoord(last);
        const catId = ev.categories?.[0]?.id;
        return coord && {
          id: ev.id,
          title: ev.title,
          catTitle: ev.categories?.[0]?.title ?? "Event",
          cat: catFor(catId),
          coord,
          date: last?.date ? Date.parse(last.date) : Date.now(),
          magnitude: last?.magnitudeValue != null ? `${last.magnitudeValue} ${last.magnitudeUnit ?? ""}`.trim() : null,
          link: ev.sources?.[0]?.url ?? ev.link,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.date - a.date);
    state.failed.delete("events");

    const counts = d3.rollup(state.events, (v) => v.length, (d) => d.cat.key);
    $("#kpi-events").textContent = nf.format(state.events.length);
    $("#count-events").textContent = state.events.length ? nf.format(state.events.length) : "";
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n} ${catFor(k).label.toLowerCase()}`);
    $("#kpi-events-sub").textContent = top.length ? top.join(" · ") : "None open right now";
    for (const c of EVENT_CATS) {
      $$(`[data-count="${c.key}"]`).forEach((el) => (el.textContent = counts.get(c.key) ?? 0));
    }
    renderEventList();
    if (state.pinned?.kind === "event") renderMapInfo();
    if (state.selected) renderCountryLocalStats(state.selected);
  } catch (err) {
    state.failed.add("events");
    $("#kpi-events-sub").innerHTML = `<span class="error-note">NASA EONET unavailable (${esc(err.message)})</span>`;
    if (!state.events.length) {
      $("#kpi-events").textContent = "—";
      $("#event-list").innerHTML = `<li class="empty">${errorBox("We couldn't reach NASA's natural-event tracker.", "events")}</li>`;
    }
  }
}

function renderEventList() {
  if (!state.events.length && state.failed.has("events")) return;
  const list = state.events.filter((e) => !state.hiddenCats.has(e.cat.key)).slice(0, 200);
  $("#event-list").innerHTML = list.length
    ? list.map((ev) => `<li class="feed-item${isPinned("event", ev) ? " selected" : ""}" tabindex="0" data-kind="event" data-id="${esc(ev.id)}">
      <span class="ev-icon">${symbolSVG(ev.cat.symbol, ev.cat.color, 120, 20)}</span>
      <span class="feed-body">
        <span class="feed-title" title="${esc(ev.title)}">${esc(ev.title)}</span>
        <span class="feed-meta"><span>${esc(ev.catTitle)}</span>${timeTag(ev.date)}${ev.magnitude ? `<span>${esc(ev.magnitude)}</span>` : ""}</span>
      </span>
      ${ev.link ? `<a class="feed-link" href="${esc(ev.link)}" target="_blank" rel="noopener" title="Open source" aria-label="Open source">${icon("external")}</a>` : "<span></span>"}</li>`).join("")
    : state.events.length
      ? `<li class="empty">All event types are hidden. Use the filters above to show them again.</li>`
      : `<li class="empty">No open natural events right now.</li>`;
}

// list → map
for (const sel of ["#quake-list", "#event-list"]) {
  const el = $(sel);
  const go = (e) => {
    if (e.target.closest("a, button")) return;
    const li = e.target.closest(".feed-item");
    if (!li) return;
    const kind = li.dataset.kind;
    const item = findItem(kind, li.dataset.id);
    if (!item) return;
    if (isPinned(kind, item) && e.type === "click") { unpin(); return; }
    pin(kind, item, { fly: true });
    if (singleColumn() && !inView(wrap, 0.6)) wrap.scrollIntoView({ behavior: smoothScroll, block: "center" });
  };
  el.addEventListener("click", go);
  el.addEventListener("keydown", (e) => {
    if (e.target.closest("a")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const li = e.target.closest(".feed-item");
      const next = e.key === "ArrowDown" ? li?.nextElementSibling : li?.previousElementSibling;
      if (next?.classList.contains("feed-item")) { e.preventDefault(); next.focus(); }
    }
  });
  el.addEventListener("mouseover", (e) => {
    const li = e.target.closest(".feed-item");
    state.hoverMarker = li ? findItem(li.dataset.kind, li.dataset.id) ?? null : null;
  });
  el.addEventListener("mouseleave", () => (state.hoverMarker = null));
}

// ---------------------------------------------------------------------------
// Data: geomagnetic Kp (NOAA SWPC — public domain)
// ---------------------------------------------------------------------------
function parseKp(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  let rows;
  if (Array.isArray(raw[0])) {
    // legacy shape: [["time_tag","Kp",...], ["2024-..", "2.33", ...], ...]
    const header = raw[0].map((h) => String(h).toLowerCase());
    const ti = header.indexOf("time_tag");
    const ki = header.findIndex((h) => h === "kp" || h === "kp_index");
    rows = raw.slice(1).map((r) => ({ time: r[ti], kp: r[ki] }));
  } else {
    rows = raw.map((r) => {
      const key = Object.keys(r).find((k) => /^kp$/i.test(k)) ?? Object.keys(r).find((k) => /kp/i.test(k) && !/_?a_/i.test(k));
      return { time: r.time_tag, kp: r[key] };
    });
  }
  return rows
    .map((r) => ({ time: new Date(String(r.time).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.time) ? "" : "Z")), kp: +r.kp }))
    .filter((r) => !isNaN(r.time) && isFinite(r.kp));
}

async function loadKp() {
  try {
    state.kp = parseKp(await getJSON(API.kp)).slice(-24);
    state.kpLoaded = true;
    state.failed.delete("kp");
    const last = state.kp[state.kp.length - 1];
    if (last) {
      const lvl = kpLevel(last.kp);
      $("#kpi-kp").innerHTML = `${last.kp.toFixed(1)}<span class="status-pill" style="background:${lvl.color}">${lvl.label}</span>`;
      $("#kpi-kp-sub").textContent = `${kpOutlook(last.kp)} · ${ago(last.time)}`;
    }
    renderKpChart();
  } catch (err) {
    state.failed.add("kp");
    $("#kpi-kp-sub").innerHTML = `<span class="error-note">NOAA SWPC unavailable (${esc(err.message)})</span>`;
    if (!state.kp.length) {
      $("#kpi-kp").textContent = "—";
      $("#kp-chart").innerHTML = errorBox("We couldn't reach NOAA's Space Weather Prediction Center.", "kp");
    }
  }
}

function renderKpChart() {
  const el = $("#kp-chart");
  const data = state.kp;
  $("#kp-legend").innerHTML = KP_LEVELS.map((l) => `<span><i style="background:${l.color}"></i>${l.label}${l.min ? ` (Kp ≥ ${l.min})` : ""}</span>`).join("") +
    `<span><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" stroke="#ec835a" stroke-dasharray="4 3"/></svg>Storm threshold</span>`;
  if (!state.kpLoaded) {
    if (!state.failed.has("kp")) el.innerHTML = `<div class="error-box"><span class="spinner"></span><span class="muted">Loading space weather…</span></div>`;
    return;
  }
  $("#kp-table tbody").innerHTML = [...data].reverse().map((d) =>
    `<tr><td>${d3.utcFormat("%a %d %b %H:%M")(d.time)}</td><td>${d.kp.toFixed(2)}</td><td>${kpLevel(d.kp).label}</td></tr>`).join("");
  if (!data.length) { el.innerHTML = `<p class="muted small" style="padding:16px">No Kp data published right now.</p>`; return; }

  const w = el.clientWidth - 24, h = el.clientHeight - 10;
  if (w <= 0 || h <= 0) return;
  const m = { t: 10, r: 8, b: 26, l: 26 };
  const x = d3.scaleBand().domain(data.map((d) => +d.time)).range([m.l, w - m.r]).paddingInner(0.14);
  const y = d3.scaleLinear().domain([0, 9]).range([h - m.b, m.t]);
  const bw = x.bandwidth();
  const rr = Math.min(4, bw / 2);
  const barPath = (d) => {
    const x0 = x(+d.time), y0 = y(Math.max(d.kp, 0.15)), yb = y(0);
    return `M${x0},${yb}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + bw - rr}Q${x0 + bw},${y0} ${x0 + bw},${y0 + rr}V${yb}Z`;
  };
  const dayTicks = data.filter((d) => d.time.getUTCHours() === 0).map((d) => +d.time);
  const last = data[data.length - 1];

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart of planetary Kp index, last ${data.length} three-hour intervals. Latest value ${last.kp.toFixed(1)}, ${kpLevel(last.kp).label}.">
    <g class="grid">${[0, 3, 5, 7, 9].map((v) => `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" ${v === 5 ? 'stroke-dasharray="4 4" style="stroke:#ec835a;stroke-opacity:.6"' : ""}/>`).join("")}</g>
    <g class="axis">${[0, 3, 5, 7, 9].map((v) => `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      ${dayTicks.map((t) => `<text x="${x(t)}" y="${h - 6}">${d3.utcFormat("%a %d")(new Date(t))}</text>`).join("")}
    </g>
    <g>${data.map((d, i) => `<path class="bar" data-i="${i}" d="${barPath(d)}" fill="${kpLevel(d.kp).color}"/>`).join("")}</g>
    <text class="now-label" x="${x(+last.time) + bw / 2}" y="${y(Math.max(last.kp, 0.15)) - 6}" text-anchor="middle">now</text>
    <g>${data.map((d, i) => `<rect class="hit" data-i="${i}" x="${x(+d.time) - (x.step() - bw) / 2}" y="${m.t}" width="${x.step()}" height="${h - m.t - m.b}"/>`).join("")}</g>
  </svg><div class="tooltip" hidden></div>`;

  const tip = el.querySelector(".tooltip");
  const svg = el.querySelector("svg");
  svg.addEventListener("pointermove", (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return;
    const d = data[i];
    el.classList.add("hovering");
    svg.querySelectorAll(".bar").forEach((b) => b.classList.toggle("on", b.dataset.i === i));
    const lvl = kpLevel(d.kp);
    tip.innerHTML = `<strong>Kp ${d.kp.toFixed(2)} <span class="status-pill" style="background:${lvl.color}">${lvl.label}</span></strong><span class="muted">${d3.utcFormat("%a %d %b, %H:%M UTC")(d.time)}</span>`;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const tx = e.clientX - r.left;
    tip.style.left = Math.min(r.width - tip.offsetWidth - 8, Math.max(8, tx - tip.offsetWidth / 2)) + "px";
    tip.style.top = Math.max(0, y(d.kp) - tip.offsetHeight - 6) + "px";
  });
  svg.addEventListener("pointerleave", () => { el.classList.remove("hovering"); tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Data: exchange rates (ECB via Frankfurter)
// ---------------------------------------------------------------------------
async function fxGet(path) {
  let lastErr;
  for (const host of API.fxHosts) {
    try { return await getJSON(host + path); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const fxAmount = $("#fx-amount"), fxFrom = $("#fx-from"), fxTo = $("#fx-to");
fxAmount.value = state.fxPref.amount;

async function loadFx() {
  try {
    const [latest, names] = await Promise.all([fxGet("/latest?base=USD"), fxGet("/currencies").catch(() => ({}))]);
    state.fx = { rates: { USD: 1, ...latest.rates }, names, date: latest.date };
    state.failed.delete("fx");
    const date = new Date(latest.date + "T12:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("#fx-date").textContent = `European Central Bank reference rates · ${date}`;
    const codes = Object.keys(state.fx.rates).sort();
    const opts = codes.map((c) => `<option value="${c}">${c}${names[c] ? ` — ${esc(names[c])}` : ""}</option>`).join("");
    const from = fxFrom.value || state.fxPref.from, to = fxTo.value || state.fxPref.to;
    fxFrom.innerHTML = opts; fxTo.innerHTML = opts;
    fxFrom.value = codes.includes(from) ? from : "USD";
    fxTo.value = codes.includes(to) ? to : "EUR";
    convert();
    if (state.selected) renderCountryFx(state.selected);
  } catch (err) {
    state.failed.add("fx");
    if (!state.fx.rates) $("#fx-result").innerHTML = errorBox(`Exchange rates are unavailable (${err.message}).`, "fx");
  }
}

const fmtMoney = (v, c) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: c, maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : 2 }).format(v); }
  catch { return `${v.toFixed(2)} ${c}`; }
};

function convert() {
  const r = state.fx.rates;
  if (!r) return;
  const amt = Math.max(0, parseFloat(fxAmount.value) || 0);
  const from = fxFrom.value, to = fxTo.value;
  const rate = r[to] / r[from];
  const val = amt * rate;
  $("#fx-from-name").textContent = state.fx.names[from] ?? from;
  $("#fx-to-name").textContent = state.fx.names[to] ?? to;
  // show only the code in the closed select; full names live in the option list + caption
  for (const sel of [fxFrom, fxTo]) {
    for (const o of sel.options) o.textContent = o.selected ? o.value : `${o.value}${state.fx.names[o.value] ? " — " + state.fx.names[o.value] : ""}`;
  }
  $("#fx-result").innerHTML = `${fmtMoney(val, to)}<small>for ${fmtMoney(amt, from)}</small><small>1 ${from} = ${fmtRate(rate)} ${to} · 1 ${to} = ${fmtRate(1 / rate)} ${from}</small>`;
  const popular = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "CAD", "AUD", "MXN", "BRL", "CHF"].filter((c) => c !== from && r[c]);
  $("#fx-chips").innerHTML = popular.map((c) =>
    `<button type="button" class="chip${c === to ? " active" : ""}" data-to="${c}" aria-pressed="${c === to}" title="${esc(state.fx.names[c] ?? c)}"><b>${c}</b>${((amt * r[c]) / r[from]).toLocaleString(undefined, { maximumFractionDigits: 2 })}</button>`).join("");
  state.fxPref = { from, to, amount: fxAmount.value };
  savePrefs();
}
fxAmount.addEventListener("input", convert);
fxFrom.addEventListener("change", convert);
fxTo.addEventListener("change", convert);
$("#fx-swap").addEventListener("click", () => {
  const a = fxFrom.value; fxFrom.value = fxTo.value; fxTo.value = a; convert();
});
$("#fx-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-to]"); if (b) { fxTo.value = b.dataset.to; convert(); }
});

// ---------------------------------------------------------------------------
// Country panel (World Bank — CC BY 4.0)
// ---------------------------------------------------------------------------
async function worldBank(iso3) {
  if (state.wbCache.has(iso3)) return state.wbCache.get(iso3);
  const p = Promise.all(
    INDICATORS.map(async (ind) => {
      try {
        const json = await getJSON(API.worldBank(iso3, ind.id));
        const row = Array.isArray(json) && Array.isArray(json[1]) ? json[1].find((r) => r.value != null) : null;
        return row ? { ...ind, value: row.value, year: row.date } : { ...ind, value: null };
      } catch {
        return { ...ind, value: null, error: true };
      }
    }),
  );
  state.wbCache.set(iso3, p);
  const res = await p;
  if (res.every((r) => r.error)) state.wbCache.delete(iso3); // don't cache total failures
  return res;
}

const countryPanel = $("#country-panel");

function renderCountryEmpty() {
  countryPanel.className = "country-empty";
  const tries = TRY_COUNTRIES.map(([a3, a2]) =>
    `<button type="button" class="try-chip" data-a3="${a3}">${flagEmoji(a2)} ${esc(regionNames?.of(a2) ?? a3)}</button>`).join("");
  countryPanel.innerHTML = `
    <div class="globe-art">${icon("globe")}</div>
    <h3>Pick a country</h3>
    <p>Click any country on the map, or search for one at the top, to see its population, economy, recent activity and exchange rate.</p>
    <div class="try-list" aria-label="Suggestions">${tries}</div>`;
}

async function selectCountry(f, { fly = true } = {}) {
  state.selected = f;
  baseDirty = true;
  $("#count-country").hidden = false;
  switchTab("country");
  if (f.a3) history.replaceState(null, "", `#country=${f.a3}`);
  if (fly) {
    const { center, zoom } = countryFocus(f);
    flyTo(center, zoom);
  }
  renderMapInfo();

  countryPanel.className = "country";
  countryPanel.innerHTML = `
    <div class="country-head"><span class="flag">${flagEmoji(f.a2)}</span>
      <div><h3>${esc(f.name)}</h3><span class="muted small">${esc(f.a3 ?? "")}${f.currency ? " · currency " + esc(f.currency) : ""}</span></div>
      <div class="country-head-actions">
        ${f.a3 ? `<button type="button" class="btn icon ghost" data-action="share" title="Copy a link to this country" aria-label="Copy link to this country">${icon("link")}</button>` : ""}
        <button type="button" class="btn icon ghost" data-action="clear-country" title="Clear selection (Esc)" aria-label="Clear selection">${icon("x")}</button>
      </div></div>
    <div><div class="section-label">At a glance</div>
      <div class="stat-grid" id="wb-grid">${INDICATORS.map((i) => `<div class="stat"><span>${i.label}</span><strong><span class="skeleton">000000</span></strong><em>&nbsp;</em></div>`).join("")}</div></div>
    <div><div class="section-label">Live activity</div><div class="stat-grid" id="local-grid"></div><ul class="mini-list" id="local-list"></ul></div>
    <div id="country-fx"></div>
    <p class="attribution">Indicators: The World Bank, World Development Indicators (CC BY 4.0). Latest available year shown.</p>`;
  $("#panel-country").scrollTop = 0;
  renderCountryLocalStats(f);
  renderCountryFx(f);

  if (!f.a3) {
    $("#wb-grid").innerHTML = `<p class="muted small">The World Bank has no data code for this territory.</p>`;
    return;
  }
  const res = await worldBank(f.a3);
  if (state.selected !== f) return;
  $("#wb-grid").innerHTML = res.every((r) => r.value == null)
    ? (res.some((r) => r.error)
      ? `<div class="stat wide">${errorBox("The World Bank API isn't responding right now.", "country")}</div>`
      : `<p class="muted small">The World Bank publishes no indicators for this territory.</p>`)
    : res.map((r) => `<div class="stat"><span>${r.label}</span><strong>${r.value == null ? "—" : r.fmt(r.value)}</strong><em>${r.year ? "as of " + r.year : "not available"}</em></div>`).join("");
}

function renderCountryLocalStats(f) {
  const grid = $("#local-grid");
  if (!grid) return;
  const qs = state.quakes.filter((q) => inCountry(f, q.coord));
  const evs = state.events.filter((e) => inCountry(f, e.coord));
  const big = qs[0];
  grid.innerHTML = `
    <div class="stat"><span>Earthquakes</span><strong>${qs.length}</strong><em>${big ? "largest M" + big.mag.toFixed(1) : "on land, in this feed"}</em></div>
    <div class="stat"><span>Natural events</span><strong>${evs.length}</strong><em>${evs.length ? esc([...new Set(evs.map((e) => e.cat.label))].join(", ")) : "none open"}</em></div>`;
  const items = [
    ...[...qs].sort((a, b) => b.time - a.time).slice(0, 4).map((q) =>
      `<li data-kind="quake" data-id="${esc(q.id)}"><span class="mini-mag" style="color:${quakeColor(q.mag)}">M${q.mag.toFixed(1)}</span><span class="mini-text">${esc(q.place)}</span><span class="mini-time">${ago(q.time)}</span></li>`),
    ...evs.slice(0, 4).map((e) =>
      `<li data-kind="event" data-id="${esc(e.id)}">${symbolSVG(e.cat.symbol, e.cat.color, 60, 12)}<span class="mini-text">${esc(e.title)}</span><span class="mini-time">${ago(e.date)}</span></li>`),
  ];
  $("#local-list").innerHTML = items.join("");
}

function renderCountryFx(f) {
  const box = $("#country-fx");
  if (!box) return;
  const r = state.fx.rates;
  if (!f.currency || !r) { box.innerHTML = ""; return; }
  if (!r[f.currency]) {
    box.innerHTML = `<div class="section-label">Currency</div><div class="stat wide"><span>Local currency</span><strong>${esc(f.currency)}</strong><em>Not in the ECB reference set, so no live rate</em></div>`;
    return;
  }
  const base = f.currency === "USD" ? "EUR" : "USD";
  const rate = r[f.currency] / r[base];
  box.innerHTML = `<div class="section-label">Currency</div><div class="stat wide"><span>Exchange rate (ECB, ${esc(state.fx.date)})</span><strong>1 ${base} = ${fmtRate(rate)} ${esc(f.currency)}</strong>
    <button type="button" class="btn sm" data-action="use-fx" data-ccy="${esc(f.currency)}" data-base="${base}">${icon("cash")}Open in converter</button></div>`;
}

function clearSelection() {
  if (!state.selected) return;
  state.selected = null;
  baseDirty = true;
  $("#count-country").hidden = true;
  history.replaceState(null, "", location.pathname + location.search);
  renderCountryEmpty();
  renderMapInfo();
}

function applyHash() {
  const m = location.hash.match(/country=([A-Za-z]{3})/);
  if (!m || !state.geo) return;
  const f = countryByA3(m[1].toUpperCase());
  if (f && f !== state.selected) selectCountry(f);
}
window.addEventListener("hashchange", applyHash);

async function shareCountry() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied. Anyone who opens it will see this country.");
  } catch {
    toast("Couldn't copy automatically. The link is in your address bar.", { tone: "warn" });
  }
}

// one delegated handler for buttons rendered inside panels and the map card
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (a) {
    switch (a.dataset.action) {
      case "unpin": unpin(); break;
      case "clear-country": clearSelection(); break;
      case "share": shareCountry(); break;
      case "country-details": switchTab("country"); $("#side").scrollIntoView({ behavior: smoothScroll, block: "start" }); break;
      case "use-fx":
        fxFrom.value = a.dataset.base; fxTo.value = a.dataset.ccy; convert();
        $("#fx-card").scrollIntoView({ behavior: smoothScroll, block: "center" });
        setTimeout(() => fxAmount.focus({ preventScroll: true }), 400);
        break;
    }
    return;
  }
  const t = e.target.closest(".try-chip");
  if (t) {
    const f = countryByA3(t.dataset.a3);
    if (f) selectCountry(f); else toast("Map data is still loading. Try again in a moment.", { tone: "warn" });
    return;
  }
  const mini = e.target.closest(".mini-list li");
  if (mini) {
    const item = findItem(mini.dataset.kind, mini.dataset.id);
    if (item) {
      state.pinned = { kind: mini.dataset.kind, id: item.id };
      flyTo(item.coord, Math.max(state.zoom, 3));
      renderMapInfo();
      if (singleColumn() && !inView(wrap, 0.6)) wrap.scrollIntoView({ behavior: smoothScroll, block: "center" });
    }
    return;
  }
  const r = e.target.closest("[data-retry]");
  if (r) {
    const which = r.dataset.retry;
    r.disabled = true;
    r.innerHTML = `<span class="spinner"></span>Retrying…`;
    ({ quakes: loadQuakes, events: loadEvents, kp: loadKp, fx: loadFx, country: () => state.selected && selectCountry(state.selected, { fly: false }) })[which]?.();
  }
});

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function switchTab(name, { focus = false } = {}) {
  $$(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `panel-${name}`));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$(".tabs").addEventListener("keydown", (e) => {
  const tabs = $$(".tab");
  const i = tabs.findIndex((t) => t.classList.contains("active"));
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (j == null) return;
  e.preventDefault();
  switchTab(tabs[(j + tabs.length) % tabs.length].dataset.tab, { focus: true });
});

function revealSide() {
  if (singleColumn() && !inView($("#side"), 0.5)) $("#side").scrollIntoView({ behavior: smoothScroll, block: "start" });
}

// headline cards
$$("[data-kpi]").forEach((b) => b.addEventListener("click", () => {
  switch (b.dataset.kpi) {
    case "quakes": switchTab("quakes"); revealSide(); break;
    case "events": switchTab("events"); revealSide(); break;
    case "kp": $("#kp-card").scrollIntoView({ behavior: smoothScroll, block: "start" }); break;
    case "strongest": {
      const q = state.quakes[0];
      if (!q) return;
      if (!state.layers.quakes) setLayer("quakes", true);
      pin("quake", q, { fly: true });
      if (!inView(wrap, 0.6)) wrap.scrollIntoView({ behavior: smoothScroll, block: "center" });
      break;
    }
  }
}));

function setProj(p) {
  if (p === state.proj) return;
  state.proj = p;
  stopAnim();
  state.zoom = 1; state.panY = 0;
  state.rotate = [state.rotate[0], p === "flat" ? 0 : DEFAULT_TILT, 0];
  $$("[data-proj]").forEach((x) => {
    const on = x.dataset.proj === p;
    x.classList.toggle("active", on);
    x.setAttribute("aria-pressed", String(on));
  });
  renderRotateBtn();
  markMoving();
  savePrefs();
}
$$("[data-proj]").forEach((b) => b.addEventListener("click", () => setProj(b.dataset.proj)));

function setLayer(k, on) {
  state.layers[k] = on;
  $(`[data-layer="${k}"]`).setAttribute("aria-pressed", String(on));
  baseDirty = true;
  savePrefs();
}
$$("[data-layer]").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer, !state.layers[b.dataset.layer])));

$("#quake-feed").addEventListener("change", (e) => {
  state.quakeFeed = e.target.value;
  savePrefs();
  $("#quake-list").innerHTML = `<li class="empty"><span class="spinner"></span>Loading earthquakes…</li>`;
  $("#kpi-quakes").innerHTML = `<span class="skeleton">000</span>`;
  state.quakesLoaded = false;
  loadQuakes();
});

// dialogs
const helpDialog = $("#help-dialog"), sourcesDialog = $("#sources-dialog");
const openDialog = (d) => (d.showModal ? d.showModal() : d.setAttribute("open", ""));
const openHelp = () => openDialog(helpDialog);
$("#help-btn").addEventListener("click", openHelp);
$("#sources-btn").addEventListener("click", () => openDialog(sourcesDialog));
$("#sources-btn-2").addEventListener("click", () => openDialog(sourcesDialog));
for (const d of [helpDialog, sourcesDialog]) {
  // click on the backdrop closes
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

// welcome banner (first visit)
const intro = $("#intro");
function dismissIntro() {
  intro.hidden = true;
  state.introDismissed = true;
  savePrefs();
}
$("#intro-dismiss").addEventListener("click", dismissIntro);
$("#intro-help").addEventListener("click", () => { dismissIntro(); openHelp(); });

// global keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  const typing = e.target.closest?.("input, select, textarea, [contenteditable='true']");
  if (e.key === "Escape" && !typing) {
    if (state.pinned) unpin();
    else if (state.selected) clearSelection();
    return;
  }
  if (typing) return;
  const actions = {
    "/": () => { searchInput.focus(); searchInput.select(); },
    "?": openHelp,
    g: () => setProj(state.proj === "globe" ? "flat" : "globe"),
    "+": () => zoomBy(1.5), "=": () => zoomBy(1.5),
    "-": () => zoomBy(1 / 1.5), _: () => zoomBy(1 / 1.5),
    0: resetView,
    p: () => toggleRotate(),
    r: () => refreshAll({ manual: true }),
    f: toggleFullscreen,
  };
  const fn = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------------------------------------------------------------------------
// Refresh + clock
// ---------------------------------------------------------------------------
let refreshing = false;
async function refreshAll({ manual = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const btn = $("#refresh-btn");
  btn.classList.add("spinning");
  btn.disabled = true;
  await Promise.allSettled([loadQuakes(), loadEvents(), loadKp()]);
  btn.classList.remove("spinning");
  btn.disabled = false;
  refreshing = false;
  state.lastRefresh = Date.now();
  baseDirty = true; // terminator moves too
  updateLiveDot();
  if (manual) {
    const bad = ["quakes", "events", "kp"].filter((k) => state.failed.has(k));
    if (bad.length) toast(`Updated, but ${bad.length === 3 ? "no feeds" : bad.length + " feed" + (bad.length > 1 ? "s" : "")} could be reached`, { tone: "warn" });
    else toast("Live data updated");
  }
  tick();
}
$("#refresh-btn").addEventListener("click", () => refreshAll({ manual: true }));

function updateLiveDot() {
  const dot = $("#live-dot");
  const offline = navigator.onLine === false;
  const some = ["quakes", "events", "kp"].some((k) => state.failed.has(k));
  dot.classList.toggle("offline", offline);
  dot.classList.toggle("stale", !offline && some);
  dot.parentElement.title = offline ? "You're offline" : some ? "Some live feeds couldn't be reached" : "Live · Coordinated Universal Time";
}

function tick() {
  const now = new Date();
  $("#clock").textContent = now.toISOString().slice(11, 19);
  if (state.lastRefresh) {
    const left = Math.max(0, state.lastRefresh + REFRESH_MS - Date.now());
    const mm = Math.floor(left / 60000), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
    $("#refresh-status").textContent = `Updated ${new Date(state.lastRefresh).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · next in ${mm}:${ss}`;
  }
}

window.addEventListener("online", () => { updateLiveDot(); toast("Back online. Refreshing…"); refreshAll(); });
window.addEventListener("offline", () => { updateLiveDot(); toast("You're offline. Showing the last data we received.", { tone: "warn", ms: 4000 }); });

let resizeT;
const ro = new ResizeObserver(() => {
  resize();
  clearTimeout(resizeT);
  resizeT = setTimeout(renderKpChart, 120);
});
ro.observe(document.body);
ro.observe(wrap);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  // reflect remembered preferences in the UI
  $("#quake-feed").value = state.quakeFeed;
  $$("[data-proj]").forEach((x) => {
    const on = x.dataset.proj === state.proj;
    x.classList.toggle("active", on);
    x.setAttribute("aria-pressed", String(on));
  });
  for (const k of Object.keys(state.layers)) $(`[data-layer="${k}"]`)?.setAttribute("aria-pressed", String(state.layers[k]));
  $$("[data-sort]").forEach((x) => {
    const on = x.dataset.sort === state.quakeSort;
    x.classList.toggle("active", on);
    x.setAttribute("aria-pressed", String(on));
  });
  intro.hidden = state.introDismissed;
  if (isMac) $$(".mod-key").forEach((k) => (k.textContent = "⌘"));
  renderRotateBtn();

  resize();
  renderLegend();
  renderEventFilters();
  renderCountryEmpty();
  renderKpChart();
  requestAnimationFrame(frame);
  setInterval(tick, 1000);
  tick();

  loadGeo()
    .then(() => { $("#map-loading").classList.add("done"); applyHash(); if (searchInput.value.trim()) renderSearch(); })
    .catch((e) => {
      console.error("geo", e);
      $("#map-loading").innerHTML = `${icon("alert")}<span>Couldn't load the map outlines. Reload the page to try again.</span>`;
    });
  await Promise.allSettled([refreshAll(), loadFx()]);
  setInterval(refreshAll, REFRESH_MS);
  setInterval(loadFx, FX_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.lastRefresh && Date.now() - state.lastRefresh > REFRESH_MS) refreshAll();
  });
})();

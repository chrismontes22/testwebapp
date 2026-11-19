/* Planet Pulse — live Earth dashboard.
 * Every source used here is public domain or permissively licensed for commercial use.
 * See README.md / DATA_SOURCES.md for details and required attributions. */

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

const INDICATORS = [
  { id: "SP.POP.TOTL", label: "Population", fmt: (v) => fmtCompact(v) },
  { id: "NY.GDP.PCAP.CD", label: "GDP per capita", fmt: (v) => "$" + fmtCompact(v) },
  { id: "NY.GDP.MKTP.CD", label: "GDP (current US$)", fmt: (v) => "$" + fmtCompact(v) },
  { id: "SP.DYN.LE00.IN", label: "Life expectancy", fmt: (v) => v.toFixed(1) + " yrs" },
  { id: "IT.NET.USER.ZS", label: "Internet users", fmt: (v) => v.toFixed(0) + "%" },
  { id: "EG.FEC.RNEW.ZS", label: "Renewable energy share", fmt: (v) => v.toFixed(1) + "%" },
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

// Earthquakes: one-hue sequential ramp by magnitude (+ size).
const quakeColor = d3.scaleSequential(d3.interpolateRgb("#f7c6bd", "#e0302a")).domain([1, 7]).clamp(true);
const quakeRadius = (m, z) => Math.max(2.2, Math.pow(1.62, Math.max(m, 0)) * 0.85) * Math.sqrt(z);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  proj: "globe",
  rotate: [-15, -18, 0],
  zoom: 1,
  panY: 0,
  quakeFeed: "2.5_day",
  quakes: [],
  events: [],
  kp: [],
  layers: { quakes: true, events: true, night: true },
  hiddenCats: new Set(),
  autoRotate: true,
  lastInteract: 0,
  moving: false,
  selected: null, // country feature
  hovered: null, // country feature
  hoverMarker: null,
  fx: { rates: null, names: {}, date: null },
  geo: null,
  codes: {},
  wbCache: new Map(),
  lastRefresh: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat();
const fmtCompact = (v) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(t) {
  const s = (t - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), "second");
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
const regionNames = (() => {
  try { return new Intl.DisplayNames(undefined, { type: "region" }); } catch { return null; }
})();
const flagEmoji = (a2) =>
  a2 && /^[A-Z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🏳️";

async function getJSON(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

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
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = wrap.clientWidth;
  H = wrap.clientHeight;
  for (const c of [canvas, base]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  baseDirty = true;
}

function projection() {
  if (state.proj === "globe") {
    const r = Math.min(W, H) / 2 - 18;
    return d3.geoOrthographic().rotate(state.rotate).scale(r * state.zoom).translate([W / 2, H / 2]).clipAngle(90).precision(0.6);
  }
  const p = d3.geoNaturalEarth1().rotate([state.rotate[0], 0, 0]).fitExtent([[12, 12], [W - 12, H - 12]], { type: "Sphere" });
  p.scale(p.scale() * state.zoom).translate([W / 2, H / 2 + state.panY]);
  return p;
}

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
    const glow = c.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.18);
    glow.addColorStop(0, "rgba(90,162,255,0.35)");
    glow.addColorStop(1, "rgba(90,162,255,0)");
    c.fillStyle = glow;
    c.beginPath(); c.arc(cx, cy, R * 1.18, 0, 2 * Math.PI); c.fill();
  }

  // ocean
  c.beginPath(); path({ type: "Sphere" });
  const ocean = globe
    ? c.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R)
    : c.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, "#14284d");
  ocean.addColorStop(1, "#070f22");
  c.fillStyle = ocean; c.fill();

  // graticule
  c.beginPath(); path(d3.geoGraticule10());
  c.strokeStyle = "rgba(140,170,230,0.09)"; c.lineWidth = 0.6; c.stroke();

  if (g) {
    const hi = !state.moving; // high-res when still
    c.beginPath(); path(hi ? g.land50 : g.land110);
    c.fillStyle = "#1f3256"; c.fill();

    if (state.hovered && state.hovered !== state.selected) {
      c.beginPath(); path(state.hovered); c.fillStyle = "#2a4677"; c.fill();
    }
    if (state.selected) {
      c.beginPath(); path(state.selected); c.fillStyle = "#3466b8"; c.fill();
      c.strokeStyle = "#a8cbff"; c.lineWidth = 1.2; c.stroke();
    }
    c.beginPath(); path(hi ? g.borders50 : g.borders110);
    c.strokeStyle = "rgba(170,200,255,0.28)"; c.lineWidth = 0.5; c.stroke();
  }

  if (state.layers.night) {
    const [lon, lat] = subsolar();
    const anti = [lon + 180, -lat];
    for (const [r, a] of [[96, 0.12], [93, 0.13], [90, 0.15], [87, 0.14], [84, 0.14]]) {
      c.beginPath(); path(d3.geoCircle().center(anti).radius(r)());
      c.fillStyle = `rgba(2,5,14,${a})`; c.fill();
    }
  }

  // rim
  c.beginPath(); path({ type: "Sphere" });
  c.strokeStyle = "rgba(168,203,255,0.35)"; c.lineWidth = 1; c.stroke();
  baseDirty = false;
}

function visible(proj, lonlat) {
  if (state.proj !== "globe") return true;
  const r = proj.rotate();
  return d3.geoDistance(lonlat, [-r[0], -r[1]]) < Math.PI / 2 - 0.02;
}

let markers = []; // screen-space hit list
function drawMarkers(proj, t) {
  const c = ctx;
  markers = [];
  const z = state.zoom;

  if (state.layers.events) {
    for (const ev of state.events) {
      if (state.hiddenCats.has(ev.cat.key) || !visible(proj, ev.coord)) continue;
      const p = proj(ev.coord);
      if (!p) continue;
      const size = 95 * Math.min(z, 3);
      c.save();
      c.translate(p[0], p[1]);
      c.beginPath();
      d3.symbol(ev.cat.symbol, size).context(c)();
      c.fillStyle = ev.cat.color;
      c.strokeStyle = "#0b1222"; c.lineWidth = 2;
      c.stroke(); c.fill();
      if (state.hoverMarker === ev) { c.strokeStyle = "#fff"; c.lineWidth = 1.5; c.stroke(); }
      c.restore();
      markers.push({ kind: "event", d: ev, x: p[0], y: p[1], r: Math.sqrt(size) / 1.4 + 4 });
    }
  }

  if (state.layers.quakes) {
    // draw biggest first so small ones stay clickable on top
    for (const q of state.quakes) {
      if (!visible(proj, q.coord)) continue;
      const p = proj(q.coord);
      if (!p) continue;
      const r = quakeRadius(q.mag, Math.min(z, 3));
      const col = quakeColor(q.mag);
      const age = Date.now() - q.time;
      if (age < 3600e3) {
        // pulse for quakes within the last hour
        const ph = ((t / 1600) + q.phase) % 1;
        c.beginPath(); c.arc(p[0], p[1], r + ph * 22, 0, 2 * Math.PI);
        c.strokeStyle = d3.color(col).copy({ opacity: 1 - ph }).toString(); c.lineWidth = 1.5; c.stroke();
      }
      c.beginPath(); c.arc(p[0], p[1], r, 0, 2 * Math.PI);
      c.fillStyle = d3.color(col).copy({ opacity: 0.55 }).toString(); c.fill();
      c.strokeStyle = state.hoverMarker === q ? "#fff" : col;
      c.lineWidth = state.hoverMarker === q ? 2 : 1.2;
      c.stroke();
      markers.push({ kind: "quake", d: q, x: p[0], y: p[1], r: r + 3 });
    }
  }
}

let lastT = 0;
let lastDetailT = 0;
function frame(t) {
  const dt = Math.min(64, t - (lastT || t));
  lastT = t;
  if (state.autoRotate && !dragging && performance.now() - state.lastInteract > 9000 && !flying) {
    state.rotate[0] = (state.rotate[0] + dt * 0.0045) % 360;
    state.moving = true;
    baseDirty = true;
    lastDetailT = t;
  } else if (state.moving && !dragging && !flying && t - lastDetailT > 180) {
    state.moving = false; // settle → redraw in high resolution
    baseDirty = true;
  }
  const proj = projection();
  if (baseDirty) drawBase(proj);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawMarkers(proj, t);
  requestAnimationFrame(frame);
}

function markMoving() {
  state.moving = true;
  baseDirty = true;
  lastDetailT = performance.now();
}

// --- interaction: drag / pinch / wheel / hover / click -----------------------
let dragging = false, flying = false, downAt = null, moved = 0;
const pointers = new Map();
let pinchStart = null;

wrap.addEventListener("pointerdown", (e) => {
  wrap.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom };
  }
  dragging = true; moved = 0; flying = false;
  downAt = { x: e.clientX, y: e.clientY };
  state.lastInteract = performance.now();
  wrap.classList.add("dragging");
  fadeHint();
});

wrap.addEventListener("pointermove", (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return hover(e);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist));
    return;
  }
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  moved += Math.abs(dx) + Math.abs(dy);
  const proj = projection();
  if (state.proj === "globe") {
    const k = 57.3 / proj.scale();
    state.rotate[0] += dx * k;
    state.rotate[1] = Math.max(-89, Math.min(89, state.rotate[1] - dy * k));
  } else {
    state.rotate[0] += dx * (360 / (proj.scale() * 2 * Math.PI));
    state.panY = Math.max(-H * state.zoom * 0.4, Math.min(H * state.zoom * 0.4, state.panY + dy));
  }
  state.lastInteract = performance.now();
  hideTooltip();
  markMoving();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) {
    dragging = false;
    wrap.classList.remove("dragging");
    if (moved < 6 && downAt) click(e);
  }
}
wrap.addEventListener("pointerup", endPointer);
wrap.addEventListener("pointercancel", endPointer);
wrap.addEventListener("pointerleave", () => { if (!dragging) { hideTooltip(); setHovered(null); } });

wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  setZoom(state.zoom * Math.exp(-e.deltaY * 0.0015));
  state.lastInteract = performance.now();
  fadeHint();
}, { passive: false });

function setZoom(z) {
  state.zoom = Math.max(0.7, Math.min(10, z));
  markMoving();
}

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

function countryAt(x, y) {
  if (!state.geo) return null;
  const proj = projection();
  const ll = proj.invert([x, y]);
  if (!ll || isNaN(ll[0])) return null;
  if (state.proj === "globe" && !visible(proj, ll)) return null;
  // also reject clicks outside the sphere on the flat map
  const back = proj(ll);
  if (!back || Math.hypot(back[0] - x, back[1] - y) > 1) return null;
  for (const f of state.geo.countries) {
    const [[x0, y0], [x1, y1]] = f.bbox;
    const inBox = x0 <= x1 ? ll[0] >= x0 && ll[0] <= x1 : ll[0] >= x0 || ll[0] <= x1;
    if (inBox && ll[1] >= y0 && ll[1] <= y1 && d3.geoContains(f, ll)) return f;
  }
  return null;
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
    if (c) showTooltip(x, y, `<strong>${flagEmoji(c.a2)} ${esc(c.name)}</strong><span class="muted">Click for indicators</span>`);
    else hideTooltip();
  });
}

function setHovered(f) {
  if (state.hovered !== f) { state.hovered = f; baseDirty = true; }
}

function click(e) {
  const [x, y] = localPoint(e);
  const m = hitMarker(x, y);
  if (m) {
    if (m.kind === "quake") { switchTab("quakes"); focusListItem("quake", m.d.id); }
    else { switchTab("events"); focusListItem("event", m.d.id); }
    return;
  }
  const c = countryAt(x, y);
  if (c) selectCountry(c);
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
  `<span class="muted">${ago(q.time)} · depth ${q.depth.toFixed(0)} km${q.tsunami ? " · tsunami flag" : ""}</span>`;
const eventTip = (ev) =>
  `<strong>${esc(ev.title)}</strong><span class="muted">${esc(ev.catTitle)} · updated ${ago(ev.date)}</span>`;

let hintFaded = false;
function fadeHint() {
  if (hintFaded) return;
  hintFaded = true;
  $("#map-hint").style.opacity = "0";
}

function flyTo(lonlat, zoom) {
  const from = [...state.rotate];
  const to = [-lonlat[0], state.proj === "globe" ? -lonlat[1] : from[1], 0];
  // take the short way round
  to[0] = from[0] + ((((to[0] - from[0]) % 360) + 540) % 360) - 180;
  const z0 = state.zoom, z1 = zoom ?? Math.max(state.zoom, 1.6);
  const interp = d3.interpolate(from, to);
  const t0 = performance.now();
  flying = true;
  state.lastInteract = t0;
  if (state.proj !== "globe") state.panY = 0;
  (function step(now) {
    const k = d3.easeCubicInOut(Math.min(1, (now - t0) / 1100));
    state.rotate = interp(k);
    state.zoom = z0 + (z1 - z0) * k;
    markMoving();
    state.lastInteract = performance.now();
    if (k < 1 && flying) requestAnimationFrame(step);
    else flying = false;
  })(t0);
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function symbolSVG(symbol, color, size = 70) {
  const d = d3.symbol(symbol, size)();
  return `<svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><path d="${d}" fill="${color}" stroke="#0b1222" stroke-width="1"/></svg>`;
}
function renderLegend() {
  const qs = [3, 5, 7].map((m) => {
    const r = Math.min(quakeRadius(m, 1), 11);
    return `<span class="legend-item" style="cursor:default"><svg width="${2 * r + 4}" height="${2 * r + 4}" aria-hidden="true"><circle cx="${r + 2}" cy="${r + 2}" r="${r}" fill="${quakeColor(m)}" fill-opacity=".55" stroke="${quakeColor(m)}"/></svg>M${m}</span>`;
  });
  const evs = EVENT_CATS.map(
    (c) => `<button type="button" class="legend-item" data-cat="${c.key}" aria-pressed="${!state.hiddenCats.has(c.key)}" title="Toggle ${c.label}">${symbolSVG(c.symbol, c.color)}${c.label} <span class="muted" data-count="${c.key}"></span></button>`,
  );
  $("#legend").innerHTML =
    `<span class="muted">Earthquakes</span>${qs.join("")}<span class="legend-sep"></span><span class="muted">Natural events</span>${evs.join("")}`;
  $("#legend").querySelectorAll("[data-cat]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.cat;
      state.hiddenCats.has(k) ? state.hiddenCats.delete(k) : state.hiddenCats.add(k);
      b.setAttribute("aria-pressed", String(!state.hiddenCats.has(k)));
      renderEventList();
    }),
  );
}

// ---------------------------------------------------------------------------
// Data: geography
// ---------------------------------------------------------------------------
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
    renderQuakeKPIs(data.metadata?.title);
    renderQuakeList();
    if (state.selected) renderCountryLocalStats(state.selected);
  } catch (err) {
    $("#kpi-quakes-sub").innerHTML = `<span class="error-note">USGS feed unavailable (${esc(err.message)})</span>`;
    $("#quake-list").innerHTML = `<li class="empty">Couldn't reach the USGS feed. Retrying on next refresh.</li>`;
  }
}

function renderQuakeKPIs(title) {
  const q = state.quakes;
  $("#kpi-quakes").textContent = nf.format(q.length);
  $("#kpi-quakes-sub").textContent = $("#quake-feed").selectedOptions[0].textContent;
  const top = q[0];
  if (top) {
    $("#kpi-strongest").textContent = "M" + top.mag.toFixed(1);
    $("#kpi-strongest-sub").textContent = `${top.place} · ${ago(top.time)}`;
    $("#kpi-strongest-sub").title = top.place;
  } else {
    $("#kpi-strongest").textContent = "—";
    $("#kpi-strongest-sub").textContent = title ? "None in this feed" : "";
  }
}

function renderQuakeList() {
  const list = [...state.quakes].sort((a, b) => b.time - a.time).slice(0, 150);
  $("#quake-list").innerHTML = list.length
    ? list
        .map(
          (q) => `<li class="feed-item" tabindex="0" data-kind="quake" data-id="${esc(q.id)}">
      <span class="mag" style="background:${d3.color(quakeColor(q.mag)).copy({ opacity: 0.35 })};border-color:${quakeColor(q.mag)}">${q.mag.toFixed(1)}</span>
      <span style="min-width:0">
        <div class="feed-title" title="${esc(q.place)}">${esc(q.place)}</div>
        <div class="feed-meta"><span>${ago(q.time)}</span><span>${q.depth.toFixed(0)} km deep</span>${q.tsunami ? '<span class="badge tsunami">tsunami flag</span>' : ""}${q.alert ? `<span class="badge">PAGER ${esc(q.alert)}</span>` : ""}<a href="${esc(q.url)}" target="_blank" rel="noopener">USGS ↗</a></div>
      </span></li>`,
        )
        .join("")
    : `<li class="empty">No earthquakes in this feed right now.</li>`;
}

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

    const counts = d3.rollup(state.events, (v) => v.length, (d) => d.cat.key);
    $("#kpi-events").textContent = nf.format(state.events.length);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n} ${catFor(k).label.toLowerCase()}`);
    $("#kpi-events-sub").textContent = top.length ? top.join(" · ") : "None open";
    for (const c of EVENT_CATS) {
      const el = document.querySelector(`[data-count="${c.key}"]`);
      if (el) el.textContent = counts.get(c.key) ?? 0;
    }
    renderEventList();
    if (state.selected) renderCountryLocalStats(state.selected);
  } catch (err) {
    $("#kpi-events-sub").innerHTML = `<span class="error-note">EONET unavailable (${esc(err.message)})</span>`;
    $("#event-list").innerHTML = `<li class="empty">Couldn't reach NASA EONET. Retrying on next refresh.</li>`;
  }
}

function renderEventList() {
  const list = state.events.filter((e) => !state.hiddenCats.has(e.cat.key)).slice(0, 200);
  $("#event-list").innerHTML = list.length
    ? list
        .map(
          (ev) => `<li class="feed-item" tabindex="0" data-kind="event" data-id="${esc(ev.id)}">
      <span class="ev-icon">${symbolSVG(ev.cat.symbol, ev.cat.color, 120).replace('width="14" height="14"', 'width="20" height="20"')}</span>
      <span style="min-width:0">
        <div class="feed-title" title="${esc(ev.title)}">${esc(ev.title)}</div>
        <div class="feed-meta"><span>${esc(ev.catTitle)}</span><span>${ago(ev.date)}</span>${ev.magnitude ? `<span>${esc(ev.magnitude)}</span>` : ""}${ev.link ? `<a href="${esc(ev.link)}" target="_blank" rel="noopener">Source ↗</a>` : ""}</div>
      </span></li>`,
        )
        .join("")
    : `<li class="empty">No open events for the selected categories.</li>`;
}

// list → map
for (const sel of ["#quake-list", "#event-list"]) {
  const el = $(sel);
  const go = (e) => {
    if (e.target.closest("a")) return;
    const li = e.target.closest(".feed-item");
    if (!li) return;
    const item = li.dataset.kind === "quake"
      ? state.quakes.find((q) => q.id === li.dataset.id)
      : state.events.find((v) => v.id === li.dataset.id);
    if (!item) return;
    state.hoverMarker = item;
    flyTo(item.coord, Math.max(state.zoom, 2.2));
    el.querySelectorAll(".feed-item").forEach((n) => n.style.background = "");
    li.style.background = "rgba(90,162,255,0.12)";
  };
  el.addEventListener("click", go);
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } });
}

function focusListItem(kind, id) {
  const li = document.querySelector(`.feed-item[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
  if (!li) return;
  li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  li.click();
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
    const last = state.kp[state.kp.length - 1];
    if (last) {
      const lvl = kpLevel(last.kp);
      $("#kpi-kp").innerHTML = `${last.kp.toFixed(2)}<span class="status-pill" style="background:${lvl.color}">${lvl.label}</span>`;
      $("#kpi-kp-sub").textContent = `${last.kp >= 5 ? "Aurora likely at mid-latitudes" : last.kp >= 4 ? "Aurora possible at high latitudes" : "Calm magnetosphere"} · ${ago(last.time)}`;
    }
    renderKpChart();
  } catch (err) {
    $("#kpi-kp-sub").innerHTML = `<span class="error-note">SWPC unavailable (${esc(err.message)})</span>`;
    $("#kp-chart").innerHTML = `<p class="muted small" style="padding:16px">Couldn't reach NOAA SWPC. Retrying on next refresh.</p>`;
  }
}

function renderKpChart() {
  const el = $("#kp-chart");
  const data = state.kp;
  $("#kp-legend").innerHTML = KP_LEVELS.map((l) => `<span><i style="background:${l.color}"></i>${l.label}${l.min ? ` (Kp ≥ ${l.min})` : ""}</span>`).join("") +
    `<span><svg width="18" height="10" aria-hidden="true"><line x1="0" x2="18" y1="5" y2="5" stroke="#ec835a" stroke-dasharray="4 3"/></svg>Storm threshold</span>`;
  $("#kp-table tbody").innerHTML = [...data].reverse().map((d) =>
    `<tr><td>${d3.utcFormat("%a %d %b %H:%M")(d.time)}</td><td>${d.kp.toFixed(2)}</td><td>${kpLevel(d.kp).label}</td></tr>`).join("");
  if (!data.length) { el.innerHTML = `<p class="muted small" style="padding:16px">No Kp data.</p>`; return; }

  const w = el.clientWidth - 24, h = el.clientHeight - 8;
  const m = { t: 10, r: 8, b: 26, l: 26 };
  const x = d3.scaleBand().domain(data.map((d) => +d.time)).range([m.l, w - m.r]).paddingInner(0.12);
  const y = d3.scaleLinear().domain([0, 9]).range([h - m.b, m.t]);
  const bw = x.bandwidth();
  const rr = Math.min(4, bw / 2);
  const barPath = (d) => {
    const x0 = x(+d.time), y0 = y(Math.max(d.kp, 0.15)), yb = y(0);
    return `M${x0},${yb}V${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}H${x0 + bw - rr}Q${x0 + bw},${y0} ${x0 + bw},${y0 + rr}V${yb}Z`;
  };
  const dayTicks = data.filter((d) => d.time.getUTCHours() === 0).map((d) => +d.time);

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart of planetary Kp index, last ${data.length} three-hour intervals">
    <g class="grid">${[0, 3, 5, 7, 9].map((v) => `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v)}" y2="${y(v)}" ${v === 5 ? 'stroke-dasharray="4 4" style="stroke:#ec835a;stroke-opacity:.6"' : ""}/>`).join("")}</g>
    <g class="axis">${[0, 3, 5, 7, 9].map((v) => `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      ${dayTicks.map((t) => `<text x="${x(t)}" y="${h - 6}">${d3.utcFormat("%a %d")(new Date(t))}</text>`).join("")}
    </g>
    <g>${data.map((d, i) => `<path class="bar" data-i="${i}" d="${barPath(d)}" fill="${kpLevel(d.kp).color}"/>`).join("")}</g>
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
    tip.innerHTML = `<strong>Kp ${d.kp.toFixed(2)}</strong><span class="status-pill" style="background:${lvl.color}">${lvl.label}</span><div class="muted">${d3.utcFormat("%a %d %b, %H:%M UTC")(d.time)}</div>`;
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

async function loadFx() {
  try {
    const [latest, names] = await Promise.all([fxGet("/latest?base=USD"), fxGet("/currencies").catch(() => ({}))]);
    state.fx = { rates: { USD: 1, ...latest.rates }, names, date: latest.date };
    $("#fx-date").textContent = `ECB reference rates · ${latest.date}`;
    const codes = Object.keys(state.fx.rates).sort();
    const opts = codes.map((c) => `<option value="${c}" title="${esc(names[c] ?? c)}">${c}</option>`).join("");
    const from = $("#fx-from").value || "USD", to = $("#fx-to").value || "EUR";
    $("#fx-from").innerHTML = opts; $("#fx-to").innerHTML = opts;
    $("#fx-from").value = codes.includes(from) ? from : "USD";
    $("#fx-to").value = codes.includes(to) ? to : "EUR";
    convert();
    if (state.selected) renderCountryFx(state.selected);
  } catch (err) {
    $("#fx-result").innerHTML = `<span class="error-note" style="font-size:13px">Exchange rates unavailable (${esc(err.message)})</span>`;
  }
}

function convert() {
  const r = state.fx.rates;
  if (!r) return;
  const amt = parseFloat($("#fx-amount").value) || 0;
  const from = $("#fx-from").value, to = $("#fx-to").value;
  const val = (amt * r[to]) / r[from];
  const fmt = (v, c) => {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: c, maximumFractionDigits: v < 1 ? 4 : 2 }).format(v); }
    catch { return `${v.toFixed(2)} ${c}`; }
  };
  $("#fx-result").innerHTML = `${fmt(val, to)}<small>${fmt(amt, from)}${state.fx.names[to] ? " → " + esc(state.fx.names[to]) : ""} · 1 ${from} = ${(r[to] / r[from]).toPrecision(5)} ${to}</small>`;
  const popular = ["USD", "EUR", "GBP", "JPY", "CNY", "INR", "CAD", "AUD", "MXN", "BRL", "CHF"].filter((c) => c !== from && r[c]);
  $("#fx-chips").innerHTML = popular.map((c) => `<button type="button" class="chip" data-to="${c}">${c} ${((amt * r[c]) / r[from]).toLocaleString(undefined, { maximumFractionDigits: 2 })}</button>`).join("");
}
$("#fx-amount").addEventListener("input", convert);
$("#fx-from").addEventListener("change", convert);
$("#fx-to").addEventListener("change", convert);
$("#fx-swap").addEventListener("click", () => {
  const a = $("#fx-from").value; $("#fx-from").value = $("#fx-to").value; $("#fx-to").value = a; convert();
});
$("#fx-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-to]"); if (b) { $("#fx-to").value = b.dataset.to; convert(); }
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

async function selectCountry(f) {
  state.selected = f;
  baseDirty = true;
  switchTab("country");
  const centroid = d3.geoCentroid(f);
  flyTo(centroid, Math.max(state.zoom, 1.3));

  const panel = $("#country-panel");
  panel.className = "country";
  panel.innerHTML = `
    <div class="country-head"><span class="flag">${flagEmoji(f.a2)}</span><div><h3>${esc(f.name)}</h3><span class="muted small">${esc(f.a3 ?? "")}${f.currency ? " · " + esc(f.currency) : ""}</span></div>
      <button class="btn ghost" id="country-close" style="margin-left:auto" aria-label="Clear selection">✕</button></div>
    <div class="stat-grid" id="wb-grid">${INDICATORS.map((i) => `<div class="stat"><span>${i.label}</span><strong class="skeleton">000000</strong><em>&nbsp;</em></div>`).join("")}</div>
    <div class="stat-grid" id="local-grid"></div>
    <div id="country-fx"></div>
    <p class="small muted" style="margin:0">Indicators: The World Bank, World Development Indicators (CC BY 4.0). Latest available year shown.</p>`;
  $("#country-close").addEventListener("click", clearSelection);
  renderCountryLocalStats(f);
  renderCountryFx(f);

  if (!f.a3) {
    $("#wb-grid").innerHTML = `<p class="muted small">No World Bank code for this territory.</p>`;
    return;
  }
  const res = await worldBank(f.a3);
  if (state.selected !== f) return;
  $("#wb-grid").innerHTML = res.every((r) => r.value == null)
    ? `<p class="muted small">${res.some((r) => r.error) ? "World Bank API unreachable right now." : "The World Bank publishes no indicators for this territory."}</p>`
    : res.map((r) => `<div class="stat"><span>${r.label}</span><strong>${r.value == null ? "—" : r.fmt(r.value)}</strong><em>${r.year ?? "n/a"}</em></div>`).join("");
}

function renderCountryLocalStats(f) {
  const grid = $("#local-grid");
  if (!grid) return;
  const inside = (c) => {
    const [[x0, y0], [x1, y1]] = f.bbox;
    const inBox = x0 <= x1 ? c[0] >= x0 && c[0] <= x1 : c[0] >= x0 || c[0] <= x1;
    return inBox && c[1] >= y0 && c[1] <= y1 && d3.geoContains(f, c);
  };
  const qs = state.quakes.filter((q) => inside(q.coord));
  const evs = state.events.filter((e) => inside(e.coord));
  const big = qs[0];
  grid.innerHTML = `
    <div class="stat"><span>Quakes in current feed</span><strong>${qs.length}</strong><em>${big ? "largest M" + big.mag.toFixed(1) : "on land / within borders"}</em></div>
    <div class="stat"><span>Open natural events</span><strong>${evs.length}</strong><em>${evs.length ? esc([...new Set(evs.map((e) => e.cat.label))].join(", ")) : "none tracked"}</em></div>`;
}

function renderCountryFx(f) {
  const box = $("#country-fx");
  if (!box) return;
  const r = state.fx.rates;
  if (!f.currency || !r) { box.innerHTML = ""; return; }
  if (!r[f.currency]) {
    box.innerHTML = `<div class="stat wide"><span>Currency</span><strong>${esc(f.currency)}</strong><em>Not in the ECB reference set</em></div>`;
    return;
  }
  box.innerHTML = `<div class="stat wide"><span>Exchange rate (ECB, ${esc(state.fx.date)})</span><strong>1 USD = ${r[f.currency].toPrecision(5)} ${esc(f.currency)}</strong>
    <button type="button" class="btn" id="use-fx" style="margin-top:8px">Use in converter</button></div>`;
  $("#use-fx").addEventListener("click", () => {
    $("#fx-to").value = f.currency; convert();
    $(".fx-card").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function clearSelection() {
  state.selected = null;
  baseDirty = true;
  const panel = $("#country-panel");
  panel.className = "country-empty";
  panel.innerHTML = `<p>Click any country on the map to see World Bank indicators and its live exchange rate.</p>`;
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== `panel-${name}`));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

document.querySelectorAll("[data-proj]").forEach((b) =>
  b.addEventListener("click", () => {
    state.proj = b.dataset.proj;
    state.zoom = 1; state.panY = 0;
    if (state.proj === "flat") state.rotate[1] = 0;
    document.querySelectorAll("[data-proj]").forEach((x) => x.classList.toggle("active", x === b));
    markMoving();
  }),
);

for (const k of ["quakes", "events", "night"]) {
  $(`#layer-${k}`).addEventListener("change", (e) => { state.layers[k] = e.target.checked; baseDirty = true; });
}

$("#quake-feed").addEventListener("change", (e) => { state.quakeFeed = e.target.value; loadQuakes(); });

const dialog = $("#sources-dialog");
$("#sources-btn").addEventListener("click", () => dialog.showModal?.() ?? dialog.setAttribute("open", ""));

async function refreshAll() {
  const btn = $("#refresh-btn");
  btn.classList.add("spinning");
  await Promise.allSettled([loadQuakes(), loadEvents(), loadKp()]);
  btn.classList.remove("spinning");
  state.lastRefresh = Date.now();
  baseDirty = true; // terminator moves too
}
$("#refresh-btn").addEventListener("click", refreshAll);

function tick() {
  const now = new Date();
  $("#clock").textContent = now.toISOString().slice(11, 19) + " UTC";
  if (state.lastRefresh) {
    const left = Math.max(0, state.lastRefresh + REFRESH_MS - Date.now());
    const mm = Math.floor(left / 60000), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
    $("#refresh-status").textContent = `Updated ${new Date(state.lastRefresh).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · next in ${mm}:${ss}`;
  }
}

let resizeT;
new ResizeObserver(() => {
  resize();
  clearTimeout(resizeT);
  resizeT = setTimeout(renderKpChart, 120);
}).observe(document.body);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function boot() {
  resize();
  renderLegend();
  requestAnimationFrame(frame);
  setInterval(tick, 1000);
  tick();

  loadGeo().catch((e) => console.error("geo", e));
  await Promise.allSettled([refreshAll(), loadFx()]);
  setInterval(refreshAll, REFRESH_MS);
  setInterval(loadFx, FX_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.lastRefresh && Date.now() - state.lastRefresh > REFRESH_MS) refreshAll();
  });
})();

/**
 * html-export.ts — the interactive HTML export.
 *
 * One self-contained page: the diagram as inline SVG, a timeline scrubber, a
 * presentation menu, and a full-screen control — no network requests, no
 * dependencies, nothing to install. The file IS the artefact, so it can be
 * mailed, attached to a ticket, or dropped on a wiki and still work in ten
 * years.
 *
 * The scrubbing works because the SVG backend groups every element's commands
 * in a `<g data-day>` carrying its EFFECTIVE landing day (cascade and edge
 * inheritance already resolved by the emitter — see DrawTag in draw.ts). The
 * player never re-renders anything: it compares numbers and toggles classes,
 * which is what makes a few hundred lines of inline vanilla JS enough.
 *
 * DOM-free string building, so the same function serves tests, a server, and
 * the browser exporters.
 */
import type { ExportPalette } from "./draw";
import { DARK_EXPORT_PALETTE } from "./draw";

/**
 * One of the document's paths, resolved for the player: members by the tag
 * the SVG backend stamps on their group (`node:<id>` / `edge:<id>`), with
 * each member's position in the walk, and the colour as a hex the page can
 * paint with (the export palette's, so a light export glows in light hues).
 */
export interface HtmlPathEntry {
  id: string;
  title: string;
  color: string;
  members: Array<{ el: string; step: number; steps: number; reversed?: boolean }>;
}

export interface TimelineHtmlOptions {
  /** The full standalone `<svg>` document, tagged groups included. */
  svg: string;
  /** Page + header title. */
  title: string;
  /** The document's distinct dates, ascending, ISO `YYYY-MM-DD`. */
  stops: string[];
  /** Colours for the page chrome, matching the SVG's own palette. */
  palette?: Partial<ExportPalette>;
  /** Accent for the scrubber (the SVG palette has no accent of its own). */
  accent?: string;
  /** Named flows the reader can light up from the menu. Omit for none. */
  paths?: HtmlPathEntry[];
}

/** Rough perceptual luminance test — enough to pick between two accents. */
function isLightHex(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Build the page. The player's behaviour mirrors the editor's scrubber where
 * it matters: continuous over days, snap to a stop within a pixel threshold,
 * hover previews the landing with a ghost dot, ◀ ▶ and arrow keys step
 * between real stops, the date readout is a click-to-type jump control, and
 * "Ghost later / Hide later" decides what happens ahead of the cursor.
 */
export function buildTimelineHtml(opts: TimelineHtmlOptions): string {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...opts.palette };
  // The scrubber accent isn't in ExportPalette, so derive it from the page:
  // the dark sky reads at ~2.2:1 on a light background, so light pages get
  // the darker sky the LIGHT_THEME uses.
  const accent = opts.accent ?? (isLightHex(palette.bg) ? "#0284c7" : "#38bdf8");
  const title = esc(opts.title);
  const hasTimeline = opts.stops.length > 0;
  // Dates are [-0-9] only after validation, but the JSON still goes through
  // esc-by-construction: no `<` can appear, so it cannot close the script.
  const stopsJson = JSON.stringify(opts.stops);
  // Paths ride the same way; titles are user text, so "<" is escaped out of
  // the script the way the multi-view page escapes its labels.
  const paths = opts.paths ?? [];
  const hasPaths = paths.length > 0;
  const pathsJson = JSON.stringify(paths).replace(/</g, "\\u003c");
  const light = isLightHex(palette.bg);
  // Everything path-shaped is emitted only when there is a path to light, so
  // a document without any produces exactly the page it always did.
  const pathCss = hasPaths
    ? `
  /* ── Paths: a lit flow glows, pulses, and its dashes run the way it goes.
     Overlays are extra strokes cloned from the element's own first path
     (an edge's line, a node's body), so they follow every bend and dim with
     their element. A light page gets a tighter, denser glow. ── */
  .bd-swatch {
    display: inline-block; flex: 0 0 auto; width: 10px; height: 10px; border-radius: 3px;
    border: 1px solid var(--bd-c); background: color-mix(in srgb, var(--bd-c) 35%, transparent);
  }
  .bd-stage { position: relative; }
  .bd-pathlegend {
    position: absolute; top: 12px; right: 12px; z-index: 5; min-width: 130px; padding: 8px 10px;
    border: 1px solid ${palette.border}; border-radius: 8px;
    background: color-mix(in srgb, ${palette.surface} 94%, transparent); font-size: 11px;
  }
  .bd-pathlegend[hidden] { display: none; }
  .bd-pathlegend__title {
    margin: 0 0 6px; font-family: ui-monospace, Menlo, monospace; font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em; color: ${palette.textDim};
  }
  .bd-pathlegend__row { display: flex; align-items: center; gap: 7px; padding: 2px 0; }
  @keyframes bd-pulse { 0%, 100% { opacity: 0.45; } 14% { opacity: 1; } 32% { opacity: 0.45; } }
  @keyframes bd-flow { to { stroke-dashoffset: -22; } }
  [data-path] {
    --bd-cycle: calc(var(--bd-steps, 1) * 420ms);
    --bd-delay: calc((var(--bd-step, 0) - var(--bd-steps, 1)) * 420ms);
    stroke: var(--bd-c); pointer-events: none;
  }
  .bd-glowline, .bd-glowbody {
    stroke-width: 9; stroke-linecap: round; stroke-linejoin: round;
    stroke-opacity: ${light ? "0.85" : "0.65"}; opacity: 0.45; filter: blur(${light ? "1.5px" : "2.5px"});
    animation: bd-pulse var(--bd-cycle) ease-in-out var(--bd-delay) infinite;
  }
  .bd-glowbody { stroke-width: 7; }
  .bd-flowline {
    stroke-width: 2.4; stroke-linecap: round; stroke-dasharray: 7 15;
    animation: bd-flow 900ms linear infinite, bd-pulse var(--bd-cycle) ease-in-out var(--bd-delay) infinite;
  }
  .bd-flowline--reverse { animation-direction: reverse, normal; }
  @media (prefers-reduced-motion: reduce) { [data-path] { animation: none !important; opacity: 0.8; } }
`
    : "";
  const pathJs = hasPaths
    ? `
  // ── Paths: light a named flow. Runs before the timeline guard below, so an
  //    undated document can still light its paths. ──
  var PATHS = ${pathsJson};
  var pathBoxes = [].slice.call(document.querySelectorAll("input.bd-path"));
  var pathLegend = $("bd-pathlegend"), pathRows = $("bd-pathrows");
  var STRIP = ["fill", "fill-opacity", "stroke", "stroke-opacity", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "class"];
  // Groups by their tag, looked up by key rather than by a selector built
  // from the id: an id is free text, and a quote in one must not break this.
  var groupsByEl = {};
  [].slice.call(document.querySelectorAll("[data-el]")).forEach(function (g) {
    var el = g.getAttribute("data-el");
    (groupsByEl[el] = groupsByEl[el] || []).push(g);
  });
  function hasOverlay(g, id) {
    for (var c = g.firstChild; c; c = c.nextSibling) {
      if (c.getAttribute && c.getAttribute("data-path") === id) return true;
    }
    return false;
  }
  function overlay(src, cls, path, m, reversed) {
    var el = src.cloneNode(false);
    STRIP.forEach(function (a) { el.removeAttribute(a); });
    el.setAttribute("class", cls + (reversed ? " " + cls + "--reverse" : ""));
    el.setAttribute("data-path", path.id);
    el.setAttribute("fill", "none");
    el.style.setProperty("--bd-c", path.color);
    el.style.setProperty("--bd-step", m.step);
    el.style.setProperty("--bd-steps", m.steps);
    return el;
  }
  function applyPaths() {
    var lit = {};
    pathBoxes.forEach(function (box) { if (box.checked) lit[box.value] = true; });
    [].slice.call(document.querySelectorAll("[data-path]")).forEach(function (el) {
      if (!lit[el.getAttribute("data-path")]) el.parentNode.removeChild(el);
    });
    var rows = [];
    PATHS.forEach(function (path) {
      if (!lit[path.id]) return;
      rows.push(path);
      path.members.forEach(function (m) {
        (groupsByEl[m.el] || []).forEach(function (g) {
          if (hasOverlay(g, path.id)) return;
          // The element's own first path: an edge's line, a node's body.
          var src = g.querySelector("path:not([data-path])");
          if (!src) return;
          var isEdge = m.el.indexOf("edge:") === 0;
          g.insertBefore(overlay(src, isEdge ? "bd-glowline" : "bd-glowbody", path, m, false), g.firstChild);
          if (isEdge) src.parentNode.insertBefore(overlay(src, "bd-flowline", path, m, !!m.reversed), src.nextSibling);
        });
      });
    });
    pathRows.textContent = "";
    rows.forEach(function (path) {
      var row = document.createElement("div"); row.className = "bd-pathlegend__row";
      var sw = document.createElement("span"); sw.className = "bd-swatch"; sw.style.setProperty("--bd-c", path.color);
      row.appendChild(sw); row.appendChild(document.createTextNode(path.title));
      pathRows.appendChild(row);
    });
    pathLegend.hidden = !rows.length;
  }
  pathBoxes.forEach(function (box) { box.addEventListener("change", applyPaths); });
  $("bd-paths-all").addEventListener("click", function () { pathBoxes.forEach(function (b) { b.checked = true; }); applyPaths(); });
  $("bd-paths-none").addEventListener("click", function () { pathBoxes.forEach(function (b) { b.checked = false; }); applyPaths(); });
`
    : "";
  const pathsSection = hasPaths
    ? `
        <div class="bd-caption">Paths</div>${paths
          .map(
            (p) =>
              `\n        <label><input type="checkbox" class="bd-path" value="${esc(p.id)}" /><span class="bd-swatch" style="--bd-c:${esc(p.color)}"></span>${esc(p.title)}</label>`,
          )
          .join("")}
        <button class="bd-menubtn" id="bd-paths-all">All paths</button>
        <button class="bd-menubtn" id="bd-paths-none">No paths</button>`
    : "";
  const pathLegend = hasPaths
    ? `
    <div class="bd-pathlegend" id="bd-pathlegend" hidden>
      <div class="bd-pathlegend__title">Paths</div>
      <div id="bd-pathrows"></div>
    </div>`
    : "";

  const css = `
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: ${palette.bg}; color: ${palette.text};
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
  }
  .bd-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bd-bar {
    display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
    padding: 8px 14px; border-bottom: 1px solid ${palette.border}; background: ${palette.surface};
  }
  .bd-title { font-weight: 600; font-size: 14px; }
  .bd-sub { font-size: 10px; color: ${palette.textDim}; font-family: ui-monospace, Menlo, monospace; }
  .bd-spacer { flex: 1; }
  .bd-btn {
    display: inline-flex; align-items: center; justify-content: center; height: 28px;
    padding: 0 10px; border: 1px solid ${palette.border}; border-radius: 6px;
    background: ${palette.surface2}; color: ${palette.textDim};
    font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .bd-btn:hover:not(:disabled) { color: ${palette.text}; }
  .bd-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .bd-btn--icon { min-width: 28px; padding: 0 7px; }
  .bd-menuwrap { position: relative; }
  .bd-menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; width: 220px;
    border: 1px solid ${palette.border}; border-radius: 8px; background: ${palette.surface};
    box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
  }
  .bd-menu[hidden] { display: none; }
  .bd-menu label {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer;
  }
  .bd-menu label:hover { background: ${palette.surface2}; }
  .bd-menu .bd-caption {
    padding: 7px 12px 3px; border-top: 1px solid ${palette.border};
    font-family: ui-monospace, Menlo, monospace; font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.06em; color: ${palette.textDim};
  }
  .bd-menu .bd-caption:first-child { border-top: 0; }
  .bd-menu .bd-menubtn {
    display: block; width: 100%; padding: 9px 12px; border: 0; border-top: 1px solid ${palette.border};
    background: none; color: ${palette.text}; font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  }
  .bd-menu .bd-menubtn:hover { background: ${palette.surface2}; }
  /* ── Timeline bar — the editor's scrubber, transplanted. ── */
  .bd-timeline {
    display: flex; align-items: center; gap: 10px; flex: 0 0 auto;
    padding: 6px 14px; border-bottom: 1px solid ${palette.border}; background: ${palette.surface};
  }
  .bd-timeline[hidden] { display: none; }
  .bd-track { position: relative; flex: 1; min-width: 140px; height: 22px; }
  .bd-rail, .bd-buffer { position: absolute; top: 9px; left: 0; height: 4px; border-radius: 2px; pointer-events: none; }
  .bd-rail { right: 0; background: ${palette.surface2}; }
  .bd-buffer { background: ${accent}; }
  .bd-tick {
    position: absolute; top: 5px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px;
    background: ${palette.textDim}; opacity: 0.6; transition: height 90ms, top 90ms, opacity 90ms;
    pointer-events: none;
  }
  .bd-tick.past { background: ${accent}; opacity: 1; }
  .bd-tick.hot { top: 3px; height: 16px; background: ${accent}; opacity: 1; }
  .bd-ghostdot {
    position: absolute; top: 4px; width: 14px; height: 14px; margin-left: -7px;
    border: 2px solid ${accent}; border-radius: 50%;
    background: color-mix(in srgb, ${accent} 18%, transparent); pointer-events: none;
  }
  .bd-ghostdot[hidden] { display: none; }
  .bd-range { position: absolute; inset: 0; width: 100%; height: 22px; margin: 0; background: none; appearance: none; cursor: pointer; }
  .bd-range::-webkit-slider-runnable-track { height: 4px; margin-top: 9px; background: none; }
  .bd-range::-moz-range-track { height: 4px; background: none; }
  .bd-range::-webkit-slider-thumb {
    width: 14px; height: 14px; margin-top: -5px; border: 2px solid ${palette.bg}; border-radius: 50%;
    background: ${accent}; appearance: none; cursor: grab; transition: opacity 90ms;
  }
  .bd-range::-moz-range-thumb {
    width: 14px; height: 14px; border: 2px solid ${palette.bg}; border-radius: 50%;
    background: ${accent}; cursor: grab; transition: opacity 90ms;
  }
  .bd-range.ghosting::-webkit-slider-thumb { opacity: 0.3; }
  .bd-range.ghosting::-moz-range-thumb { opacity: 0.3; }
  .bd-date {
    min-width: 96px; padding: 2px 6px; border: 1px solid transparent; border-radius: 5px;
    background: none; color: ${palette.text}; font-family: ui-monospace, Menlo, monospace;
    font-size: 12px; font-weight: 600; text-align: right; white-space: nowrap; cursor: pointer;
  }
  .bd-date:hover { border-color: ${palette.border}; background: ${palette.surface2}; }
  .bd-date.onstop { color: ${accent}; }
  .bd-datepick { width: 138px; height: 28px; border: 1px solid ${palette.border}; border-radius: 6px;
    background: ${palette.surface2}; color: ${palette.text}; font: inherit; font-size: 12px; padding: 0 6px; }
  .bd-datepick[hidden] { display: none; }
  .bd-ahead { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: ${palette.textDim}; white-space: nowrap; }
  /* ── Stage ── */
  .bd-stage { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 16px; }
  .bd-stage.fit svg { max-width: 100%; height: auto; }
  /* ── The scrub itself: what "later" looks like. ── */
  .bd-el { transition: opacity 160ms; }
  .bd-dim { opacity: 0.22; filter: grayscale(1); }
  .bd-hidden { display: none; }
  ${pathCss}`;

  // The player. Plain script, no modules, nothing external; every hook is
  // looked up by id so the markup above stays the single source of structure.
  const js = `
  "use strict";
  var STOPS = ${stopsJson};
  var DAY_MS = 86400000, SNAP_PX = 11, HOVER_PX = 14;
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function toDay(iso) { var p = iso.split("-"); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS); }
  function fmt(day) {
    var d = new Date(day * DAY_MS), y = d.getUTCFullYear();
    var label = MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
    if (y !== new Date().getFullYear()) label += " \\u2019" + ("0" + (y % 100)).slice(-2);
    return label;
  }
  function iso(day) {
    var d = new Date(day * DAY_MS);
    return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2);
  }
  var $ = function (id) { return document.getElementById(id); };
  var els = [].slice.call(document.querySelectorAll("[data-day]"));

  // ── Menu + fullscreen + fit: present whether or not anything is dated. ──
  var menuBtn = $("bd-menu"), dropdown = $("bd-dropdown");
  menuBtn.addEventListener("click", function (e) { e.stopPropagation(); dropdown.hidden = !dropdown.hidden; });
  document.addEventListener("click", function (e) { if (!dropdown.contains(e.target)) dropdown.hidden = true; });
  function fullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else if (document.documentElement.requestFullscreen) { document.documentElement.requestFullscreen(); }
  }
  $("bd-full").addEventListener("click", fullscreen);
  var full2 = $("bd-full2"); if (full2) full2.addEventListener("click", function () { dropdown.hidden = true; fullscreen(); });
  var fit = $("bd-fit");
  fit.addEventListener("change", function () { $("bd-stage").classList.toggle("fit", fit.checked); });
${pathJs}
  if (!STOPS.length) return; // undated document: a plain viewer, and that is all

  // ── The scrubber. Cursor is a DAY; stops are where ticks and snapping live. ──
  var stopDays = STOPS.map(toDay);
  var min = stopDays[0], max = stopDays[stopDays.length - 1], span = Math.max(1, max - min);
  var now = new Date();
  var cursor = Math.min(max, Math.max(min, Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS)));
  var mode = "dim";
  var track = $("bd-track"), range = $("bd-range"), buffer = $("bd-buffer"), ghost = $("bd-ghostdot");
  var dateBtn = $("bd-date"), datePick = $("bd-datepick"), ahead = $("bd-ahead");
  var prev = $("bd-prev"), next = $("bd-next"), bar = $("bd-timeline");
  range.min = min; range.max = max; range.step = 1;
  var pct = function (day) { return ((day - min) / span) * 100; };
  var ticks = stopDays.map(function (day) {
    var t = document.createElement("div");
    t.className = "bd-tick"; t.style.left = pct(day) + "%"; t.title = fmt(day);
    track.insertBefore(t, range);
    return t;
  });
  function daysFor(px) { var w = track.offsetWidth; return w > 0 ? (px * span) / w : 0; }
  function nearest(day, within) {
    var best = null, gap = Infinity;
    stopDays.forEach(function (s) { var g = Math.abs(s - day); if (g < gap) { gap = g; best = s; } });
    return best !== null && gap <= within ? best : null;
  }
  function apply() {
    range.value = cursor;
    // Announce the DATE, not the raw epoch-day number the slider runs on.
    range.setAttribute("aria-valuetext", fmt(cursor));
    buffer.style.width = pct(cursor) + "%";
    ticks.forEach(function (t, i) { t.classList.toggle("past", stopDays[i] <= cursor); });
    dateBtn.textContent = fmt(cursor);
    dateBtn.classList.toggle("onstop", stopDays.indexOf(cursor) !== -1);
    datePick.value = iso(cursor);
    prev.disabled = !stopDays.some(function (s) { return s < cursor; });
    next.disabled = !stopDays.some(function (s) { return s > cursor; });
    var futureEls = {};
    els.forEach(function (g) {
      var future = +g.getAttribute("data-day") > cursor;
      if (future) futureEls[g.getAttribute("data-el")] = true;
      g.classList.toggle("bd-dim", future && mode === "dim");
      g.classList.toggle("bd-hidden", future && mode === "hide");
    });
    var n = Object.keys(futureEls).length;
    ahead.textContent = n ? n + " ahead" : "all here";
  }
  function scrubTo(day) {
    // Explicit null check: day 0 is the epoch itself, and || would skip it.
    var hit = nearest(day, daysFor(SNAP_PX));
    cursor = hit !== null ? hit : Math.min(max, Math.max(min, day));
    apply();
  }
  range.addEventListener("input", function () { scrubTo(+range.value); });
  function step(dir) {
    var candidates = stopDays.filter(function (s) { return dir > 0 ? s > cursor : s < cursor; });
    if (candidates.length) { cursor = dir > 0 ? candidates[0] : candidates[candidates.length - 1]; apply(); }
  }
  prev.addEventListener("click", function () { step(-1); });
  next.addEventListener("click", function () { step(1); });
  document.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (bar.hidden) return; // no visible cursor to move — stepping would scrub invisibly
    if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  });
  // Hover preview: an outline dot at the landable tick, the real thumb fading.
  track.addEventListener("pointermove", function (e) {
    var rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    var day = min + ((e.clientX - rect.left) / rect.width) * span;
    var hit = nearest(day, daysFor(HOVER_PX));
    ticks.forEach(function (t, i) { t.classList.toggle("hot", stopDays[i] === hit); });
    if (hit !== null && hit !== cursor) {
      ghost.style.left = pct(hit) + "%"; ghost.hidden = false; range.classList.add("ghosting");
    } else { ghost.hidden = true; range.classList.remove("ghosting"); }
  });
  track.addEventListener("pointerleave", function () {
    ghost.hidden = true; range.classList.remove("ghosting");
    ticks.forEach(function (t) { t.classList.remove("hot"); });
  });
  // The readout doubles as a jump-to-a-date control.
  dateBtn.addEventListener("click", function () { dateBtn.hidden = true; datePick.hidden = false; datePick.focus(); });
  function unpick() { datePick.hidden = true; dateBtn.hidden = false; }
  datePick.addEventListener("change", function () {
    if (datePick.value) { cursor = Math.min(max, Math.max(min, toDay(datePick.value))); apply(); }
  });
  datePick.addEventListener("blur", unpick);
  datePick.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === "Escape") unpick(); });
  // Presentation menu: how later elements read, and whether the bar shows.
  [].slice.call(document.querySelectorAll('input[name="bd-mode"]')).forEach(function (radio) {
    radio.addEventListener("change", function () { mode = radio.value; apply(); });
  });
  var showTl = $("bd-showtl");
  showTl.addEventListener("change", function () {
    bar.hidden = !showTl.checked;
    // With the bar gone there is no cursor to read, so everything shows.
    if (!showTl.checked) { cursor = max; }
    apply();
  });
  apply();
  `;

  // The timeline bar and its menu section exist only when something is dated —
  // an undated document exports as a plain viewer with fit + fullscreen.
  const timelineBar = hasTimeline
    ? `
  <div class="bd-timeline" id="bd-timeline" role="group" aria-label="Timeline scrubber">
    <span class="bd-sub">TIMELINE</span>
    <button class="bd-btn bd-btn--icon" id="bd-prev" title="Previous dated point" aria-label="Previous dated point">&#9664;</button>
    <div class="bd-track" id="bd-track">
      <div class="bd-rail"></div>
      <div class="bd-buffer" id="bd-buffer"></div>
      <div class="bd-ghostdot" id="bd-ghostdot" hidden></div>
      <input class="bd-range" id="bd-range" type="range" aria-label="Scrub to a date" />
    </div>
    <button class="bd-date" id="bd-date" title="Jump to a specific date"></button>
    <input class="bd-datepick" id="bd-datepick" type="date" aria-label="Jump to a date" hidden />
    <button class="bd-btn bd-btn--icon" id="bd-next" title="Next dated point" aria-label="Next dated point">&#9654;</button>
    <span class="bd-ahead" id="bd-ahead"></span>
  </div>`
    : "";

  const modeSection = hasTimeline
    ? `
        <div class="bd-caption">Later elements</div>
        <label><input type="radio" name="bd-mode" value="dim" checked /> Ghost later</label>
        <label><input type="radio" name="bd-mode" value="hide" /> Hide later</label>
        <div class="bd-caption">View</div>
        <label><input type="checkbox" id="bd-showtl" checked /> Timeline bar</label>`
    : `
        <div class="bd-caption">View</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
  <header class="bd-bar">
    <span class="bd-title">${title}</span>
    <span class="bd-sub">interactive export</span>
    <span class="bd-spacer"></span>
    <button class="bd-btn bd-btn--icon" id="bd-full" title="Full screen" aria-label="Full screen">&#x26F6;</button>
    <div class="bd-menuwrap">
      <button class="bd-btn bd-btn--icon" id="bd-menu" title="Presentation options" aria-haspopup="menu" aria-label="Presentation options">&#8943;</button>
      <div class="bd-menu" id="bd-dropdown" hidden>${modeSection}${pathsSection}
        <label><input type="checkbox" id="bd-fit" checked /> Fit to window</label>
        <button class="bd-menubtn" id="bd-full2">Full screen</button>
      </div>
    </div>
  </header>${timelineBar}
  <main class="bd-stage fit" id="bd-stage">${pathLegend}
${opts.svg}
  </main>
<script>
(function () {
${js}
})();
</script>
</body>
</html>
`;
}

// ─── Multi-view: one page, one section per C4 level ──────────────────────────

/** One drill level in the exported page. */
export interface ViewEntry {
  /** The focused node's id; "" is the root (C1) view. */
  key: string;
  /** Crumb trail, root first, ending in this view. */
  crumb: Array<{ key: string; label: string }>;
  /** "C1 · Context" … shown as the level pill. */
  levelLabel: string;
  /** Parent view's key for Esc/drill-out; null on the root. */
  parent: string | null;
  /** The level's standalone SVG (give each view a distinct gridId). */
  svg: string;
  /** data-el attribute → view key: which group opens what on click. */
  drills: Record<string, string>;
}

export interface MultiViewHtmlOptions {
  /** [0] must be the root view. */
  views: ViewEntry[];
  title: string;
  stops: string[];
  palette?: Partial<ExportPalette>;
  accent?: string;
  paths?: HtmlPathEntry[];
}

/**
 * The drill-down page: every level pre-rendered, a breadcrumb bar, hash
 * routing (`#/pay/workers` — display only; the embedded map is the source of
 * truth), Esc/Back navigation, and the SAME timeline player scrubbing every
 * view in sync (elements carry the same `data-el`/`data-day` on each level
 * they appear on).
 *
 * Composed THROUGH `buildTimelineHtml` at three stable seams — the stage
 * content, the `</style>` close, and the `</body>` close — so the pinned
 * single-view page stays byte-identical and there is exactly one copy of the
 * player.
 */
export function buildMultiViewHtml(opts: MultiViewHtmlOptions): string {
  const palette: ExportPalette = { ...DARK_EXPORT_PALETTE, ...opts.palette };
  const accent = opts.accent ?? (isLightHex(palette.bg) ? "#0284c7" : "#38bdf8");

  const sections = opts.views
    .map(
      (view, i) =>
        `<section class="bd-view" data-view="${esc(view.key)}"${i === 0 ? "" : " hidden"}>\n${view.svg}\n</section>`,
    )
    .join("\n");

  const navCss = `
  .bd-crumbbar {
    display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
    padding: 6px 14px; border-bottom: 1px solid ${palette.border}; background: ${palette.surface};
  }
  .bd-crumb {
    max-width: 200px; overflow: hidden; padding: 2px 6px; border: 0; border-radius: 5px;
    background: none; color: ${palette.textDim}; font: inherit; font-size: 12px;
    text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
  }
  .bd-crumb:hover:not(:disabled) { background: ${palette.surface2}; color: ${palette.text}; }
  .bd-crumb--here { color: ${palette.text}; font-weight: 600; cursor: default; }
  .bd-crumbsep { color: ${palette.textDim}; font-size: 12px; }
  .bd-levelpill {
    margin-left: 6px; padding: 2px 8px; border: 1px solid currentcolor; border-radius: 999px;
    color: ${accent}; font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 600;
    white-space: nowrap;
  }
  .bd-view[hidden] { display: none; }
  [data-drill] { cursor: pointer; }
  [data-drill]:hover { opacity: 0.85; }
  @media (prefers-reduced-motion: no-preference) {
    .bd-view { transition: transform 200ms ease, opacity 200ms ease; }
    .bd-view.bd-view--enter { transform: scale(0.94); opacity: 0; }
  }
  `;

  const crumbBar = `  <nav class="bd-crumbbar" id="bd-crumbbar" aria-label="Diagram level"></nav>
`;

  // Labels are user text: JSON is embedded in a <script>, so every "<" is
  // escaped to keep a hostile label from closing it.
  const viewsJson = JSON.stringify(
    Object.fromEntries(
      opts.views.map((v) => [
        v.key,
        { crumb: v.crumb, level: v.levelLabel, parent: v.parent, drills: v.drills },
      ]),
    ),
  ).replace(/</g, "\\u003c");

  const navJs = `
  "use strict";
  var VIEWS = ${viewsJson};
  var crumbbar = document.getElementById("bd-crumbbar");
  var sections = [].slice.call(document.querySelectorAll(".bd-view"));
  var current = "";
  function sectionOf(key) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getAttribute("data-view") === key) return sections[i];
    }
    return null;
  }
  function hashOf(key) {
    return "#/" + VIEWS[key].crumb.slice(1).map(function (c) { return encodeURIComponent(c.key); }).join("/");
  }
  var byHash = {};
  Object.keys(VIEWS).forEach(function (key) { byHash[hashOf(key)] = key; });
  function renderCrumbs() {
    var view = VIEWS[current];
    crumbbar.textContent = "";
    view.crumb.forEach(function (entry, i) {
      if (i > 0) {
        var sep = document.createElement("span");
        sep.className = "bd-crumbsep"; sep.textContent = "\\u203a";
        crumbbar.appendChild(sep);
      }
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bd-crumb" + (i === view.crumb.length - 1 ? " bd-crumb--here" : "");
      btn.disabled = i === view.crumb.length - 1;
      btn.textContent = entry.label;
      btn.addEventListener("click", function () { show(entry.key); });
      crumbbar.appendChild(btn);
    });
    var pill = document.createElement("span");
    pill.className = "bd-levelpill"; pill.textContent = view.level;
    crumbbar.appendChild(pill);
  }
  function show(key, fromHash) {
    if (!(key in VIEWS) || key === current) return;
    var inc = sectionOf(key);
    if (!inc) return;
    var out = sectionOf(current);
    if (out) out.hidden = true;
    inc.hidden = false;
    inc.classList.add("bd-view--enter");
    requestAnimationFrame(function () { inc.classList.remove("bd-view--enter"); });
    current = key;
    renderCrumbs();
    if (!fromHash && location.hash !== hashOf(key)) location.hash = hashOf(key);
  }
  window.addEventListener("hashchange", function () {
    var key = byHash[location.hash];
    if (key !== undefined) show(key, true);
  });
  document.addEventListener("keydown", function (e) {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "Escape") {
      var parent = VIEWS[current].parent;
      if (parent !== null) show(parent);
    }
  });
  sections.forEach(function (section) {
    var key = section.getAttribute("data-view");
    var drills = (VIEWS[key] || {}).drills || {};
    [].slice.call(section.querySelectorAll("[data-el]")).forEach(function (g) {
      var el = g.getAttribute("data-el");
      if (el in drills) {
        g.setAttribute("data-drill", "");
        g.addEventListener("click", function () { show(drills[el]); });
      }
    });
  });
  renderCrumbs();
  if (byHash[location.hash] !== undefined) show(byHash[location.hash], true);
  `;

  const page = buildTimelineHtml({
    svg: sections,
    title: opts.title,
    stops: opts.stops,
    palette: opts.palette,
    accent: opts.accent,
    paths: opts.paths,
  });

  return page
    .replace("</style>", `${navCss}</style>`)
    .replace('  <main class="bd-stage fit" id="bd-stage">', `${crumbBar}  <main class="bd-stage fit" id="bd-stage">`)
    .replace(
      "</body>",
      `<script>\n(function () {\n${navJs}\n})();\n</script>\n</body>`,
    );
}

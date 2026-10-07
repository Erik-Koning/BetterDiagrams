/**
 * html-tasks.ts — task graphs, live in the interactive HTML export.
 *
 * A task's corner check toggles in the page — the check, the strike, the
 * card's fade, and every check waiting on it (struck through while blocked,
 * open once it can be done) follow — and the People legend previews a person
 * on hover and focuses on them on click, as the editor does.
 *
 * The SVG carries every state a task can take as PARTS (`data-part` groups
 * under the node's own `data-el`, see `EmitOptions.taskHits`), stamped with
 * the export's state; the page only flips `data-on` / `data-done`. Who to
 * mute for each person is worked out HERE, per drawn level, with the same
 * stand-in rules the editor and the explorer use — the page just applies it.
 *
 * Checks can be kept. Every toggle is remembered in this browser; and where
 * the browser lets a page write a file the reader picks (Chrome, Edge), Save
 * writes them INTO this .html: it re-reads the file, swaps the one marked
 * state block, and writes it back — never the live page, whose runtime marks
 * would freeze into the file. Elsewhere Save downloads a copy with the
 * checks in. The export stays a snapshot: nothing here reaches the editor.
 *
 * DOM-free string building, like html-export.ts.
 */
import type { DiagramTemplate } from "../contract/schema";
import { isBoundaryNodeId, isGhostNodeId } from "../contract/schema";
import { MILESTONE_KIND, TASK_KIND, isTaskLink, isWorkItem, planProgress, taskRollups } from "../contract/tasks";
import { documentNodeId, keptOnCanvas, representatives } from "./path-view";
import type { ExplorerLevel } from "./html-explorer";
import type { ExportPalette } from "./draw";

/** Who recedes for one person on one drawn level, by the `data-el` its groups carry. */
export interface HtmlTaskPeopleView {
  /** Hover: the task cards that aren't theirs. */
  preview: Record<string, string[]>;
  /** Click: every node that isn't theirs (open frames, the boundary and zones never). */
  focusNodes: Record<string, string[]>;
  /** Click: every line that touches none of their tasks. */
  focusEdges: Record<string, string[]>;
}

export interface HtmlTaskData {
  /** A hash of the document — what a saved file must match before it is written. */
  exportId: string;
  /** The export's own file name, for when the page can't read its own. */
  fileName: string;
  /** The done tasks at export time — the state block's starting value. */
  done: string[];
  /** Every task and milestone: what the page recomputes Ready, Blocked, Reached and late from. */
  tasks: Record<
    string,
    { label: string; kind?: "milestone"; assignees: string[]; prereqs: string[]; points?: number; date?: string; stage?: string }
  >;
  /** Containers holding tasks: which tasks, and any capacity — their roll-ups. */
  rollups: Record<string, { tasks: string[]; capacity?: number }>;
  /** Each person's capacity, from `settings.capacity`. */
  capacity: Record<string, number>;
  /** Whether the plan estimates — counts read in points, else in tasks. */
  byPoints: boolean;
  /** The two inks a person's count can take: ordinary, and over capacity. */
  inks: { faint: string; warn: string };
  /** Per page level ("" is the root), the People legend's muting. */
  views: Record<string, HtmlTaskPeopleView>;
}

/** Whether a document has anything for this module to do: a task or a milestone. */
export function hasTasks(template: Pick<DiagramTemplate, "nodes">): boolean {
  return template.nodes.some(isWorkItem);
}

/** FNV-1a, 32 bits, hex — a stable fingerprint, not a secret. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Everything the page needs, from the document and the levels the export
 * draws (`htmlExplorerData().levels` — the root plus one per drillable node).
 */
export function htmlTaskData(
  template: DiagramTemplate,
  levels: Record<string, ExplorerLevel>,
  opts: { fileName: string; containerKinds?: readonly string[]; inks?: { faint: string; warn: string } },
): HtmlTaskData {
  const byId = new Map(template.nodes.map((n) => [n.id, n]));
  const containers = new Set(opts.containerKinds ?? ["group"]);
  const folded = template.settings?.groupContents === "hide";

  const tasks: HtmlTaskData["tasks"] = {};
  const byPerson = new Map<string, Set<string>>();
  for (const n of template.nodes) {
    if (!isWorkItem(n)) continue;
    tasks[n.id] = {
      label: n.label,
      ...(n.kind === MILESTONE_KIND ? { kind: "milestone" as const } : {}),
      assignees: n.kind === TASK_KIND ? (n.assignees ?? []) : [],
      prereqs: [],
      ...(n.storyPoints !== undefined ? { points: n.storyPoints } : {}),
      ...(n.date ? { date: n.date } : {}),
      ...(n.stage ? { stage: n.stage } : {}),
    };
    if (n.kind !== TASK_KIND) continue;
    for (const name of n.assignees ?? []) {
      if (!byPerson.has(name)) byPerson.set(name, new Set());
      byPerson.get(name)!.add(n.id);
    }
  }
  // What each task waits on — the same lines `blockedTasks` reads.
  for (const e of template.edges) {
    if (e.source === e.target || !isTaskLink(e)) continue;
    const to = tasks[e.target];
    if (!tasks[e.source] || !to || to.prereqs.includes(e.source)) continue;
    to.prereqs.push(e.source);
  }

  const edgeById = new Map(template.edges.map((e) => [e.id, e]));
  const views: HtmlTaskData["views"] = {};
  for (const [key, level] of Object.entries(levels)) {
    const reps = representatives(template, level.nodes);
    // The nodes that can recede: not a zone, not the boundary frame, not an
    // open frame (it never dims on the canvas — its children do, each for
    // itself). A chip and a ghost are cards, and recede like one.
    const leaves: Array<{ el: string; docId: string }> = [];
    for (const canvasId of level.nodes) {
      const docId = documentNodeId(canvasId);
      if (docId === null || isBoundaryNodeId(canvasId)) continue;
      const node = byId.get(docId);
      if (!node) continue;
      const openFrame = containers.has(node.kind as string) && !isGhostNodeId(canvasId) && !node.collapsed && !folded;
      if (!openFrame) leaves.push({ el: `node:${canvasId}`, docId });
    }
    // The document edges each drawn line stands for — the explorer's rule: a
    // line drawn between other boxes than its own ends bundles every edge
    // whose ends land on the same two.
    const byPair = new Map<string, string[]>();
    for (const e of template.edges) {
      const s = reps.get(e.source);
      const t = reps.get(e.target);
      if (s === undefined || t === undefined || s === t) continue;
      const pair = `${s}\u0000${t}`;
      const list = byPair.get(pair);
      if (list) list.push(e.id);
      else byPair.set(pair, [e.id]);
    }
    const lines = level.edges.map(([id, source, target]) => {
      const own = edgeById.get(id);
      const standIn = !own || own.source !== source || own.target !== target;
      return { el: `edge:${id}`, edges: standIn ? (byPair.get(`${source}\u0000${target}`) ?? []) : [id] };
    });

    const view: HtmlTaskPeopleView = { preview: {}, focusNodes: {}, focusEdges: {} };
    for (const [name, theirs] of byPerson) {
      view.preview[name] = leaves
        .filter(({ docId }) => byId.get(docId)?.kind === TASK_KIND && !theirs.has(docId))
        .map(({ el }) => el);
      const keep = keptOnCanvas(theirs, reps);
      view.focusNodes[name] = leaves.filter(({ docId }) => !keep.has(docId)).map(({ el }) => el);
      const touching = new Set(
        template.edges.filter((e) => theirs.has(e.source) || theirs.has(e.target)).map((e) => e.id),
      );
      view.focusEdges[name] = lines.filter((l) => !l.edges.some((id) => touching.has(id))).map((l) => l.el);
    }
    views[key] = view;
  }

  // Which tasks each container holds, at any depth — its roll-up.
  const rollups: HtmlTaskData["rollups"] = {};
  const byIdAll = new Map(template.nodes.map((n) => [n.id, n]));
  for (const [id, r] of taskRollups(template)) {
    const held: string[] = [];
    for (const n of template.nodes) {
      if (n.kind !== TASK_KIND) continue;
      let cursor = n.parentId ?? null;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        if (cursor === id) {
          held.push(n.id);
          break;
        }
        guard.add(cursor);
        cursor = byIdAll.get(cursor)?.parentId ?? null;
      }
    }
    rollups[id] = { tasks: held, ...(r.capacity !== undefined ? { capacity: r.capacity } : {}) };
  }

  return {
    exportId: fingerprint(JSON.stringify(template)),
    fileName: opts.fileName,
    done: template.nodes.filter((n) => n.kind === TASK_KIND && n.done).map((n) => n.id).sort(),
    tasks,
    rollups,
    capacity: { ...(template.settings?.capacity ?? {}) },
    byPoints: planProgress(template).points > 0,
    inks: opts.inks ?? { faint: "#94a3b8", warn: "#fa8072" },
    views,
  };
}

/**
 * JSON that is safe inside a `<script>`: no `<` can open a tag or a comment,
 * and the two line terminators JavaScript once refused are escaped too.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The state-block markers. The page builds the same strings by concatenation, so each appears once in the file. */
const STATE_OPEN = "<!--bd-task-state-->";
const STATE_CLOSE = "<!--/bd-task-state-->";

/** The one block Save rewrites: the done tasks, and when they were last saved. */
export function htmlTaskStateBlock(data: HtmlTaskData): string {
  const state = { exportId: data.exportId, done: data.done, savedAt: 0 };
  return `${STATE_OPEN}<script type="application/json" id="bd-task-state">${scriptJson(state)}</script>${STATE_CLOSE}`;
}

export function htmlTaskCss(palette: ExportPalette, accent: string): string {
  return `
  /* ── Tasks: parts the page shows by state, the corner check, the People
     legend's mute. The parts hide unless on — and carry no display rule
     when on, so the scrubber's .bd-hidden still wins. ── */
  .bd-el[data-part]:not([data-on]) { display: none; }
  .bd-el[data-done] > :not(:first-child):not([data-x]):not([data-path]) { opacity: 0.55; }
  .bd-el[data-part] > [data-path] { display: none; }
  .bd-el[data-part^="check"] { cursor: pointer; outline: none; }
  .bd-el[data-part="check-blocked"] { cursor: not-allowed; }
  .bd-el[data-part^="check"]:focus-visible > circle { stroke: ${accent}; stroke-width: 2.5; }
  .bd-el[data-person] { cursor: pointer; outline: none; }
  .bd-el[data-person]:hover > path:first-child,
  .bd-el[data-person]:focus-visible > path:first-child { fill-opacity: 0.06; }
  .bd-el[data-person].bd-person-on > path:first-child { fill-opacity: 0.12; }
  .bd-pmute { filter: grayscale(1) opacity(0.4); }
  .bd-pmute:hover { filter: none; }
  .bd-pmute-edge { filter: opacity(0.25); }
  .bd-taskstatus { font-size: 11px; color: ${palette.textDim}; white-space: nowrap; }
  .bd-taskstatus:empty { display: none; }
  #bd-task-save[hidden] { display: none; }`;
}

export const htmlTaskMarkup = `
    <span class="bd-taskstatus" id="bd-task-status" aria-live="polite"></span>
    <button class="bd-btn" id="bd-task-save" title="Keep your checks in this file" hidden>Save to file…</button>`;

/**
 * The page's task script. Hand-written vanilla JS, no bundle. It must never
 * contain the sequences that end a script or open a comment in HTML — the
 * markers are built by concatenation, and `<\/script>` is escaped.
 */
const TASK_JS = `
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var DATA = JSON.parse($("bd-task-data").textContent);
  var fileState = JSON.parse($("bd-task-state").textContent);
  var TASKS = DATA.tasks;
  var OPEN = "<!-" + "-bd-task-state-" + "->", CLOSE = "<!-" + "-/bd-task-state-" + "->";
  var pageName = "";
  try { pageName = decodeURIComponent(location.pathname.split("/").pop() || ""); } catch (e) {}
  if (!pageName) pageName = DATA.fileName;
  var KEY = "bd-tasks:" + location.pathname + ":" + DATA.exportId;

  // ── State: the file's block, unless this browser holds newer checks. ──
  var done = {};
  (fileState.done || []).forEach(function (id) { done[id] = true; });
  var savedAt = fileState.savedAt || 0, updatedAt = savedAt;
  function doneList() { return Object.keys(done).filter(function (id) { return done[id] && TASKS[id]; }).sort(); }
  function readStore() { try { var raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function writeStore() { try { localStorage.setItem(KEY, JSON.stringify({ done: doneList(), updatedAt: updatedAt })); } catch (e) {} }
  var stored = readStore();
  if (stored && Array.isArray(stored.done) && stored.updatedAt > savedAt) {
    done = {};
    stored.done.forEach(function (id) { done[id] = true; });
    updatedAt = stored.updatedAt;
  }

  // ── The task groups: a body, and the parts that show its state. ──
  function docOf(el) { var id = el.slice(5); return id.indexOf("ghost:") === 0 ? id.slice(6) : id; }
  var bodies = [], parts = [];
  [].slice.call(document.querySelectorAll('.bd-el[data-el^="node:"]')).forEach(function (g) {
    var id = docOf(g.getAttribute("data-el"));
    if (!TASKS[id]) return;
    if (g.hasAttribute("data-part")) parts.push({ g: g, id: id, part: g.getAttribute("data-part") });
    else bodies.push({ g: g, id: id });
  });
  function flag(g, name, on) { if (on) g.setAttribute(name, ""); else g.removeAttribute(name); }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  var TODAY = todayIso();
  // A task is finished when checked; a milestone when everything feeding it is.
  var reachedMemo = {};
  function finished(id) {
    var t = TASKS[id];
    if (!t) return false;
    if (t.kind !== "milestone") return !!done[id];
    if (id in reachedMemo) return reachedMemo[id];
    reachedMemo[id] = false; // a loop is never reached
    var p = t.prereqs, all = p.length > 0;
    for (var i = 0; i < p.length; i++) if (!finished(p[i])) { all = false; break; }
    reachedMemo[id] = all;
    return all;
  }
  function blocked(id) {
    if (finished(id)) return false;
    var p = TASKS[id].prereqs;
    for (var i = 0; i < p.length; i++) if (!finished(p[i])) return true;
    return false;
  }
  function ready(id) { var t = TASKS[id]; return t.kind !== "milestone" && !done[id] && !t.stage && !blocked(id); }
  function late(id) { var t = TASKS[id]; return !!t.date && t.date < TODAY && !finished(id); }
  function isCheck(part) { return part === "check-open" || part === "check-done" || part === "check-blocked"; }
  /** "Blocked — waiting on Design, Infra", from what is unfinished now. */
  function waitingOn(id) {
    return "Blocked — waiting on " + TASKS[id].prereqs
      .filter(function (p) { return !finished(p); })
      .map(function (p) { return TASKS[p].label; })
      .join(", ");
  }
  function partOn(p) {
    switch (p.part) {
      case "check-open": return !done[p.id] && !blocked(p.id);
      case "check-blocked": return blocked(p.id);
      case "check-done": case "strike": return !!done[p.id];
      case "stage": return !done[p.id];
      case "reached": return finished(p.id);
      case "due": return !late(p.id);
      case "due-late": return late(p.id);
      default: return true;
    }
  }
  // Rewrite a bar drawn at "x,y,w,h" to a fraction of its width.
  function rr(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return "M " + (x + r) + " " + y + " H " + (x + w - r) + " A " + r + " " + r + " 0 0 1 " + (x + w) + " " + (y + r) +
      " V " + (y + h - r) + " A " + r + " " + r + " 0 0 1 " + (x + w - r) + " " + (y + h) + " H " + (x + r) +
      " A " + r + " " + r + " 0 0 1 " + x + " " + (y + h - r) + " V " + (y + r) + " A " + r + " " + r + " 0 0 1 " + (x + r) + " " + y + " Z";
  }
  function setBar(g, path, frac) {
    var geom = (g.getAttribute("data-bar") || "").split(",").map(Number);
    if (geom.length !== 4 || !path) return;
    path.setAttribute("d", rr(geom[0], geom[1], Math.max(0.01, geom[2] * frac), geom[3], geom[3] / 2));
  }
  function tally(ids) {
    var t = 0, d = 0, pts = 0, dpts = 0;
    ids.forEach(function (id) {
      var task = TASKS[id];
      if (!task || task.kind === "milestone") return;
      var p = task.points || 0;
      t += 1; pts += p;
      if (done[id]) { d += 1; dpts += p; }
    });
    return { label: pts > 0 ? dpts + "/" + pts + " pts" : d + "/" + t + " tasks", frac: pts > 0 ? dpts / pts : t ? d / t : 0 };
  }
  var rollupParts = [].slice.call(document.querySelectorAll('.bd-el[data-part="rollup"]'));
  var planRows = [].slice.call(document.querySelectorAll(".bd-el[data-plan]"));
  function render() {
    reachedMemo = {};
    bodies.forEach(function (b) { flag(b.g, "data-done", TASKS[b.id].kind !== "milestone" && !!done[b.id]); });
    parts.forEach(function (p) {
      flag(p.g, "data-on", partOn(p));
      if (!isCheck(p.part)) return;
      p.g.setAttribute("aria-checked", done[p.id] ? "true" : "false");
      // A blocked check names what it waits on — to a screen reader, and on
      // hover through an SVG <title>, the only tooltip a group can carry.
      if (p.part === "check-blocked") {
        var why = waitingOn(p.id), tip = p.g.querySelector("title");
        if (!tip) tip = p.g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title"));
        tip.textContent = why;
        p.g.setAttribute("aria-label", TASKS[p.id].label + " — " + why);
      }
    });
    // Roll-ups, the Plan row and each person's open work, recounted.
    rollupParts.forEach(function (g) {
      var r = DATA.rollups[docOf(g.getAttribute("data-el"))];
      if (!r) return;
      var t = tally(r.tasks), paths = g.querySelectorAll("path"), texts = g.querySelectorAll("text");
      setBar(g, paths[2], t.frac);
      if (texts[0]) texts[0].textContent = t.label + (r.capacity != null ? " · cap " + r.capacity : "");
    });
    var all = Object.keys(TASKS);
    planRows.forEach(function (g) {
      var t = tally(all), paths = g.querySelectorAll("path"), texts = g.querySelectorAll("text");
      var nReady = 0, nBlocked = 0, nLate = 0;
      all.forEach(function (id) {
        if (TASKS[id].kind === "milestone") return;
        if (ready(id)) nReady += 1;
        if (blocked(id)) nBlocked += 1;
        if (late(id)) nLate += 1;
      });
      var states = [nReady ? nReady + " READY" : "", nBlocked ? nBlocked + " BLOCKED" : "", nLate ? nLate + " OVERDUE" : ""]
        .filter(Boolean).join(" · ");
      if (g.hasAttribute("data-bar")) { setBar(g, paths[1], t.frac); if (texts[0]) texts[0].textContent = t.label; }
      var last = texts[texts.length - 1];
      if (last && (!g.hasAttribute("data-bar") || texts.length > 1)) last.textContent = states;
    });
    rows.forEach(function (r) {
      var name = personOf(r), texts = r.querySelectorAll("text"), count = texts[texts.length - 1];
      if (!count) return;
      var openTasks = 0, openPoints = 0;
      all.forEach(function (id) {
        var task = TASKS[id];
        if (task.assignees.indexOf(name) < 0 || done[id]) return;
        openTasks += 1; openPoints += task.points || 0;
      });
      var held = DATA.byPoints ? openPoints : openTasks, cap = DATA.capacity[name];
      count.textContent = (DATA.byPoints && cap != null ? held + "/" + cap : String(held)) + (DATA.byPoints ? " pts" : "");
      var over = cap != null && openPoints > cap;
      count.setAttribute("fill", over ? DATA.inks.warn : DATA.inks.faint);
      flag(count, "font-weight", false);
      if (over) count.setAttribute("font-weight", "700");
    });
  }
  parts.forEach(function (p) {
    if (!isCheck(p.part)) return;
    p.g.setAttribute("tabindex", "0");
    p.g.setAttribute("role", "checkbox");
    p.g.setAttribute("aria-label", TASKS[p.id].label + " — done");
    if (p.part === "check-blocked") p.g.setAttribute("aria-disabled", "true");
  });
  function toggle(id, from) {
    // A task waiting on unfinished work can't be checked yet.
    if (!done[id] && blocked(id)) return;
    if (done[id]) delete done[id]; else done[id] = true;
    updatedAt = Date.now();
    render();
    writeStore();
    // The check just pressed is hidden now; keep the keyboard on its twin.
    if (from && document.activeElement === from) {
      var twin = parts.filter(function (p) { return p.id === id && isCheck(p.part) && p.g !== from && partOn(p) && p.g.parentNode === from.parentNode; })[0];
      if (twin && twin.g.focus) twin.g.focus();
    }
    afterChange();
  }

  // ── People: hover previews a person, click focuses on them. ──
  var roots = {};
  var sections = [].slice.call(document.querySelectorAll("section.bd-view"));
  if (sections.length) sections.forEach(function (s) { roots[s.getAttribute("data-view")] = s; });
  else roots[""] = $("bd-stage");
  var groupsIn = {};
  Object.keys(roots).forEach(function (key) {
    var map = {};
    [].slice.call(roots[key].querySelectorAll(".bd-el[data-el]")).forEach(function (g) {
      var el = g.getAttribute("data-el");
      (map[el] = map[el] || []).push(g);
    });
    groupsIn[key] = map;
  });
  var rows = [].slice.call(document.querySelectorAll(".bd-el[data-person]"));
  function personOf(g) { return g.getAttribute("data-el").slice(7); }
  rows.forEach(function (r) {
    r.setAttribute("tabindex", "0");
    r.setAttribute("role", "button");
    r.setAttribute("aria-pressed", "false");
    r.setAttribute("aria-label", "Focus on " + personOf(r));
    r.addEventListener("pointerenter", function () { hovered = personOf(r); applyPeople(); });
    r.addEventListener("pointerleave", function () { if (hovered === personOf(r)) { hovered = null; applyPeople(); } });
  });
  var focused = null, hovered = null;
  function mute(key, list, cls) {
    (list || []).forEach(function (el) { (groupsIn[key][el] || []).forEach(function (g) { g.classList.add(cls); }); });
  }
  function applyPeople() {
    [].slice.call(document.querySelectorAll(".bd-pmute, .bd-pmute-edge")).forEach(function (g) {
      g.classList.remove("bd-pmute"); g.classList.remove("bd-pmute-edge");
    });
    var preview = hovered && hovered !== focused ? hovered : null;
    Object.keys(groupsIn).forEach(function (key) {
      var v = DATA.views[key];
      if (!v) return;
      if (preview) mute(key, v.preview[preview], "bd-pmute");
      else if (focused) { mute(key, v.focusNodes[focused], "bd-pmute"); mute(key, v.focusEdges[focused], "bd-pmute-edge"); }
    });
    rows.forEach(function (r) {
      var on = personOf(r) === focused;
      r.classList.toggle("bd-person-on", on);
      r.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function focusPerson(name) { focused = focused === name ? null : name; applyPeople(); }

  // A press on a check or a legend row is theirs alone: caught on the way
  // down, before the explorer's stage click (which would select or clear)
  // and the level navigator's drill.
  function target(e) { return e.target && e.target.closest ? e.target.closest(".bd-el[data-part], .bd-el[data-person]") : null; }
  document.addEventListener("click", function (e) {
    var t = target(e);
    if (!t) return;
    var part = t.getAttribute("data-part");
    if (part && !isCheck(part)) return;
    e.stopPropagation();
    e.preventDefault();
    var dropdown = $("bd-dropdown");
    if (dropdown) dropdown.hidden = true;
    if (part) toggle(docOf(t.getAttribute("data-el")), t);
    else focusPerson(personOf(t));
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key !== " " && e.key !== "Enter") return;
    var t = e.target;
    if (!t || !t.getAttribute || !t.classList || !t.classList.contains("bd-el")) return;
    var part = t.getAttribute("data-part");
    if (part && isCheck(part)) { e.preventDefault(); e.stopPropagation(); toggle(docOf(t.getAttribute("data-el")), t); }
    else if (t.hasAttribute("data-person")) { e.preventDefault(); e.stopPropagation(); focusPerson(personOf(t)); }
  }, true);

  // ── Keeping checks: this browser always; the file where the browser lets us. ──
  var saveBtn = $("bd-task-save"), statusEl = $("bd-task-status");
  var canPick = typeof window.showOpenFilePicker === "function";
  var handle = null, stashed = null, saving = false, again = false, timer = 0;
  function dirty() { return updatedAt > savedAt; }
  function status(message) {
    if (message !== undefined) statusEl.textContent = message;
    else if (!dirty()) statusEl.textContent = handle ? "Saved to " + handle.name : "";
    else statusEl.textContent = handle ? "Saving…" : "Unsaved changes — kept in this browser";
    saveBtn.hidden = !(dirty() && !handle);
    saveBtn.textContent = stashed && !handle ? "Save to " + stashed.name : "Save to file…";
  }
  function stateJson(state) {
    return JSON.stringify(state).replace(/</g, "\\\\u003c").replace(/\\u2028/g, "\\\\u2028").replace(/\\u2029/g, "\\\\u2029");
  }
  // Swap the one state block in a file's text — after checking the file IS
  // this export: exactly one block, and the same fingerprint.
  function withState(text) {
    var a = text.indexOf(OPEN), b = text.indexOf(CLOSE);
    if (a < 0 || b < a || text.indexOf(OPEN, a + 1) >= 0 || text.indexOf(CLOSE, b + 1) >= 0) {
      throw new Error("That file isn't this export — pick " + pageName);
    }
    var inner = text.slice(a + OPEN.length, b);
    var m = /id="bd-task-state">([\\s\\S]*?)<\\/script>/.exec(inner);
    var prior = null;
    try { prior = m && JSON.parse(m[1]); } catch (e) {}
    if (!prior || prior.exportId !== DATA.exportId) throw new Error("That file is a different export — pick " + pageName);
    var state = { exportId: DATA.exportId, done: doneList(), savedAt: updatedAt };
    var block = '<script type="application/json" id="bd-task-state">' + stateJson(state) + "<\\/script>";
    return text.slice(0, a) + OPEN + block + CLOSE + text.slice(b + CLOSE.length);
  }
  function save() {
    if (!handle) return;
    if (saving) { again = true; return; }
    saving = true;
    status();
    var at = updatedAt;
    handle.getFile()
      .then(function (f) { return f.text(); })
      .then(function (text) {
        var next = withState(text);
        return handle.createWritable().then(function (w) { return w.write(next).then(function () { return w.close(); }); });
      })
      .then(function () {
        savedAt = at;
        writeStore();
        saving = false;
        status();
        if (handle.name !== pageName) status("Saved to " + handle.name + " (a copy of this export)");
        if (again) { again = false; if (dirty()) save(); }
      })
      .catch(function (err) {
        saving = false;
        status("Couldn't save: " + ((err && err.message) || err));
      });
  }
  function afterChange() {
    status();
    if (handle) { clearTimeout(timer); timer = setTimeout(save, 400); }
    else if (stashed) reconnect();
  }
  // A file picked on an earlier visit: the press that changed something is
  // the gesture the browser wants before it lets the page write again.
  function reconnect() {
    var h = stashed;
    h.requestPermission({ mode: "readwrite" }).then(function (p) {
      if (p !== "granted") return;
      handle = h;
      save();
    }).catch(function () {});
  }
  function idb(fn) {
    try {
      var req = indexedDB.open("bd-task-files", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("files"); };
      req.onsuccess = function () { try { fn(req.result.transaction("files", "readwrite").objectStore("files")); } catch (e) {} };
    } catch (e) {}
  }
  if (canPick) idb(function (store) {
    var r = store.get(KEY);
    r.onsuccess = function () { if (r.result) { stashed = r.result; status(); } };
  });
  function pick() {
    status("Pick " + pageName + " to keep your checks in it");
    window.showOpenFilePicker({ multiple: false, types: [{ description: "This export", accept: { "text/html": [".html", ".htm"] } }] })
      .then(function (picked) {
        var h = picked[0];
        return h.requestPermission({ mode: "readwrite" }).then(function (p) {
          if (p !== "granted") throw new Error("The browser didn't allow saving to " + h.name);
          return h.getFile().then(function (f) { return f.text(); }).then(function (text) {
            withState(text); // the file must be this export before it is kept
            handle = h;
            stashed = h;
            idb(function (store) { store.put(h, KEY); });
            save();
          });
        });
      })
      .catch(function (err) {
        if (err && err.name === "AbortError") { status(); return; }
        status((err && err.message) || String(err));
      });
  }
  // No file access (Firefox, Safari): read the export the reader picks and
  // hand back a copy with the checks in, to put in its place.
  function downloadCopy() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,.htm,text/html";
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      f.text().then(function (text) {
        var next = withState(text);
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([next], { type: "text/html" }));
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        status("Downloaded " + f.name + " with your checks — replace the old file with it");
      }).catch(function (err) { status((err && err.message) || String(err)); });
    });
    input.click();
  }
  saveBtn.addEventListener("click", function () {
    if (stashed && !handle) reconnect();
    else if (canPick) pick();
    else downloadCopy();
  });

  render();
  status();

  // A page left open past midnight: what's overdue moves with the date. A
  // timer for the next midnight, and a look whenever the page is shown again
  // (a sleeping laptop's timer can wake late).
  function newDay() {
    var now = todayIso();
    if (now !== TODAY) { TODAY = now; render(); }
  }
  (function atMidnight() {
    var d = new Date(), next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    setTimeout(function () { newDay(); atMidnight(); }, next - d + 1000);
  })();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) newDay(); });
`;

/** The page's data block, the state block Save rewrites, and the task script. */
export function htmlTaskScripts(data: HtmlTaskData): string {
  const { done: _done, ...pageData } = data;
  return `<script type="application/json" id="bd-task-data">${scriptJson(pageData)}</script>
${htmlTaskStateBlock(data)}
<script>
(function () {
${TASK_JS}
})();
</script>
`;
}

/** Exposed for tests: the script must never contain what ends a script or opens a comment in HTML. */
export const HTML_TASK_SCRIPT = TASK_JS;

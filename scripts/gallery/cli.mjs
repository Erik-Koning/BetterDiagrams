/**
 * The gallery: draw the same documents with two versions of the code, or in
 * every arrangement the engine offers, look at them side by side, and record
 * which picture readers would ship — the data the layout linter is fitted to.
 *
 *   npm run gallery -- compare [--base main] [--only a,b] [--out name]
 *       Arrange every gallery document with the base ref's engine and with the
 *       working tree's, draw each in its own studio, and write a contact sheet.
 *   npm run gallery -- variants [--only a,b] [--out name]
 *       Every arrangement `layoutCandidates` offers for each document (and the
 *       real documents as authored), drawn by the working tree's studio.
 *   npm run gallery -- pairs <run> [--per 3] [--max 80] [--seed 1]
 *       Blind A/B pictures from a run, for reviewers; the key stays in the run.
 *   npm run gallery -- pick <run> <picks.txt> [--by reviewer]
 *       Record picks ("<pair> A|B|tie [reason,reason]" per line) in gallery/picks.jsonl.
 *   npm run gallery -- fit [--by name-prefix] [--write]
 *       Fit the linter's rule costs to the recorded picks (those of reviewers whose
 *       name starts with --by, if given) and report how often the linter agrees with
 *       readers, before and after, on picks it wasn't fitted to.
 *
 * Runs go to gallery/out/<name>/ (ignored by git). Nothing here touches the
 * repo's templates, a running dev server, or the network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { loadCorpus } from "./corpus.mjs";
import { loadEngine, REPO } from "./engine.mjs";
import { withStudio } from "./render.mjs";

const OUT = join(REPO, "gallery/out");
const DOCS = join(REPO, "gallery/docs");
const PICKS = join(REPO, "gallery/picks.jsonl");
/** Documents past this size are drawn but never stored for fitting. */
const STORE_LIMIT = 400_000;
/** The window's width: a pair shows each picture at the size a screen would. */
const SHOT_WIDTH = 1500;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at > 0 ? args[at + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const only = (flag("only", "") || "").split(",").filter(Boolean);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const git = (...cmd) => spawnSync("git", cmd, { cwd: REPO, encoding: "utf8" });
const hashOf = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

function summary(report) {
  const top = Object.entries(report.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([rule, n]) => `${rule} ${n}`)
    .join(", ");
  return { score: report.score, cost: Math.round(report.cost * 10) / 10, counts: report.counts, top, width: Math.round(report.metrics.width), height: Math.round(report.metrics.height) };
}

/** A worktree at `ref` that shares this checkout's installed packages. */
function checkoutAt(ref, scratch) {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`).stdout.trim();
  if (!sha) throw new Error(`no commit called ${ref}`);
  const dir = join(scratch, `checkout-${sha.slice(0, 8)}`);
  const made = git("worktree", "add", "--detach", "--quiet", dir, sha);
  if (made.status !== 0) throw new Error(made.stderr);
  for (const sub of ["node_modules", "packages/better-diagrams/node_modules", "packages/vscode/node_modules", "example/node_modules"]) {
    if (existsSync(join(REPO, sub)) && !existsSync(join(dir, sub))) symlinkSync(join(REPO, sub), join(dir, sub));
  }
  return { dir, sha, remove: () => git("worktree", "remove", "--force", dir) };
}

function sheet(run, title, rows, name = "sheet.html") {
  const cell = (c) =>
    c
      ? `<td><img src="${c.shot}"><div class="m"><b>${c.label}</b> · score ${c.metrics.score} · cost ${c.metrics.cost} · ${c.metrics.width}×${c.metrics.height}<br>${c.metrics.top || "nothing found"}</div></td>`
      : "<td></td>";
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:13px system-ui;margin:16px;background:#fff}table{border-collapse:collapse;width:100%}td{vertical-align:top;padding:6px;border-top:1px solid #ddd;width:50%}
img{width:100%;border:1px solid #eee}h2{font-size:15px;margin:18px 0 4px}.m{color:#444;margin-top:4px}</style>
<h1 style="font-size:18px">${title}</h1>
${rows.map((r) => `<h2>${r.name}</h2><table><tr>${r.cells.map(cell).join("")}</tr></table>`).join("\n")}`;
  const file = join(run, name);
  writeFileSync(file, html);
  return file;
}

async function compare() {
  const base = flag("base", "main");
  const run = join(OUT, flag("out", `compare-${stamp()}`));
  const scratch = mkdtempSync(join(tmpdir(), "bd-gallery-"));
  mkdirSync(join(run, "shots"), { recursive: true });
  mkdirSync(join(run, "docs"), { recursive: true });
  const head = await loadEngine(REPO, join(scratch, "engine-head"));
  const corpus = loadCorpus(head, only);
  const ref = checkoutAt(base, scratch);
  try {
    const sides = [
      { key: "base", label: `${base} (${ref.sha.slice(0, 7)})`, checkout: ref.dir, engine: await loadEngine(ref.dir, join(scratch, "engine-base")) },
      { key: "head", label: "working tree", checkout: REPO, engine: head },
    ];
    const rows = corpus.map((c) => ({ name: c.name, cells: [] }));
    for (const side of sides) {
      const arranged = corpus.map((c) => side.engine.autoLayout(side.engine.validateTemplate(c.doc), { frames: "all" }));
      await withStudio(side.checkout, join(scratch, `studio-${side.key}`), async (studio) => {
        for (const [i, c] of corpus.entries()) {
          const doc = arranged[i];
          const file = `${c.name}__${side.key}`;
          writeFileSync(join(run, "docs", `${file}.json`), JSON.stringify(doc));
          await studio.shoot(doc, join(run, "shots", `${file}.png`), c.name);
          rows[i].cells.push({ label: side.label, shot: `shots/${file}.png`, doc: `docs/${file}.json`, metrics: summary(head.lintLayout(head.validateTemplate(doc))) });
          console.log(`${side.key} ${c.name}`);
        }
      });
    }
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ kind: "compare", base, sha: ref.sha, rows }, null, 1));
    const html = sheet(run, `Gallery: ${base} (left) against the working tree (right)`, rows);
    await shootSheet(html, run, scratch);
    report(rows);
    console.log(`\n${relative(REPO, html)}`);
  } finally {
    ref.remove();
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function variants() {
  const run = join(OUT, flag("out", `variants-${stamp()}`));
  const scratch = mkdtempSync(join(tmpdir(), "bd-gallery-"));
  mkdirSync(join(run, "shots"), { recursive: true });
  mkdirSync(join(run, "docs"), { recursive: true });
  try {
    const head = await loadEngine(REPO, join(scratch, "engine-head"));
    const corpus = loadCorpus(head, only);
    const rows = [];
    await withStudio(REPO, join(scratch, "studio"), async (studio) => {
      for (const c of corpus) {
        const placed = c.doc.nodes.some((n) => n.x || n.y);
        const options = [
          ...(placed ? [{ id: "authored", label: "As authored", template: c.doc }] : []),
          ...head.layoutCandidates(c.doc, { frames: "all" }).map((k) => ({ id: k.id, label: k.label, template: k.template })),
        ];
        const cells = [];
        for (const v of options) {
          const file = `${c.name}__${v.id}`;
          writeFileSync(join(run, "docs", `${file}.json`), JSON.stringify(v.template));
          await studio.shoot(v.template, join(run, "shots", `${file}.png`), c.name);
          cells.push({ label: v.label, variant: v.id, shot: `shots/${file}.png`, doc: `docs/${file}.json`, metrics: summary(head.lintLayout(v.template)) });
        }
        rows.push({ name: c.name, cells });
        console.log(`${c.name}: ${cells.length} arrangements`);
      }
    });
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ kind: "variants", rows }, null, 1));
    console.log(`\n${relative(REPO, sheet(run, "Gallery: every arrangement", rows))}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The contact sheet as PNG pages, a few documents each, for reading as images. */
async function shootSheet(html, run, scratch) {
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  const per = 3;
  await withStudio(REPO, join(scratch, "sheet-studio"), async (studio) => {
    for (let page = 0; page * per < manifest.rows.length; page += 1) {
      const file = sheet(run, `Page ${page + 1}`, manifest.rows.slice(page * per, page * per + per), "sheet-page.html");
      await studio.page(file, join(run, `sheet-${page + 1}.png`), 1600);
    }
  });
  rmSync(join(run, "sheet-page.html"), { force: true });
}

function report(rows) {
  console.log("\ndocument".padEnd(26), "score".padStart(12), "cost".padStart(16));
  for (const r of rows) {
    const [a, b] = r.cells;
    if (!a || !b) continue;
    const arrow = (x, y) => `${x} → ${y}`;
    console.log(r.name.padEnd(25), arrow(a.metrics.score, b.metrics.score).padStart(12), arrow(a.metrics.cost, b.metrics.cost).padStart(16));
  }
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

async function pairs() {
  const run = join(OUT, args[1] ?? "");
  if (!args[1] || !existsSync(join(run, "manifest.json"))) throw new Error("usage: gallery pairs <run>");
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  const per = Number(flag("per", 3));
  const max = Number(flag("max", 80));
  const random = rng(Number(flag("seed", 1)));
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  mkdirSync(join(run, "pairs"), { recursive: true });
  mkdirSync(DOCS, { recursive: true });
  const key = [];
  for (const row of manifest.rows) {
    const cells = row.cells.map((c) => ({ ...c, text: readFileSync(join(run, c.doc), "utf8") }));
    const options = [];
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const place = (t) => JSON.parse(t).nodes.map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`).join("|");
        if (place(cells[i].text) !== place(cells[j].text)) options.push([cells[i], cells[j]]);
      }
    }
    for (const [x, y] of shuffle(options).slice(0, per)) {
      const [a, b] = random() < 0.5 ? [x, y] : [y, x];
      const id = `p${String(key.length + 1).padStart(3, "0")}`;
      const store = (cell) => {
        const hash = hashOf(cell.text);
        if (cell.text.length <= STORE_LIMIT) writeFileSync(join(DOCS, `${hash}.json`), cell.text);
        return hash;
      };
      key.push({ id, doc: row.name, a: { variant: a.variant ?? a.label, hash: store(a), shot: a.shot }, b: { variant: b.variant ?? b.label, hash: store(b), shot: b.shot } });
    }
  }
  key.splice(max);
  const scratch = mkdtempSync(join(tmpdir(), "bd-gallery-"));
  try {
    await withStudio(REPO, join(scratch, "studio"), async (studio) => {
      for (const p of key) {
        const html = join(run, "pairs", `${p.id}.html`);
        // One above the other, each at the size the window shows it: side by side
        // each is shrunk to two thirds, and reviewers then mark down any picture
        // whose words are small, far more than someone at a screen would.
        writeFileSync(
          html,
          `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:600 22px system-ui;background:#fff}
.c{padding:8px 12px}.c img{display:block;width:${SHOT_WIDTH}px;border:2px solid #ccc}</style>
<div class="c">A<img src="../${p.a.shot}"></div><div class="c">B<img src="../${p.b.shot}"></div>`,
        );
        await studio.page(html, join(run, "pairs", `${p.id}.png`), SHOT_WIDTH + 28);
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(run, "pairs", "key.json"), JSON.stringify(key, null, 1));
  console.log(`${key.length} pairs in ${relative(REPO, join(run, "pairs"))}`);
}

function pick() {
  const run = join(OUT, args[1] ?? "");
  const file = args[2];
  if (!file || !existsSync(join(run, "pairs/key.json"))) throw new Error("usage: gallery pick <run> <picks.txt> [--by name]");
  const key = new Map(JSON.parse(readFileSync(join(run, "pairs/key.json"), "utf8")).map((p) => [p.id, p]));
  const by = flag("by", "reviewer");
  let n = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [id, choice, reasons = ""] = line.split(/\s+/);
    const p = key.get(id);
    const verdict = choice?.toLowerCase();
    if (!p || !["a", "b", "tie"].includes(verdict)) throw new Error(`can't read "${raw}"`);
    appendFileSync(
      PICKS,
      `${JSON.stringify({ pair: id, run: basename(run), doc: p.doc, a: p.a.hash, b: p.b.hash, aVariant: p.a.variant, bVariant: p.b.variant, pick: verdict, reasons: reasons.split(",").filter(Boolean), by, at: new Date().toISOString() })}\n`,
    );
    n += 1;
  }
  console.log(`${n} picks recorded in ${relative(REPO, PICKS)}`);
}

async function fit() {
  const { fitCommand } = await import("./fit.mjs");
  await fitCommand({ write: has("write"), by: flag("by", "") });
}

const commands = { compare, variants, pairs, pick, fit };
if (!commands[command]) {
  console.error("usage: npm run gallery -- compare|variants|pairs|pick|fit  (see scripts/gallery/cli.mjs)");
  process.exit(2);
}
await commands[command]();

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
 *       Record picks ("<pair> A|B|tie reason,reason" per line, the reasons optional) in
 *       gallery/picks.jsonl. One reviewer's pick of one pair is recorded once: give each
 *       reviewer their own --by, and recording a file again adds nothing.
 *   npm run gallery -- fit [--by name-prefix] [--write]
 *       Fit the linter's rule costs to the recorded picks (those of reviewers whose
 *       name starts with --by, if given) and report how often the linter agrees with
 *       readers, before and after, on picks it wasn't fitted to.
 *
 * Runs go to gallery/out/<name>/ (ignored by git). Nothing here touches the
 * repo's templates, a running dev server, or the network. The worktree and the
 * scratch folder a run makes are removed however it ends, an error or ctrl-C
 * included.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadCorpus } from "./corpus.mjs";
import { loadEngine, REPO } from "./engine.mjs";
import { choosePairs, countFlag, escapeHtml, flagValue, newPicks, parsePicks, runName } from "./pairing.mjs";
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
const flag = (name, fallback) => flagValue(args, name, fallback);
const has = (name) => args.includes(`--${name}`);
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

/**
 * What a run has made outside gallery/out and has to take away again: a
 * scratch folder, a worktree. Undone last-made first when the run ends, and
 * when it is interrupted, since a `finally` never runs on ctrl-C.
 */
const leftovers = [];
function tidyUp() {
  while (leftovers.length) {
    try {
      leftovers.pop()();
    } catch {
      // One thing that won't go mustn't keep the rest.
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    tidyUp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** A scratch folder that goes when the run does. */
function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "bd-gallery-"));
  leftovers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A worktree at `ref` that shares this checkout's installed packages. */
function checkoutAt(ref, scratch) {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`).stdout.trim();
  if (!sha) throw new Error(`no commit called ${ref}`);
  const dir = join(scratch, `checkout-${sha.slice(0, 8)}`);
  // Registered before it is made: git may have put some of it down before failing.
  leftovers.push(() => {
    git("worktree", "remove", "--force", dir);
    git("worktree", "prune");
  });
  const made = git("worktree", "add", "--detach", "--quiet", dir, sha);
  if (made.status !== 0) throw new Error(made.stderr);
  for (const sub of ["node_modules", "packages/better-diagrams/node_modules", "packages/vscode/node_modules", "example/node_modules"]) {
    if (existsSync(join(REPO, sub)) && !existsSync(join(dir, sub))) symlinkSync(join(REPO, sub), join(dir, sub));
  }
  return { dir, sha };
}

function sheet(run, title, rows, name = "sheet.html") {
  const cell = (c) =>
    c
      ? `<td><img src="${escapeHtml(c.shot)}"><div class="m"><b>${escapeHtml(c.label)}</b> · score ${c.metrics.score} · cost ${c.metrics.cost} · ${c.metrics.width}×${c.metrics.height}<br>${escapeHtml(c.metrics.top || "nothing found")}</div></td>`
      : "<td></td>";
  // A ref, a document's name and a label are whatever someone called them.
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:13px system-ui;margin:16px;background:#fff}table{border-collapse:collapse;width:100%}td{vertical-align:top;padding:6px;border-top:1px solid #ddd;width:50%}
img{width:100%;border:1px solid #eee}h2{font-size:15px;margin:18px 0 4px}.m{color:#444;margin-top:4px}</style>
<h1 style="font-size:18px">${escapeHtml(title)}</h1>
${rows.map((r) => `<h2>${escapeHtml(r.name)}</h2><table><tr>${r.cells.map(cell).join("")}</tr></table>`).join("\n")}`;
  const file = join(run, name);
  writeFileSync(file, html);
  return file;
}

async function compare() {
  const base = flag("base", "main");
  const only = flag("only", "").split(",").filter(Boolean);
  const run = join(OUT, runName(flag("out", `compare-${stamp()}`)));
  const scratch = scratchDir();
  try {
    mkdirSync(join(run, "shots"), { recursive: true });
    mkdirSync(join(run, "docs"), { recursive: true });
    const head = await loadEngine(REPO, join(scratch, "engine-head"));
    const corpus = loadCorpus(head, only);
    const ref = checkoutAt(base, scratch);
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
    tidyUp();
  }
}

async function variants() {
  const only = flag("only", "").split(",").filter(Boolean);
  const run = join(OUT, runName(flag("out", `variants-${stamp()}`)));
  const scratch = scratchDir();
  try {
    mkdirSync(join(run, "shots"), { recursive: true });
    mkdirSync(join(run, "docs"), { recursive: true });
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
    tidyUp();
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

async function pairs() {
  if (!args[1] || args[1].startsWith("--")) throw new Error("usage: gallery pairs <run> [--per 3] [--max 80] [--seed 1]");
  const run = join(OUT, runName(args[1]));
  if (!existsSync(join(run, "manifest.json"))) throw new Error(`no run called ${args[1]} in ${relative(REPO, OUT)}`);
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  const rows = manifest.rows.map((row) => ({
    name: row.name,
    cells: row.cells.map((c) => ({ ...c, text: readFileSync(join(run, c.doc), "utf8") })),
  }));
  // Chosen, and cut to --max, before anything is stored: gallery/docs is kept
  // in git, and a document no pair shows has no business there.
  const chosen = choosePairs(rows, { per: countFlag(args, "per", 3), max: countFlag(args, "max", 80), seed: countFlag(args, "seed", 1) });
  mkdirSync(join(run, "pairs"), { recursive: true });
  mkdirSync(DOCS, { recursive: true });
  const store = (cell) => {
    const hash = hashOf(cell.text);
    if (cell.text.length <= STORE_LIMIT) writeFileSync(join(DOCS, `${hash}.json`), cell.text);
    return hash;
  };
  const key = chosen.map((p) => ({
    id: p.id,
    doc: p.doc,
    a: { variant: p.a.variant ?? p.a.label, hash: store(p.a), shot: p.a.shot },
    b: { variant: p.b.variant ?? p.b.label, hash: store(p.b), shot: p.b.shot },
  }));
  const scratch = scratchDir();
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
<div class="c">A<img src="../${escapeHtml(p.a.shot)}"></div><div class="c">B<img src="../${escapeHtml(p.b.shot)}"></div>`,
        );
        await studio.page(html, join(run, "pairs", `${p.id}.png`), SHOT_WIDTH + 28);
      }
    });
  } finally {
    tidyUp();
  }
  writeFileSync(join(run, "pairs", "key.json"), JSON.stringify(key, null, 1));
  console.log(`${key.length} pairs in ${relative(REPO, join(run, "pairs"))}`);
}

function pick() {
  const usage = "usage: gallery pick <run> <picks.txt> [--by name]";
  if (!args[1] || args[1].startsWith("--") || !args[2] || args[2].startsWith("--")) throw new Error(usage);
  const name = runName(args[1]);
  const run = join(OUT, name);
  if (!existsSync(join(run, "pairs/key.json"))) throw new Error(`no pairs in a run called ${name}: make them with \`gallery pairs ${name}\``);
  const key = new Map(JSON.parse(readFileSync(join(run, "pairs/key.json"), "utf8")).map((p) => [p.id, p]));
  const by = flag("by", "reviewer");
  // Every line is read before any is recorded, and what the record already has
  // is left out, so a file can be corrected and recorded again.
  const said = parsePicks(readFileSync(args[2], "utf8"), key, { run: name, by, at: new Date().toISOString() });
  const recorded = existsSync(PICKS) ? readFileSync(PICKS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const fresh = newPicks(said, recorded);
  if (fresh.length) appendFileSync(PICKS, fresh.map((p) => `${JSON.stringify(p)}\n`).join(""));
  const skipped = said.length - fresh.length;
  console.log(`${fresh.length} picks recorded in ${relative(REPO, PICKS)}${skipped ? `, ${skipped} left out (${by} had already picked those pairs)` : ""}`);
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
try {
  await commands[command]();
} catch (error) {
  // What went wrong, without a stack: these are mistakes in how it was asked.
  console.error(`gallery: ${error.message}`);
  process.exitCode = 1;
} finally {
  tidyUp();
}

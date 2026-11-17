/**
 * The disk store, end to end over real HTTP, against real folders: a linked
 * git repo with a Prettier config, links in and out of it, and the
 * standalone server's host and path checks. The browser half is the e2e
 * suite's (e2e/disk-sync.spec.ts).
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayOf, writeFileAtomic } from "./files";
import { formatDiagram, plainJson } from "./format";
import { createDiskStore, type DiskStore, type Listing, type TemplateEntry } from "./store";
import { startStandalone, type Standalone } from "./standalone";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const plan = (title: string, extra: Record<string, unknown> = {}) => ({
  version: 1,
  meta: { title },
  nodes: [{ id: "a", label: "A", kind: "service", x: 0, y: 0, w: 200, h: 84 }],
  edges: [],
  ...extra,
});

let root: string;
let home: string;
let repo: string;
let outside: string;
let app: string;

/** A repo the way a project keeps one: code, config, a diagram in docs/, build output git ignores. */
function makeRepo() {
  mkdirSync(join(repo, "docs", "arch"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "other-repo", version: "1.0.0" }));
  writeFileSync(join(repo, "tsconfig.json"), '{\n  // comments: not JSON.parse-able\n  "compilerOptions": {}\n}\n');
  writeFileSync(join(repo, "docs", "arch", "BetterDiagram.json"), JSON.stringify(plan("Payments architecture"), null, 2));
  writeFileSync(join(repo, "broken.json"), '{ "nodes": [ ');
  writeFileSync(join(repo, "dist", "built.json"), JSON.stringify(plan("Built")));
  writeFileSync(join(repo, ".gitignore"), "dist/\n");
  if (hasGit) execFileSync("git", ["init", "-q"], { cwd: repo });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bd-disk-")));
  home = join(root, "home");
  repo = join(root, "other-repo");
  outside = join(root, "elsewhere");
  app = join(root, "app");
  for (const dir of [home, repo, outside, app]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(app, "index.html"), "<!doctype html><title>app</title>");
  makeRepo();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A store over node:http, the way a host mounts it. */
async function serve(store: DiskStore): Promise<{ base: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void store.handle(req, res).then((served) => {
      if (!served) res.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((done) => {
        store.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

const quiet = { info: () => {}, warn: () => {} };
const makeStore = (env: NodeJS.ProcessEnv = {}) =>
  createDiskStore({ dirs: { scratch: join(home, "scratch"), symlinks: join(home, "symlinks") }, linked: [repo], logger: quiet, env });

const route = (base: string, folder: string, file: string, target?: string) =>
  `${base}/__templates/${encodeURIComponent(folder)}/${encodeURIComponent(file)}${target ? `?target=${encodeURIComponent(target)}` : ""}`;
const put = (url: string, doc: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("linked folders", () => {
  it.skipIf(!hasGit)("list a repo's diagrams at any depth, leave its other JSON out, and skip what git ignores", async () => {
    const { base, close } = await serve(makeStore());
    try {
      const listing = (await (await fetch(`${base}/__templates`)).json()) as Listing;
      const link = listing.linked.find((l) => l.dir === repo)!;
      const rows = listing.templates.filter((t) => t.folder === link.folder);
      expect(rows.map((r) => [r.file, r.kind])).toEqual(
        expect.arrayContaining([
          ["docs/arch/BetterDiagram.json", "architecture"],
          ["broken.json", "unreadable"],
        ]),
      );
      expect(rows.find((r) => r.file === "docs/arch/BetterDiagram.json")?.name).toBe("Payments architecture");
      // package.json and the comment-y tsconfig: counted, not listed; dist/ is git-ignored.
      expect(rows).toHaveLength(2);
      expect(link.skipped).toBe(2);
    } finally {
      await close();
    }
  });

  it("address a nested file as one encoded segment, and never anything outside the folder", async () => {
    const store = makeStore();
    const { base, close } = await serve(store);
    try {
      const id = store.listing().linked[0].folder;
      const read = await fetch(route(base, id, "docs/arch/BetterDiagram.json"));
      expect(read.status).toBe(200);
      expect((await read.json()).meta.title).toBe("Payments architecture");
      for (const name of ["../escape.json", "docs/../../escape.json", ".git/config.json", "node_modules/x.json", "docs/.hidden/x.json"]) {
        expect((await put(route(base, id, name), plan("x"))).status, name).toBe(400);
      }
      // Never written over: a package.json, and never a folder that isn't there.
      expect((await put(route(base, id, "package.json"), plan("x"))).status).toBe(409);
      expect((await put(route(base, id, "gone/new.json"), plan("x"))).status).toBe(404);
      expect(readdirSync(repo)).not.toContain("gone");
    } finally {
      await close();
    }
  });
});

describe("writes", () => {
  it("are formatted by the repo's Prettier config, and plain where .prettierignore says so", async () => {
    writeFileSync(join(repo, ".prettierrc"), JSON.stringify({ useTabs: true }));
    const store = makeStore();
    const { base, close } = await serve(store);
    try {
      const id = store.listing().linked[0].folder;
      const file = join(repo, "docs", "arch", "BetterDiagram.json");
      const doc = plan("Formatted", { edges: [{ id: "e", source: "a", target: "a" }] });
      expect((await put(route(base, id, "docs/arch/BetterDiagram.json"), doc)).status).toBe(200);
      const text = readFileSync(file, "utf8");
      expect(text).toMatch(/^\t"version": 1,$/m);
      const prettier = await import("prettier");
      expect(text).toBe(await prettier.format(plainJson(doc), { useTabs: true, filepath: file }));

      writeFileSync(join(repo, ".prettierignore"), "docs/\n");
      expect((await put(route(base, id, "docs/arch/BetterDiagram.json"), doc)).status).toBe(200);
      expect(readFileSync(file, "utf8")).toBe(plainJson(doc));
    } finally {
      await close();
    }
  });

  it("without a Prettier config are plain JSON", async () => {
    const file = join(outside, "plain.json");
    expect(await formatDiagram(file, plan("Plain"))).toBe(plainJson(plan("Plain")));
  });

  it("replace the file whole, keep its mode, and go through a symlink rather than over it", () => {
    const target = join(outside, "target.json");
    const link = join(outside, "link.json");
    writeFileSync(target, "{}");
    chmodSync(target, 0o640);
    symlinkSync(target, link);
    writeFileAtomic(link, "{\"nodes\":[]}\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{\"nodes\":[]}\n");
    expect(statSync(target).mode & 0o777).toBe(0o640);
    // No temporary file left beside it.
    expect(readdirSync(outside).sort()).toEqual(["link.json", "target.json"]);
  });
});

describe("linked files", () => {
  it("answer only to the file they pointed at when bound — a link remade for another file is refused", async () => {
    const store = makeStore();
    const { base, close } = await serve(store);
    try {
      const [a, b] = ["a", "b"].map((sub) => {
        mkdirSync(join(outside, sub));
        const path = join(outside, sub, "BetterDiagram.json");
        writeFileSync(path, JSON.stringify(plan(`Plan ${sub}`)));
        return path;
      });
      const first = (await (await post(`${base}/__templates/symlinks`, { path: a })).json()).entry as TemplateEntry;
      expect(first).toMatchObject({ folder: "symlinks", file: "BetterDiagram.json", target: displayOf(a) });
      // The link goes (by hand, or a `git clean`), and B is linked: it takes the free name.
      unlinkSync(join(home, "symlinks", "BetterDiagram.json"));
      const second = (await (await post(`${base}/__templates/symlinks`, { path: b })).json()).entry as TemplateEntry;
      expect(second.file).toBe("BetterDiagram.json");

      // A page still bound to A is told, and never handed B — nor writes into it.
      const read = await fetch(route(base, "symlinks", "BetterDiagram.json", first.target));
      expect(read.status).toBe(409);
      expect(await read.json()).toMatchObject({ moved: true, target: displayOf(b) });
      expect((await put(route(base, "symlinks", "BetterDiagram.json", first.target), plan("Overwrite"))).status).toBe(409);
      expect(JSON.parse(readFileSync(b, "utf8")).meta.title).toBe("Plan b");
      // Bound to B, it reads and writes B.
      expect((await put(route(base, "symlinks", "BetterDiagram.json", second.target), plan("B, edited"))).status).toBe(200);
      expect(JSON.parse(readFileSync(b, "utf8")).meta.title).toBe("B, edited");
    } finally {
      await close();
    }
  });
});

describe("open file", () => {
  it("links a diagram it opens, and hands any other file back as a copy to read in", async () => {
    const { base, close } = await serve(makeStore());
    try {
      const open = (name: string, text: string) => {
        const path = join(outside, name);
        writeFileSync(path, text);
        return post(`${base}/__templates/symlinks`, { path, open: true });
      };
      // A diagram is linked, as Link a file… links it.
      const linked = await open("BetterDiagram.json", JSON.stringify(plan("Opened")));
      expect(linked.status).toBe(200);
      expect((await linked.json()).entry).toMatchObject({ folder: "symlinks", file: "BetterDiagram.json", target: displayOf(join(outside, "BetterDiagram.json")) });
      expect(lstatSync(join(home, "symlinks", "BetterDiagram.json")).isSymbolicLink()).toBe(true);

      // Anything else is the page's to read in: a schema script, a dbt
      // manifest, a React Flow export (converted, never edited in place), and
      // JSON that doesn't parse, which the page reports as it reads it.
      const sql = "create table customers (id int primary key);\n";
      const reactFlow = JSON.stringify({ nodes: [{ id: "n", position: { x: 0, y: 0 }, data: {} }], edges: [] });
      for (const [name, text] of [
        ["schema.sql", sql],
        ["manifest.json", JSON.stringify({ metadata: { dbt_schema_version: "v12" }, nodes: {} })],
        ["flow.json", reactFlow],
        ["broken.json", '{ "nodes": ['],
      ] as const) {
        const answer = await open(name, text);
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({ copy: { name, text } });
      }
      expect(readdirSync(join(home, "symlinks"))).toEqual(["BetterDiagram.json"]);

      expect((await post(`${base}/__templates/symlinks`, { path: join(outside, "nope.json"), open: true })).status).toBe(400);
      expect((await post(`${base}/__templates/symlinks`, { path: join(outside, "x.json"), open: true, create: plan("x") })).status).toBe(400);
    } finally {
      await close();
    }
  });

  it("asks its own dialog, for any file — and says when there is none", async () => {
    const picked = join(outside, "schema.sql");
    writeFileSync(picked, "create table t (id int);\n");
    const asked = await serve(makeStore({ BD_OPEN_PICKER: `printf '%s' '${picked}'` }));
    try {
      expect(((await (await fetch(`${asked.base}/__templates`)).json()) as Listing).openPicker).toBe(true);
      const answer = await post(`${asked.base}/__templates/symlinks`, { pick: true, open: true });
      expect((await answer.json()).copy).toMatchObject({ name: "schema.sql" });
    } finally {
      await asked.close();
    }
    const none = await serve(makeStore({ BD_OPEN_PICKER: "none" }));
    try {
      expect(((await (await fetch(`${none.base}/__templates`)).json()) as Listing).openPicker).toBe(false);
      expect(await (await post(`${none.base}/__templates/symlinks`, { pick: true, open: true })).json()).toEqual({ unsupported: true });
    } finally {
      await none.close();
    }
  });
});

describe("save as", () => {
  it("writes a new file elsewhere and links it; into a linked folder it binds there", async () => {
    const store = makeStore();
    const { base, close } = await serve(store);
    try {
      const away = await post(`${base}/__templates/save-as`, { path: join(outside, "Saved"), doc: plan("Saved") });
      expect(away.status).toBe(200);
      const entry = (await away.json()).entry as TemplateEntry;
      expect(entry).toMatchObject({ folder: "symlinks", file: "Saved.json", target: displayOf(join(outside, "Saved.json")), name: "Saved" });
      expect(lstatSync(join(home, "symlinks", "Saved.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(outside, "Saved.json"), "utf8")).meta.title).toBe("Saved");

      const inRepo = await post(`${base}/__templates/save-as`, { path: join(repo, "docs", "Context.json"), doc: plan("Context") });
      expect((await inRepo.json()).entry).toMatchObject({ folder: store.listing().linked[0].folder, file: "docs/Context.json" });
      // Bound to the linked folder, not linked a second time.
      expect(readdirSync(join(home, "symlinks"))).toEqual(["Saved.json"]);
    } finally {
      await close();
    }
  });

  it("finds the linked folder a new file lands in through a symlinked path, and announces its own write only as a save", async () => {
    // How macOS's /var is /private/var: the folder is linked by one path, the file saved by the other.
    const alias = join(root, "alias");
    symlinkSync(repo, alias);
    const events: unknown[] = [];
    const store = createDiskStore({
      dirs: { scratch: join(home, "scratch"), symlinks: join(home, "symlinks") },
      linked: [alias],
      logger: quiet,
      notify: (event, data) => events.push({ event, data }),
    });
    const { base, close } = await serve(store);
    try {
      const answer = await post(`${base}/__templates/save-as`, { path: join(repo, "docs", "New.json"), doc: plan("New") });
      expect((await answer.json()).entry).toMatchObject({ folder: store.listing().linked[0].folder, file: "docs/New.json" });
      expect(readdirSync(join(home, "symlinks"))).toEqual([]);
      // The store's own write is news to other pages only as a save, never as an outside edit, which
      // wins over anything. A file it has just made may not be announced at all: watching folder by
      // folder (Linux), the store starts watching it once it is written. No other page has it open.
      const at = { folder: store.listing().linked[0].folder, file: "docs/New.json" };
      await new Promise((done) => setTimeout(done, 600));
      expect(events.every((e) => (e as { data: { saved?: boolean } }).data.saved === true)).toBe(true);
      expect(events).not.toContainEqual({ event: "better-diagrams:template", data: at });
      // An edit made there is an outside edit.
      writeFileSync(join(repo, "docs", "New.json"), JSON.stringify(plan("New, edited there")));
      await expect.poll(() => events, { timeout: 5000 }).toContainEqual({ event: "better-diagrams:template", data: at });
    } finally {
      await close();
    }
  });

  it("never writes over a file that isn't a diagram, and over one that is only when told", async () => {
    const { base, close } = await serve(makeStore());
    try {
      const pkg = await post(`${base}/__templates/save-as`, { path: join(repo, "package.json"), doc: plan("x"), overwrite: true });
      expect(pkg.status).toBe(409);
      const existing = await post(`${base}/__templates/save-as`, { path: join(repo, "docs", "arch", "BetterDiagram.json"), doc: plan("x") });
      expect(existing.status).toBe(409);
      expect(await existing.json()).toMatchObject({ exists: true });
      expect(JSON.parse(readFileSync(join(repo, "docs", "arch", "BetterDiagram.json"), "utf8")).meta.title).toBe("Payments architecture");
      expect((await post(`${base}/__templates/save-as`, { path: join(outside, "x.yaml"), doc: plan("x") })).status).toBe(400);
      expect((await post(`${base}/__templates/save-as`, { path: join(home, "symlinks", "x.json"), doc: plan("x") })).status).toBe(400);
      expect((await post(`${base}/__templates/save-as`, { path: join(outside, "x.json"), doc: { not: "a diagram" } })).status).toBe(400);
      // A cross-site form post can't save anything.
      const crossSite = await fetch(`${base}/__templates/save-as`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ path: join(outside, "x.json"), doc: plan("x") }),
      });
      expect(crossSite.status).toBe(415);
    } finally {
      await close();
    }
  });

  it("asks the save dialog where, suggesting the name and folder", async () => {
    const env = { BD_SAVE_PICKER: `printf '%s' "$BD_PICK_NEAR/$BD_PICK_NAME"` };
    const { base, close } = await serve(makeStore(env));
    try {
      const answer = await post(`${base}/__templates/save-as`, { pick: true, name: "Picked.json", near: join(outside, "nope", "deeper"), doc: plan("Picked") });
      expect((await answer.json()).entry).toMatchObject({ folder: "symlinks", file: "Picked.json", target: displayOf(join(outside, "Picked.json")) });
    } finally {
      await close();
    }
  });
});

describe("new files", () => {
  const blank = { version: 1, nodes: [], edges: [] };

  it("are made where asked, titled after their name, and linked; a file already there is linked as it is", async () => {
    const store = makeStore();
    const { base, close } = await serve(store);
    try {
      const made = await post(`${base}/__templates/symlinks`, { path: join(outside, "BetterDiagram"), create: blank });
      expect(made.status).toBe(200);
      expect(await made.json()).toMatchObject({
        created: true,
        entry: { folder: "symlinks", file: "BetterDiagram.json", name: "BetterDiagram", target: displayOf(join(outside, "BetterDiagram.json")) },
      });
      expect(lstatSync(join(home, "symlinks", "BetterDiagram.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(outside, "BetterDiagram.json"), "utf8"))).toEqual({ ...blank, meta: { title: "BetterDiagram" } });

      // One there already is never written over — in a linked folder it binds there, as opening it would.
      const kept = join(repo, "docs", "arch", "BetterDiagram.json");
      const before = readFileSync(kept, "utf8");
      const there = await post(`${base}/__templates/symlinks`, { path: kept, create: blank });
      expect(await there.json()).toMatchObject({
        created: false,
        entry: { folder: store.listing().linked[0].folder, file: "docs/arch/BetterDiagram.json", name: "Payments architecture" },
      });
      expect(readFileSync(kept, "utf8")).toBe(before);
      expect(readdirSync(join(home, "symlinks"))).toEqual(["BetterDiagram.json"]);
    } finally {
      await close();
    }
  });

  it("are never made over a file that isn't a diagram, from something that isn't one, or by a re-link", async () => {
    const { base, close } = await serve(makeStore());
    try {
      const pkg = join(repo, "package.json");
      const before = readFileSync(pkg, "utf8");
      expect((await post(`${base}/__templates/symlinks`, { path: pkg, create: blank })).status).toBe(400);
      expect(readFileSync(pkg, "utf8")).toBe(before);
      expect((await post(`${base}/__templates/symlinks`, { path: join(outside, "x.json"), create: { not: "a diagram" } })).status).toBe(400);
      expect((await post(`${base}/__templates/symlinks`, { path: join(outside, "x.json"), create: blank, replaces: "x.json" })).status).toBe(400);
      expect((await post(`${base}/__templates/symlinks`, { path: join(home, "symlinks", "x.json"), create: blank })).status).toBe(400);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("ask the save dialog where, suggesting the name", async () => {
    const env = { BD_SAVE_PICKER: `printf '%s' "$BD_PICK_NEAR/$BD_PICK_NAME"` };
    const { base, close } = await serve(makeStore(env));
    try {
      const answer = await post(`${base}/__templates/symlinks`, { pick: true, create: blank, name: "diagram.json", near: outside });
      expect(await answer.json()).toMatchObject({ created: true, entry: { folder: "symlinks", file: "diagram.json", target: displayOf(join(outside, "diagram.json")) } });
    } finally {
      await close();
    }
  });
});

/**
 * A request as a browser sends one — `Origin`, `Sec-Fetch-Site`, the `Host`
 * it addressed — which fetch() here leaves out or fills in itself.
 */
function send(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const { port } = new URL(base);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("other origins", () => {
  it("are refused before anything is read, linked or written; the page the store serves is answered", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "the secret");
    const { base, close } = await serve(makeStore());
    const { host } = new URL(base);
    try {
      // The app's own requests: same-origin writes name the origin; a typed URL or a script names none.
      const own = { origin: base, "sec-fetch-site": "same-origin" };
      expect((await send(base, "GET", "/__templates", {})).status).toBe(200);
      expect((await send(base, "GET", "/__templates", { "sec-fetch-site": "none" })).status).toBe(200);
      expect((await send(base, "GET", "/__templates", { "sec-fetch-site": "same-origin" })).status).toBe(200);
      const opened = await send(base, "POST", "/__templates/symlinks", own, { open: true, path: secret });
      expect(opened.status).toBe(200);
      expect(JSON.parse(opened.body).copy.text).toBe("the secret");
      expect((await send(base, "PUT", "/__templates/scratch/mine.json", own, plan("Mine"))).status).toBe(200);

      // A page on another port of localhost — "same-site", not same-origin —
      // which a dev server's CORS lets in; and one on another site.
      const others: Array<Record<string, string>> = [
        { host: `localhost:${new URL(base).port}`, origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
        { origin: "http://localhost:3000" },
        { origin: `http://${host.replace("127.0.0.1", "localhost")}` },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        { origin: "null" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
      ];
      for (const headers of others) {
        const label = JSON.stringify(headers);
        const read = await send(base, "POST", "/__templates/symlinks", headers, { open: true, path: secret });
        expect(read.status, label).toBe(403);
        expect(read.body, label).not.toContain("the secret");
        expect(read.headers["access-control-allow-origin"], label).toBeUndefined();
        const saved = await send(base, "POST", "/__templates/save-as", headers, { path: join(outside, "planted.json"), doc: plan("Planted") });
        expect(saved.status, label).toBe(403);
        expect((await send(base, "GET", "/__templates", headers)).status, label).toBe(403);
        expect((await send(base, "PUT", "/__templates/scratch/planted.json", headers, plan("Planted"))).status, label).toBe(403);
        expect((await send(base, "POST", "/__templates/links", headers, { dir: outside })).status, label).toBe(403);
        // The preflight a JSON request needs is refused too.
        const preflight = await send(base, "OPTIONS", "/__templates/symlinks", { ...headers, "access-control-request-method": "POST" });
        expect(preflight.status, label).toBe(403);
        expect(preflight.headers["access-control-allow-origin"], label).toBeUndefined();
      }
      expect(readdirSync(outside)).toEqual(["secret.txt"]);
      expect(readdirSync(join(home, "scratch"))).toEqual(["mine.json"]);
      expect(readdirSync(join(home, "symlinks"))).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("guards", () => {
  it("never write over a file that doesn't read as a diagram, in any folder — repo folders included", async () => {
    const dirs = { scratch: join(home, "scratch"), examples: join(home, "examples"), symlinks: join(home, "symlinks") };
    const store = createDiskStore({ dirs, linked: [repo], logger: quiet });
    const { base, close } = await serve(store);
    try {
      // Mid hand-edit, empty, and JSON that isn't a diagram.
      const kept = {
        "examples/broken.json": '{ "nodes": [ {"id":"a","label":"hand edit in progress"}, ',
        "examples/empty.json": "",
        "examples/package.json": JSON.stringify({ name: "x" }),
        "scratch/broken.json": '{ "nodes": [ ',
      };
      for (const [path, text] of Object.entries(kept)) writeFileSync(join(home, path), text);
      for (const [path, text] of Object.entries(kept)) {
        const [folder, file] = path.split("/");
        const answer = await put(route(base, folder, file), plan("A stale copy"));
        expect(answer.status, path).toBe(409);
        expect((await answer.json()).error, path).toMatch(/not a diagram/);
        expect(readFileSync(join(home, path), "utf8"), path).toBe(text);
      }
      const id = store.listing().linked[0].folder;
      expect((await put(route(base, id, "broken.json"), plan("A stale copy"))).status).toBe(409);
      expect(readFileSync(join(repo, "broken.json"), "utf8")).toBe('{ "nodes": [ ');
      // A diagram is written over, and a file that isn't there yet is made.
      writeFileSync(join(home, "examples", "plan.json"), JSON.stringify(plan("Plan")));
      expect((await put(route(base, "examples", "plan.json"), plan("Plan, edited"))).status).toBe(200);
      expect(JSON.parse(readFileSync(join(home, "examples", "plan.json"), "utf8")).meta.title).toBe("Plan, edited");
      expect((await put(route(base, "scratch", "new.json"), plan("New"))).status).toBe(200);
      expect(JSON.parse(readFileSync(join(home, "scratch", "new.json"), "utf8")).meta.title).toBe("New");
    } finally {
      await close();
    }
  });

  it("never write through a symlinked file to outside its folder; one pointing inside is written", async () => {
    const dirs = { scratch: join(home, "scratch"), examples: join(home, "examples"), symlinks: join(home, "symlinks") };
    const store = createDiskStore({ dirs, linked: [repo], logger: quiet });
    const { base, close } = await serve(store);
    try {
      const target = join(outside, "other.json");
      const before = JSON.stringify(plan("Keep me"));
      writeFileSync(target, before);
      symlinkSync(target, join(repo, "z.json"));
      symlinkSync(target, join(home, "examples", "z.json"));
      const id = store.listing().linked[0].folder;
      expect((await put(route(base, id, "z.json"), plan("Through the link"))).status).toBe(403);
      expect((await put(route(base, "examples", "z.json"), plan("Through the link"))).status).toBe(403);
      expect(readFileSync(target, "utf8")).toBe(before);

      // A link to a diagram inside the folder is the folder's own file.
      symlinkSync(join(repo, "docs", "arch", "BetterDiagram.json"), join(repo, "alias.json"));
      expect((await put(route(base, id, "alias.json"), plan("Through an inside link"))).status).toBe(200);
      expect(JSON.parse(readFileSync(join(repo, "docs", "arch", "BetterDiagram.json"), "utf8")).meta.title).toBe("Through an inside link");
      expect(lstatSync(join(repo, "alias.json")).isSymbolicLink()).toBe(true);
    } finally {
      await close();
    }
  });

  it("name no folder by a key every object has", async () => {
    const { base, close } = await serve(makeStore());
    try {
      for (const folder of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"]) {
        const read = await fetch(route(base, folder, "a.json"));
        expect(read.status, folder).toBe(400);
        expect((await put(route(base, folder, "a.json"), plan("x"))).status, folder).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it("keep the folders linked from the app in the links file, written whole", async () => {
    const linksFile = join(home, "linked.json");
    const store = createDiskStore({ dirs: { scratch: join(home, "scratch") }, linksFile, logger: quiet });
    const { base, close } = await serve(store);
    try {
      expect((await post(`${base}/__templates/links`, { dir: outside })).status).toBe(200);
      expect(JSON.parse(readFileSync(linksFile, "utf8")).linked).toEqual([outside]);
      // No temporary file left beside it.
      expect(readdirSync(home).sort()).toEqual(["linked.json", "scratch"]);
      const id = store.listing().linked[0].folder;
      expect((await fetch(`${base}/__templates/links/${id}`, { method: "DELETE" })).status).toBe(200);
      expect(JSON.parse(readFileSync(linksFile, "utf8")).linked).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("standalone", () => {
  let running: Standalone | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  const raw = (port: number, path: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", fail);
      req.end();
    });

  it("serves the app and the store, answers only to its own host, and never serves outside the app", async () => {
    running = await startStandalone({ appDir: app, home, linked: [repo], port: 0, logger: quiet });
    const { port } = running;
    expect((await raw(port, "/")).body).toContain("<title>app</title>");
    expect((await raw(port, "/some/route")).body).toContain("<title>app</title>");
    expect((await raw(port, "/assets/missing.js")).status).toBe(404);
    expect(JSON.parse((await raw(port, "/api/ai")).body)).toEqual({ configured: false });
    expect((await raw(port, "/api/diagram")).status).toBe(404);
    writeFileSync(join(root, "secret.txt"), "secret");
    for (const path of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      const answer = await raw(port, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain("secret");
    }
    expect(JSON.parse((await raw(port, "/__templates")).body).events).toBe(true);
    // DNS rebinding: a page on another name, pointed at 127.0.0.1, gets nothing.
    expect((await raw(port, "/__templates", "evil.example")).status).toBe(403);
    expect((await raw(port, "/", `evil.example:${port}`)).status).toBe(403);
  });

  it("streams an outside edit to the page, and its own write only as a save", async () => {
    running = await startStandalone({ appDir: app, home, linked: [repo], port: 0, logger: quiet });
    const { port, url } = running;
    const id = running.store.listing().linked[0].folder;
    const events: string[] = [];
    const stream = request({ host: "127.0.0.1", port, path: "/__templates/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => events.push(chunk));
    });
    stream.end();
    try {
      await expect.poll(() => events.join("")).toContain("retry:");
      const file = join(repo, "docs", "arch", "BetterDiagram.json");
      writeFileSync(file, JSON.stringify(plan("Edited elsewhere"), null, 2));
      await expect
        .poll(() => events.join(""), { timeout: 5000 })
        .toContain(`"folder":"${id}","file":"docs/arch/BetterDiagram.json"`);
      events.length = 0;
      expect((await put(route(url, id, "docs/arch/BetterDiagram.json"), plan("Edited here"))).status).toBe(200);
      await expect.poll(() => events.join(""), { timeout: 5000 }).toContain(`"file":"docs/arch/BetterDiagram.json","saved":true`);
      await new Promise((done) => setTimeout(done, 300));
      const frames = events.join("").split("\n").filter((line) => line.startsWith("data: "));
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(JSON.parse(frame.slice(6))).toMatchObject({ saved: true });
    } finally {
      stream.destroy();
    }
  });
});

/**
 * vite-plugin-templates.js — the disk store behind auto-save.
 *
 * The editor keeps its workspace in localStorage, which is fine for a browser
 * but invisible everywhere else: you cannot read it, diff it, or commit it. A
 * few lines of dev middleware turn every open document into a real `.json`
 * file in the repo, so the diagrams you make while developing are ordinary
 * files — greppable, reviewable, and loadable back into the app.
 *
 * DEV ONLY, deliberately. `configureServer` runs for `vite dev` and nowhere
 * else, so a production build has no route to write with and the app quietly
 * does without it (see `templates.js` on the client). Nothing here should ever
 * ship in a bundle.
 *
 * The route is `/__templates` rather than `/api/...` because `/api` is proxied
 * to the AI server (vite.config.js) — a separate prefix keeps the two from
 * ever having to argue about ordering.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROUTE = "/__templates";

/** `Payments flow` → `payments-flow`. Empty (all punctuation) falls back. */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * A file name we are willing to touch. Two rules, both about not writing
 * outside the folder: the name is a plain slug, and the resolved path is still
 * inside `dir` after resolution (belt and braces against `..` games).
 */
function safePath(dir, name) {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) return null;
  const full = resolve(dir, name);
  return full.startsWith(resolve(dir) + sep) ? full : null;
}

function readBody(req) {
  return new Promise((resolve_, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // A diagram is never megabytes; refuse anything that large rather than
      // buffering it.
      if (size > 5_000_000) {
        reject(new Error("Template too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve_(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
};

/**
 * What the dropdown needs to list a file without opening it: its name, which
 * editor can render it, and when it last changed. The kind is sniffed from the
 * document's own shape — the same rule the welcome modal uses on pasted JSON —
 * so the files stay plain templates with nothing this app invented in them.
 */
function describe(dir, file) {
  const raw = readFileSync(join(dir, file), "utf8");
  const doc = JSON.parse(raw);
  return {
    file,
    name: typeof doc?.meta?.title === "string" && doc.meta.title.trim() ? doc.meta.title : file.replace(/\.json$/, ""),
    kind: Array.isArray(doc?.participants) ? "sequence" : "architecture",
    nodes: Array.isArray(doc?.nodes) ? doc.nodes.length : (doc?.participants?.length ?? 0),
    updated: statSync(join(dir, file)).mtimeMs,
  };
}

export function templatesPlugin({ dir }) {
  return {
    name: "better-diagrams-templates",
    configureServer(server) {
      mkdirSync(dir, { recursive: true });
      server.middlewares.use(ROUTE, async (req, res) => {
        // Inside `use(prefix, …)` the prefix is already stripped: "/" lists,
        // "/name.json" addresses one file.
        const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));

        try {
          if (req.method === "GET" && !name) {
            const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
            const listed = [];
            for (const file of files) {
              // One unreadable file must not take the whole list down —
              // hand-edited JSON is exactly what this folder invites.
              try {
                listed.push(describe(dir, file));
              } catch {
                listed.push({ file, name: file, kind: "unreadable", nodes: 0, updated: 0 });
              }
            }
            listed.sort((a, b) => b.updated - a.updated);
            return json(res, 200, { dir, templates: listed });
          }

          const full = safePath(dir, name);
          if (!full) return json(res, 400, { error: `Bad template name: ${name}` });

          if (req.method === "GET") {
            return json(res, 200, JSON.parse(readFileSync(full, "utf8")));
          }
          if (req.method === "PUT") {
            // The folder can vanish under a running server (a `git clean`, a
            // stray `rm -rf`); recreate it rather than failing every write
            // until someone restarts vite.
            mkdirSync(dir, { recursive: true });
            const body = await readBody(req);
            // Parse before writing: a malformed body should fail loudly here
            // rather than land a broken file in the repo.
            const doc = JSON.parse(body);
            writeFileSync(full, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
            return json(res, 200, { ok: true, file: name });
          }
          if (req.method === "DELETE") {
            rmSync(full, { force: true });
            return json(res, 200, { ok: true, file: name });
          }
          res.statusCode = 405;
          return res.end("Method not allowed");
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) });
        }
      });
      server.config.logger.info(`  ➜  templates:  ${dir}`, { timestamp: true });
    },
  };
}

/**
 * standalone.ts — the editor and its disk store, served together without
 * Vite: what `better-diagrams` runs, so any repo can open the diagrams it
 * keeps with no checkout of this one.
 *
 *   const { url, close } = await startStandalone({ appDir, home, linked: [process.cwd()] });
 *
 * The page is the built example app (`app/` in the package). The store's
 * scratch and symlinks folders live in `home` (`~/.better-diagrams`), and
 * changes reach the page as Server-Sent Events.
 *
 * Listens on 127.0.0.1 only, and answers only requests that name it as the
 * host: a page elsewhere that points its own domain at 127.0.0.1 (DNS
 * rebinding) would otherwise count as same-origin, and could read and write
 * files through the store.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createDiskStore, type DiskLogger, type DiskStore } from "./store";

export interface StandaloneOptions {
  /** The built editor: an index.html and its assets. */
  appDir: string;
  /** Where scratch/, symlinks/ and linked.json live. */
  home: string;
  /** Folders to link — the command line's. */
  linked?: string[];
  /** The port to try first; the next free one up to 20 above it is taken. Default 5199. */
  port?: number;
  logger?: DiskLogger;
}

export interface Standalone {
  url: string;
  port: number;
  store: DiskStore;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve a file of the built app — index.html for the root and any route the app owns. */
function serveApp(appDir: string, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("Bad path");
    return;
  }
  // No AI route here: the page asks, hears that none is configured, and keeps its AI panel off.
  if (pathname.startsWith("/api/")) {
    const status = pathname === "/api/ai" ? 200 : 404;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { configured: false } : { error: "No AI route in this server" }));
    return;
  }
  const root = resolve(appDir);
  let file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // A path with an extension that isn't there is a missing asset; anything else is the app.
    if (extname(pathname)) {
      res.writeHead(404).end("Not found");
      return;
    }
    file = join(root, "index.html");
  }
  const isIndex = file === join(root, "index.html");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    // Hashed assets never change under their name; the page that names them does.
    "cache-control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function listen(server: Server, port: number, tries: number): Promise<number> {
  return new Promise((done, fail) => {
    const attempt = (at: number, left: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && left > 0) attempt(at + 1, left - 1);
        else fail(error);
      };
      const onListening = () => {
        server.off("error", onError);
        // Port 0 asks for any free one: the one taken is the one to report.
        done((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(at, "127.0.0.1");
    };
    attempt(port, tries);
  });
}

export async function startStandalone({ appDir, home, linked = [], port = 5199, logger }: StandaloneOptions): Promise<Standalone> {
  if (!existsSync(join(appDir, "index.html"))) throw new Error(`No editor at ${appDir} — build it first (npm run build:app)`);
  const dirs = { scratch: join(home, "scratch"), symlinks: join(home, "symlinks") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const store = createDiskStore({ dirs, linked, linkedSource: "cli", linksFile: join(home, "linked.json"), logger });
  let bound = port;
  const allowed = () => new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const server = createServer((req, res) => {
    if (!allowed().has(req.headers.host ?? "")) {
      res.writeHead(403, { "content-type": "text/plain" }).end("This server answers only to 127.0.0.1 and localhost");
      return;
    }
    store
      .handle(req, res)
      .then((served) => {
        if (!served) serveApp(appDir, req, res);
      })
      .catch((error) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String((error as Error)?.message ?? error) }));
      });
  });
  bound = await listen(server, port, 20);
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    store,
    close: () =>
      new Promise((done) => {
        store.close();
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

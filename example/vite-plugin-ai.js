/**
 * vite-plugin-ai.js — the editor's AI route, served by the dev server itself,
 * so `npm run dev` is all it takes: the keys come from the environment Vite
 * was started in and never reach the browser.
 *
 *   GET  /api/ai       → which model answers, for the AI panel to say so
 *   POST /api/diagram  → a GenerateRequest in, the model's reply out
 *
 * The route is the library's `@mosphere/better-diagrams/server`, read from
 * source like the rest of the example so it needs no build (Vite bundles the
 * config and what it imports). `vite preview` serves it too.
 *
 * Only to this app's own page: a request from a page on another origin —
 * another site, or another port of localhost — is refused, so nothing else
 * running on this machine can spend the key.
 */
import { createDiagramRoute, serveAiRequest } from "../packages/better-diagrams/src/server/index.ts";

const ROUTES = new Set(["/api/ai", "/api/diagram"]);

/**
 * Does this request come from a page on another origin? The app's own are
 * same-origin: `Origin` (sent with every POST) names the host it addressed,
 * and `Sec-Fetch-Site` says same-origin. A script or `curl` sends neither.
 */
function fromAnotherOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return true;
  const { origin } = req.headers;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? "").toLowerCase();
  } catch {
    return true; // `null`: a sandboxed frame, a file:// page
  }
}

export function aiPlugin(env = process.env) {
  const route = createDiagramRoute({ env });
  const mount = (server) => {
    const { label, keyVar, gateway, off, models } = route.status();
    server.config.logger.info(
      off
        ? "  ➜  AI:      off (BD_AI=off)"
        : keyVar
          ? `  ➜  AI:      ${label} via ${keyVar}${gateway ? " (custom base URL)" : ""}, ${models.length} model${models.length === 1 ? "" : "s"} in the panel's picker`
          : "  ➜  AI:      no ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment — the AI panel stays off until one is set",
    );
    server.middlewares.use((req, res, next) => {
      if (ROUTES.has((req.url ?? "").split("?")[0]) && fromAnotherOrigin(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "The AI route answers only this app's own page." }));
        return;
      }
      serveAiRequest(route, req, res)
        .then((served) => {
          if (!served) next();
        })
        .catch(next);
    });
  };
  return { name: "better-diagrams-ai", configureServer: mount, configurePreviewServer: mount };
}

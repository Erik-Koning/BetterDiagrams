/**
 * server.mjs — the AI route on its own, for serving the built example
 * without Vite. `npm run dev` already answers it (vite-plugin-ai.js); this is
 * the same route over plain node:http, and the reference for a host's own.
 *
 *   npm run server -w example    # :8787, keys from the environment
 *
 * Which model answers is decided by the environment — ANTHROPIC_API_KEY first,
 * OPENAI_API_KEY as the fallback; see ai-route.mjs. The editor itself has no
 * provider code: it posts a GenerateRequest and parses the reply.
 */
import { createServer } from "node:http";
import { createDiagramRoute, sendJson, serveAiRequest } from "./ai-route.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const route = createDiagramRoute();

const server = createServer((req, res) => {
  serveAiRequest(route, req, res)
    .then((served) => {
      if (!served) sendJson(res, 404, { error: "Not found" });
    })
    .catch((err) => {
      console.error("[ai]", err);
      if (!res.writableEnded) sendJson(res, 500, { error: "Generation failed." });
    });
});

server.listen(PORT, () => {
  const { label, keyVar, gateway } = route.status();
  if (keyVar) {
    console.log(`AI route on http://localhost:${PORT}/api/diagram — ${label} via ${keyVar}${gateway ? " (custom base URL)" : ""}`);
  } else {
    console.warn("⚠  No ANTHROPIC_API_KEY or OPENAI_API_KEY is set — requests fail unless `ant auth login` saved a profile.\n");
    console.log(`AI route on http://localhost:${PORT}/api/diagram`);
  }
});

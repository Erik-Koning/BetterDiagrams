/**
 * server.mjs — the AI route on its own, over plain node:http: what a host's
 * own server looks like. `npm run dev` already answers the route
 * (vite-plugin-ai.js); this imports it the way another project would, from
 * the built package, so build the library first:
 *
 *   npm run build                # at the repo root
 *   npm run server -w example    # 127.0.0.1:8787, keys from the environment
 *
 * Which model answers is decided by the environment — ANTHROPIC_API_KEY first,
 * OPENAI_API_KEY as the fallback. The editor itself has no provider code: it
 * posts a GenerateRequest and parses the reply.
 *
 * It listens on 127.0.0.1 only, since every request it answers spends the
 * key: `HOST=0.0.0.0` (or an address of this machine) opens it to the
 * network — put your own auth in front first. `PORT` moves it.
 */
import { createServer } from "node:http";
import { createDiagramRoute, serveAiRequest } from "@mosphere/better-diagrams/server";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST || "127.0.0.1";
const route = createDiagramRoute();

const sendError = (res, status, error) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
};

const server = createServer((req, res) => {
  serveAiRequest(route, req, res)
    .then((served) => {
      if (!served) sendError(res, 404, "Not found");
    })
    .catch((err) => {
      console.error("[ai]", err);
      if (!res.writableEnded) sendError(res, 500, "Generation failed.");
    });
});

server.listen(PORT, HOST, () => {
  const { label, keyVar, gateway } = route.status();
  const at = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}/api/diagram`;
  if (keyVar) {
    console.log(`AI route on ${at} — ${label} via ${keyVar}${gateway ? " (custom base URL)" : ""}`);
  } else {
    console.warn("⚠  No ANTHROPIC_API_KEY or OPENAI_API_KEY is set — requests fail unless `ant auth login` saved a profile.\n");
    console.log(`AI route on ${at}`);
  }
});

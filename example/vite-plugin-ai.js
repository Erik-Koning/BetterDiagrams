/**
 * vite-plugin-ai.js — the editor's AI route, served by the dev server itself,
 * so `npm run dev` is all it takes: the keys come from the environment Vite
 * was started in (see ai-route.mjs for which variables it reads) and never
 * reach the browser.
 *
 *   GET  /api/ai       → which model answers, for the AI panel to say so
 *   POST /api/diagram  → a GenerateRequest in, the model's reply out
 *
 * `vite preview` serves it too.
 */
import { createDiagramRoute, serveAiRequest } from "./ai-route.mjs";

export function aiPlugin(env = process.env) {
  const route = createDiagramRoute(env);
  const mount = (server) => {
    const { label, keyVar, gateway, off } = route.status();
    server.config.logger.info(
      off
        ? "  ➜  AI:      off (BD_AI=off)"
        : keyVar
          ? `  ➜  AI:      ${label} via ${keyVar}${gateway ? " (custom base URL)" : ""}`
          : "  ➜  AI:      no ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment — the AI panel stays off until one is set",
    );
    server.middlewares.use((req, res, next) => {
      serveAiRequest(route, req, res)
        .then((served) => {
          if (!served) next();
        })
        .catch(next);
    });
  };
  return { name: "better-diagrams-ai", configureServer: mount, configurePreviewServer: mount };
}

/**
 * @mosphere/better-diagrams/server — the AI route for the editor's AI panel.
 *
 *   import { createDiagramRoute, serveAiRequest } from "@mosphere/better-diagrams/server";
 *   const route = createDiagramRoute();          // keys from process.env
 *   http.createServer((req, res) => serveAiRequest(route, req, res));
 *
 * The browser half is `createProxyGenerator({ endpoint: "/api/diagram" })` from the
 * contract, passed to the editor as `generate`. Install the provider SDK you
 * use — `@anthropic-ai/sdk` or `openai` — or pass `complete` with your own.
 */
export {
  resolveProvider,
  createCompleter,
  createDiagramRoute,
  RouteError,
} from "./ai-route";
export type {
  AiEnv,
  AiProvider,
  AiProviderName,
  AiRouteResult,
  AiRouteStatus,
  ChatMessage,
  Completer,
  CompletionRequest,
  DiagramRoute,
  DiagramRouteOptions,
} from "./ai-route";
export { serveAiRequest, createFetchHandler } from "./http";
export type { ServeOptions } from "./http";

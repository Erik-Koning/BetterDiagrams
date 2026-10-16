/**
 * http.ts — the diagram route mounted on a server: node:http (and anything
 * built on it — Express, Connect, Vite's dev server) or the Fetch API
 * (Next.js route handlers, Hono, Bun, Deno).
 *
 *   GET  /api/ai       → which model answers, for the AI panel to say so
 *   POST /api/diagram  → a GenerateRequest in, the model's reply out
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDiagramRoute, RouteError, type DiagramRoute } from "./ai-route";

/** Far larger than any diagram prompt; anything bigger is refused unread. */
const BODY_LIMIT = 2_000_000;

export interface ServeOptions {
  /** Where the status answers. Default `/api/ai`. */
  statusPath?: string;
  /** Where generation answers. Default `/api/diagram`. */
  generatePath?: string;
  /** The largest request body read, in bytes. Default 2 MB. */
  bodyLimit?: number;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      // Past the limit the rest is read and dropped, never kept. Destroying
      // the request instead would close the socket under the 413, and the
      // client would see a reset connection rather than the answer.
      if (tooBig) return;
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(new RouteError(413, "Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooBig) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * A Fetch request's body as text, or null once it passes `limit` bytes. Read
 * a chunk at a time, so a body that never says its length (or lies about it)
 * is cut off at the limit rather than held in memory whole.
 */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Serve one node:http request if it is for the route; resolves false when it
 * is not, so the caller can pass it on (`next()` in a middleware). A browser
 * that goes away mid-request — the panel's Stop, a closed tab — aborts the
 * model call with it.
 */
export async function serveAiRequest(
  route: DiagramRoute,
  req: IncomingMessage,
  res: ServerResponse,
  { statusPath = "/api/ai", generatePath = "/api/diagram", bodyLimit = BODY_LIMIT }: ServeOptions = {},
): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0];
  if (path === statusPath) {
    if (req.method !== "GET") sendJson(res, 405, { error: "GET only." });
    else sendJson(res, 200, route.status());
    return true;
  }
  if (path !== generatePath) return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST a GenerateRequest." });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, bodyLimit));
  } catch (err) {
    sendJson(res, err instanceof RouteError ? err.status : 400, {
      error: err instanceof RouteError ? err.message : "The body is not JSON.",
    });
    return true;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const { status, payload } = await route.handle(body, controller.signal);
  if (!res.writableEnded && !controller.signal.aborted) sendJson(res, status, payload);
  return true;
}

/**
 * The route as a Fetch API handler: GET answers the status, POST generates.
 * Mount it on the one path the editor's generator posts to —
 *
 *   // app/api/diagram/route.ts (Next.js)
 *   import { createFetchHandler } from "@mosphere/better-diagrams/server";
 *   const handler = createFetchHandler();
 *   export { handler as GET, handler as POST };
 *
 * The request's own signal aborts the model call when the browser goes away.
 */
export function createFetchHandler(
  route: DiagramRoute = createDiagramRoute(),
  { bodyLimit = BODY_LIMIT }: Pick<ServeOptions, "bodyLimit"> = {},
): (request: Request) => Promise<Response> {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  return async (request) => {
    if (request.method === "GET") return json(route.status());
    if (request.method !== "POST") return json({ error: "POST a GenerateRequest." }, 405);
    const tooLarge = () => json({ error: "Request body too large." }, 413);
    if (Number(request.headers.get("content-length") ?? 0) > bodyLimit) return tooLarge();
    let text: string | null;
    try {
      text = await readLimited(request, bodyLimit);
    } catch {
      return json({ error: "The body could not be read." }, 400);
    }
    if (text === null) return tooLarge();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "The body is not JSON." }, 400);
    }
    const { status, payload } = await route.handle(body, request.signal);
    return json(payload, status);
  };
}

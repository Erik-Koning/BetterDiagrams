/**
 * events.ts — how the disk store tells an open app that a file changed, when
 * there is no Vite HMR socket to say it over: Server-Sent Events, one stream
 * per open page. The browser's EventSource reconnects by itself after a
 * restart, so a page outlives the server that served it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface EventHub {
  /** Hold `res` open as an event stream until the page goes away. */
  serve(req: IncomingMessage, res: ServerResponse): void;
  /** Send one event to every open page. */
  send(event: string, data: unknown): void;
  close(): void;
}

/** Often enough that no proxy or idle timer in between closes a quiet stream. */
const HEARTBEAT_MS = 25_000;

export function createEventHub(): EventHub {
  const clients = new Set<ServerResponse>();
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    serve(req, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Reconnect quickly after a restart: the person is waiting on it.
      res.write("retry: 1000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },
    send(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) client.write(frame);
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

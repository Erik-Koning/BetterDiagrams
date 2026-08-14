/**
 * llm.ts — how the editor talks to a model.
 *
 * The editor never calls a model provider directly. Doing so from the browser
 * would require shipping an API key to every visitor, and would be blocked by
 * CORS regardless. Instead the host app supplies a `generate` function, and
 * where that request actually goes is the host's business:
 *
 *   <ArchitectureStudio generate={createProxyGenerator({ endpoint: "/api/diagram" })} />
 *
 * Omit `generate` entirely and the AI panel is not rendered at all — the editor
 * is then a pure cursor-driven tool with no network surface.
 *
 * See `docs/server.md` for a ~20-line reference route.
 */
import { parseLlmTemplate, type DiagramTemplate, type ValidateOptions } from "./schema";
import type { DiagramContent } from "./presentation";

export interface GenerateRequest {
  /** `create` replaces the diagram; `refine` edits the one in `current`. */
  mode: "create" | "refine";
  /** The user's prompt — requirements, source code, or an edit instruction. */
  input: string;
  /** The schema contract, generated from the live registry. Send as the system prompt. */
  systemPrompt: string;
  /**
   * The diagram being refined. Present only when `mode === "refine"`.
   * The editor sends the CONTENT form (no geometry) — the model edits the
   * architecture and the layout is merged back from the live document, so a
   * refine can never scramble a hand-made arrangement.
   */
  current?: DiagramTemplate | DiagramContent;
}

/**
 * Return either a ready-made template or the model's raw text — raw text is run
 * through `parseLlmTemplate`, which strips markdown fences and repairs the
 * document, so a passthrough proxy needs no parsing logic of its own.
 */
export type DiagramGenerator = (
  request: GenerateRequest,
  signal: AbortSignal,
) => Promise<DiagramTemplate | string>;

export interface ProxyGeneratorOptions {
  /** Your server route. It receives the GenerateRequest as a JSON body. */
  endpoint: string;
  /** Extra headers, e.g. an auth token from your session. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Defaults to "POST". */
  method?: string;
  /** Forwarded to fetch — set "include" if your route needs cookies. */
  credentials?: RequestCredentials;
}

/**
 * A generator that POSTs to a route in your own app. The response may be:
 *   { template: {...} }  — already-parsed template
 *   { text: "..." }      — the model's raw reply
 *   "..."                — a bare text/plain reply
 */
export function createProxyGenerator(options: ProxyGeneratorOptions): DiagramGenerator {
  const { endpoint, headers, method = "POST", credentials } = options;

  return async (request, signal) => {
    const extra = typeof headers === "function" ? headers() : headers;
    const response = await fetch(endpoint, {
      method,
      signal,
      credentials,
      headers: { "Content-Type": "application/json", ...extra },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      // Surface the server's message when it sent one — a bare status code is
      // useless to whoever is looking at the error in the panel.
      const detail = await response.text().catch(() => "");
      let message = `Request failed (${response.status})`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.error) message = String(parsed.error);
      } catch {
        if (detail) message = detail.slice(0, 300);
      }
      throw new Error(message);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return response.text();

    const payload = await response.json();
    if (payload && typeof payload === "object") {
      if ("template" in payload && payload.template) return payload.template as DiagramTemplate;
      if ("text" in payload && typeof payload.text === "string") return payload.text;
      if ("error" in payload) throw new Error(String(payload.error));
    }
    return payload as DiagramTemplate;
  };
}

/** Normalise whatever a generator returned into a validated template. */
export function coerceGeneratorResult(
  result: DiagramTemplate | string,
  opts?: ValidateOptions,
): DiagramTemplate {
  if (typeof result === "string") return parseLlmTemplate(result, opts);
  // An object still goes through validation — a proxy that forwards model
  // output verbatim can hand back a structurally invalid document.
  return parseLlmTemplate(JSON.stringify(result), opts);
}

/** Build the user-turn message for a refine request. */
export function buildRefineMessage(
  current: DiagramTemplate | DiagramContent,
  instruction: string,
  opts: {
    /**
     * The drill-in scope: the user is looking INSIDE this node, so the
     * instruction applies to its internal decomposition, not the whole
     * document. The full document still travels — ids stay stable and the
     * merge machinery is unchanged — the model is just told where to work.
     */
    focus?: { id: string; label: string };
  } = {},
): string {
  return [
    "CURRENT DIAGRAM TEMPLATE:",
    JSON.stringify(current),
    ...(opts.focus
      ? [
          "",
          `The user is drilled into "${opts.focus.label}" (node id "${opts.focus.id}"). ` +
            `Apply the instruction INSIDE that component only: add, edit, or remove nodes whose parentId chain leads to "${opts.focus.id}" ` +
            `(new internal parts get parentId "${opts.focus.id}") and edges among them or from them to existing outside nodes. ` +
            `Leave everything outside it untouched and keep every existing id.`,
        ]
      : []),
    "",
    "Apply this instruction and return the FULL updated template JSON:",
    instruction,
  ].join("\n");
}

/**
 * ai-route.ts — the route the editor's AI panel talks to, and which model
 * answers it, picked from the environment the server starts in. Keys never
 * leave the server: the browser only ever sees the route.
 *
 *   ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)  → Claude Opus 5.5;
 *     ANTHROPIC_BASE_URL sends it through a gateway or proxy instead
 *   otherwise OPENAI_API_KEY (or OPENAI_KEY)      → OpenAI's GPT-6 Astra;
 *     OPENAI_BASE_URL likewise
 *   neither: Claude, which still finds a profile saved by `ant auth login`
 *
 * ANTHROPIC_MODEL or OPENAI_MODEL picks a different model on that side, and
 * BD_AI=off answers every request with a 503 and calls no one.
 *
 * The provider SDKs are optional peer dependencies, loaded only when their
 * provider answers: install `@anthropic-ai/sdk`, `openai`, or both. A host
 * with its own model call passes `complete` and needs neither.
 */

/** The environment the route reads — `process.env` on Node. */
export type AiEnv = Readonly<Record<string, string | undefined>>;

export type AiProviderName = "anthropic" | "openai";

/** Which provider and model answer, as the environment selects them. */
export interface AiProvider {
  name: AiProviderName;
  model: string;
  /** A name for people: "Claude Opus 5.5". */
  label: string;
  /** The variable the key came from — never the key — or null with none set. */
  keyVar: string | null;
  /** A gateway or proxy the requests go through instead, or null. */
  baseURL: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system: string;
  /** The conversation, oldest first, ending with the user's new message. */
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/** One model call: the system prompt and the conversation in, the reply's text out. */
export type Completer = (request: CompletionRequest) => Promise<string>;

/** What `GET /api/ai` answers: enough for the app to name the model and decide whether to offer the panel. */
export interface AiRouteStatus {
  provider: AiProviderName;
  model: string;
  label: string;
  /** A key is set and the route is on — the panel can be offered. */
  configured: boolean;
  keyVar: string | null;
  /** Requests go through a custom base URL. */
  gateway: boolean;
  /** Switched off with BD_AI=off. */
  off: boolean;
}

/** A response to send: its HTTP status and JSON body. */
export interface AiRouteResult {
  status: number;
  payload: { text: string } | { error: string };
}

export interface DiagramRoute {
  provider: AiProvider;
  status(): AiRouteStatus;
  /** Answer one `GenerateRequest` body (see the contract's llm.ts). */
  handle(body: unknown, signal?: AbortSignal): Promise<AiRouteResult>;
}

export interface DiagramRouteOptions {
  /** Where keys and settings are read from. Default `process.env`. */
  env?: AiEnv;
  /**
   * Answer with your own model call instead of the providers above — a
   * gateway SDK, a self-hosted model. The route still checks the request,
   * trims the history and maps failures; `status()` then reports itself
   * configured.
   */
  complete?: Completer;
}

const MODELS: Record<AiProviderName, { id: string; label: string }> = {
  anthropic: { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  openai: { id: "gpt-6-astra", label: "GPT-6 Astra" },
};

/** How many earlier chat turns go to the model — the editor sends at most this many too. */
const MAX_TURNS = 16;
/** A turn longer than this is cut: history is context, not a second document. */
const MAX_TURN_CHARS = 4000;

const SET_A_KEY =
  "Set ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a gateway), or OPENAI_API_KEY, in the environment the server starts in, then restart it.";

/** A failure the route answers with its own status and message. */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

const processEnv = (): AiEnv => (typeof process !== "undefined" ? process.env : {});

/**
 * Which provider and model the environment selects. Reads names only: the
 * result carries which variable the key came from, never the key.
 */
export function resolveProvider(env: AiEnv = processEnv()): AiProvider {
  const anthropicVar = env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : null;
  const openaiVar = env.OPENAI_API_KEY ? "OPENAI_API_KEY" : env.OPENAI_KEY ? "OPENAI_KEY" : null;
  const name: AiProviderName = anthropicVar || !openaiVar ? "anthropic" : "openai";
  const override = name === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL;
  return {
    name,
    model: override || MODELS[name].id,
    label: override || MODELS[name].label,
    keyVar: name === "anthropic" ? anthropicVar : openaiVar,
    baseURL: (name === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL) || null,
  };
}

/** The provider's model call, sending one request and resolving with the reply's text. */
export function createCompleter(provider: AiProvider, env: AiEnv = processEnv()): Completer {
  return provider.name === "anthropic" ? anthropicCompleter(provider, env) : openaiCompleter(provider, env);
}

/** Load an optional SDK, saying how to install it when it isn't. */
async function loadSdk<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new RouteError(500, `The ${name} package isn't installed on the server. Run \`npm install ${name}\`.`);
    }
    throw err;
  }
}

/** An SDK's error classes, in the shape both SDKs share. */
interface SdkErrors {
  APIUserAbortError: abstract new (...args: never[]) => Error;
  AuthenticationError: abstract new (...args: never[]) => Error;
  APIError: abstract new (...args: never[]) => Error;
}

/** An SDK's failure as the route's own: cancelled, a key it refused, or the API's status and message. */
function translate(err: unknown, sdk: SdkErrors, provider: AiProvider): unknown {
  if (err instanceof sdk.APIUserAbortError) return new RouteError(499, "Cancelled.");
  if (err instanceof sdk.AuthenticationError) {
    return new RouteError(401, `${provider.label} did not accept the key in ${provider.keyVar ?? "the environment"}. ${SET_A_KEY}`);
  }
  if (err instanceof sdk.APIError) {
    const status = (err as { status?: unknown }).status;
    return new RouteError(Number.isInteger(status) ? (status as number) : 502, err.message);
  }
  return err;
}

function anthropicCompleter(provider: AiProvider, env: AiEnv): Completer {
  const { model, baseURL } = provider;
  let client: import("@anthropic-ai/sdk").default | undefined;
  return async ({ system, messages, signal }) => {
    const { default: Anthropic } = await loadSdk("@anthropic-ai/sdk", () => import("@anthropic-ai/sdk"));
    // What the environment holds goes in explicitly; whatever it lacks, the
    // SDK looks up itself — down to an `ant auth login` profile.
    client ??= new Anthropic({
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_AUTH_TOKEN ? { authToken: env.ANTHROPIC_AUTH_TOKEN } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
    let message;
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          // Streamed, so a large diagram never runs into an HTTP timeout; the
          // headroom covers thinking and the whole JSON reply together.
          max_tokens: 64000,
          // The schema prompt is the same on every turn of a chat: cache it.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages,
          // Medium is Opus 5.5's own default, set here so the choice is
          // visible: a diagram edit is structured work someone is waiting on.
          output_config: { effort: "medium" },
          // Opus 5.5's safety classifiers can decline a request; this re-runs
          // it on Anthropic's recommended fallback instead of returning the
          // refusal. A gateway on ANTHROPIC_BASE_URL may not pass betas
          // through, so it is left off there.
          ...(baseURL ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
        },
        { signal },
      );
      message = await stream.finalMessage();
    } catch (err) {
      throw translate(err, Anthropic, provider);
    }
    // Check stop_reason before reading content: a refusal can leave it empty.
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      throw new RouteError(422, `The model declined this request${category ? ` (${category})` : ""}.`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new RouteError(502, "The reply reached the length limit before the diagram was complete.");
    }
    return message.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  };
}

function openaiCompleter(provider: AiProvider, env: AiEnv): Completer {
  const { model, baseURL } = provider;
  let client: import("openai").default | undefined;
  return async ({ system, messages, signal }) => {
    const { default: OpenAI } = await loadSdk("openai", () => import("openai"));
    client ??= new OpenAI({
      apiKey: env.OPENAI_API_KEY || env.OPENAI_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
    let response;
    try {
      response = await client.responses.create(
        {
          model,
          instructions: system,
          input: messages,
          reasoning: { effort: "medium" },
          max_output_tokens: 64000,
        },
        { signal },
      );
    } catch (err) {
      throw translate(err, OpenAI, provider);
    }
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "incomplete";
      throw new RouteError(502, `The reply stopped early (${reason}) before the diagram was complete.`);
    }
    return response.output_text;
  };
}

/**
 * The route: `status()` for GET /api/ai, `handle(body, signal)` for POST
 * /api/diagram. Each resolves to the status and JSON payload to send — mount
 * it with `serveAiRequest` (node:http, Express, Vite) or `createFetchHandler`
 * (Next.js route handlers, Hono, Bun, Deno).
 */
export function createDiagramRoute(options: DiagramRouteOptions = {}): DiagramRoute {
  const env = options.env ?? processEnv();
  const off = env.BD_AI === "off";
  const provider = resolveProvider(env);
  const complete = options.complete ?? createCompleter(provider, env);
  return {
    provider,
    status() {
      return {
        provider: provider.name,
        model: provider.model,
        label: provider.label,
        configured: !off && (!!options.complete || !!provider.keyVar),
        keyVar: off ? null : provider.keyVar,
        gateway: !!provider.baseURL,
        off,
      };
    },
    async handle(body, signal) {
      if (off) return { status: 503, payload: { error: "AI is switched off here (BD_AI=off)." } };
      const { input, systemPrompt, history } = (body ?? {}) as { input?: unknown; systemPrompt?: unknown; history?: unknown };
      if (typeof input !== "string" || !input || typeof systemPrompt !== "string" || !systemPrompt) {
        return { status: 400, payload: { error: "Expected `input` and `systemPrompt` in the body." } };
      }
      try {
        const text = await complete({
          system: systemPrompt,
          messages: [...earlierTurns(history), { role: "user", content: input }],
          signal,
        });
        if (!text.trim()) return { status: 502, payload: { error: "The model returned no text to parse." } };
        // Raw text: the editor strips fences, lifts the chat note and repairs
        // the document against its schema.
        return { status: 200, payload: { text } };
      } catch (err) {
        return failure(err, provider, !!options.complete);
      }
    },
  };
}

/** The chat's earlier turns as messages — checked, since they come from the browser. */
function earlierTurns(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter(
      (turn): turn is ChatMessage =>
        (turn?.role === "user" || turn?.role === "assistant") && typeof turn.content === "string" && !!turn.content.trim(),
    )
    .slice(-MAX_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) }));
  // A conversation opens with the user.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

function failure(err: unknown, provider: AiProvider, custom: boolean): AiRouteResult {
  if (err instanceof RouteError) return { status: err.status, payload: { error: err.message } };
  if ((err as { name?: string } | null)?.name === "AbortError") return { status: 499, payload: { error: "Cancelled." } };
  // Not an API answer at all. With no key in the environment, that is the
  // SDK finding no credentials to send.
  console.error("[ai]", err);
  const noKey = !custom && !provider.keyVar;
  const message = err instanceof Error ? err.message : "Generation failed.";
  return { status: noKey ? 401 : 500, payload: { error: noKey ? `No AI key found. ${SET_A_KEY}` : message } };
}

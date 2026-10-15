/**
 * ai-route.mjs — the route the editor's AI panel talks to, and which model
 * answers it, picked from the environment the server starts in. The keys
 * never leave this process: the browser only ever sees the route.
 *
 *   ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)  → Claude Opus 5.5;
 *     ANTHROPIC_BASE_URL sends it through a gateway or proxy instead
 *   otherwise OPENAI_API_KEY (or OPENAI_KEY)      → OpenAI's GPT-6 Astra;
 *     OPENAI_BASE_URL likewise
 *   neither: Claude, which still finds a profile saved by `ant auth login`
 *
 * ANTHROPIC_MODEL or OPENAI_MODEL picks a different model on that side, and
 * BD_AI=off answers every request with a 503 and calls no one (the e2e suite
 * runs that way).
 *
 * Both the dev server (vite-plugin-ai.js) and the standalone server.mjs mount
 * this, so `npm run dev` alone answers the panel.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const MODELS = {
  anthropic: { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  openai: { id: "gpt-6-astra", label: "GPT-6 Astra" },
};

/** How many earlier chat turns go to the model — the editor sends at most this many too. */
const MAX_TURNS = 16;

/**
 * Which provider and model the environment selects. Reads names only: the
 * result carries which variable the key came from, never the key.
 */
export function resolveProvider(env = process.env) {
  const anthropicVar = env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : null;
  const openaiVar = env.OPENAI_API_KEY ? "OPENAI_API_KEY" : env.OPENAI_KEY ? "OPENAI_KEY" : null;
  const name = anthropicVar || !openaiVar ? "anthropic" : "openai";
  const override = name === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL;
  return {
    name,
    model: override || MODELS[name].id,
    label: override || MODELS[name].label,
    keyVar: name === "anthropic" ? anthropicVar : openaiVar,
    baseURL: (name === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL) || null,
  };
}

/**
 * A function sending one request — the system prompt and the conversation —
 * to the selected provider, resolving with the reply's text.
 */
export function createCompleter(provider, env = process.env) {
  return provider.name === "anthropic" ? anthropicCompleter(provider, env) : openaiCompleter(provider, env);
}

function anthropicCompleter({ model, baseURL }, env) {
  let client;
  return async ({ system, messages, signal }) => {
    // What the environment holds goes in explicitly; whatever it lacks, the
    // SDK looks up itself — down to an `ant auth login` profile.
    client ??= new Anthropic({
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(env.ANTHROPIC_AUTH_TOKEN ? { authToken: env.ANTHROPIC_AUTH_TOKEN } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
    const stream = client.beta.messages.stream(
      {
        model,
        // Streamed, so a large diagram never runs into an HTTP timeout; the
        // headroom covers thinking and the whole JSON reply together.
        max_tokens: 64000,
        // The schema prompt is the same on every turn of a chat: cache it.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        // Medium is Opus 5.5's own default, set here so the choice is visible:
        // a diagram edit is structured work someone is waiting on.
        output_config: { effort: "medium" },
        // Opus 5.5's safety classifiers can decline a request; this re-runs it
        // on Anthropic's recommended fallback instead of returning the
        // refusal. A gateway on ANTHROPIC_BASE_URL may not pass betas through,
        // so it is left off there.
        ...(baseURL ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
      },
      { signal },
    );
    const message = await stream.finalMessage();
    // Check stop_reason before reading content: a refusal can leave it empty.
    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      throw new RouteError(422, `The model declined this request${category ? ` (${category})` : ""}.`);
    }
    if (message.stop_reason === "max_tokens") {
      throw new RouteError(502, "The reply reached the length limit before the diagram was complete.");
    }
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  };
}

function openaiCompleter({ model, baseURL }, env) {
  let client;
  return async ({ system, messages, signal }) => {
    client ??= new OpenAI({
      apiKey: env.OPENAI_API_KEY || env.OPENAI_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
    const response = await client.responses.create(
      {
        model,
        instructions: system,
        input: messages,
        reasoning: { effort: "medium" },
        max_output_tokens: 64000,
      },
      { signal },
    );
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "incomplete";
      throw new RouteError(502, `The reply stopped early (${reason}) before the diagram was complete.`);
    }
    return response.output_text;
  };
}

/** A failure the route answers with its own status and message. */
class RouteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The route: `status()` for GET /api/ai, `handle(body, signal)` for POST
 * /api/diagram. Each resolves to the status and JSON payload to send.
 */
export function createDiagramRoute(env = process.env) {
  const off = env.BD_AI === "off";
  const provider = resolveProvider(env);
  const complete = createCompleter(provider, env);
  return {
    provider,
    /** Enough for the app to name the model and decide whether to offer the panel. */
    status() {
      return {
        provider: provider.name,
        model: provider.model,
        label: provider.label,
        configured: !off && !!provider.keyVar,
        keyVar: off ? null : provider.keyVar,
        gateway: !!provider.baseURL,
        off,
      };
    },
    async handle(body, signal) {
      if (off) return { status: 503, payload: { error: "AI is switched off here (BD_AI=off)." } };
      const { input, systemPrompt, history } = body ?? {};
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
        return failure(err, provider);
      }
    },
  };
}

/** The chat's earlier turns as messages — checked, since they come from the browser. */
function earlierTurns(history) {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter(
      (turn) =>
        (turn?.role === "user" || turn?.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim(),
    )
    .slice(-MAX_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 4000) }));
  // A conversation opens with the user.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return turns;
}

const SET_A_KEY =
  "Set ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a gateway), or OPENAI_API_KEY, in the shell that starts the dev server, then restart it.";

function failure(err, provider) {
  if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError) {
    return { status: 499, payload: { error: "Cancelled." } };
  }
  if (err instanceof RouteError) return { status: err.status, payload: { error: err.message } };
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return {
      status: 401,
      payload: { error: `${provider.label} did not accept the key in ${provider.keyVar ?? "the environment"}. ${SET_A_KEY}` },
    };
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const status = Number.isInteger(err.status) ? err.status : 502;
    return { status, payload: { error: err.message } };
  }
  // Not an API answer at all: with no key in the environment, that is the SDK
  // finding no credentials to send.
  console.error("[ai]", err);
  return {
    status: provider.keyVar ? 500 : 401,
    payload: { error: provider.keyVar ? err?.message ?? "Generation failed." : `No AI key found. ${SET_A_KEY}` },
  };
}

/** Read a JSON request body, refusing anything far larger than a diagram prompt. */
export function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RouteError(413, "Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Serve one request if it is for the AI route; resolves false when it is not,
 * so a caller can pass it on. A browser that goes away mid-request (the
 * panel's Stop, a closed tab) aborts the model call with it.
 */
export async function serveAiRequest(route, req, res) {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/api/ai") {
    if (req.method !== "GET") sendJson(res, 405, { error: "GET only." });
    else sendJson(res, 200, route.status());
    return true;
  }
  if (path !== "/api/diagram") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST a GenerateRequest." });
    return true;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, err instanceof RouteError ? err.status : 400, { error: err instanceof RouteError ? err.message : "The body is not JSON." });
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

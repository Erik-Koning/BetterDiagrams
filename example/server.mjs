/**
 * server.mjs — the AI generation route the editor talks to.
 *
 * The editor deliberately has no provider code in it. This is the whole
 * backend contract: accept the GenerateRequest the browser posts, call a model
 * with it, return the reply. The API key stays here.
 *
 *   npm run server        # in one terminal (needs ANTHROPIC_API_KEY)
 *   npm run dev           # in another; Vite proxies /api → :8787
 *
 * Everything still works with this server stopped — the editor just reports the
 * failed request in its panel. Cursor editing, import/export, and save are
 * entirely local.
 */
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT ?? 8787);
const client = new Anthropic(); // reads ANTHROPIC_API_KEY, or an `ant auth login` profile

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // A diagram prompt is never megabytes; refuse anything that large.
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.startsWith("/api/diagram")) {
    return json(res, 404, { error: "Not found" });
  }

  try {
    const { input, systemPrompt } = JSON.parse(await readBody(req));
    if (!input || !systemPrompt) {
      return json(res, 400, { error: "Expected `input` and `systemPrompt` in the body." });
    }

    const message = await client.beta.messages.create({
      model: "claude-opus-5",
      // Thinking is on by default on Opus 5, and max_tokens caps thinking plus
      // the reply together — so leave generous headroom or the JSON gets cut
      // off mid-object (which the client reports as a truncated response).
      max_tokens: 16000,
      // The editor generates this from its own registry, so a node kind added
      // in extensions.js is automatically offered to the model.
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
      // Opus 5's safety classifiers can decline a request; this re-runs it on
      // Anthropic's recommended fallback server-side instead of returning the
      // refusal. Remove both lines if you'd rather handle refusals yourself.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    // Always check stop_reason before reading content — on a refusal the
    // content array can be empty, and indexing it blindly would throw.
    if (message.stop_reason === "refusal") {
      return json(res, 422, {
        error: `The model declined this request${
          message.stop_details?.category ? ` (${message.stop_details.category})` : ""
        }.`,
      });
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    if (!text.trim()) {
      return json(res, 502, { error: "The model returned no text to parse." });
    }

    // Hand back raw text — the client runs it through `parseLlmTemplate`, which
    // strips fences and repairs the document against the schema.
    return json(res, 200, { text });
  } catch (err) {
    console.error("[diagram]", err);
    const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
    return json(res, status, { error: err?.message ?? "Generation failed" });
  }
});

server.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY is not set — requests will fail auth.");
    console.warn("   Set it, or run `ant auth login` to use a stored profile.\n");
  }
  console.log(`diagram API listening on http://localhost:${PORT}/api/diagram`);
});

/**
 * ai-request.ts — the studio's AI requests, checked and turned into a
 * conversation, as the web app's route (`@mosphere/better-diagrams/server`)
 * does before it calls a provider. Pure: the extension sends the result to
 * one of VS Code's language models (ai.ts), and its unit tests check it here.
 */

/** How many earlier chat turns go to the model, as the web app's route sends. */
export const MAX_TURNS = 16;
/** A turn longer than this is cut: history is context, not a second document. */
export const MAX_TURN_CHARS = 4000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * A GenerateRequest from the webview as the model gets it: the schema prompt
 * as the system message, the Adjust with AI chat's earlier turns, then this
 * turn's input. Checked, since it comes from the webview; null when it isn't
 * a request at all.
 */
export function conversationOf(request: unknown): { system: string; turns: ChatTurn[] } | null {
  if (!request || typeof request !== "object") return null;
  const { input, systemPrompt, history } = request as { input?: unknown; systemPrompt?: unknown; history?: unknown };
  if (typeof input !== "string" || !input || typeof systemPrompt !== "string" || !systemPrompt) return null;
  const earlier = (Array.isArray(history) ? history : [])
    .filter(
      (turn): turn is ChatTurn =>
        (turn?.role === "user" || turn?.role === "assistant") && typeof turn.content === "string" && !!turn.content.trim(),
    )
    .slice(-MAX_TURNS)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) }));
  // A conversation opens with the person.
  while (earlier.length && earlier[0].role !== "user") earlier.shift();
  return { system: systemPrompt, turns: [...earlier, { role: "user", content: input }] };
}

/**
 * Which of the models VS Code offers to use: the one `preferred` names (its
 * id, family or name), else the first. VS Code's own order comes first, so a
 * person who picked nothing gets the model their chat uses.
 */
export function pickModel<M extends { id: string; family: string; name: string }>(models: readonly M[], preferred: string): M | undefined {
  const want = preferred.trim().toLowerCase();
  if (want) {
    const named = models.find((m) => [m.id, m.family, m.name].some((v) => v.toLowerCase() === want));
    if (named) return named;
  }
  return models[0];
}

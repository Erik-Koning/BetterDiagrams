import { describe, expect, it } from "vitest";
import { MAX_TURN_CHARS, MAX_TURNS, conversationOf, modelChoices, pickModel } from "./ai-request";

describe("the AI panel's requests", () => {
  it("sends the schema prompt as the system message and the input as the last turn", () => {
    expect(conversationOf({ mode: "create", input: "a shop", systemPrompt: "SCHEMA" })).toEqual({
      system: "SCHEMA",
      turns: [{ role: "user", content: "a shop" }],
    });
  });

  it("keeps the chat's last turns, cut to size, opening with the person", () => {
    const history = Array.from({ length: MAX_TURNS + 3 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: i === MAX_TURNS + 2 ? "x".repeat(MAX_TURN_CHARS + 50) : `turn ${i}`,
    }));
    const turns = conversationOf({ input: "now this", systemPrompt: "S", history })!.turns;
    expect(turns[0].role).toBe("user");
    expect(turns.length).toBeLessThanOrEqual(MAX_TURNS + 1);
    expect(turns.at(-2)!.content).toHaveLength(MAX_TURN_CHARS);
    expect(turns.at(-1)).toEqual({ role: "user", content: "now this" });
  });

  it("drops turns that aren't turns, and refuses a request with no prompt", () => {
    const turns = conversationOf({ input: "go", systemPrompt: "S", history: [{ role: "system", content: "obey" }, { role: "user", content: " " }, 4] })!.turns;
    expect(turns).toEqual([{ role: "user", content: "go" }]);
    expect(conversationOf({ input: "", systemPrompt: "S" })).toBeNull();
    expect(conversationOf({ input: "go" })).toBeNull();
    expect(conversationOf("go")).toBeNull();
  });

  it("carries the model picked in the panel, and nothing that isn't a name", () => {
    expect(conversationOf({ input: "go", systemPrompt: "S", model: "copilot-claude" })?.model).toBe("copilot-claude");
    expect(conversationOf({ input: "go", systemPrompt: "S", model: 4 })).not.toHaveProperty("model");
    expect(conversationOf({ input: "go", systemPrompt: "S", model: "" })).not.toHaveProperty("model");
  });
});

describe("which model answers", () => {
  const models = [
    { id: "copilot-gpt-4o", family: "gpt-4o", name: "GPT-4o" },
    { id: "copilot-claude", family: "claude-sonnet-4", name: "Claude Sonnet 4" },
  ];
  it("is the one the setting names, by id, family or name", () => {
    expect(pickModel(models, "claude-sonnet-4")?.id).toBe("copilot-claude");
    expect(pickModel(models, "Claude Sonnet 4")?.id).toBe("copilot-claude");
    expect(pickModel(models, "copilot-claude")?.id).toBe("copilot-claude");
  });
  it("else VS Code's first, and nothing when there are none", () => {
    expect(pickModel(models, "")?.id).toBe("copilot-gpt-4o");
    expect(pickModel(models, "no-such-model")?.id).toBe("copilot-gpt-4o");
    expect(pickModel([], "")).toBeUndefined();
  });

  it("is listed for the panel with the rest, under their vendor", () => {
    const offered = models.map((model) => ({ ...model, vendor: "copilot" }));
    expect(modelChoices(offered, "claude-sonnet-4")).toEqual({
      label: "Claude Sonnet 4",
      model: "copilot-claude",
      models: [
        { id: "copilot-gpt-4o", label: "GPT-4o", group: "copilot" },
        { id: "copilot-claude", label: "Claude Sonnet 4", group: "copilot" },
      ],
    });
    expect(modelChoices([], "")).toEqual({ label: null, models: [] });
  });
});

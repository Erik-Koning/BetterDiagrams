import { describe, expect, it } from "vitest";
import { replyNote } from "./llm";
import { parseLlmTemplate } from "./schema";

describe("replyNote", () => {
  const doc = '{"nodes":[{"id":"cdn","label":"CDN","kind":"gateway"}],"edges":[]}';

  it("is the sentence a chat reply opens with, before the JSON or its fence", () => {
    expect(replyNote(`Added a CDN in front of the API.\n${doc}`)).toBe("Added a CDN in front of the API.");
    expect(replyNote(`Added a CDN.\n\n\`\`\`json\n${doc}\n\`\`\``)).toBe("Added a CDN.");
  });

  it("is empty for a bare document, and the whole text when there is no document", () => {
    expect(replyNote(doc)).toBe("");
    expect(replyNote("```json\n" + doc + "\n```")).toBe("");
    expect(replyNote("Nothing to change.")).toBe("Nothing to change.");
  });

  it("leaves the document to the parser, which skips the note", () => {
    expect(parseLlmTemplate(`Added a CDN.\n${doc}`).nodes.map((n) => n.id)).toEqual(["cdn"]);
  });
});

/**
 * welcome-parse.ts — the welcome modal's architecture-text parser.
 *
 * Extracted from the architecture studio so the SEQUENCE studio's modal can
 * parse a cross-kind paste the same way: raw React Flow exports are accepted
 * exactly like the Import button, and a document with no real coordinates
 * (validation coerces missing x/y to 0, piling every node at the origin) is
 * laid out instead of stacked. Any explicitly placed node disables the
 * layout — the author's coordinates are truth.
 */
import { autoLayout } from "../contract/layout";
import {
  fromReactFlow,
  parseLlmTemplate,
  validateTemplate,
  type DiagramTemplate,
  type ValidateOptions,
} from "../contract/schema";

/**
 * Lay out a document that arrived with no real coordinates — a CONTENT doc,
 * or any JSON whose author never placed anything. Validation coerces missing
 * x/y to 0, so "every node at the origin" is the reliable signature; a single
 * explicitly placed node disables the layout, because the author's
 * coordinates are truth. Shared by the welcome-modal paste path and the
 * Import button so the two doors agree.
 */
export function layoutIfUnpositioned(template: DiagramTemplate): DiagramTemplate {
  return template.nodes.length > 1 && template.nodes.every((n) => n.x === 0 && n.y === 0)
    ? // Every frame, not just the visible one: a nested document arrives with
      // each drilled canvas unplaced too, and a level nobody arranged would
      // otherwise open onto a single pile at its origin.
      autoLayout(template, { frames: "all" })
    : template;
}

export function parseArchitectureText(
  text: string,
  opts: ValidateOptions = {},
): DiagramTemplate {
  const laidOut = layoutIfUnpositioned;
  // Validated here, not just downstream: on the zero-files path the result
  // goes straight to the host's onFileCreate, which is promised a validated
  // document.
  try {
    const raw = JSON.parse(text);
    if (Array.isArray(raw?.nodes) && raw.nodes[0] && "position" in raw.nodes[0]) {
      return laidOut(validateTemplate(fromReactFlow(raw.nodes, raw.edges ?? [], opts), opts));
    }
  } catch {
    // Not plain JSON — parseLlmTemplate handles fences and better errors.
  }
  return laidOut(parseLlmTemplate(text, opts));
}

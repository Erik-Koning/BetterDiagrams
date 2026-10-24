/**
 * agent.ts — Better Diagrams for an AI agent: the format to write, and what
 * the editor makes of a file once it's written. Both are the web app's own:
 * the prompt its Copy Schema & System Prompt button copies (with the app's
 * registry, so its extra kinds are offered), and the reading it gives a file
 * from disk (example/src/documents.js), plus its Checks.
 *
 * Pure. The language model tools and the Add Agent Instructions command
 * (agent-tools.ts) wrap it.
 */
import {
  EMPTY_TEMPLATE,
  buildSequencePrompt,
  lintTemplate,
  resolveRegistry,
  templatePromptContext,
  type DiagramTemplate,
  type SequenceTemplate,
} from "@mosphere/better-diagrams";
import { isDiagram } from "@mosphere/better-diagrams/disk";
import { kindOf, lossOf, registry, validateDoc } from "@app/documents.js";

export const DIAGRAM_KINDS = ["architecture", "tasks", "sequence"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

/** The clouds whose component packs a prompt can carry. */
export const CLOUDS = ["aws", "azure", "gcp"] as const;

/** Prefaces the prompt: it was written for the editor's own model, which answers with JSON. */
const WRITING_A_FILE =
  "This is the prompt Better Diagrams gives its own AI. Where it says to respond with JSON, " +
  "write that JSON to the diagram's .json file instead (any formatting: the editor reformats it " +
  "on save). When editing an existing diagram, keep every id that stays: other elements and " +
  "people's links refer to them. Check the file afterwards with the Better Diagrams validate tool.";

export interface SchemaRequest {
  /** Default: the existing diagram's kind, else architecture. */
  kind?: DiagramKind;
  /** Default: the clouds the existing diagram already uses, else none. */
  clouds?: readonly string[];
  /** `false` asks for the content form: elements only, no positions or sizes, the editor lays them out. */
  geometry?: boolean;
  /** An existing diagram (parsed JSON) to tailor the prompt to. */
  existing?: unknown;
}

/** The system prompt for writing a diagram, exactly as the web app's copy button gives it. */
export function schemaPrompt({ kind, clouds, geometry = true, existing }: SchemaRequest = {}): string {
  const existingKind = existing !== undefined && isDiagram(existing) ? kindOf(existing) : undefined;
  const wanted = kind ?? existingKind ?? "architecture";
  if (wanted === "sequence") return buildSequencePrompt();
  const doc = existingKind === "architecture" ? validateDoc("architecture", existing) : EMPTY_TEMPLATE;
  const context = templatePromptContext(doc, registry);
  const scope = clouds ? clouds.filter((cloud) => (CLOUDS as readonly string[]).includes(cloud)) : context.referencedClouds;
  return context.promptForClouds(scope, {
    ...(geometry ? {} : { geometry: false }),
    ...(wanted === "tasks" ? { focus: "tasks" as const } : {}),
  });
}

/** What the schema tool answers: how to use the prompt, then the prompt. */
export const schemaAnswer = (request: SchemaRequest = {}) => `${WRITING_A_FILE}\n\n${schemaPrompt(request)}`;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the editor makes of `text`, the contents of the file `name`, for an
 * agent to act on: whether it opens, what opening it would repair or drop,
 * and the diagram's Checks.
 */
export function checkDiagram(name: string, text: string): string {
  if (!text.trim()) return `${name} is empty. The editor opens it as a new architecture diagram; write one into it.`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `${name} isn't valid JSON: ${(error as Error).message}. The editor won't open it until it parses.`;
  }
  if (!isDiagram(raw)) {
    const first = (raw as { nodes?: unknown[] } | null)?.nodes?.[0];
    if (first && typeof first === "object" && "position" in first) {
      return `${name} is a React Flow export (its nodes have "position"). The editor converts one on import but never edits it in place: write a Better Diagrams document instead (see the schema tool).`;
    }
    return `${name} is JSON, but not a Better Diagrams diagram: one has a "nodes" array (an architecture diagram or task flow) or a "participants" array (a sequence diagram).`;
  }
  const kind = kindOf(raw);
  let doc: DiagramTemplate | SequenceTemplate;
  try {
    doc = validateDoc(kind, raw);
  } catch (error) {
    return `${name} couldn't be read as a ${kind} diagram: ${(error as Error).message}`;
  }
  const lines: string[] = [];
  if (kind === "sequence") {
    const seq = doc as SequenceTemplate;
    lines.push(`${name}: a sequence diagram, ${count(seq.participants.length, "participant")} and ${count(seq.messages.length, "message")}.`);
  } else {
    const arch = doc as DiagramTemplate;
    const zones = arch.zones?.length ? `, ${count(arch.zones.length, "zone")}` : "";
    lines.push(`${name}: an architecture diagram, ${count(arch.nodes.length, "node")}, ${count(arch.edges.length, "edge")}${zones}.`);
  }
  const loss = lossOf(kind, raw, doc);
  if (loss.length) {
    lines.push("", `The editor would repair or drop ${count(loss.length, "thing")} as it opens it. Fix them in the file:`);
    for (const line of loss) lines.push(`- ${line}`);
  } else {
    lines.push("", "The editor reads it exactly as written: nothing is repaired or dropped.");
  }
  if (kind === "architecture") {
    const findings = lintTemplate(doc as DiagramTemplate, resolveRegistry(registry).lintRules);
    if (findings.length) {
      lines.push("", `Checks, as the editor's Checks menu lists them (fix errors; warnings may be deliberate):`);
      for (const finding of findings) {
        const ids = [...(finding.nodeIds ?? []), ...(finding.edgeIds ?? [])];
        lines.push(`- ${finding.severity} ${finding.rule}: ${finding.message}${ids.length ? ` (${ids.join(", ")})` : ""}`);
      }
    } else {
      lines.push("", "Checks: none.");
    }
  }
  return lines.join("\n");
}

/**
 * The one stretch of text `longer` adds to `base`: the task-flow prompt is
 * the architecture prompt with its brief inserted (before any extra rules).
 * All of `longer`, should it ever differ some other way.
 */
function inserted(base: string, longer: string): string {
  let start = 0;
  while (start < base.length && base[start] === longer[start]) start++;
  let end = 0;
  while (end < base.length - start && base[base.length - 1 - end] === longer[longer.length - 1 - end]) end++;
  return start + end === base.length ? longer.slice(start, longer.length - end).trim() : longer;
}

/** The instructions file's first line: how a later run knows the file is its own to rewrite. */
export const INSTRUCTIONS_MARK = "<!-- Written by Better Diagrams for VS Code";

/**
 * The repo's instructions for agents that read files rather than call
 * tools: what a diagram is here, how to keep one intact, and the format
 * itself (architecture, the task-flow addition, sequence).
 */
export function instructionsMarkdown(requested: readonly string[] = []): string {
  const clouds = requested.filter((cloud) => (CLOUDS as readonly string[]).includes(cloud));
  const architecture = schemaPrompt({ kind: "architecture", clouds });
  const taskBrief = inserted(architecture, schemaPrompt({ kind: "tasks", clouds }));
  const scope = clouds.length ? ` It carries the ${clouds.join(", ")} component packs.` : "";
  return `${INSTRUCTIONS_MARK} (Better Diagrams: Add Agent Instructions). Run it again to refresh; edits here are replaced. -->
# Better Diagrams

Diagrams in this repo are Better Diagrams documents: JSON files with a \`"nodes"\` array (an
architecture diagram or a task flow) or a \`"participants"\` array (a sequence diagram). People
open them in the Better Diagrams editor, in VS Code (Open With… → Better Diagrams) or in a
browser (\`npx @mosphere/better-diagrams path/to/diagram.json\`), and edits save back to the file.

When you write or edit one:

- Follow the format below. Where it says to respond with JSON, write that JSON to the file.
- Keep every id that stays: other elements, and people's links, refer to them.
- A key the format doesn't have, or a value outside its vocabulary, is dropped the next time
  someone edits the file in the editor.
- In VS Code, the \`#betterDiagramsValidate\` tool says what the editor would repair or drop in a
  file, and lists the diagram's checks. Run it on each file you write and fix what it reports.

## Architecture diagrams

The prompt the editor gives its own AI.${scope}

${architecture}

## Task flows

A task flow is an architecture document whose nodes are tasks. On top of the above:

${taskBrief}

## Sequence diagrams

${buildSequencePrompt()}
`;
}

/** Where a pointer to the instructions starts and ends in AGENTS.md, CLAUDE.md and the like. */
const POINTER_START = "<!-- better-diagrams -->";
const POINTER_END = "<!-- /better-diagrams -->";

/**
 * `existing` (a repo's AGENTS.md, say) with a pointer to the instructions
 * at `path`, relative to it: added at the end, or replacing the pointer an
 * earlier run added. Everything else in the file is left as it was.
 */
export function withPointer(existing: string, path: string): string {
  const pointer = `${POINTER_START}
Diagrams here are Better Diagrams JSON files. Before writing or editing one, read
[${path}](${path}) for the format and how to keep a diagram intact.
${POINTER_END}`;
  const start = existing.indexOf(POINTER_START);
  const end = existing.indexOf(POINTER_END, start);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + pointer + existing.slice(end + POINTER_END.length);
  if (!existing.trim()) return `${pointer}\n`;
  return `${existing.replace(/\s*$/, "")}\n\n${pointer}\n`;
}

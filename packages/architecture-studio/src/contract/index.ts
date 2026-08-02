/**
 * contract/ — the portable half.
 *
 * Zero dependencies: no React, no @xyflow/react, no DOM. This is the half you
 * can copy into a backend, a Lambda, or an LLM pipeline and run as-is — it
 * defines the document, validates it, generates the system prompt that
 * produces it, and transforms it.
 *
 *   import { validateTemplate, buildSystemPrompt } from "@mosphere/architect-better-code-diagrams/contract";
 *
 * The React Flow adapters live here too (`toReactFlow` / `fromReactFlow`), but
 * only as *structural* types — they describe the shape without importing the
 * library, so a server can produce React Flow state it never has to render.
 */

export * from "./schema";
export * from "./zones";
export * from "./layout";
export * from "./clipboard";
export * from "./llm";
export * from "./geometry";
export * from "./lint";
export * from "./diff";
export * from "./sequence";
export * from "./sequence-layout";
export * from "./timeline";

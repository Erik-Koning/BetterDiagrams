/**
 * Public API.
 *
 *   import { ArchitectureStudio } from "@mosphere/architect-better-code-diagrams";
 *   import "@mosphere/architect-better-code-diagrams/styles.css";
 *
 * The package is two halves:
 *
 *   contract/ — zero dependencies. The document, its validation, the generated
 *               system prompt, layout, and the clipboard. Import it on its own
 *               (`@mosphere/architect-better-code-diagrams/contract`) from a server or an LLM
 *               pipeline and none of React comes with it.
 *   react/    — the editor component, its registry, and the exporters.
 *
 * Everything from both is re-exported here, so this barrel's surface is
 * unchanged from before the split.
 */
import "./styles.css";

// ── The portable contract ────────────────────────────────────────────────────
export * from "./contract";

// ── The React half ───────────────────────────────────────────────────────────
export * from "./react";

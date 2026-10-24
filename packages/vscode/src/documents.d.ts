/**
 * The web app's document handling (example/src/documents.js), which this
 * editor shares so a file reads, renders and warns the same in both.
 */
declare module "@app/documents.js" {
  import type { DiagramTemplate, RegistryExtensions, SequenceTemplate, Theme } from "@mosphere/better-diagrams";

  export type DocumentKind = "architecture" | "sequence";
  export type ViewMode = "light" | "dark";

  export const registry: RegistryExtensions;
  export const kindOf: (doc: unknown) => DocumentKind;
  export function validateDoc(kind: "sequence", doc: unknown): SequenceTemplate;
  export function validateDoc(kind: "architecture", doc: unknown): DiagramTemplate;
  export function validateDoc(kind: DocumentKind, doc: unknown): DiagramTemplate | SequenceTemplate;
  export function lossOf(kind: DocumentKind, raw: unknown, doc: DiagramTemplate | SequenceTemplate): string[];
  export const DEFAULT_VIEW: {
    mode: ViewMode;
    studioMode: "technical" | "marketing";
    gradients: boolean;
    minimap: boolean;
    edgesOnHover: boolean;
  };
  /** `Order flow` → `order-flow.json`: the file the web app saves a diagram called that as. */
  export function templateFile(name: string, fallback: string): string;
  export const studioTheme: (mode: ViewMode, accent?: string | null) => Theme;
  export const completeTheme: (mode: ViewMode, accent?: string | null) => Theme;
}

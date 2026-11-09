/**
 * The extension's own menu in the studio's toolbar: what the web app keeps in
 * its header — Copy schema, Edit JSON, Derive sequence, the examples and the
 * Settings › View switches — for a file open in VS Code. The view switches
 * are VS Code settings (`betterDiagrams.*`), so a change here holds for every
 * diagram and window, as one in the Settings UI does.
 */
import { useEffect, useRef, useState } from "react";
import { ToolbarMenu } from "@mosphere/better-diagrams";
import type { ViewMode } from "@app/documents.js";
import type { ViewSettings } from "../protocol";

export interface HostToolsProps {
  kind: "architecture" | "sequence";
  view: ViewSettings;
  /** Light or dark as VS Code's colour theme has it: what Follow VS Code shows now. */
  vsCodeMode: ViewMode;
  /** The accent the theme gives when none is picked, for the colour well to start from. */
  themeAccent: string;
  onView: (change: Partial<ViewSettings>) => void;
  /** Read-only for this editor only, as the web app's Settings › View has it. */
  readOnly: boolean;
  onReadOnly: (on: boolean) => void;
  /** Whether this file can be edited at all: a read-only file system or broken JSON can't. */
  canEdit: boolean;
  /** The model the AI panel would use; null when VS Code has none. */
  aiLabel: string | null;
  onCopySchema: () => void;
  onEditJson: () => void;
  onDeriveSequence: () => void;
  onExample: (which: "zoned" | "plain") => void;
}

export function HostTools(props: HostToolsProps) {
  const { kind, view, vsCodeMode, onView, readOnly, canEdit, aiLabel } = props;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const architecture = kind === "architecture";
  const editable = canEdit && !readOnly;

  // The studio closes its own menus; this one closes on a click outside it, and on Escape.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  /** A row that does something, then closes the menu. */
  const action = (label: string, hint: string, run: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="as-menu__item"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <div className="as-menu__label">{label}</div>
      <div className="as-menu__hint">{hint}</div>
    </button>
  );
  const check = (label: string, title: string, checked: boolean, set: (on: boolean) => void, disabled = false) => (
    <label className="as-menu__check" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => set(event.target.checked)} />
      {label}
    </label>
  );
  const theme = (value: ViewSettings["theme"], label: string, title: string) => (
    <label className="as-menu__check" title={title}>
      <input type="radio" checked={view.theme === value} onChange={() => onView({ theme: value })} />
      {label}
    </label>
  );

  return (
    <div className="as-toolbar__group bd-vscode__tools" ref={wrap}>
      <ToolbarMenu
        label="Settings"
        icon="settings"
        title="The editor's theme and view, the diagram's schema for your AI agent, and examples"
        open={open}
        onToggle={() => setOpen((on) => !on)}
      >
        <div className="as-menu__caption">Diagram</div>
        {action(
          "Copy schema…",
          architecture ? "The format, for your AI agent: pick the clouds it may use" : "The sequence format, for your AI agent",
          props.onCopySchema,
        )}
        {action("Edit JSON…", "Paste what an AI agent wrote, or edit the whole document as text", props.onEditJson, !editable)}
        {architecture
          ? action("Derive sequence", "A new sequence file from this diagram's numbered connections (seq)", props.onDeriveSequence)
          : null}

        <div className="as-menu__caption">View</div>
        {theme("auto", `Follow VS Code (${vsCodeMode})`, "Light or dark, as VS Code's colour theme is")}
        {theme("light", "Light", "Always light, whatever VS Code's theme")}
        {theme("dark", "Dark", "Always dark, whatever VS Code's theme")}
        {check(
          "Marketing",
          "The presentation look — bigger type and icons, tucked-away labels; off for technical",
          view.presentation === "marketing",
          (on) => onView({ presentation: on ? "marketing" : "technical" }),
        )}
        {view.presentation === "marketing"
          ? check("Gradients", "Marketing's gradients, or one flat coat per card — on screen and in every picture export", view.gradients, (on) =>
              onView({ gradients: on }),
            )
          : null}
        {architecture ? check("Minimap", "The overview in the canvas corner", view.minimap, (on) => onView({ minimap: on })) : null}
        {architecture
          ? check(
              "Lines on hover",
              "Draw a connection only while the pointer is over a node it touches; a selected node keeps its lines",
              view.linesOnHover,
              (on) => onView({ linesOnHover: on }),
            )
          : null}
        {aiLabel
          ? check("AI panel", `Offer Generate and Adjust with AI, answered by ${aiLabel}`, view.ai, (on) => onView({ ai: on }))
          : null}
        {check(
          "Read-only",
          canEdit ? "Hide every editing affordance in this editor; pan, zoom and export still work" : "This file can't be edited here",
          readOnly || !canEdit,
          props.onReadOnly,
          !canEdit,
        )}
        <label className="as-menu__check bd-vscode__accent" title="The accent colour: selection, focus and highlights">
          <input
            type="color"
            aria-label="Accent colour"
            value={view.accent || props.themeAccent}
            onChange={(event) => onView({ accent: event.target.value })}
          />
          Accent
          {view.accent ? (
            <button type="button" className="as-btn bd-vscode__reset" onClick={() => onView({ accent: "" })}>
              Reset
            </button>
          ) : null}
        </label>

        {architecture ? (
          <>
            <div className="as-menu__caption">Examples</div>
            {action("Multi-cloud", "Replace this diagram with the zoned multi-cloud example (⌘Z undoes it)", () => props.onExample("zoned"), !editable)}
            {action("Plain", "Replace this diagram with the plain example, without zones", () => props.onExample("plain"), !editable)}
          </>
        ) : null}
      </ToolbarMenu>
    </div>
  );
}

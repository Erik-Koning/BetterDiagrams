/**
 * sequence-exporters.ts — the sequence document's built-in export formats:
 * images through the shared draw-command backends, plus Mermaid and PlantUML
 * text (both of which share the sequence schema's model — participants in
 * order, messages in order, fragments as nested blocks).
 */
import type { ExporterDef } from "./registry-types";
import type { ExportPalette } from "./draw";
import { emitSequence } from "./sequence-draw";
import {
  blobToUint8,
  buildSinglePageJpegPdf,
  canvasToBlob,
  emittedToCanvas,
  emittedToSvg,
  type RenderedCanvas,
} from "./export-helpers";
import { type SeqFragment, type SequenceTemplate } from "../contract/sequence";
import { formatDiagramDate } from "../contract/timeline";

// ─── Image wrappers ──────────────────────────────────────────────────────────

export function renderSequenceToCanvas(
  template: SequenceTemplate,
  scale = 2,
  palette: Partial<ExportPalette> = {},
): RenderedCanvas {
  return emittedToCanvas(emitSequence(template, palette), scale);
}

export function renderSequenceToSvg(
  template: SequenceTemplate,
  palette: Partial<ExportPalette> = {},
): string {
  return emittedToSvg(emitSequence(template, palette));
}

// ─── Fragment walking (shared by both text formats) ──────────────────────────

interface FragmentEvents {
  /** Fragments opening at message index i, outermost first. */
  opens: Map<number, SeqFragment[]>;
  /** Fragments closing after message index i, innermost first. */
  closes: Map<number, SeqFragment[]>;
  /** Branch dividers at message index i. */
  branches: Map<number, Array<{ fragment: SeqFragment; label: string }>>;
}

function fragmentEvents(t: SequenceTemplate): FragmentEvents {
  const index = new Map(t.messages.map((m, i) => [m.id, i]));
  const spans = (t.fragments ?? []).map((f) => ({
    f,
    from: index.get(f.from) ?? 0,
    to: index.get(f.to) ?? 0,
  }));
  // Outermost (widest, earliest) first so nesting comes out right.
  spans.sort((a, b) => a.from - b.from || b.to - a.to);

  const opens = new Map<number, SeqFragment[]>();
  const closes = new Map<number, SeqFragment[]>();
  const branches = new Map<number, Array<{ fragment: SeqFragment; label: string }>>();
  for (const { f, from, to } of spans) {
    opens.set(from, [...(opens.get(from) ?? []), f]);
    closes.set(to, [f, ...(closes.get(to) ?? [])]);
    for (const branch of f.elses ?? []) {
      const at = index.get(branch.at);
      if (at === undefined) continue;
      branches.set(at, [...(branches.get(at) ?? []), { fragment: f, label: branch.label }]);
    }
  }
  return { opens, closes, branches };
}

// ─── Mermaid ─────────────────────────────────────────────────────────────────

/** `sequenceDiagram` text — pastes straight into mermaid.live or a README. */
export function renderSequenceToMermaid(t: SequenceTemplate): string {
  const q = (s: string) => s.replace(/[\n;]/g, " ").trim();
  const lines: string[] = ["sequenceDiagram"];
  if (t.meta?.autonumber) lines.push("  autonumber");

  for (const p of t.participants) {
    const kw = p.kind === "actor" ? "actor" : "participant";
    lines.push(`  ${kw} ${p.id} as ${q(p.label) || p.id}`);
  }

  const { opens, closes, branches } = fragmentEvents(t);
  const openKeyword = (f: SeqFragment) => (f.kind === "alt" ? "alt" : f.kind);
  const branchKeyword = (f: SeqFragment) => (f.kind === "par" ? "and" : "else");
  const arrow = (style: string) => (style === "async" ? "-)" : style === "reply" ? "-->>" : "->>");

  t.messages.forEach((m, i) => {
    for (const f of opens.get(i) ?? []) {
      lines.push(`  ${openKeyword(f)} ${q(f.label)}`);
    }
    for (const b of branches.get(i) ?? []) {
      lines.push(`  ${branchKeyword(b.fragment)} ${q(b.label)}`);
    }
    const label =
      q(m.label) +
      (m.tech ? ` [${q(m.tech)}]` : "") +
      // The date is data, not decoration — it travels with the semantic
      // exports too, in the only free-form slot a message line has.
      (m.date ? ` (${formatDiagramDate(m.date, { year: "always" })})` : "");
    if (m.from === null || m.to === null) {
      // Mermaid cannot express lost/found messages.
      lines.push(`  %% ${m.from === null ? "found" : "lost"}: ${m.from ?? "?"} -> ${m.to ?? "?"} : ${label}`);
    } else {
      lines.push(`  ${m.from}${arrow(m.style)}${m.to}: ${label || " "}`);
    }
    for (const act of t.activations ?? []) {
      if (act.from === m.id) lines.push(`  activate ${act.participant}`);
    }
    for (const note of t.notes ?? []) {
      if (note.at === m.id) {
        const place = note.across
          ? `over ${note.participant},${note.across}`
          : note.side === "over"
            ? `over ${note.participant}`
            : `${note.side} of ${note.participant}`;
        lines.push(`  Note ${place}: ${q(note.text)}`);
      }
    }
    for (const act of t.activations ?? []) {
      if (act.to === m.id) lines.push(`  deactivate ${act.participant}`);
    }
    for (const _f of closes.get(i) ?? []) {
      lines.push("  end");
    }
  });

  // Notes with no anchor sit right after the participants.
  for (const note of t.notes ?? []) {
    if (note.at === undefined) {
      const place = note.across ? `over ${note.participant},${note.across}` : `${note.side === "over" ? "over" : `${note.side} of`} ${note.participant}`;
      lines.splice(1 + t.participants.length + (t.meta?.autonumber ? 1 : 0), 0, `  Note ${place}: ${q(note.text)}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ─── PlantUML ────────────────────────────────────────────────────────────────

/** PlantUML sequence text — full fidelity, including lost/found messages. */
export function renderSequenceToPlantUml(t: SequenceTemplate): string {
  const q = (s: string) => s.replace(/\n/g, "\\n").trim();
  const lines: string[] = ["@startuml"];
  if (t.meta?.title) lines.push(`title ${q(String(t.meta.title))}`);
  if (t.meta?.autonumber) lines.push("autonumber");
  lines.push("");

  const KIND_KEYWORD: Record<string, string> = {
    actor: "actor",
    database: "database",
    queue: "queue",
    service: "participant",
    external: "participant",
  };
  for (const p of t.participants) {
    const kw = KIND_KEYWORD[p.kind] ?? "participant";
    const stereotype = p.kind === "external" ? " <<external>>" : "";
    lines.push(`${kw} "${q(p.label) || p.id}" as ${p.id}${stereotype}`);
  }
  lines.push("");

  const { opens, closes, branches } = fragmentEvents(t);
  const branchKeyword = (f: SeqFragment) => (f.kind === "par" ? "else" : "else");
  const arrow = (style: string) => (style === "async" ? "->>" : style === "reply" ? "-->" : "->");

  t.messages.forEach((m, i) => {
    for (const f of opens.get(i) ?? []) {
      lines.push(`${f.kind} ${q(f.label)}`.trimEnd());
    }
    for (const b of branches.get(i) ?? []) {
      lines.push(`${branchKeyword(b.fragment)} ${q(b.label)}`.trimEnd());
    }
    const label =
      q(m.label) +
      (m.tech ? ` [${q(m.tech)}]` : "") +
      // The date is data, not decoration — it travels with the semantic
      // exports too, in the only free-form slot a message line has.
      (m.date ? ` (${formatDiagramDate(m.date, { year: "always" })})` : "");
    if (m.from === null) {
      lines.push(`[${arrow(m.style)} ${m.to} : ${label}`);
    } else if (m.to === null) {
      lines.push(`${m.from} ${arrow(m.style)}] : ${label}`);
    } else {
      lines.push(`${m.from} ${arrow(m.style)} ${m.to} : ${label || " "}`);
    }
    for (const act of t.activations ?? []) {
      if (act.from === m.id) lines.push(`activate ${act.participant}`);
    }
    for (const note of t.notes ?? []) {
      if (note.at === m.id) {
        const place = note.across
          ? `over ${note.participant}, ${note.across}`
          : note.side === "over"
            ? `over ${note.participant}`
            : `${note.side} of ${note.participant}`;
        lines.push(`note ${place} : ${q(note.text)}`);
      }
    }
    for (const act of t.activations ?? []) {
      if (act.to === m.id) lines.push(`deactivate ${act.participant}`);
    }
    for (const _f of closes.get(i) ?? []) {
      lines.push("end");
    }
  });

  lines.push("@enduml");
  return lines.join("\n") + "\n";
}

// ─── The exporter table ──────────────────────────────────────────────────────

export const BUILTIN_SEQUENCE_EXPORTERS: Record<string, ExporterDef<SequenceTemplate>> = {
  png: {
    label: "PNG image",
    hint: "Raster at 2x, matches the canvas exactly",
    async run({ template, filename, palette }) {
      const { canvas } = renderSequenceToCanvas(template, 2, palette);
      return { blob: await canvasToBlob(canvas, "image/png"), filename: `${filename}.png` };
    },
  },
  pdf: {
    label: "PDF document",
    hint: "Single page, prints at a sane size",
    async run({ template, filename, palette }) {
      const { canvas } = renderSequenceToCanvas(template, 2, palette);
      const jpeg = await blobToUint8(await canvasToBlob(canvas, "image/jpeg", 0.92));
      return {
        blob: buildSinglePageJpegPdf(jpeg, canvas.width, canvas.height),
        filename: `${filename}.pdf`,
      };
    },
  },
  svg: {
    label: "SVG vector",
    hint: "Editable in Figma / Illustrator",
    run({ template, filename, palette }) {
      const svg = renderSequenceToSvg(template, palette);
      return { blob: new Blob([svg], { type: "image/svg+xml" }), filename: `${filename}.svg` };
    },
  },
  json: {
    label: "Sequence JSON",
    hint: "The document itself — re-importable",
    run({ template, filename }) {
      return {
        blob: new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }),
        filename: `${filename}.sequence.json`,
      };
    },
  },
  mermaid: {
    label: "Mermaid",
    hint: "sequenceDiagram for READMEs and wikis",
    run({ template, filename }) {
      return {
        blob: new Blob([renderSequenceToMermaid(template)], { type: "text/plain" }),
        filename: `${filename}.mmd`,
      };
    },
  },
  plantuml: {
    label: "PlantUML",
    hint: "Full fidelity, incl. lost/found messages",
    run({ template, filename }) {
      return {
        blob: new Blob([renderSequenceToPlantUml(template)], { type: "text/plain" }),
        filename: `${filename}.puml`,
      };
    },
  },
};

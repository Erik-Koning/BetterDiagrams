/**
 * How each arrangement of a document reads as a flow: the numbers a new
 * arrangement has to beat. Pure: an engine and a document in, rows out.
 */

/** Every way the engine can arrange a document, and the document as its author placed it. */
export function arrangementsOf(engine, doc) {
  const out = [];
  if (doc.nodes.some((n) => n.x || n.y)) out.push({ id: "authored", label: "As authored", template: doc });
  for (const k of engine.layoutCandidates(doc, { frames: "all" })) out.push({ id: k.id, label: k.label, template: k.template });
  // The two arrangements Tidy had before the auto-placer, which documents can still choose.
  for (const mode of ["flow", "untangle"]) {
    out.push({ id: mode, label: mode === "flow" ? "Left to right (old)" : "Untangle", template: engine.autoLayout(doc, { mode, frames: "all" }) });
  }
  // Directed flow, one per method, where this engine has it.
  for (const method of engine.DIRECTED_METHODS ?? []) {
    const template = engine.autoLayout({ ...doc, settings: { ...doc.settings, directed: { ...doc.settings?.directed, method } } }, { mode: "directed", frames: "all" });
    out.push({ id: `directed-${method}`, label: `Directed: ${method}`, template });
  }
  return out;
}

const round = (value, places = 2) => (value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places);

/** One arrangement, measured. */
export function flowRow(engine, template) {
  const report = engine.lintLayout(template);
  const m = engine.measureFlow(template, { report });
  return {
    score: report.score,
    cost: round(report.cost, 1),
    axis: m.axis,
    crossings: m.crossings,
    overlaps: m.overlaps,
    through: report.counts["line-through-box"] ?? 0,
    backward: m.backward,
    backwardNeeded: m.backwardNeeded,
    flow: round(m.flowConsistency),
    ports: round(m.portDiscipline),
    ends: round(m.sourceSinkPlacement),
    bends: round(m.bends),
    spine: round(m.spineStraightness),
    stress: round(m.stress, 3),
    even: round(m.rankEvenness),
    symmetry: round(m.symmetry),
    angle: round(m.crossingAngle, 0),
    zoom: round(report.metrics.zoom),
  };
}

const COLUMNS = [
  ["score", 5],
  ["crossings", 9],
  ["overlaps", 8],
  ["through", 7],
  ["backward", 8],
  ["flow", 5],
  ["ports", 5],
  ["bends", 5],
  ["spine", 5],
  ["stress", 6],
  ["zoom", 5],
];

/** A table of rows `{ name, cells: [{ variant, metrics }] }`, as text. */
export function flowTable(rows) {
  const lines = [];
  const head = "arrangement".padEnd(22) + COLUMNS.map(([name, width]) => name.padStart(width + 1)).join("");
  for (const row of rows) {
    lines.push("", row.name, head);
    for (const cell of row.cells) {
      const m = cell.metrics;
      lines.push(
        cell.variant.padEnd(22) +
          COLUMNS.map(([name, width]) => {
            const value = name === "backward" ? `${m.backward}/${m.backwardNeeded}` : m[name];
            return String(value ?? "-").padStart(width + 1);
          }).join(""),
      );
    }
  }
  return lines.join("\n");
}

/** Each arrangement over every document: totals of what is counted, means of what is a share. */
export function flowSummary(rows) {
  const by = new Map();
  for (const row of rows) {
    for (const cell of row.cells) {
      const sum = by.get(cell.variant) ?? { variant: cell.variant, documents: 0, score: 0, crossings: 0, overlaps: 0, through: 0, backward: 0, backwardNeeded: 0, flow: 0, ports: 0, bends: 0, spine: 0, zoom: 0 };
      sum.documents += 1;
      for (const key of ["score", "crossings", "overlaps", "through", "backward", "backwardNeeded", "flow", "ports", "bends", "spine", "zoom"]) sum[key] += cell.metrics[key] ?? 0;
      by.set(cell.variant, sum);
    }
  }
  // An arrangement isn't offered for every document, so each says how many it covers.
  return [...by.values()].map((sum) => ({
    variant: `${sum.variant} (${sum.documents})`,
    documents: sum.documents,
    metrics: {
      score: round(sum.score / sum.documents, 1),
      crossings: sum.crossings,
      overlaps: sum.overlaps,
      through: sum.through,
      backward: sum.backward,
      backwardNeeded: sum.backwardNeeded,
      flow: round(sum.flow / sum.documents),
      ports: round(sum.ports / sum.documents),
      bends: round(sum.bends / sum.documents),
      spine: round(sum.spine / sum.documents),
      stress: null,
      zoom: round(sum.zoom / sum.documents),
    },
  }));
}

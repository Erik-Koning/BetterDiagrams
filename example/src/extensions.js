/**
 * extensions.js — proof that the editor extends without being forked.
 *
 * Nothing here imports library internals. Three plain objects add two AWS-ish
 * node kinds, an icon for each, and a custom exporter — and because the
 * registry also feeds the generated LLM system prompt, the model can emit the
 * new kinds too.
 */

/** 24x24 viewBox path data, same format as the built-in icons. */
export const icons = {
  lambda: ["M4 4h6l7 16h3", "M20 4h-5L8 20H4"],
  bucket: ["M4 6h16l-2 14H6z", "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3"],
};

/**
 * A partial definition merges over the built-in fallback, so a new kind only
 * has to state what makes it different.
 */
export const nodeKinds = {
  lambda: {
    label: "Lambda",
    fill: "#2a1607",
    accent: "#fb923c",
    text: "#fed7aa",
    icon: "lambda",
  },
  bucket: {
    label: "S3 Bucket",
    fill: "#052e1a",
    accent: "#4ade80",
    text: "#bbf7d0",
    icon: "bucket",
  },
  // A container kind, so nodes can nest inside it exactly like a Group.
  region: {
    label: "AWS Region",
    accent: "#a855f7",
    container: true,
  },
};

/**
 * A custom exporter. `run` returns a blob to download — or nothing at all if it
 * delivers the result itself, as this one does when the clipboard is available.
 */
export const exporters = {
  summary: {
    label: "Copy summary",
    hint: "Plain-text inventory to the clipboard",
    async run({ template }) {
      const counts = {};
      for (const node of template.nodes) {
        counts[node.kind] = (counts[node.kind] ?? 0) + 1;
      }
      const lines = [
        `# ${template.meta?.title ?? "Architecture"}`,
        "",
        `${template.nodes.length} nodes, ${template.edges.length} connections`,
        "",
        ...Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, n]) => `  ${String(n).padStart(3)}  ${kind}`),
        "",
        "Connections:",
        ...template.edges.map((e) => `  ${e.source} → ${e.target}${e.label ? ` (${e.label})` : ""}`),
      ];
      const text = lines.join("\n");

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return; // Handled — nothing to download.
      }
      // No clipboard permission: fall back to a file.
      return { blob: new Blob([text], { type: "text/plain" }), filename: "summary.txt" };
    },
  },
};

/**
 * Custom infra providers for zones, merged over the built-ins the same way.
 * These show up in the zone toggle, the legend, the scenario control, and the
 * generated LLM prompt.
 */
export const providers = {
  fly: { label: "Fly.io", color: "#8b5cf6", icon: "bolt" },
  // Partial override of a built-in — keeps AWS's label and icon, new colour.
  aws: { color: "#ff9d2e" },
};

/** Extra guidance appended to the generated LLM system prompt. */
export const promptExtraRules =
  '- This organisation runs on AWS. Prefer "lambda" for compute, "bucket" for object storage, and wrap cloud resources in a "region" container.';

export const registry = { nodeKinds, icons, exporters, providers, promptExtraRules };

/**
 * extensions.js — proof that the editor extends without being forked.
 *
 * Nothing here imports library internals. Three plain objects add two custom
 * node kinds, an icon for each, and a custom exporter — and because the
 * registry also feeds the generated LLM system prompt, the model can emit the
 * new kinds too. (AWS/Azure/GCP components ship built in — these demo kinds
 * deliberately cover things the cloud packs don't.)
 */

/** 24x24 viewBox path data, same format as the built-in icons. */
export const icons = {
  vault: ["M12 2l9 5v10l-9 5-9-5V7z", "M12 9v6", "M9 12h6"],
  cache: ["M4 7h16v10H4z", "M4 12h16", "M8 7v10"],
};

/**
 * A partial definition merges over the built-in fallback, so a new kind only
 * has to state what makes it different.
 */
export const nodeKinds = {
  vault: {
    label: "Vault",
    fill: "#241a04",
    accent: "#eab308",
    text: "#fde68a",
    icon: "vault",
  },
  cache: {
    label: "Redis Cache",
    fill: "#2d0a0a",
    accent: "#f87171",
    text: "#fecaca",
    icon: "cache",
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
  '- This organisation runs on AWS. Prefer the aws-* component kinds for cloud resources, "vault" for secrets management, "cache" for Redis, and wrap cloud resources in a "region" container.';

export const registry = { nodeKinds, icons, exporters, providers, promptExtraRules };

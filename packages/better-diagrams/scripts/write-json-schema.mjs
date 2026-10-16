/**
 * Write dist/schema.json — the document's JSON Schema with the built-in
 * vocabulary — from the built contract, so the shipped file is exactly what
 * `diagramJsonSchema()` returns. Run after `vite build` (see `npm run build`).
 */
import { writeFileSync } from "node:fs";
import { diagramJsonSchema } from "../dist/contract.js";

const out = new URL("../dist/schema.json", import.meta.url);
writeFileSync(out, `${JSON.stringify(diagramJsonSchema(), null, 2)}\n`);
console.log(`schema: ${out.pathname}`);

/**
 * schema-lint-diagnostics.ts — the walk that turns schema-lint's rules into
 * CodeMirror diagnostics over the JSON syntax tree.
 *
 * Apart from schema-lint.ts so the rules — which the editor builds from its
 * registry on every mount — don't bring CodeMirror with them: only the JSON
 * editor, which loads on demand, needs this half.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { normalizeDate } from "../contract/timeline";
import { suggest, type JsonDocLint, type RefRule, type ValueRule } from "./schema-lint";

// ─── The walk ────────────────────────────────────────────────────────────────

const ruleKey = (path: string, key: string) => `${path}\0${key}`;

/**
 * All diagnostics for the document under `lint`: unknown keys, unknown
 * values, dangling references, sibling-membership, unreadable dates. Always
 * severity "warning" — this lint informs, it never blocks.
 */
export function docDiagnostics(state: EditorState, lint: JsonDocLint): Diagnostic[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const diagnostics: Diagnostic[] = [];

  let pools: Record<string, ReadonlySet<string>> | null = null;
  if (lint.refPools) {
    try {
      pools = lint.refPools(JSON.parse(state.doc.toString()));
    } catch {
      pools = null; // half-typed doc: skip refs rather than mis-warn
    }
  }

  const valueRules = new Map(lint.values.map((r) => [ruleKey(r.path, r.key), r]));
  const refRules = new Map(lint.refs.map((r) => [ruleKey(r.path, r.key), r]));
  const dateRules = new Set(lint.dates.map((r) => ruleKey(r.path, r.key)));

  const stringAt = (from: number, to: number): string => {
    const raw = state.doc.sliceString(from, to);
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.replace(/^"|"$/g, "");
    }
  };

  const warn = (node: SyntaxNode, message: string) =>
    diagnostics.push({ from: node.from, to: node.to, severity: "warning", message });

  const checkValue = (node: SyntaxNode, rule: ValueRule) => {
    const value = stringAt(node.from, node.to);
    if (rule.allowed.has(value)) return;
    warn(
      node,
      `Unknown ${rule.noun} "${value}" — not ${rule.describe} this editor knows` +
        `${suggest(value, rule.allowed)}. ${rule.consequence}`,
    );
  };

  const checkRef = (node: SyntaxNode, rule: RefRule) => {
    const pool = pools?.[rule.pool];
    if (!pool) return;
    const value = stringAt(node.from, node.to);
    if (rule.optional && value === "") return;
    if (pool.has(value) || pool.has(value.trim())) return;
    warn(
      node,
      `Unknown ${rule.noun} "${value}" — nothing in this document declares it` +
        `${suggest(value, pool)}. ${rule.consequence}`,
    );
  };

  const walkValue = (node: SyntaxNode, path: string[]): void => {
    if (node.name === "Object") {
      const pathId = path.join(".");
      const allowed = lint.keys(path);

      // The zone-local provider list, gathered before judging `provider`.
      let siblingList: string[] | null = null;
      if (lint.sibling && pathId === lint.sibling.path) {
        for (let prop = node.firstChild; prop; prop = prop.nextSibling) {
          if (prop.name !== "Property") continue;
          const nameNode = prop.getChild("PropertyName");
          const value = prop.lastChild;
          if (!nameNode || !value) continue;
          if (stringAt(nameNode.from, nameNode.to) !== lint.sibling.arrayKey) continue;
          if (value.name !== "Array") continue;
          siblingList = [];
          for (let entry = value.firstChild; entry; entry = entry.nextSibling) {
            if (entry.name === "String") siblingList.push(stringAt(entry.from, entry.to));
          }
        }
      }

      for (let prop = node.firstChild; prop; prop = prop.nextSibling) {
        if (prop.name !== "Property") continue;
        const nameNode = prop.getChild("PropertyName");
        if (!nameNode) continue;
        const key = stringAt(nameNode.from, nameNode.to);
        if (allowed && !allowed.includes(key)) {
          warn(
            nameNode,
            `Unknown key "${key}" — not part of the ${lint.name} schema` +
              `${suggest(key, allowed)}. It will be ignored on insert.`,
          );
        }
        const value = prop.lastChild;
        if (!value || value.from < nameNode.to) continue;

        const id = ruleKey(pathId, key);
        const valueRule = valueRules.get(id);
        if (valueRule) {
          if (valueRule.each && value.name === "Array") {
            for (let entry = value.firstChild; entry; entry = entry.nextSibling) {
              if (entry.name === "String") checkValue(entry, valueRule);
            }
          } else if (value.name === "String") {
            checkValue(value, valueRule);
          }
        }

        const refRule = refRules.get(id);
        if (refRule) {
          if (refRule.each && value.name === "Array") {
            for (let entry = value.firstChild; entry; entry = entry.nextSibling) {
              if (entry.name === "String") checkRef(entry, refRule);
            }
          } else if (value.name === "String") {
            checkRef(value, refRule);
          }
        }

        if (dateRules.has(id) && value.name === "String") {
          const date = stringAt(value.from, value.to);
          if (date !== "" && normalizeDate(date) === undefined) {
            warn(
              value,
              `Unrecognisable date "${date}" — expected something like "2026-03-14". ` +
                "It will be ignored on insert.",
            );
          }
        }

        if (
          lint.sibling &&
          pathId === lint.sibling.path &&
          key === lint.sibling.key &&
          siblingList?.length &&
          value.name === "String"
        ) {
          const provider = stringAt(value.from, value.to);
          if (!siblingList.includes(provider)) {
            warn(
              value,
              `"${provider}" is not one of this zone's providers` +
                `${suggest(provider, siblingList)}. It will fall back to "${siblingList[0]}", ` +
                "the first provider the zone lists.",
            );
          }
        }

        walkValue(value, [...path, key]);
      }
    } else if (node.name === "Array") {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "Object" || child.name === "Array") {
          walkValue(child, [...path, "*"]);
        }
      }
    }
  };

  const top = tree.topNode.firstChild;
  if (top) walkValue(top, []);
  return diagnostics;
}

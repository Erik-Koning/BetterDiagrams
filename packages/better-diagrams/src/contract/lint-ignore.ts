/**
 * lint-ignore.ts — the tag that excuses an element from a check.
 *
 * Zero dependencies, like every contract module.
 */

/**
 * Tag that opts one element out of linting: `lint-ignore` silences every rule
 * on it, `lint-ignore:no-orphans` silences one.
 *
 * A tag rather than a schema field because that is where "this is deliberate,
 * stop telling me" already lives in this document, it survives every
 * round-trip, and it shows in the tag filter — so a reader can see at a glance
 * what has been excused and why the Checks count is what it is.
 */
export const LINT_IGNORE_TAG = "lint-ignore";

export function lintIgnored(n: { tags?: readonly string[] }, rule: string): boolean {
  const tags = n.tags;
  if (!tags?.length) return false;
  return tags.some((t) => {
    const tag = t.trim().toLowerCase();
    return tag === LINT_IGNORE_TAG || tag === `${LINT_IGNORE_TAG}:${rule.toLowerCase()}`;
  });
}

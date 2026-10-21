/**
 * KindSelect — the node-type picker, relevance-aware.
 *
 * A native <select> can't style its options, and the cloud packs need
 * structure a flat list can't give: core kinds first, then the clouds this
 * document actually references (a zone/node/edge names the provider), and at
 * the bottom a dimmed "Other clouds" section holding every cloud the
 * document doesn't touch — visually demoted, still fully selectable, so
 * discovering a pack never requires leaving the dropdown.
 *
 * Typing searches, as in every inspector picker (`useSearchMenu`): the box
 * at the top narrows every section at once, by kind name, id or cloud — so
 * "lambda" or "aws queue" finds a pack kind without scrolling to it.
 */
import { Fragment } from "react";
import type { ResolvedRegistry } from "./registry-types";
import { matchesQuery, SearchMenuBox, useSearchMenu } from "./SearchSelect";

export interface KindSelectProps {
  registry: ResolvedRegistry;
  value: string;
  onChange: (kind: string) => void;
  /** Providers the document references — these clouds list un-demoted. */
  relevantProviders: ReadonlySet<string>;
  /**
   * Kinds this picker must not offer. Used where a kind would be a category
   * error rather than a bad choice — nesting a group cannot turn it into
   * another container, or the contents would stay inline.
   */
  omit?: (kind: string) => boolean;
  /**
   * What the button reads while `value` is empty — a selection whose nodes
   * are of different kinds has no one kind to show.
   */
  placeholder?: string;
}

interface CloudGroup {
  provider: string;
  label: string;
  color: string;
  kinds: string[];
}

export function KindSelect({ registry, value, onChange, relevantProviders, omit, placeholder }: KindSelectProps) {
  const menu = useSearchMenu({ selected: value || null });
  const labelOf = (kind: string) => registry.nodeKinds[kind]?.label ?? kind;

  const coreKinds: string[] = [];
  const byProvider = new Map<string, string[]>();
  for (const kind of registry.kindOrder) {
    if (omit?.(kind)) continue;
    const provider = registry.nodeKinds[kind]?.provider;
    const cloud = provider ? (registry.providers[provider]?.label ?? provider) : undefined;
    if (!matchesQuery(menu.query, labelOf(kind), kind, cloud)) continue;
    if (!provider) {
      coreKinds.push(kind);
    } else {
      const list = byProvider.get(provider) ?? [];
      list.push(kind);
      byProvider.set(provider, list);
    }
  }
  const group = (provider: string): CloudGroup => ({
    provider,
    label: registry.providers[provider]?.label ?? provider,
    color: registry.providers[provider]?.color ?? "var(--as-text-dim)",
    kinds: byProvider.get(provider) ?? [],
  });
  const cloudProviders = [...byProvider.keys()];
  const relevant = cloudProviders.filter((p) => relevantProviders.has(p)).map(group);
  const demoted = cloudProviders.filter((p) => !relevantProviders.has(p)).map(group);
  // The rows in the order they show, for the arrow keys.
  const visible = [...coreKinds, ...relevant.flatMap((c) => c.kinds), ...demoted.flatMap((c) => c.kinds)].map(
    (kind) => ({ value: kind }),
  );
  const active = visible.find((o) => o.value === menu.activeValue)?.value ?? visible[0]?.value;

  const pick = (kind: string) => {
    menu.close(true);
    onChange(kind);
  };

  const option = (kind: string) => (
    <button
      key={kind}
      id={menu.optionId(kind)}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={kind === value}
      data-active={kind === active}
      className={`as-kindmenu__option${kind === value ? " as-kindmenu__option--active" : ""}`}
      // Keep focus in the search box, so the keys go on working.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => menu.setActiveValue(kind)}
      onClick={() => pick(kind)}
    >
      {labelOf(kind)}
    </button>
  );

  return (
    <div className="as-kindselect" ref={menu.wrapRef}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="as-select as-kindselect__button"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-label="Node kind"
        title="Node kind"
      >
        {value ? labelOf(value) : placeholder}
      </button>
      {menu.open ? (
        <div className="as-menu as-kindmenu as-searchmenu">
          <SearchMenuBox menu={menu} visible={visible} pick={pick} label="Node kind" />
          <div ref={menu.listRef} id={menu.listId} role="listbox" aria-label="Node kind">
            {coreKinds.map(option)}
            {relevant.map((cloud) => (
              <Fragment key={cloud.provider}>
                <div className="as-kindmenu__header">
                  <span className="as-kindmenu__dot" style={{ background: cloud.color }} />
                  {cloud.label}
                </div>
                {cloud.kinds.map(option)}
              </Fragment>
            ))}
            {demoted.length ? (
              <div className="as-kindmenu__dim">
                <div className="as-kindmenu__header">Other clouds</div>
                {demoted.map((cloud) => (
                  <Fragment key={cloud.provider}>
                    <div className="as-kindmenu__header as-kindmenu__header--sub">
                      <span className="as-kindmenu__dot" style={{ background: cloud.color }} />
                      {cloud.label}
                    </div>
                    {cloud.kinds.map(option)}
                  </Fragment>
                ))}
              </div>
            ) : null}
            {!visible.length ? <div className="as-searchmenu__empty">No matches</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
